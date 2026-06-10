import { PipelineRunner, createLLMClient } from "@actalk/inkos-core";
import type { Hono } from "hono";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { LLMConfig, WritePipelineMode } from "@actalk/inkos-core";
import { resolveAgentModelSelection } from "./agent-model-resolution.js";
import { enqueueBookScopedBackgroundResync } from "./background-resync-queue.js";
import type { BookChapterRoutesDeps } from "./book-route-context.js";
import { findChapterMarkdownFile, parsePositiveIntegerParam } from "./book-route-utils.js";

function resolveWritePipelineMode(value: unknown): WritePipelineMode {
  return value === "full" ? "full" : "quick";
}

export function registerBookGenerationRoutes(app: Hono, deps: BookChapterRoutesDeps): void {
  const {
    root,
    state,
    buildPipelineConfig,
    loadCurrentProjectConfig,
    syncBookDerivedFoundationFiles,
    broadcast,
    serverLog,
    setOperation,
    getActiveOperation,
    touchOperation,
    createOperationController,
    isOperationCancelled,
    clearOperation,
    isOperationAbortError,
    rememberRuntimeNotice,
    readRuntimeTokenUsage,
    appendRuntimeTokenSummary,
  } = deps;
  // --- Actions ---

  const refreshDerivedFoundationFilesAfterSuccess = (bookId: string): void => {
    void syncBookDerivedFoundationFiles(bookId).catch((error) => {
      serverLog(
        "info",
        "foundation",
        `核心文件聚合暂未刷新，不影响已完成的章节/状态补算：${bookId} (${error instanceof Error ? error.message : String(error)})`,
      );
    });
  };

  app.post("/api/v1/books/:id/write-next", async (c) => {
    const id = c.req.param("id");
    const body = await c.req
      .json<{ wordCount?: number; mode?: unknown }>()
      .catch(() => ({ wordCount: undefined, mode: undefined }));
    const mode = resolveWritePipelineMode(body.mode);
    const modeLabel = mode === "quick" ? "快速" : "完整";

    broadcast("write:start", { bookId: id });
    serverLog("info", "write", `开始${modeLabel}写作书籍 ${id}`);

    // Track active operation for session recovery
    const operationKey = `write:${id}`;
    setOperation(operationKey, {
      type: "write",
      bookId: id,
      label: "章节写作",
      message: `正在以${modeLabel}模式为《${id}》生成下一章，AI 正在整理剧情、人物状态和章节文本。`,
    });
    const operationController = createOperationController(operationKey);

    const startBackgroundStateResync = (chapterNumber: number) => {
      const resyncKey = `resync:${id}:${chapterNumber}`;
      if (getActiveOperation(resyncKey)) {
        serverLog("warn", "resync", `书籍 ${id} 第 ${chapterNumber} 章状态补算已在运行，跳过重复任务`);
        return;
      }
      if (!enqueueBookScopedBackgroundResync(id, resyncKey, async () => {

      broadcast("resync:start", { bookId: id, chapter: chapterNumber, background: true });
      setOperation(resyncKey, {
        type: "resync",
        bookId: id,
        chapter: chapterNumber,
        label: "后台状态补算",
        message: `《${id}》第 ${chapterNumber} 章正文已完成，正在后台同步 truth/state/summary。`,
      });
      const resyncController = createOperationController(resyncKey);
      touchOperation(resyncKey, `正在后台补算《${id}》第 ${chapterNumber} 章状态产物。`);

      const resyncPipeline = new PipelineRunner(await buildPipelineConfig({
        bookId: id,
        operationKey: resyncKey,
        signal: resyncController.signal,
      }));
      await resyncPipeline.resyncChapterArtifacts(id, chapterNumber).then(
        (resyncResult) => {
          if (isOperationCancelled(resyncKey) || resyncController.signal.aborted) {
            clearOperation(resyncKey, { status: "cancelled", message: "用户已停止后台状态补算。" });
            return;
          }
          const message = `《${id}》第 ${resyncResult.chapterNumber} 章状态补算完成：${resyncResult.status}`;
          serverLog("info", "resync", message);
          rememberRuntimeNotice({
            kind: "completed",
            title: "状态补算完成",
            message,
          });
          clearOperation(resyncKey, { status: "completed", message });
          broadcast("resync:complete", {
            bookId: id,
            chapter: resyncResult.chapterNumber,
            status: resyncResult.status,
            background: true,
          });
          refreshDerivedFoundationFilesAfterSuccess(id);
        },
        (error) => {
          const msg = error instanceof Error ? error.message : String(error);
          if (isOperationAbortError(error)) {
            clearOperation(resyncKey, { status: "cancelled", message: "用户已停止后台状态补算。" });
            broadcast("resync:error", { bookId: id, chapter: chapterNumber, error: "用户已停止后台状态补算。", background: true });
            return;
          }
          const message = `《${id}》第 ${chapterNumber} 章状态补算失败：${msg}`;
          clearOperation(resyncKey, { status: "error", message, error: msg });
          serverLog("error", "resync", message);
          rememberRuntimeNotice({
            kind: "error",
            title: "状态补算失败",
            message: `${message.slice(0, 180)}。章节正文已保留，可手动重同步。`,
          });
          broadcast("resync:error", { bookId: id, chapter: chapterNumber, error: msg, background: true });
        },
      );
      })) {
        serverLog("warn", "resync", `书籍 ${id} 第 ${chapterNumber} 章状态补算已排队，跳过重复任务`);
      }
    };

    // Fire and forget — progress/completion/errors pushed via SSE
    touchOperation(operationKey, `正在准备《${id}》下一章上下文和写作计划（${modeLabel}模式）。`);
    const pipeline = new PipelineRunner(await buildPipelineConfig({ bookId: id, operationKey, signal: operationController.signal }));
    pipeline.writeNextChapter(id, body.wordCount, undefined, { mode }).then(
      (result) => {
        if (isOperationCancelled(operationKey) || operationController.signal.aborted) {
          serverLog("warn", "write", `书籍 ${id} 写作结果已丢弃：任务已停止`);
          clearOperation(operationKey, { status: "cancelled", message: "用户已停止当前生成。" });
          return;
        }
        const completionMessage = mode === "quick"
          ? `书籍 ${id} 第 ${result.chapterNumber} 章正文已完成: ${result.title} (${result.wordCount} 字)，状态补算已转入后台`
          : `书籍 ${id} 第 ${result.chapterNumber} 章${modeLabel}写作完成: ${result.title} (${result.wordCount} 字)`;
        serverLog("info", "write", completionMessage);
        refreshDerivedFoundationFilesAfterSuccess(id);
        const runtimeTokenUsage = readRuntimeTokenUsage(result.tokenUsage);
        rememberRuntimeNotice({
          kind: "completed",
          title: mode === "quick" ? "章节正文已完成" : "章节生成完成",
          message: appendRuntimeTokenSummary(
            mode === "quick"
              ? `《${id}》第 ${result.chapterNumber} 章《${result.title}》正文已完成，${result.wordCount} 字；truth/state/summary 正在后台补算。`
              : `《${id}》第 ${result.chapterNumber} 章《${result.title}》已完成，${result.wordCount} 字，状态 ${result.status}。`,
            runtimeTokenUsage,
          ),
          ...(runtimeTokenUsage ? { tokenUsage: runtimeTokenUsage } : {}),
        });
        clearOperation(operationKey, { status: "completed", message: completionMessage });
        broadcast("write:complete", { bookId: id, chapterNumber: result.chapterNumber, status: result.status, title: result.title, wordCount: result.wordCount });
        if (mode === "quick") {
          startBackgroundStateResync(result.chapterNumber);
        }
      },
      (e) => {
        const msg = e instanceof Error ? e.message : String(e);
        if (isOperationAbortError(e)) {
          clearOperation(operationKey, { status: "cancelled", message: "用户已停止当前生成。" });
          serverLog("warn", "write", `书籍 ${id} 写作已停止`);
          broadcast("write:error", { bookId: id, error: "用户已停止当前生成。" });
          return;
        }
        const errorMessage = `书籍 ${id} 写作失败: ${msg}`;
        clearOperation(operationKey, { status: "error", message: errorMessage, error: msg });
        serverLog("error", "write", errorMessage);
        rememberRuntimeNotice({
          kind: "error",
          title: "章节生成失败",
          message: `《${id}》写作失败：${msg.slice(0, 160)}`,
        });
        broadcast("write:error", { bookId: id, error: msg });
      },
    );

    return c.json({ status: "writing", bookId: id });
  });

  app.post("/api/v1/books/:id/draft", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json<{ wordCount?: number; context?: string }>().catch(() => ({ wordCount: undefined, context: undefined }));

    broadcast("draft:start", { bookId: id });
    serverLog("info", "draft", `开始草稿书籍 ${id}`);

    // Track active operation for session recovery
    const operationKey = `draft:${id}`;
    setOperation(operationKey, {
      type: "draft",
      bookId: id,
      label: "章节草稿",
      message: `正在为《${id}》生成草稿，会先铺剧情骨架再扩写正文。`,
    });
    const operationController = createOperationController(operationKey);

    touchOperation(operationKey, `正在准备《${id}》草稿上下文和章节骨架。`);
    const pipeline = new PipelineRunner(await buildPipelineConfig({ bookId: id, operationKey, signal: operationController.signal }));
    pipeline.writeDraft(id, body.context, body.wordCount).then(
      (result) => {
        if (isOperationCancelled(operationKey) || operationController.signal.aborted) {
          serverLog("warn", "draft", `书籍 ${id} 草稿结果已丢弃：任务已停止`);
          clearOperation(operationKey, { status: "cancelled", message: "用户已停止当前生成。" });
          return;
        }
        const completionMessage = `书籍 ${id} 草稿完成: ${result.title} (${result.wordCount} 字)`;
        serverLog("info", "draft", completionMessage);
        refreshDerivedFoundationFilesAfterSuccess(id);
        const runtimeTokenUsage = readRuntimeTokenUsage(result.tokenUsage);
        rememberRuntimeNotice({
          kind: "completed",
          title: "章节草稿完成",
          message: appendRuntimeTokenSummary(
            `《${id}》第 ${result.chapterNumber} 章草稿《${result.title}》已完成，${result.wordCount} 字。`,
            runtimeTokenUsage,
          ),
          ...(runtimeTokenUsage ? { tokenUsage: runtimeTokenUsage } : {}),
        });
        clearOperation(operationKey, { status: "completed", message: completionMessage });
        broadcast("draft:complete", { bookId: id, chapterNumber: result.chapterNumber, title: result.title, wordCount: result.wordCount });
      },
      (e) => {
        const msg = e instanceof Error ? e.message : String(e);
        if (isOperationAbortError(e)) {
          clearOperation(operationKey, { status: "cancelled", message: "用户已停止当前生成。" });
          serverLog("warn", "draft", `书籍 ${id} 草稿已停止`);
          broadcast("draft:error", { bookId: id, error: "用户已停止当前生成。" });
          return;
        }
        const errorMessage = `书籍 ${id} 草稿失败: ${msg}`;
        clearOperation(operationKey, { status: "error", message: errorMessage, error: msg });
        serverLog("error", "draft", errorMessage);
        rememberRuntimeNotice({
          kind: "error",
          title: "章节草稿失败",
          message: `《${id}》草稿生成失败：${msg.slice(0, 160)}`,
        });
        broadcast("draft:error", { bookId: id, error: msg });
      },
    );

    return c.json({ status: "drafting", bookId: id });
  });

  // --- Audit ---

  app.post("/api/v1/books/:id/audit/:chapter", async (c) => {
    const id = c.req.param("id");
    const chapterNum = parsePositiveIntegerParam(c.req.param("chapter"));
    if (chapterNum === null) {
      return c.json({ error: "Invalid chapter number" }, 400);
    }
    const bookDir = state.bookDir(id);

    const operationKey = `audit:${id}:${chapterNum}`;
    broadcast("audit:start", { bookId: id, chapter: chapterNum });
    setOperation(operationKey, {
      type: "audit",
      bookId: id,
      chapter: chapterNum,
      label: "章节审计",
      message: `正在审计《${id}》第 ${chapterNum} 章的连续性和设定一致性。`,
    });
    const operationController = createOperationController(operationKey);
    try {
      touchOperation(operationKey, `正在读取《${id}》第 ${chapterNum} 章并准备审计上下文。`);
      const book = await state.loadBookConfig(id);
      const chaptersDir = join(bookDir, "chapters");
      const match = await findChapterMarkdownFile(chaptersDir, chapterNum);
      if (!match) {
        clearOperation(operationKey, { status: "error", message: "Chapter not found", error: "Chapter not found" });
        return c.json({ error: "Chapter not found" }, 404);
      }

      const content = await readFile(join(chaptersDir, match), "utf-8");
      const currentConfig = await loadCurrentProjectConfig();
      const legacyClient = createLLMClient(currentConfig.llm);
      const modelSelection = await resolveAgentModelSelection({
        root,
        config: currentConfig,
        legacyClient,
      });
      const auditClient = modelSelection.configuredEntry
        ? createLLMClient({
            ...currentConfig.llm,
            service: modelSelection.configuredEntry.service,
            model: modelSelection.modelId,
            apiKey: modelSelection.apiKey ?? "",
            ...(modelSelection.configuredEntry.apiFormat ? { apiFormat: modelSelection.configuredEntry.apiFormat } : {}),
            ...(modelSelection.configuredEntry.stream !== undefined ? { stream: modelSelection.configuredEntry.stream } : {}),
            baseUrl: modelSelection.configuredEntry.baseUrl ?? "",
          } satisfies LLMConfig)
        : legacyClient;
      const { ContinuityAuditor } = await import("@actalk/inkos-core");
      const auditor = new ContinuityAuditor({
        client: auditClient,
        model: modelSelection.modelId,
        projectRoot: root,
        bookId: id,
        signal: operationController.signal,
      });
      touchOperation(operationKey, `正在调用模型审计《${id}》第 ${chapterNum} 章。`);
      const result = await auditor.auditChapter(bookDir, content, chapterNum, book.genre);
      clearOperation(operationKey, {
        status: "completed",
        message: `《${id}》第 ${chapterNum} 章审计完成：${result.passed ? "通过" : "未通过"}`,
      });
      broadcast("audit:complete", { bookId: id, chapter: chapterNum, passed: result.passed });
      return c.json(result);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (isOperationAbortError(e)) {
        clearOperation(operationKey, { status: "cancelled", message: "用户已停止当前生成。" });
        broadcast("audit:error", { bookId: id, error: "用户已停止当前生成。" });
        return c.json({ error: "用户已停止当前生成。" }, 400);
      }
      clearOperation(operationKey, { status: "error", message: `《${id}》第 ${chapterNum} 章审计失败：${msg}`, error: msg });
      broadcast("audit:error", { bookId: id, error: msg });
      return c.json({ error: msg }, 500);
    }
  });

  // --- Revise ---

  app.post("/api/v1/books/:id/revise/:chapter", async (c) => {
    const id = c.req.param("id");
    const chapterNum = parsePositiveIntegerParam(c.req.param("chapter"));
    if (chapterNum === null) {
      return c.json({ error: "Invalid chapter number" }, 400);
    }
    const bookDir = state.bookDir(id);
    const body = await c.req
      .json<{ mode?: string; brief?: string }>()
      .catch(() => ({ mode: "spot-fix", brief: undefined }));

    broadcast("revise:start", { bookId: id, chapter: chapterNum });
    serverLog("info", "revise", `开始修订书籍 ${id} 第 ${chapterNum} 章`);
    const operationKey = `revise:${id}:${chapterNum}`;
    setOperation(operationKey, {
      type: "revise",
      bookId: id,
      chapter: chapterNum,
      label: "章节修订",
      message: `正在修订《${id}》第 ${chapterNum} 章，保留原剧情并优化表达。`,
    });
    const operationController = createOperationController(operationKey);
    try {
      const book = await state.loadBookConfig(id);
      const chaptersDir = join(bookDir, "chapters");
      const match = await findChapterMarkdownFile(chaptersDir, chapterNum);
      if (!match) {
        clearOperation(operationKey, { status: "error", message: "Chapter not found", error: "Chapter not found" });
        return c.json({ error: "Chapter not found" }, 404);
      }

      const pipeline = new PipelineRunner(await buildPipelineConfig({
        externalContext: body.brief,
        bookId: id,
        signal: operationController.signal,
      }));
      const normalizedMode = body.mode ?? "spot-fix";
      const result = await pipeline.reviseDraft(
        id,
        chapterNum,
        normalizedMode as "polish" | "rewrite" | "rework" | "spot-fix" | "anti-detect",
      );
      const completionMessage = `书籍 ${id} 第 ${chapterNum} 章修订完成`;
      serverLog("info", "revise", completionMessage);
      refreshDerivedFoundationFilesAfterSuccess(id);
      clearOperation(operationKey, { status: "completed", message: completionMessage });
      broadcast("revise:complete", { bookId: id, chapter: chapterNum });
      return c.json(result);
    } catch (e) {
      if (isOperationAbortError(e)) {
        clearOperation(operationKey, { status: "cancelled", message: "用户已停止当前生成。" });
        serverLog("warn", "revise", `书籍 ${id} 第 ${chapterNum} 章修订已停止`);
        broadcast("revise:error", { bookId: id, error: "用户已停止当前生成。" });
        return c.json({ error: "用户已停止当前生成。" }, 400);
      }
      const msg = e instanceof Error ? e.message : String(e);
      const errorMessage = `书籍 ${id} 第 ${chapterNum} 章修订失败: ${msg}`;
      clearOperation(operationKey, { status: "error", message: errorMessage, error: msg });
      serverLog("error", "revise", errorMessage);
      broadcast("revise:error", { bookId: id, error: msg });
      return c.json({ error: msg }, 500);
    }
  });

  // --- AIGC Detection ---

  app.post("/api/v1/books/:id/detect/:chapter", async (c) => {
    const id = c.req.param("id");
    const chapterNum = parsePositiveIntegerParam(c.req.param("chapter"));
    if (chapterNum === null) {
      return c.json({ error: "Invalid chapter number" }, 400);
    }
    const bookDir = state.bookDir(id);

    try {
      const chaptersDir = join(bookDir, "chapters");
      const match = await findChapterMarkdownFile(chaptersDir, chapterNum);
      if (!match) return c.json({ error: "Chapter not found" }, 404);

      const content = await readFile(join(chaptersDir, match), "utf-8");
      const { analyzeAITells } = await import("@actalk/inkos-core");
      const result = analyzeAITells(content);
      return c.json({ chapterNumber: chapterNum, ...result });
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  // --- Write Rewrite (specific chapter) ---

  app.post("/api/v1/books/:id/rewrite/:chapter", async (c) => {
    const id = c.req.param("id");
    const chapterNum = parsePositiveIntegerParam(c.req.param("chapter"));
    if (chapterNum === null) {
      return c.json({ error: "Invalid chapter number" }, 400);
    }
    const body: { brief?: string } = await c.req
      .json<{ brief?: string }>()
      .catch(() => ({}));

    broadcast("rewrite:start", { bookId: id, chapter: chapterNum });
    serverLog("info", "rewrite", `开始重写书籍 ${id} 第 ${chapterNum} 章`);

    // Track active operation for session recovery
    const operationKey = `rewrite:${id}`;
    setOperation(operationKey, {
      type: "rewrite",
      bookId: id,
      chapter: chapterNum,
      label: "章节重写",
      message: `正在回退并重写《${id}》第 ${chapterNum} 章后的内容。`,
    });
    const operationController = createOperationController(operationKey);

    try {
      const rollbackTarget = chapterNum - 1;
      const discarded = await state.rollbackToChapter(id, rollbackTarget);
      const pipeline = new PipelineRunner(await buildPipelineConfig({
        externalContext: body.brief,
        bookId: id,
        signal: operationController.signal,
      }));
      pipeline.writeNextChapter(id).then(
        (result) => {
        if (isOperationCancelled(operationKey) || operationController.signal.aborted) {
          serverLog("warn", "rewrite", `书籍 ${id} 重写结果已丢弃：任务已停止`);
          clearOperation(operationKey, { status: "cancelled", message: "用户已停止当前生成。" });
          return;
        }
          const completionMessage = `书籍 ${id} 第 ${result.chapterNumber} 章重写完成: ${result.title} (${result.wordCount} 字)`;
          serverLog("info", "rewrite", completionMessage);
          refreshDerivedFoundationFilesAfterSuccess(id);
          clearOperation(operationKey, { status: "completed", message: completionMessage });
          broadcast("rewrite:complete", { bookId: id, chapterNumber: result.chapterNumber, title: result.title, wordCount: result.wordCount });
        },
        (e) => {
          if (isOperationAbortError(e)) {
            clearOperation(operationKey, { status: "cancelled", message: "用户已停止当前生成。" });
            serverLog("warn", "rewrite", `书籍 ${id} 重写已停止`);
            broadcast("rewrite:error", { bookId: id, error: "用户已停止当前生成。" });
            return;
          }
          const msg = e instanceof Error ? e.message : String(e);
          const errorMessage = `书籍 ${id} 重写失败: ${msg}`;
          clearOperation(operationKey, { status: "error", message: errorMessage, error: msg });
          serverLog("error", "rewrite", errorMessage);
          broadcast("rewrite:error", { bookId: id, error: msg });
        },
      );
      return c.json({ status: "rewriting", bookId: id, chapter: chapterNum, rolledBackTo: rollbackTarget, discarded });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const errorMessage = `书籍 ${id} 重写失败: ${msg}`;
      clearOperation(operationKey, { status: "error", message: errorMessage, error: msg });
      serverLog("error", "rewrite", errorMessage);
      broadcast("rewrite:error", { bookId: id, error: msg });
      return c.json({ error: msg }, 500);
    }
  });

  app.post("/api/v1/books/:id/resync/:chapter", async (c) => {
    const id = c.req.param("id");
    const chapterNum = parsePositiveIntegerParam(c.req.param("chapter"));
    if (chapterNum === null) {
      return c.json({ error: "Invalid chapter number" }, 400);
    }
    const body: { brief?: string } = await c.req
      .json<{ brief?: string }>()
      .catch(() => ({}));

    try {
      const pipeline = new PipelineRunner(await buildPipelineConfig({
        externalContext: body.brief,
      }));
      const result = await pipeline.resyncChapterArtifacts(id, chapterNum);
      refreshDerivedFoundationFilesAfterSuccess(id);
      return c.json(result);
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  // --- Detect All chapters ---

  app.post("/api/v1/books/:id/detect-all", async (c) => {
    const id = c.req.param("id");
    const bookDir = state.bookDir(id);

    try {
      const chaptersDir = join(bookDir, "chapters");
      const files = await readdir(chaptersDir);
      const mdFiles = files.filter((f) => f.endsWith(".md") && /^\d{4}/.test(f)).sort();
      const { analyzeAITells } = await import("@actalk/inkos-core");

      const results = await Promise.all(
        mdFiles.map(async (f) => {
          const num = parseInt(f.slice(0, 4), 10);
          const content = await readFile(join(chaptersDir, f), "utf-8");
          const result = analyzeAITells(content);
          return { chapterNumber: num, filename: f, ...result };
        }),
      );
      return c.json({ bookId: id, results });
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  // --- Detect Stats ---

  app.get("/api/v1/books/:id/detect/stats", async (c) => {
    const id = c.req.param("id");
    try {
      const { loadDetectionHistory, analyzeDetectionInsights } = await import("@actalk/inkos-core");
      const bookDir = state.bookDir(id);
      const history = await loadDetectionHistory(bookDir);
      const insights = analyzeDetectionInsights(history);
      return c.json(insights);
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });
}
