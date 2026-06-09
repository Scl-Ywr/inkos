import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { serve } from "@hono/node-server";
import {
  StateManager,
  PipelineRunner,
  createLLMClient,
  createLogger,
  loadProjectConfig,
  loadBookSession,
  appendManualSessionMessages,
  migrateBookSession,
  SessionAlreadyMigratedError,
  runAgentSession,
  buildAgentSystemPrompt,
  chatCompletion,
  getHeadroomSavingsTelemetry,
  diffHeadroomSavingsTelemetry,
  GLOBAL_CONFIG_DIR,
  GLOBAL_ENV_PATH,
  type PipelineConfig,
  type ProjectConfig,
  type LLMConfig,
  type LogSink,
  type LogEntry,
} from "@actalk/inkos-core";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isSafeBookId } from "./safety.js";
import { ApiError } from "./errors.js";
import {
  formatUnknownError,
  writeConsoleLogEntry,
} from "./server-logs.js";
import { operationCancelledError, type OperationFinishInput } from "./active-operations.js";
import { createOperationRuntime } from "./operation-runtime.js";
import { registerOperationRuntimeRoutes } from "./operation-runtime-routes.js";
import { registerRuntimeRoutes } from "./runtime-routes.js";
import { registerDaemonRoutes } from "./daemon-routes.js";
import { registerSessionRoutes } from "./session-routes.js";
import { registerProjectRoutes } from "./project-routes.js";
import { registerServiceModelRoutes } from "./service-routes.js";
import { registerBookChapterRoutes } from "./book-chapter-routes.js";
import { registerGenreRoutes } from "./genre-routes.js";
import { registerCreativeToolRoutes } from "./creative-tool-routes.js";
import { registerDoctorRoutes } from "./doctor-routes.js";
import {
  PIPELINE_STAGES,
  extractToolError,
  isWriteNextInstruction,
  parseSseResultEnvelope,
  resolveArchitectBookIdFromArgs,
  resolveCreatedBookIdFromToolExecs,
  resolveToolLabel,
  summarizeResult,
  validateAgentActionExecution,
  type CollectedToolExec,
} from "./agent-route-utils.js";
import { tryHandleExternalChatEdit } from "./chat-external-edit.js";
import {
  buildDefaultStudioProjectConfig,
  ensureProjectStorageSkeleton,
  repairBookResourceLayout,
  repairProjectResourceIndex,
  repairStudioStartupCompatibility,
  shouldRefreshDerivedFoundationFile,
  type StorageRepairEntry,
} from "./storage-repair.js";
import { normalizeApiBookId } from "./api-validation.js";
import {
  filterTextChatModels,
  isTextChatModelId,
  loadRawConfig,
  nonTextModelMessage,
  probeServiceCapabilities,
  readEnvConfigStatus,
  resolveConfiguredServiceBaseUrl,
  saveRawConfig,
} from "./service-runtime.js";
import {
  AgentModelApiKeyError,
  resolveAgentModelSelection,
} from "./agent-model-resolution.js";
import type { StudioBookListSummary } from "./book-route-context.js";

const bookCreateStatus = new Map<string, { status: "creating" | "error"; error?: string }>();
const operationRuntime = createOperationRuntime();
const {
  appendRuntimeTokenSummary,
  broadcast,
  clearOperation,
  configureOperationHistoryPersistence,
  createOperationController,
  emitStudioFileAudit,
  getActiveOperation,
  isCancellationResult,
  isOperationAbortError,
  isOperationCancelled,
  pushLog,
  readRuntimeTokenSavings,
  readRuntimeTokenUsage,
  rememberAgentRequestResult,
  rememberRuntimeNotice,
  serverLog,
  setOperation,
  shouldRejectCancelledAgentRequest,
  touchOperation,
} = operationRuntime;

async function loadStudioBookListSummary(
  state: StateManager,
  bookId: string,
): Promise<StudioBookListSummary> {
  const book = await state.loadBookConfig(bookId);
  const nextChapter = await state.getNextChapterNumber(bookId);
  return { ...book, chaptersWritten: nextChapter - 1 };
}

// --- Server factory ---

export function createStudioServer(initialConfig: ProjectConfig, root: string) {
  process.env.INKOS_PROJECT_ROOT ??= root;
  configureOperationHistoryPersistence(root);
  const app = new Hono();
  const state = new StateManager(root);
  let cachedConfig = initialConfig;

  app.use("/*", cors());

  // Structured error handler — ApiError returns typed JSON, others return 500
  app.onError((error, c) => {
    if (error instanceof ApiError) {
      return c.json({ error: { code: error.code, message: error.message } }, error.status as 400);
    }
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("LLM API key not set") || message.includes("INKOS_LLM_API_KEY not set")) {
      return c.json({ error: { code: "LLM_CONFIG_ERROR", message } }, 400);
    }
    writeConsoleLogEntry({
      level: "error",
      tag: "studio",
      message: `Unexpected server error: ${formatUnknownError(error)}`,
    });
    return c.json(
      { error: { code: "INTERNAL_ERROR", message: "Unexpected server error." } },
      500,
    );
  });

  // BookId validation middleware — blocks path traversal on all book routes
  app.use("/api/v1/books/:id/*", async (c, next) => {
    const bookId = c.req.param("id");
    if (!isSafeBookId(bookId)) {
      throw new ApiError(400, "INVALID_BOOK_ID", `Invalid book ID: "${bookId}"`);
    }
    await next();
  });
  app.use("/api/v1/books/:id", async (c, next) => {
    const bookId = c.req.param("id");
    if (!isSafeBookId(bookId)) {
      throw new ApiError(400, "INVALID_BOOK_ID", `Invalid book ID: "${bookId}"`);
    }
    await next();
  });

  registerRuntimeRoutes(app, {
    root,
    state,
    ensureProjectStorageSkeleton,
    repairProjectResourceIndex,
    broadcast,
  });

  // Logger sink that broadcasts to SSE and stores in buffer
  const sseSink: LogSink = {
    write(entry: LogEntry): void {
      pushLog(entry);
      broadcast("log", { level: entry.level, tag: entry.tag, message: entry.message, timestamp: entry.timestamp });
    },
  };

  // Logger sink that prints to server terminal
  const consoleSink: LogSink = {
    write(entry: LogEntry): void {
      writeConsoleLogEntry(entry);
    },
  };

  async function loadCurrentProjectConfig(
    options?: { readonly requireApiKey?: boolean },
  ): Promise<ProjectConfig> {
    const freshConfig = await loadProjectConfig(root, { ...options, consumer: "studio" });
    cachedConfig = freshConfig;
    return freshConfig;
  }

  async function buildPipelineConfig(
    overrides?: Partial<Pick<PipelineConfig, "externalContext" | "client" | "model" | "signal">> & {
      readonly currentConfig?: ProjectConfig;
      readonly sessionIdForSSE?: string;
      readonly bookId?: string;
    },
  ): Promise<PipelineConfig> {
    const currentConfig = overrides?.currentConfig ?? await loadCurrentProjectConfig();
    const scopedSseSink: LogSink = overrides?.sessionIdForSSE
      ? {
          write(entry) {
            pushLog(entry);
            broadcast("log", {
              sessionId: overrides.sessionIdForSSE,
              level: entry.level,
              tag: entry.tag,
              message: entry.message,
              timestamp: entry.timestamp,
            });
          },
        }
      : sseSink;
    const logger = createLogger({ tag: "studio", sinks: [scopedSseSink, consoleSink] });
    return {
      client: overrides?.client ?? createLLMClient(currentConfig.llm),
      model: overrides?.model ?? currentConfig.llm.model,
      projectRoot: root,
      defaultLLMConfig: currentConfig.llm,
      foundationReviewRetries: currentConfig.foundation?.reviewRetries ?? 2,
      writingReviewRetries: currentConfig.writing?.reviewRetries ?? 1,
      modelOverrides: currentConfig.modelOverrides,
      notifyChannels: currentConfig.notify,
      logger,
      onStreamProgress: (progress) => {
        broadcast("llm:progress", {
          ...(overrides?.sessionIdForSSE ? { sessionId: overrides.sessionIdForSSE } : {}),
          ...(overrides?.bookId ? { bookId: overrides.bookId } : {}),
          status: progress.status,
          elapsedMs: progress.elapsedMs,
          totalChars: progress.totalChars,
          chineseChars: progress.chineseChars,
        });
      },
      onTextDelta: (text, agent) => {
        if (agent === "writer" || agent === "reviser") {
          broadcast("write:delta", {
            ...(overrides?.sessionIdForSSE ? { sessionId: overrides.sessionIdForSSE } : {}),
            bookId: overrides?.bookId ?? "",
            text,
          });
        }
      },
      externalContext: overrides?.externalContext,
      signal: overrides?.signal,
    };
  }

  async function syncBookDerivedFoundationFiles(bookId: string): Promise<void> {
    const repaired: StorageRepairEntry[] = [];
    await repairBookResourceLayout(root, state.bookDir(bookId), repaired);
    if (repaired.length > 0) {
      serverLog("info", "foundation", `已同步 ${bookId} 的核心文件聚合：${repaired.map((item) => item.path).join(", ")}`);
    }
  }

  registerBookChapterRoutes(app, {
    root,
    state,
    bookCreateStatus,
    buildPipelineConfig,
    loadCurrentProjectConfig,
    syncBookDerivedFoundationFiles,
    shouldRefreshDerivedFoundationFile,
    loadStudioBookListSummary,
    broadcast,
    serverLog,
    emitStudioFileAudit,
    setOperation,
    createOperationController,
    isOperationCancelled,
    clearOperation,
    isOperationAbortError,
    rememberRuntimeNotice,
    readRuntimeTokenUsage,
    appendRuntimeTokenSummary,
  });
  registerGenreRoutes(app, { root });

  registerOperationRuntimeRoutes(app, { root, runtime: operationRuntime });

  registerServiceModelRoutes(app, {
    root,
    loadRawConfig,
    saveRawConfig,
    readEnvConfigStatus,
    resolveConfiguredServiceBaseUrl,
    probeServiceCapabilities,
    filterTextChatModels,
    isTextChatModelId,
  });
  registerProjectRoutes(app, { root, loadCurrentProjectConfig });

  registerDaemonRoutes(app, {
    loadCurrentProjectConfig,
    buildPipelineConfig,
    broadcast,
  });

  registerSessionRoutes(app, { root });
  registerCreativeToolRoutes(app, { root, buildPipelineConfig, broadcast });
  registerDoctorRoutes(app, {
    root,
    state,
    loadCurrentProjectConfig,
    probeServiceCapabilities,
    repairStudioStartupCompatibility,
    ensureProjectStorageSkeleton,
  });

  // --- Agent chat ---

  app.post("/api/v1/agent", async (c) => {
    // Parse request body first (before entering SSE stream)
    const requestBody = await c.req.json<{
      instruction: string;
      activeBookId?: string;
      sessionId?: string;
      model?: string;
      service?: string;
      stream?: boolean;
      requestId?: string;
      clientStartedAt?: number;
    }>();
    const { instruction, activeBookId, sessionId: reqSessionId, model: reqModel, service: reqService, stream: reqStream } = requestBody;
    const sessionId = reqSessionId;
    const requestId = typeof requestBody.requestId === "string" && /^[a-z0-9-]{8,80}$/i.test(requestBody.requestId)
      ? requestBody.requestId
      : undefined;
    const clientStartedAt = typeof requestBody.clientStartedAt === "number" && Number.isFinite(requestBody.clientStartedAt)
      ? requestBody.clientStartedAt
      : Date.now();

    // Validation - return JSON for simple errors (before SSE stream starts)
    if (!instruction?.trim()) {
      return c.json({ error: "No instruction provided" }, 400);
    }
    if (!sessionId?.trim()) {
      throw new ApiError(400, "SESSION_ID_REQUIRED", "sessionId is required");
    }
    if (reqModel && !isTextChatModelId(reqModel)) {
      const message = nonTextModelMessage(reqModel);
      return c.json({ error: message, response: message }, 400);
    }

    const wantsSse = reqStream === true || (c.req.header("accept") ?? "").includes("text/event-stream");
    if (!wantsSse) {
      const streamedResponse = await app.request(c.req.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: JSON.stringify({
          instruction,
          activeBookId,
          sessionId,
          model: reqModel,
          service: reqService,
          stream: true,
          requestId,
          clientStartedAt,
        }),
      });
      const envelope = parseSseResultEnvelope(await streamedResponse.text());
      if (!envelope) {
        return c.json({
          error: {
            code: "AGENT_STREAM_RESULT_MISSING",
            message: "Agent stream finished without a result event",
          },
        }, 500);
      }

      const { status, ...payload } = envelope;
      const envelopeStatus = typeof status === "number" ? status : undefined;
      const responseStatus = envelopeStatus !== undefined
        && Number.isInteger(envelopeStatus)
        && envelopeStatus >= 100
        && envelopeStatus <= 599
        ? envelopeStatus
        : streamedResponse.status;
      return c.json(payload, responseStatus as 200);
    }

    // Use SSE stream for long-running operations (prevents Cloudflare 524 timeout)
    return streamSSE(c, async (stream) => {
      const operationKey = requestId ? `agent:${sessionId}:${requestId}` : `agent:${sessionId}`;
      const savingsBeforeRun = getHeadroomSavingsTelemetry();
      let operationOutcome: OperationFinishInput | undefined;
      // Helper to send JSON response via SSE event and close stream
      const sendResult = async (data: Record<string, unknown>, status?: number) => {
        const resultStatus = status ?? 200;
        if (isOperationCancelled(operationKey) && !isCancellationResult(data, resultStatus)) {
          serverLog("warn", "agent", `丢弃已停止任务的迟到结果：${operationKey}`);
          return;
        }
        rememberAgentRequestResult(sessionId, requestId, data, resultStatus);
        const tokenSavings = diffHeadroomSavingsTelemetry(savingsBeforeRun);
        const activeOperation = getActiveOperation(operationKey);
        if (activeOperation?.label === "章节写作") {
          const responseText = typeof data.response === "string" ? data.response : "";
          const tokenUsage = readRuntimeTokenUsage(data.tokenUsage);
          const runtimeSavings = readRuntimeTokenSavings(tokenSavings);
          const baseMessage = responseText
            ? responseText.slice(0, 160)
            : activeOperation.message;
          rememberRuntimeNotice({
            kind: resultStatus >= 400 || Boolean(data.error) ? "error" : "completed",
            title: resultStatus >= 400 || Boolean(data.error) ? "章节生成遇到问题" : "章节生成完成",
            message: appendRuntimeTokenSummary(baseMessage, tokenUsage, runtimeSavings),
            ...(tokenUsage ? { tokenUsage } : {}),
            ...(runtimeSavings ? { tokenSavings: runtimeSavings } : {}),
          });
        }
        const errorMessage = data.error && typeof data.error === "object"
          && "message" in data.error
          && typeof (data.error as { message?: unknown }).message === "string"
          ? (data.error as { message: string }).message
          : typeof data.error === "string"
            ? data.error
            : "";
        const responseMessage = typeof data.response === "string" && data.response.trim()
          ? data.response.trim()
          : "";
        const outcomeMessage = (errorMessage || responseMessage || activeOperation?.message || "任务已结束").slice(0, 180);
        const outcomeStatus = isCancellationResult(data, resultStatus)
          ? "cancelled"
          : resultStatus >= 400 || Boolean(data.error)
            ? "error"
            : "completed";
        operationOutcome = {
          status: outcomeStatus,
          message: outcomeMessage,
          ...(outcomeStatus === "error" ? { error: errorMessage || outcomeMessage } : {}),
        };
        try {
          await stream.writeSSE({
            event: "result",
            data: JSON.stringify({
              ...data,
              tokenSavings,
              status: resultStatus,
            }),
          });
        } catch {
          // The Android WebView may be backgrounded or killed while Node keeps
          // working. Do not turn a finished backend task into a failed task just
          // because the foreground page disconnected before the final SSE event.
        }
      };

      // Keep-alive ping every 60 seconds (Cloudflare timeout is 100s)
      const keepAlive = setInterval(() => {
        stream.writeSSE({ event: "ping", data: "" }).catch(() => {});
      }, 60_000);

      const transcriptUsageFrom = (usage?: {
        readonly promptTokens?: number;
        readonly completionTokens?: number;
        readonly totalTokens?: number;
      }) => {
        const input = Math.max(0, usage?.promptTokens ?? 0);
        const output = Math.max(0, usage?.completionTokens ?? 0);
        const totalTokens = Math.max(0, usage?.totalTokens ?? input + output);
        return {
          input,
          output,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        };
      };

      stream.onAbort(() => {
        clearInterval(keepAlive);
      });

      try {
        if (shouldRejectCancelledAgentRequest(sessionId, clientStartedAt)) {
          serverLog("warn", "agent", `忽略已停止的过期指令: ${instruction.slice(0, 60)}${instruction.length > 60 ? "..." : ""}`);
          await sendResult({
            error: { code: "OPERATION_CANCELLED", message: "用户已停止当前生成。" },
            response: "已停止当前生成。需要的话可以调整提示后重新发送。",
          }, 499);
          return;
        }
        broadcast("agent:start", { instruction, activeBookId, sessionId });
        serverLog("info", "agent", `开始处理指令: ${instruction.slice(0, 60)}${instruction.length > 60 ? "..." : ""}`);

        // Track active operation for notification + session recovery.
        setOperation(operationKey, {
          type: "agent",
          bookId: activeBookId ?? "project",
          sessionId,
          instruction,
          label: activeBookId && isWriteNextInstruction(instruction) ? "章节写作" : "AI 对话",
          message: activeBookId && isWriteNextInstruction(instruction)
            ? `正在通过对话为《${activeBookId}》写下一章，页面退到后台也会继续执行。`
            : `正在处理对话指令：${instruction.slice(0, 42)}${instruction.length > 42 ? "..." : ""}`,
        });
        const operationController = createOperationController(operationKey);
        if (isOperationCancelled(operationKey)) {
          throw new ApiError(499, "OPERATION_CANCELLED", "用户已停止当前生成。");
        }

        // Load config + create LLM client (pipeline created after model resolution)
        const config = await loadCurrentProjectConfig({ requireApiKey: false });
      const client = createLLMClient(config.llm);

      const loadedBookSession = await loadBookSession(root, sessionId);
      if (!loadedBookSession) {
        throw new ApiError(404, "SESSION_NOT_FOUND", `Session not found: ${sessionId}`);
      }
      let bookSession = loadedBookSession;
      const requestedActiveBookId = normalizeApiBookId(activeBookId, "activeBookId");
      const persistedBookId = normalizeApiBookId(bookSession.bookId, "session.bookId");
      if (
        requestedActiveBookId
        && persistedBookId
        && persistedBookId !== requestedActiveBookId
      ) {
        throw new ApiError(
          409,
          "SESSION_BOOK_MISMATCH",
          `Session ${bookSession.sessionId} is bound to ${persistedBookId}, not ${requestedActiveBookId}`,
        );
      }
      const agentBookId = requestedActiveBookId ?? persistedBookId;
      if (agentBookId) {
        try {
          await state.loadBookConfig(agentBookId);
        } catch {
          throw new ApiError(404, "BOOK_NOT_FOUND", `Book not found: ${agentBookId}`);
        }
      }
      const streamSessionId = loadedBookSession.sessionId;
      const titleBeforeRun = bookSession.title;
      let sessionTitleBroadcasted = false;
      const refreshBookSessionFromTranscript = async (): Promise<void> => {
        const refreshed = await loadBookSession(root, bookSession.sessionId);
        if (refreshed) {
          bookSession = refreshed;
        }
        if (!sessionTitleBroadcasted && titleBeforeRun === null && bookSession.title) {
          broadcast("session:title", { sessionId: bookSession.sessionId, title: bookSession.title });
          sessionTitleBroadcasted = true;
        }
      };

      const externalEdit = await tryHandleExternalChatEdit({
        root,
        state,
        instruction,
        activeBookId: agentBookId,
      });
      if (externalEdit) {
        await appendManualSessionMessages(root, bookSession.sessionId, [{
          role: "assistant",
          content: [{ type: "text", text: externalEdit.responseText }],
          api: "anthropic-messages",
          provider: config.llm.provider,
          model: config.llm.model,
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop",
          timestamp: Date.now(),
        }], instruction);
        await refreshBookSessionFromTranscript();
        broadcast("agent:complete", { instruction, activeBookId: externalEdit.activeBookId, sessionId: bookSession.sessionId });
        await sendResult({
          response: externalEdit.responseText,
          session: {
            sessionId: bookSession.sessionId,
            ...(externalEdit.activeBookId ? { activeBookId: externalEdit.activeBookId } : {}),
          },
        });
        return;
      }

      const modelSelection = await resolveAgentModelSelection({
        root,
        config,
        reqService,
        reqModel,
        legacyClient: client,
      }).catch(async (error: unknown) => {
        if (error instanceof AgentModelApiKeyError) {
          await sendResult({
            error: `请先为 ${error.service} 配置 API Key`,
            response: `请先在模型配置中为 ${error.service} 填写 API Key，然后再试。`,
          }, 400);
          return null;
        }
        throw error;
      });
      if (!modelSelection) return;

      const { model, configuredEntry } = modelSelection;
      const agentApiKey = modelSelection.apiKey;

      // Create pipeline with resolved model (so sub_agent tools use the frontend-selected model)
      // Don't spread config.llm — its baseUrl/provider belong to the old service.
      // Let createLLMClient resolve baseUrl from the service preset.
      const pipelineClient = (reqService && reqModel)
        ? createLLMClient({
            ...config.llm,
            service: configuredEntry?.service ?? reqService,
            model: reqModel,
            apiKey: agentApiKey ?? "",
            ...(configuredEntry?.apiFormat ? { apiFormat: configuredEntry.apiFormat } : {}),
            ...(configuredEntry?.stream !== undefined ? { stream: configuredEntry.stream } : {}),
            baseUrl: configuredEntry?.baseUrl ?? "",
          } satisfies LLMConfig)
        : client;
      const pipeline = new PipelineRunner(await buildPipelineConfig({
      client: pipelineClient,
        model: reqModel ?? config.llm.model,
        currentConfig: config,
        sessionIdForSSE: bookSession.sessionId,
        bookId: agentBookId ?? undefined,
        signal: operationController.signal,
      }));

      if (agentBookId && isWriteNextInstruction(instruction)) {
        const toolCallId = `direct-writer-${Date.now().toString(36)}`;
        const toolArgs = { agent: "writer", bookId: agentBookId };
        touchOperation(operationKey, `正在调用写作工具，为《${agentBookId}》生成下一章正文。`);
        broadcast("tool:start", {
          sessionId: streamSessionId,
          id: toolCallId,
          tool: "sub_agent",
          args: toolArgs,
          stages: PIPELINE_STAGES.writer,
        });

        try {
          emitStudioFileAudit({
            action: "read",
            bookId: agentBookId,
            tool: "sub_agent.writer",
            path: `books/${agentBookId}/story/`,
            detail: "读取世界观、角色、伏笔和章节上下文",
          }, { sessionId: streamSessionId, bookId: agentBookId });
          const writeResult = await pipeline.writeNextChapter(agentBookId);
          if (isOperationCancelled(operationKey) || operationController.signal.aborted) {
            throw operationCancelledError();
          }
          touchOperation(
            operationKey,
            `《${agentBookId}》第 ${writeResult.chapterNumber} 章已完成，正在保存会话和章节记录。`,
          );
          emitStudioFileAudit({
            action: "write",
            bookId: agentBookId,
            tool: "sub_agent.writer",
            path: `books/${agentBookId}/chapters/${String(writeResult.chapterNumber).padStart(4, "0")}-*.md`,
            detail: `写入第 ${writeResult.chapterNumber} 章正文`,
          }, { sessionId: streamSessionId, bookId: agentBookId });
          emitStudioFileAudit({
            action: "modify",
            bookId: agentBookId,
            tool: "sub_agent.writer",
            path: `books/${agentBookId}/story/`,
            detail: "更新核心文件、章节摘要、伏笔和角色状态",
          }, { sessionId: streamSessionId, bookId: agentBookId });
          const responseText = [
            `已为 ${agentBookId} 完成第 ${writeResult.chapterNumber} 章`,
            writeResult.title ? `《${writeResult.title}》` : "",
            `，字数 ${writeResult.wordCount}，状态 ${writeResult.status}。`,
          ].join("");
          const writeTokenUsage = writeResult.tokenUsage && writeResult.tokenUsage.totalTokens > 0
            ? writeResult.tokenUsage
            : undefined;
          const toolResult = {
            content: [{ type: "text", text: responseText }],
            details: {
              kind: "chapter_written",
              bookId: agentBookId,
              chapterNumber: writeResult.chapterNumber,
              title: writeResult.title,
              wordCount: writeResult.wordCount,
              status: writeResult.status,
            },
          };
          broadcast("tool:end", {
            sessionId: streamSessionId,
            id: toolCallId,
            tool: "sub_agent",
            result: toolResult,
            details: toolResult.details,
            isError: false,
          });
          await appendManualSessionMessages(root, bookSession.sessionId, [{
            role: "assistant",
            content: [{ type: "text", text: responseText }],
            api: "anthropic-messages",
            provider: configuredEntry?.service ?? reqService ?? config.llm.provider,
            model: reqModel ?? config.llm.model,
            usage: transcriptUsageFrom(writeTokenUsage),
            stopReason: "toolUse",
            timestamp: Date.now(),
          }], instruction);
          await refreshBookSessionFromTranscript();
          broadcast("agent:complete", { instruction, activeBookId: agentBookId, sessionId: bookSession.sessionId });
          await sendResult({
            response: responseText,
            session: {
              sessionId: bookSession.sessionId,
              activeBookId: agentBookId,
            },
            ...(writeTokenUsage ? { tokenUsage: writeTokenUsage } : {}),
          });
          return;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const toolResult = { content: [{ type: "text", text: message }] };
          broadcast("tool:end", {
            sessionId: streamSessionId,
            id: toolCallId,
            tool: "sub_agent",
            result: toolResult,
            isError: true,
          });
          if (isOperationAbortError(error)) {
            broadcast("agent:error", { instruction, activeBookId: agentBookId, sessionId: bookSession.sessionId, error: "用户已停止当前生成。" });
            await sendResult({
              error: { code: "OPERATION_CANCELLED", message: "用户已停止当前生成。" },
              response: "已停止当前生成。需要的话可以调整提示后重新发送。",
            }, 499);
            return;
          }
          broadcast("agent:error", { instruction, activeBookId: agentBookId, sessionId: bookSession.sessionId, error: message });
          await sendResult({
            error: { code: "AGENT_ACTION_FAILED", message },
            response: message,
          }, 502);
          return;
        }
      }

      // Run pi-agent session
      const collectedToolExecs: CollectedToolExec[] = [];
      const result = await runAgentSession(
        {
          model,
          apiKey: agentApiKey,
          pipeline,
          projectRoot: root,
          bookId: agentBookId,
          sessionId: bookSession.sessionId,
          language: config.language ?? "zh",
          onFileAudit: (event) => emitStudioFileAudit(event, {
            sessionId: streamSessionId,
            bookId: agentBookId ?? undefined,
          }),
          signal: operationController.signal,
          onEvent: (event) => {
            if (isOperationCancelled(operationKey)) {
              throw new ApiError(499, "OPERATION_CANCELLED", "用户已停止当前生成。");
            }
            if (event.type === "message_update") {
              const ame = event.assistantMessageEvent;
              if (ame.type === "text_delta") {
                broadcast("draft:delta", { sessionId: streamSessionId, text: ame.delta });
              } else if (ame.type === "thinking_delta") {
                const thinkingDelta = (ame as { readonly delta?: unknown }).delta;
                if (typeof thinkingDelta === "string") {
                  broadcast("thinking:delta", { sessionId: streamSessionId, text: thinkingDelta });
                }
              } else if (ame.type === "thinking_start") {
                broadcast("thinking:start", { sessionId: streamSessionId });
              } else if (ame.type === "thinking_end") {
                broadcast("thinking:end", { sessionId: streamSessionId });
              }
            }
            if (event.type === "tool_execution_start") {
              const args = event.args as Record<string, unknown> | undefined;
              const agent = event.toolName === "sub_agent" ? (args?.agent as string | undefined) : undefined;
              const stages = agent ? (PIPELINE_STAGES[agent] ?? []) : [];

              collectedToolExecs.push({
                id: event.toolCallId,
                tool: event.toolName,
                agent,
                label: resolveToolLabel(event.toolName, agent),
                status: "running",
                args,
                stages: stages.length > 0
                  ? stages.map(l => ({ label: l, status: "pending" as const }))
                  : undefined,
                startedAt: Date.now(),
              });
              touchOperation(
                operationKey,
                agent
                  ? `正在执行 ${resolveToolLabel(event.toolName, agent)} 工具：${stages[0] ?? "准备上下文"}`
                  : `正在执行 ${resolveToolLabel(event.toolName)} 工具。`,
              );

              if (!agentBookId && event.toolName === "sub_agent" && agent === "architect") {
                const bookId = resolveArchitectBookIdFromArgs(args);
                if (bookId) {
                  const title = typeof args?.title === "string" && args.title.trim()
                    ? args.title.trim()
                    : bookId;
                  bookCreateStatus.set(bookId, { status: "creating" });
                  broadcast("book:creating", { bookId, title, sessionId: streamSessionId });
                }
              }

              broadcast("tool:start", {
                sessionId: streamSessionId,
                id: event.toolCallId,
                tool: event.toolName,
                args,
                stages,
              });
            }
            if (event.type === "tool_execution_update") {
              broadcast("tool:update", {
                sessionId: streamSessionId,
                tool: event.toolName,
                partialResult: event.partialResult,
              });
            }
            if (event.type === "tool_execution_end") {
              const exec = collectedToolExecs.find(t => t.id === event.toolCallId);
              if (exec) {
                exec.status = event.isError ? "error" : "completed";
                exec.completedAt = Date.now();
                exec.stages = exec.stages?.map(s => ({ ...s, status: "completed" as const }));
                if (event.isError) exec.error = extractToolError(event.result);
                else exec.result = summarizeResult(event.result);
                exec.details = (event.result as { details?: unknown } | undefined)?.details;
                if (
                  event.isError &&
                  !agentBookId &&
                  exec.tool === "sub_agent" &&
                  exec.agent === "architect"
                ) {
                  const bookId = resolveArchitectBookIdFromArgs(exec.args);
                  if (bookId) {
                    const error = exec.error ?? "Book creation failed";
                    bookCreateStatus.set(bookId, { status: "error", error });
                    broadcast("book:error", { bookId, sessionId: streamSessionId, error });
                  }
                }
              }
              broadcast("tool:end", {
                sessionId: streamSessionId,
                id: event.toolCallId,
                tool: event.toolName,
                result: event.result,
                details: exec?.details,
                isError: event.isError,
              });
              touchOperation(
                operationKey,
                event.isError
                  ? `${resolveToolLabel(event.toolName, exec?.agent)} 执行失败，正在整理错误信息。`
                  : `${resolveToolLabel(event.toolName, exec?.agent)} 已完成，正在合并结果。`,
              );
            }
          },
        },
        instruction,
      );
      if (isOperationCancelled(operationKey)) {
        throw new ApiError(499, "OPERATION_CANCELLED", "用户已停止当前生成。");
      }

      if (result.responseText) {
        const actionExecutionError = validateAgentActionExecution({
          instruction,
          agentBookId,
          responseText: result.responseText,
          collectedToolExecs,
        });
        if (actionExecutionError) {
          await sendResult({
            error: { code: "AGENT_ACTION_NOT_EXECUTED", message: actionExecutionError },
            response: actionExecutionError,
          }, 502);
          return;
        }
      }

      let broadcastedCreatedBookId: string | null = null;
      const finalizeCreatedBook = async (): Promise<string | null> => {
        if (agentBookId) return null;
        const createdBookId = resolveCreatedBookIdFromToolExecs(collectedToolExecs);
        if (!createdBookId) return null;
        if (broadcastedCreatedBookId === createdBookId) return createdBookId;

        try {
          const migratedSession = await migrateBookSession(root, bookSession.sessionId, createdBookId);
          if (migratedSession) {
            bookSession = migratedSession;
          }
        } catch (e) {
          if (!(e instanceof SessionAlreadyMigratedError)) {
            throw e;
          }
        }

        const book = await loadStudioBookListSummary(state, createdBookId).catch(() => undefined);
        bookCreateStatus.delete(createdBookId);
        broadcast("book:created", {
          bookId: createdBookId,
          sessionId: bookSession.sessionId,
          ...(book ? { book } : {}),
        });
        broadcastedCreatedBookId = createdBookId;
        return createdBookId;
      };

      if (!result.responseText) {
        if (result.errorMessage) {
          if (resolveCreatedBookIdFromToolExecs(collectedToolExecs)) {
            await finalizeCreatedBook();
          }
          await sendResult({
            error: { code: "AGENT_LLM_ERROR", message: result.errorMessage },
            response: result.errorMessage,
          }, 502);
          return;
        }

        try {
          const fallbackClient = createLLMClient({
            ...config.llm,
            service: configuredEntry?.service ?? reqService ?? config.llm.service,
            model: reqModel ?? config.llm.model,
            apiKey: agentApiKey ?? config.llm.apiKey,
            baseUrl: configuredEntry?.baseUrl ?? "",
            ...(configuredEntry?.apiFormat ? { apiFormat: configuredEntry.apiFormat } : {}),
            ...(configuredEntry?.stream !== undefined ? { stream: configuredEntry.stream } : {}),
          } as ProjectConfig["llm"]);
          const fallback = await chatCompletion(
            fallbackClient,
            reqModel ?? config.llm.model,
            [
              { role: "system", content: buildAgentSystemPrompt(agentBookId, config.language ?? "zh") },
              { role: "user", content: instruction },
            ],
            { maxTokens: 256, signal: operationController.signal },
          );
          if (fallback.content?.trim()) {
            const actionExecutionError = validateAgentActionExecution({
              instruction,
              agentBookId,
              responseText: fallback.content,
              collectedToolExecs,
            });
            if (actionExecutionError) {
              await sendResult({
                error: { code: "AGENT_ACTION_NOT_EXECUTED", message: actionExecutionError },
                response: actionExecutionError,
              }, 502);
              return;
            }
            await appendManualSessionMessages(root, bookSession.sessionId, [{
              role: "assistant",
              content: [{ type: "text", text: fallback.content }],
              api: "anthropic-messages",
              provider: configuredEntry?.service ?? reqService ?? config.llm.provider,
              model: reqModel ?? config.llm.model,
              usage: transcriptUsageFrom(fallback.usage),
              stopReason: "stop",
              timestamp: Date.now(),
            }], instruction);
            await refreshBookSessionFromTranscript();
            const createdBookId = await finalizeCreatedBook();
            await sendResult({
              response: fallback.content,
              session: {
                sessionId: bookSession.sessionId,
                ...(createdBookId ? { activeBookId: createdBookId } : {}),
              },
              tokenUsage: fallback.usage,
            });
            return;
          }
        } catch {
          // fall through to probe-based diagnosis below
        }

        try {
          const probeClient = createLLMClient({
            ...config.llm,
            service: configuredEntry?.service ?? reqService ?? config.llm.service,
            model: reqModel ?? config.llm.model,
            apiKey: agentApiKey ?? config.llm.apiKey,
            baseUrl: configuredEntry?.baseUrl ?? "",
            ...(configuredEntry?.apiFormat ? { apiFormat: configuredEntry.apiFormat } : {}),
            ...(configuredEntry?.stream !== undefined ? { stream: configuredEntry.stream } : {}),
          } as ProjectConfig["llm"]);
          await chatCompletion(
            probeClient,
            reqModel ?? config.llm.model,
            [{ role: "user", content: "ping" }],
            { maxTokens: 5, signal: operationController.signal },
          );
        } catch (probeError) {
          const probeMessage = probeError instanceof Error ? probeError.message : String(probeError);
          if (resolveCreatedBookIdFromToolExecs(collectedToolExecs)) {
            await finalizeCreatedBook();
          }
          await sendResult({
            error: { code: "AGENT_EMPTY_RESPONSE", message: probeMessage },
            response: probeMessage,
          }, 502);
          return;
        }

        const emptyMessage = "模型未返回文本内容。请检查协议类型（chat/responses）、流式开关或上游服务兼容性。";
        if (resolveCreatedBookIdFromToolExecs(collectedToolExecs)) {
          await finalizeCreatedBook();
        }
        await sendResult({
          error: { code: "AGENT_EMPTY_RESPONSE", message: emptyMessage },
          response: emptyMessage,
        }, 502);
        return;
      }
      await refreshBookSessionFromTranscript();
      await finalizeCreatedBook();

      broadcast("agent:complete", { instruction, activeBookId, sessionId: bookSession.sessionId });
      serverLog("info", "agent", `指令完成: ${instruction.slice(0, 40)}${instruction.length > 40 ? "..." : ""}`);
      const resultUsage = (result as {
        readonly tokenUsage?: { readonly promptTokens: number; readonly completionTokens: number; readonly totalTokens: number };
      }).tokenUsage;
      const resultTokenUsage = resultUsage && resultUsage.totalTokens > 0
        ? resultUsage
        : undefined;

      await sendResult({
        response: result.responseText,
        session: {
          sessionId: bookSession.sessionId,
          ...(bookSession.bookId ? { activeBookId: bookSession.bookId } : {}),
        },
        ...(resultTokenUsage ? { tokenUsage: resultTokenUsage } : {}),
      });
    } catch (e) {
      if (e instanceof ApiError) {
        serverLog("warn", "agent", `API错误: ${e.message}`);
        await sendResult({ error: { code: e.code, message: e.message } }, e.status);
        return;
      }
      if (e instanceof SessionAlreadyMigratedError) {
        const migratedMessage = e instanceof Error ? e.message : String(e);
        await sendResult({ error: { code: "SESSION_ALREADY_MIGRATED", message: migratedMessage } }, 409);
        return;
      }
      const msg = e instanceof Error ? e.message : String(e);
      serverLog("error", "agent", `指令失败: ${msg}`);
      broadcast("agent:error", { instruction, activeBookId, sessionId, error: msg });

      // Agent busy — return 429 with user-friendly message
      if (/already processing|prompt.*queue/i.test(msg)) {
        await sendResult({
          error: { code: "AGENT_BUSY", message: "正在处理中，请等待当前操作完成" },
          response: "正在处理中，请等待当前操作完成后再发送。",
        }, 429);
        return;
      }

      await sendResult({ error: { code: "AGENT_ERROR", message: msg } }, 500);
    } finally {
      clearInterval(keepAlive);
      clearOperation(operationKey, operationOutcome);
    }
    });
  });

  return app;
}

// --- Standalone runner ---

export async function startStudioServer(
  root: string,
  port = 4567,
  options?: { readonly staticDir?: string },
): Promise<void> {
  await repairStudioStartupCompatibility(root);
  await ensureProjectStorageSkeleton(root);
  const projectConfigPath = join(root, "inkos.json");

  try {
    await access(projectConfigPath);
    const raw = JSON.parse(await readFile(projectConfigPath, "utf-8")) as Record<string, unknown>;
    const llm = raw.llm && typeof raw.llm === "object" ? raw.llm as Record<string, unknown> : {};
    const needsRepair = raw.name === undefined
      || raw.version !== "0.1.0"
      || typeof llm.service !== "string"
      || typeof llm.defaultModel !== "string"
      || (typeof llm.provider === "string" && !["openai", "anthropic", "custom"].includes(llm.provider));
    if (needsRepair) {
      await writeFile(projectConfigPath, JSON.stringify(buildDefaultStudioProjectConfig(raw), null, 2), "utf-8");
    }
  } catch {
    await writeFile(projectConfigPath, JSON.stringify(buildDefaultStudioProjectConfig(), null, 2), "utf-8");
  }
  const envPath = join(root, ".env");
  try {
    await access(envPath);
  } catch {
    await writeFile(envPath, "", "utf-8");
  }

  try {
    await mkdir(GLOBAL_CONFIG_DIR, { recursive: true });
    await access(GLOBAL_ENV_PATH);
  } catch {
    await writeFile(GLOBAL_ENV_PATH, [
      "# InkOS global environment",
      "# This file is created automatically by InkOS Studio on Android.",
      "# Configure provider credentials in the app's model settings; they are stored in .inkos/secrets.json.",
      "",
    ].join("\n"), "utf-8");
  }

  const config = await loadProjectConfig(root, { consumer: "studio", requireApiKey: false });

  const app = createStudioServer(config, root);

  // Serve frontend static files — single process for API + frontend
  if (options?.staticDir) {
    const { readFile: readFileFs } = await import("node:fs/promises");
    const { join: joinPath } = await import("node:path");
    const { existsSync } = await import("node:fs");

    // Serve static assets (js, css, etc.)
    app.get("/assets/*", async (c) => {
      const filePath = joinPath(options.staticDir!, c.req.path);
      try {
        const content = await readFileFs(filePath);
        const ext = filePath.split(".").pop() ?? "";
        const contentTypes: Record<string, string> = {
          js: "application/javascript",
          css: "text/css",
          svg: "image/svg+xml",
          png: "image/png",
          ico: "image/x-icon",
          json: "application/json",
        };
        return new Response(content, {
          headers: { "Content-Type": contentTypes[ext] ?? "application/octet-stream" },
        });
      } catch {
        return c.notFound();
      }
    });

    // SPA fallback — serve index.html for all non-API routes
    const indexPath = joinPath(options.staticDir!, "index.html");
    if (existsSync(indexPath)) {
      app.get("*", async (c) => {
        if (c.req.path.startsWith("/api/v1/")) return c.notFound();
        const indexHtml = await readFileFs(indexPath, "utf-8");
        return c.html(indexHtml);
      });
    }
  }

  const server = serve({ fetch: app.fetch, port });
  server.on("listening", () => {
    writeConsoleLogEntry({
      level: "info",
      tag: "studio",
      message: `InkOS Studio running on http://localhost:${port}`,
    });
    void (async () => {
      try {
        await mkdir(root, { recursive: true });
        await writeFile(join(root, "runtime-status.json"), JSON.stringify({
          state: "running",
          message: `Node backend listening on 127.0.0.1:${port}`,
          updatedAt: Date.now(),
        }, null, 2), "utf-8");
      } catch (error) {
        writeConsoleLogEntry({
          level: "warn",
          tag: "studio",
          message: `Unable to write runtime status: ${formatUnknownError(error)}`,
        });
      }
    })();
  });
  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      writeConsoleLogEntry({
        level: "error",
        tag: "studio",
        message: `Port ${port} is already in use. Stop the other process or use --port <number>.`,
      });
      process.exit(1);
    }
  });
}
