import { randomUUID } from "node:crypto";
import { Agent } from "@mariozechner/pi-agent-core";
import type { AgentEvent, AgentMessage } from "@mariozechner/pi-agent-core";
import { streamSimple, getModel, getEnvApiKey, createAssistantMessageEventStream } from "@mariozechner/pi-ai";
import type {
  Model,
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  Context as PiContext,
  Message,
  SimpleStreamOptions,
  ToolResultMessage,
  UserMessage,
} from "@mariozechner/pi-ai";
import type { PipelineRunner } from "../pipeline/runner.js";
import { assertWithinContextWindow, estimatePiContextTokens } from "../llm/provider.js";
import { buildAgentSystemPrompt } from "./agent-system-prompt.js";
import {
  createPatchChapterTextTool,
  createReplaceChapterTextTool,
  createRenameEntityTool,
  createSubAgentTool,
  createReadTool,
  createGrepTool,
  createLsTool,
  createWriteTruthFileTool,
  createShortFictionRunTool,
  createGenerateCoverTool,
  createPlayEditTool,
  createPlayReviseTool,
  createPlayStartTool,
  createPlayStepTool,
  createProposeActionTool,
} from "./agent-tools.js";
import { createBookContextTransform } from "./context-transform.js";
import {
  appendTranscriptEvents,
  readTranscriptEvents,
} from "../interaction/session-transcript.js";
import {
  TOOL_RESULT_BRIDGE_TEXT,
  adaptRestoredAgentMessagesForModel,
  appendRestoredHistoryBoundary,
  restoreAgentMessagesFromTranscript,
} from "../interaction/session-transcript-restore.js";
import type { TranscriptEvent, TranscriptRole } from "../interaction/session-transcript-schema.js";
import type { PlayMode, SessionKind } from "../interaction/session.js";
import type { ActionPayload, ActionSource, RequestedIntent } from "../interaction/action-envelope.js";
import type { ContextCompressionCallback } from "../models/context-compression.js";
import { assertSafeBookId } from "../utils/book-id.js";
import { PlayStore } from "../play/play-store.js";

const INKOS_AGENT_USER_AGENT = "InkOS Agent Client";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentRequestDiagnostics {
  readonly provider: string;
  readonly model: string;
  readonly api: string;
  readonly baseUrl?: string;
  readonly stream: true;
  readonly maxTokens: number;
  readonly systemChars: number;
  readonly messageCount: number;
  readonly promptChars: number;
}

export interface AgentSessionConfig {
  /** Unique session identifier (typically the BookSession id). */
  sessionId: string;
  /** Book ID, or null if in "new book" mode. */
  bookId: string | null;
  /** Studio conversation surface. Used to narrow the visible tools. */
  sessionKind?: SessionKind;
  /** Play interaction mode chosen by the player at launch (guided = choice-only, open = free text). */
  playMode?: PlayMode;
  /** Where this turn came from. Button/slash turns can execute confirmed production actions. */
  actionSource?: ActionSource;
  /** Explicit user-confirmed action requested by the UI/command surface. */
  requestedIntent?: RequestedIntent;
  /** Structured execution arguments confirmed by the UI/command surface. */
  actionPayload?: ActionPayload;
  /** Language for the system prompt. */
  language: string;
  /** PipelineRunner for sub-agent tool delegation. */
  pipeline: PipelineRunner;
  /** Project root directory (books/ lives under this). */
  projectRoot: string;
  /** pi-ai Model to use, or provider+modelId to resolve via getModel. */
  model: Model<Api> | { provider: string; modelId: string };
  /** Optional API key. When omitted, falls back to env-based key lookup. */
  apiKey?: string;
  /** Allow the read tool to read absolute paths outside projectRoot/books. Defaults to false; set INKOS_AGENT_ALLOW_SYSTEM_READ=1 to enable. */
  allowSystemFileRead?: boolean;
  /** Optional listener for streaming events (for SSE forwarding). */
  onEvent?: (event: AgentEvent) => void;
  /** Optional listener for context compression lifecycle events. */
  onContextCompression?: ContextCompressionCallback;
  /** Extra HTTP headers for the model request made by the official agent stream. */
  requestHeaders?: Record<string, string>;
  /** Optional diagnostics for model requests made by the official agent stream. */
  onRequestDiagnostics?: (diagnostics: AgentRequestDiagnostics) => void;
}

export interface AgentSessionResult {
  /** Extracted text from the final assistant message. */
  responseText: string;
  /** Full raw Agent conversation history. */
  messages: AgentMessage[];
  /** Upstream model error surfaced by pi-agent-core, if the final assistant turn failed. */
  errorMessage?: string;
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

interface CachedAgent {
  agent: Agent;
  sessionId: string;
  projectRoot: string;
  bookId: string | null;
  sessionKind: SessionKind;
  actionSource: NonNullable<AgentSessionConfig["actionSource"]>;
  requestedIntent: AgentSessionConfig["requestedIntent"];
  actionPayloadKey: string;
  playWorldExists: boolean;
  language: string;
  modelIdentity: string;
  apiKey: string | undefined;
  allowSystemFileRead: boolean;
  lastCommittedSeq: number;
  lastActive: number;
}

const agentCache = new Map<string, CachedAgent>();
const agentSessionQueues = new Map<string, Promise<void>>();

/** TTL for cached agents: 5 minutes. */
const CACHE_TTL_MS = 5 * 60 * 1000;

const EMPTY_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** Cleanup interval handle (lazy-started). */
let cleanupTimer: ReturnType<typeof setInterval> | null = null;

function ensureCleanupTimer(): void {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [id, entry] of agentCache) {
      if (now - entry.lastActive > CACHE_TTL_MS) {
        agentCache.delete(id);
      }
    }
    // Stop the timer when nothing left to watch.
    if (agentCache.size === 0 && cleanupTimer) {
      clearInterval(cleanupTimer);
      cleanupTimer = null;
    }
  }, 60_000); // run every 60 s
  // Allow the process to exit even if this timer is alive.
  if (cleanupTimer && typeof cleanupTimer === "object" && "unref" in cleanupTimer) {
    cleanupTimer.unref();
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveModel(spec: AgentSessionConfig["model"]): Model<Api> {
  if (!spec) {
    throw new Error("Model is required but was undefined. Check LLM configuration.");
  }
  if (typeof spec === "object" && "id" in spec && "api" in spec) {
    // Already a Model object.
    return spec as Model<Api>;
  }
  const { provider, modelId } = spec as { provider: string; modelId: string };
  if (!provider || !modelId) {
    throw new Error(`Invalid model spec: provider=${provider}, modelId=${modelId}`);
  }
  return getModel(provider as any, modelId as any);
}

function envFlagEnabled(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined) return defaultValue;
  if (value === "1" || value.toLowerCase() === "true") return true;
  if (value === "0" || value.toLowerCase() === "false") return false;
  return defaultValue;
}

function agentModelIdentity(model: Model<Api>): string {
  return [
    model.api,
    model.provider,
    model.baseUrl ?? "",
    model.id,
  ].join("::");
}

function actionPayloadCacheKey(payload: ActionPayload | undefined): string {
  return payload ? JSON.stringify(payload) : "";
}

function sessionQueueKey(projectRoot: string, sessionId: string): string {
  return `${projectRoot}\0${sessionId}`;
}

function agentCacheKey(projectRoot: string, sessionId: string): string {
  return sessionQueueKey(projectRoot, sessionId);
}

function mergeAgentRequestHeaders(
  modelHeaders?: Record<string, string>,
  optionHeaders?: Record<string, string>,
  requestHeaders?: Record<string, string>,
): Record<string, string> {
  return {
    ...(modelHeaders ?? {}),
    ...(optionHeaders ?? {}),
    ...(requestHeaders ?? {}),
    "User-Agent": INKOS_AGENT_USER_AGENT,
  };
}

function textLengthFromPiMessage(message: Message): number {
  const content = (message as any).content;
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) return 0;
  return content.reduce((sum, part) => {
    if (typeof part?.text === "string") return sum + part.text.length;
    if (typeof part?.content === "string") return sum + part.content.length;
    return sum;
  }, 0);
}

function guardedStreamSimple<TApi extends Api>(
  model: Model<TApi>,
  context: PiContext,
  options?: SimpleStreamOptions,
  requestHeaders?: Record<string, string>,
  onRequestDiagnostics?: (diagnostics: AgentRequestDiagnostics) => void,
): AssistantMessageEventStream {
  const reservedOutputTokens = Number.isFinite(options?.maxTokens)
    ? options!.maxTokens!
    : Number.isFinite(model.maxTokens)
      ? model.maxTokens
      : 4096;
  const systemChars = typeof context.systemPrompt === "string" ? context.systemPrompt.length : 0;
  const messageChars = context.messages.reduce((sum, message) => sum + textLengthFromPiMessage(message), 0);
  onRequestDiagnostics?.({
    provider: String(model.provider),
    model: String(model.id),
    api: String(model.api),
    ...(typeof (model as any).baseUrl === "string" ? { baseUrl: (model as any).baseUrl } : {}),
    stream: true,
    maxTokens: reservedOutputTokens,
    systemChars,
    messageCount: context.messages.length,
    promptChars: systemChars + messageChars,
  });
  const nextOptions = {
    ...(options ?? {}),
    headers: mergeAgentRequestHeaders(
      (model as any).headers,
      (options as any)?.headers,
      requestHeaders,
    ),
  } as SimpleStreamOptions;
  assertWithinContextWindow({
    piModel: model,
    model: model.id,
    estimatedInputTokens: estimatePiContextTokens(context),
    reservedOutputTokens,
  });
  return streamSimple(model, context, nextOptions);
}

function localAssistantStopStream(model: Model<Api>): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  const message: AssistantMessage = {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: EMPTY_USAGE,
    stopReason: "stop",
    timestamp: Date.now(),
  };
  queueMicrotask(() => {
    stream.push({ type: "done", reason: "stop", message });
    stream.end(message);
  });
  return stream;
}

function isTerminalProductionToolName(toolName: unknown): boolean {
  return toolName === "propose_action"
    || toolName === "sub_agent"
    || toolName === "short_fiction_run"
    || toolName === "generate_cover"
    || toolName === "play_start"
    || toolName === "play_edit"
    || toolName === "play_revise"
    || toolName === "play_step";
}

function hasUnansweredTerminalToolResult(messages: AgentMessage[]): boolean {
  let assistantTextAfterTool = false;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || typeof message !== "object" || !("role" in message)) continue;
    const role = (message as { role?: unknown }).role;
    if (role === "user") return false;
    if (role === "assistant") {
      const text = extractTextFromAssistant(message as AssistantMessage).trim();
      if (text) assistantTextAfterTool = true;
      continue;
    }
    if (role !== "toolResult") continue;
    const toolName = (message as { toolName?: unknown }).toolName;
    const isError = (message as { isError?: unknown }).isError;
    if (isTerminalProductionToolName(toolName) && isError !== true) {
      return !assistantTextAfterTool;
    }
  }
  return false;
}

async function runInAgentSessionQueue<T>(
  projectRoot: string,
  sessionId: string,
  task: () => Promise<T>,
): Promise<T> {
  const key = sessionQueueKey(projectRoot, sessionId);
  const previous = agentSessionQueues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.catch(() => undefined).then(() => gate);
  agentSessionQueues.set(key, queued);

  await previous.catch(() => undefined);
  try {
    return await task();
  } finally {
    release();
    if (agentSessionQueues.get(key) === queued) {
      agentSessionQueues.delete(key);
    }
  }
}

async function latestCommittedSeq(projectRoot: string, sessionId: string): Promise<number> {
  const events = await readTranscriptEvents(projectRoot, sessionId);
  return events
    .filter((event) => event.type === "request_committed")
    .reduce((max, event) => Math.max(max, event.seq), 0);
}

function transcriptRoleForMessage(message: AgentMessage): TranscriptRole | null {
  if (!message || typeof message !== "object" || !("role" in message)) return null;
  const role = (message as { role?: unknown }).role;
  return role === "user" || role === "assistant" || role === "toolResult" || role === "system"
    ? role
    : null;
}

function firstToolCallId(message: AgentMessage): string | undefined {
  if (!message || typeof message !== "object" || !("content" in message)) return undefined;
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return undefined;
  const block = content.find(
    (item): item is { type: "toolCall"; id: string } =>
      !!item &&
      typeof item === "object" &&
      (item as { type?: unknown }).type === "toolCall" &&
      typeof (item as { id?: unknown }).id === "string",
  );
  return block?.id;
}

function toolCallIdForMessage(message: AgentMessage): string | undefined {
  if (!message || typeof message !== "object") return undefined;
  if ((message as { role?: unknown }).role === "toolResult") {
    const toolCallId = (message as { toolCallId?: unknown }).toolCallId;
    return typeof toolCallId === "string" && toolCallId.length > 0 ? toolCallId : undefined;
  }
  return firstToolCallId(message);
}

function messageTimestamp(message: AgentMessage): number {
  if (message && typeof message === "object") {
    const timestamp = (message as { timestamp?: unknown }).timestamp;
    if (typeof timestamp === "number" && Number.isFinite(timestamp) && timestamp >= 0) {
      return Math.floor(timestamp);
    }
  }
  return Date.now();
}

async function ensureSessionCreatedEvent(
  projectRoot: string,
  sessionId: string,
  bookId: string | null,
  sessionKind?: SessionKind,
): Promise<void> {
  await appendTranscriptEvents(projectRoot, sessionId, ({ events, nextSeq }) => {
    if (events.some((event) => event.type === "session_created")) return [];

    const now = Date.now();
    return [{
      type: "session_created",
      version: 1,
      sessionId,
      seq: nextSeq,
      timestamp: now,
      bookId,
      ...(sessionKind ? { sessionKind } : {}),
      title: null,
      createdAt: now,
      updatedAt: now,
    }];
  });
}

async function appendAgentTranscriptEvent(
  projectRoot: string,
  sessionId: string,
  buildEvent: (seq: number) => TranscriptEvent,
): Promise<TranscriptEvent> {
  const events = await appendTranscriptEvents(projectRoot, sessionId, ({ nextSeq }) => [
    buildEvent(nextSeq),
  ]);
  const event = events[0];
  if (!event) throw new Error(`Failed to append transcript event for session "${sessionId}"`);
  return event;
}

/**
 * Extract readable text from an AssistantMessage's content array.
 * Filters out tool-call blocks; concatenates text blocks.
 */
function extractTextFromAssistant(msg: AssistantMessage): string {
  return msg.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("");
}

function looksLikeUnsavedChapterProse(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 800) return false;
  return /(^|\n)\s{0,3}#{1,3}\s*(?:第\s*[0-9一二三四五六七八九十百千]+\s*章|Chapter\s+\d+)/i.test(trimmed);
}

function bookRawChapterBoundaryText(language: string): string {
  return language === "zh"
    ? "这次模型输出了章节正文样式的聊天文本，但没有落盘。写下一章必须调用 sub_agent(agent=\"writer\")，由写作管线生成并保存章节。请重新发送“继续写下一章”，系统会走 writer 工具。"
    : "The model produced chapter-like prose in chat, but nothing was saved. Writing the next chapter must call sub_agent(agent=\"writer\") so the writing pipeline generates and persists it. Please ask to continue again and the system will use the writer tool.";
}

function replaceAssistantText(message: AssistantMessage, text: string): void {
  message.content = [{ type: "text", text }];
  message.stopReason = "stop";
  delete message.errorMessage;
}

function lastAssistantMessage(messages: AgentMessage[]): AssistantMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg && typeof msg === "object" && "role" in msg && (msg as { role?: unknown }).role === "assistant") {
      return msg as AssistantMessage;
    }
  }
  return undefined;
}

function assistantErrorMessage(message: AssistantMessage | undefined): string | undefined {
  return message &&
    (message.stopReason === "error" || message.stopReason === "aborted") &&
    message.errorMessage
      ? message.errorMessage
      : undefined;
}

function convertAgentMessagesForModel(messages: AgentMessage[], model: Model<Api>): Message[] {
  const llmMessages = messages.flatMap((message): Message[] => {
    if (!message || typeof message !== "object" || !("role" in message)) return [];
    const raw = message as { role?: unknown; content?: unknown };
    if (raw.role === "user" || raw.role === "assistant" || raw.role === "toolResult") {
      return [message as Message];
    }
    if (raw.role === "system" && typeof raw.content === "string") {
      return [{
        role: "user",
        content: raw.content,
        timestamp: messageTimestamp(message),
      }];
    }
    return [];
  });

  const candidate = model as { api?: unknown; baseUrl?: unknown };
  // InkOS's internal `toolResult` role is not part of the OpenAI Chat Completions spec.
  // Many openai-completions upstreams (Google, and kkaiapi/DeepSeek-Pro-style gateways) reject
  // it outright — which surfaces as an opaque "503 provider temporarily unavailable" — so fold
  // tool results into a plain user message for EVERY openai-completions endpoint, not just Google.
  // Anthropic-format endpoints (MiniMax / 百炼) handle tool results natively and are left untouched.
  const isOpenAICompletionsCompatible = candidate.api === "openai-completions";
  if (!isOpenAICompletionsCompatible) return llmMessages;

  const converted: Message[] = [];
  const pushToolResultsAsUser = (toolResults: ToolResultMessage[]) => {
    const lines = toolResults.flatMap((result) => {
      const content = result.content
        .map((block) => block.type === "text" ? block.text : "[image]")
        .filter(Boolean)
        .join("\n")
        .trim() || "(empty tool result)";
      return [`- ${result.toolName} (${result.toolCallId}):`, content];
    });
    converted.push({
      role: "user",
      content: [
        "[Tool results]",
        ...lines,
        "Use these tool results to answer the active user request. If a tool failed, explain the failure and choose the next useful action.",
      ].join("\n"),
      timestamp: toolResults.reduce(
        (max, result) => Math.max(max, messageTimestamp(result as AgentMessage)),
        0,
      ) || Date.now(),
    });
  };

  for (let i = 0; i < llmMessages.length; i++) {
    const message = llmMessages[i];

    if (message.role === "assistant") {
      const textContent = message.content.filter(
        (block): block is { type: "text"; text: string } =>
          block.type === "text" && typeof block.text === "string" && block.text.trim().length > 0,
      );
      if (
        textContent.length === 1 &&
        message.content.length === 1 &&
        textContent[0].text.trim() === TOOL_RESULT_BRIDGE_TEXT
      ) {
        continue;
      }

      const toolCallIds = new Set<string>();
      for (const block of message.content) {
        if (block.type === "toolCall" && typeof block.id === "string" && block.id.length > 0) {
          toolCallIds.add(block.id);
        }
      }
      if (toolCallIds.size === 0) {
        converted.push(message);
        continue;
      }

      if (textContent.length > 0) {
        converted.push({ ...message, content: textContent });
      }

      const toolResults: ToolResultMessage[] = [];
      let nextIndex = i + 1;
      while (nextIndex < llmMessages.length) {
        const next = llmMessages[nextIndex];
        if (next.role !== "toolResult" || !toolCallIds.has(next.toolCallId)) break;
        toolResults.push(next);
        nextIndex += 1;
      }

      if (toolResults.length > 0) {
        pushToolResultsAsUser(toolResults);
        i = nextIndex - 1;
      }
      continue;
    }

    if (message.role === "toolResult") {
      pushToolResultsAsUser([message]);
      continue;
    }

    converted.push(message);
  }

  return converted;
}

/**
 * Extract thinking/reasoning text from an AssistantMessage's content array.
 */
function extractThinkingFromAssistant(msg: AssistantMessage): string {
  return msg.content
    .filter((c: any) => c.type === "thinking")
    .map((c: any) => c.thinking ?? "")
    .join("");
}

/**
 * Convert plain `{ role, content }` messages (from BookSession disk storage)
 * back into pi-agent AgentMessage format so they can be loaded into an Agent.
 */
function plainToAgentMessages(
  plain: Array<{ role: string; content: string }>,
): AgentMessage[] {
  return plain.map((m) => {
    const ts = Date.now();
    if (m.role === "user") {
      return { role: "user", content: m.content, timestamp: ts } satisfies UserMessage;
    }
    // For stored assistant messages we only have the text.
    // Re-wrap as a minimal AssistantMessage with a single TextContent.
    return {
      role: "assistant",
      content: [{ type: "text", text: m.content }],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "unknown",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop",
      timestamp: ts,
    } satisfies AssistantMessage;
  });
}

/**
 * Flatten the Agent's in-memory messages to plain `{ role, content }` pairs
 * suitable for BookSession persistence.
 */
function agentMessagesToPlain(
  messages: AgentMessage[],
): Array<{ role: string; content: string; thinking?: string }> {
  const out: Array<{ role: string; content: string; thinking?: string }> = [];
  for (const msg of messages) {
    if (!msg || typeof msg !== "object" || !("role" in msg)) continue;

    const m = msg as { role: string; [k: string]: any };

    if (m.role === "user") {
      const content = typeof m.content === "string"
        ? m.content
        : Array.isArray(m.content)
          ? m.content
              .filter((c: any) => c.type === "text")
              .map((c: any) => c.text)
              .join("")
          : "";
      if (content) out.push({ role: "user", content });
    } else if (m.role === "assistant") {
      const text = extractTextFromAssistant(m as AssistantMessage);
      const thinking = extractThinkingFromAssistant(m as AssistantMessage);
      if (text || thinking) {
        const entry: { role: string; content: string; thinking?: string } = { role: "assistant", content: text };
        if (thinking) entry.thinking = thinking;
        out.push(entry);
      }
    }
    // ToolResult messages are internal; skip them for persistence.
  }
  return out;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

function createAgentToolsForMode(params: {
  readonly pipeline: PipelineRunner;
  readonly bookId: string | null;
  readonly sessionId: string;
  readonly sessionKind: SessionKind;
  readonly actionSource: NonNullable<AgentSessionConfig["actionSource"]>;
  readonly requestedIntent: AgentSessionConfig["requestedIntent"];
  readonly actionPayload: AgentSessionConfig["actionPayload"];
  readonly projectRoot: string;
  readonly allowSystemFileRead: boolean;
  readonly language: string;
  readonly playMode?: "open" | "guided";
  readonly playWorldExists: boolean;
}) {
  const subAgentTool = createSubAgentTool(params.pipeline, params.bookId, params.projectRoot, { actionPayload: params.actionPayload });
  const lang = params.language === "en" ? "en" : "zh";
  const proposalTool = createProposeActionTool(lang, {
    sameSession: params.sessionKind !== "chat",
  });
  const isConfirmed = (
    intent: NonNullable<AgentSessionConfig["requestedIntent"]>,
  ): boolean => {
    return (params.actionSource === "button" || params.actionSource === "slash")
      && params.requestedIntent === intent;
  };

  if (params.sessionKind === "chat") {
    return [proposalTool];
  }

  if (params.sessionKind === "short") {
    if (isConfirmed("short_run")) {
      return [createShortFictionRunTool(params.pipeline, params.projectRoot, { actionPayload: params.actionPayload })];
    }
    if (isConfirmed("generate_cover")) {
      return [createGenerateCoverTool(params.projectRoot, { actionPayload: params.actionPayload })];
    }
    return [proposalTool];
  }

  if (params.sessionKind === "play") {
    if (isConfirmed("play_start")) {
      return [createPlayStartTool(params.pipeline, params.projectRoot, params.sessionId, params.playMode, { actionPayload: params.actionPayload })];
    }
    if (params.playWorldExists) {
      return [
        createPlayEditTool(params.projectRoot, params.sessionId),
        createPlayReviseTool(params.pipeline, params.projectRoot, params.sessionId),
        createPlayStepTool(params.pipeline, params.projectRoot, params.sessionId, {
          playMode: params.playMode,
        }),
      ];
    }
    return [proposalTool];
  }

  if (params.sessionKind === "book-create" && !params.bookId) {
    if (isConfirmed("create_book")) {
      return [createSubAgentTool(params.pipeline, params.bookId, params.projectRoot, {
        actionPayload: params.actionPayload,
        architectCreateOnly: true,
      })];
    }
    return [proposalTool];
  }

  if (!params.bookId) {
    return [];
  }

  const bookTools = [
    subAgentTool,
    createGenerateCoverTool(params.projectRoot, { actionPayload: params.actionPayload }),
    createReadTool(params.projectRoot, { allowSystemPaths: params.allowSystemFileRead }),
    createWriteTruthFileTool(params.pipeline, params.projectRoot, params.bookId),
    createRenameEntityTool(params.pipeline, params.projectRoot, params.bookId),
    createPatchChapterTextTool(params.pipeline, params.projectRoot, params.bookId),
    createReplaceChapterTextTool(params.pipeline, params.projectRoot, params.bookId),
    createGrepTool(params.projectRoot),
    createLsTool(params.projectRoot),
  ];

  if (params.sessionKind === "edit") {
    return bookTools.filter((tool) => tool.name !== "sub_agent" && tool.name !== "generate_cover");
  }

  return bookTools;
}

/**
 * Run a single conversation turn within a cached Agent session.
 *
 * If the session already exists in the cache, reuses the Agent (with its full
 * in-memory message history including tool calls). Otherwise creates a new
 * Agent, optionally restoring messages from `initialMessages`.
 */
export async function runAgentSession(
  config: AgentSessionConfig,
  userMessage: string,
  initialMessages?: Array<{ role: string; content: string }>,
): Promise<AgentSessionResult> {
  return runInAgentSessionQueue(config.projectRoot, config.sessionId, () =>
    runAgentSessionUnlocked(config, userMessage, initialMessages)
  );
}

async function runAgentSessionUnlocked(
  config: AgentSessionConfig,
  userMessage: string,
  initialMessages?: Array<{ role: string; content: string }>,
): Promise<AgentSessionResult> {
  const { sessionId, language, pipeline, projectRoot, onEvent, onContextCompression } = config;
  // Normalize at the entry point so downstream comparisons, closures, and
  // fs paths never see `undefined`. The type is already `string | null`, but
  // some callers may bypass the type system (e.g. `activeBookId ?? null` gets
  // skipped) and we don't want that to (a) throw in path.join or (b) trigger
  // a spurious cache eviction because `null !== undefined`.
  const bookId: string | null = config.bookId ? assertSafeBookId(config.bookId) : null;
  const sessionKind: SessionKind = config.sessionKind ?? (bookId ? "book" : "chat");
  const playMode = config.playMode;
  const actionSource = config.actionSource ?? "free-text";
  const requestedIntent = config.requestedIntent;
  const actionPayload = config.actionPayload;
  const actionPayloadKey = actionPayloadCacheKey(actionPayload);
  const model = resolveModel(config.model);
  const requestedModelIdentity = agentModelIdentity(model);
  const allowSystemFileRead = config.allowSystemFileRead ?? envFlagEnabled(process.env.INKOS_AGENT_ALLOW_SYSTEM_READ, false);
  const playWorldExists = sessionKind === "play"
    ? Boolean(await new PlayStore(projectRoot).loadWorld(sessionId))
    : false;
  const cacheKey = agentCacheKey(projectRoot, sessionId);

  // ----- Resolve or create Agent -----
  let cached = agentCache.get(cacheKey);
  let currentCommittedSeq: number | undefined;

  if (cached) {
    currentCommittedSeq = await latestCommittedSeq(projectRoot, sessionId);
    // Evict and rebuild if model protocol identity OR bookId changed. Both are
    // captured into the Agent at construction time (model via initialState,
    // bookId via closures in systemPrompt / tools / transformContext), so a
    // mismatch means the cached Agent would keep using stale context.
    const modelChanged = cached.modelIdentity !== requestedModelIdentity;
    const projectRootChanged = cached.projectRoot !== projectRoot;
    const bookChanged = cached.bookId !== bookId;
    const sessionKindChanged = cached.sessionKind !== sessionKind;
    const actionSourceChanged = cached.actionSource !== actionSource;
    const requestedIntentChanged = cached.requestedIntent !== requestedIntent;
    const actionPayloadChanged = cached.actionPayloadKey !== actionPayloadKey;
    const languageChanged = cached.language !== language;
    const apiKeyChanged = cached.apiKey !== config.apiKey;
    const readPermissionChanged = cached.allowSystemFileRead !== allowSystemFileRead;
    const playWorldChanged = cached.playWorldExists !== playWorldExists;
    const transcriptChanged = cached.lastCommittedSeq !== currentCommittedSeq;

    if (
      modelChanged ||
      projectRootChanged ||
      bookChanged ||
      sessionKindChanged ||
      actionSourceChanged ||
      requestedIntentChanged ||
      actionPayloadChanged ||
      languageChanged ||
      apiKeyChanged ||
      readPermissionChanged ||
      playWorldChanged ||
      transcriptChanged
    ) {
      agentCache.delete(cacheKey);
      cached = undefined;
    }
  }

  if (!cached) {
    const restoredHistory = await restoreAgentMessagesFromTranscript(projectRoot, sessionId, sessionKind);
    if (restoredHistory.length > 0) {
      onContextCompression?.({
        category: "session_context",
        phase: "start",
        sources: ["session transcript"],
      });
      onContextCompression?.({
        category: "session_context",
        phase: "end",
        sources: ["session transcript"],
      });
    }
    const restoredMessages = appendRestoredHistoryBoundary(
      adaptRestoredAgentMessagesForModel(
        restoredHistory,
        model,
      ),
      language,
    );
    const initialAgentMessages = restoredMessages.length > 0
      ? restoredMessages
      : initialMessages && initialMessages.length > 0
        ? plainToAgentMessages(initialMessages)
        : [];
    let terminalToolResultTail = false;
    const agent = new Agent({
      initialState: {
        model,
        systemPrompt: buildAgentSystemPrompt(bookId, language, sessionKind, { actionSource, requestedIntent, playWorldExists }),
        tools: createAgentToolsForMode({
          pipeline,
          bookId,
          sessionId,
          sessionKind,
          actionSource,
          requestedIntent,
          actionPayload,
          projectRoot,
          allowSystemFileRead,
          language,
          playMode,
          playWorldExists,
        }),
        messages: initialAgentMessages,
      },
      transformContext: createBookContextTransform(bookId, projectRoot, { onContextCompression }),
      convertToLlm: (messages) => {
        terminalToolResultTail = hasUnansweredTerminalToolResult(messages);
        return convertAgentMessagesForModel(messages, model);
      },
      streamFn: (streamModel, context, options) => {
        if (terminalToolResultTail) {
          terminalToolResultTail = false;
          return localAssistantStopStream(streamModel);
        }
        return guardedStreamSimple(streamModel, context, options, config.requestHeaders, config.onRequestDiagnostics);
      },
      getApiKey: (provider: string) => {
        if (config.apiKey) return config.apiKey;
        return getEnvApiKey(provider);
      },
    });

    cached = {
      agent,
      sessionId,
      projectRoot,
      bookId,
      sessionKind,
      actionSource,
      requestedIntent,
      actionPayloadKey,
      playWorldExists,
      language,
      modelIdentity: requestedModelIdentity,
      apiKey: config.apiKey,
      allowSystemFileRead,
      lastCommittedSeq: currentCommittedSeq ?? await latestCommittedSeq(projectRoot, sessionId),
      lastActive: Date.now(),
    };
    agentCache.set(cacheKey, cached);
    ensureCleanupTimer();
  }

  cached.lastActive = Date.now();
  const { agent } = cached;

  // ----- Prepare transcript persistence -----
  const requestId = randomUUID();
  await ensureSessionCreatedEvent(projectRoot, sessionId, bookId, sessionKind);
  await appendAgentTranscriptEvent(projectRoot, sessionId, (seq) => ({
    type: "request_started",
    version: 1,
    sessionId,
    requestId,
    seq,
    timestamp: Date.now(),
    sessionKind,
    input: userMessage,
  }));

  let parentUuid: string | null = null;
  let piTurnIndex = 0;
  let lastAssistantUuid: string | null = null;
  let successfulProductionToolResultSeen = false;

  const persistAgentEvent = async (event: AgentEvent): Promise<void> => {
    if (event.type === "turn_start") {
      piTurnIndex += 1;
      return;
    }
    if (event.type !== "message_end") return;

    const role = transcriptRoleForMessage(event.message);
    if (!role) return;

    if (role === "toolResult") {
      const toolName = (event.message as { toolName?: unknown }).toolName;
      const isError = (event.message as { isError?: unknown }).isError;
      if (isTerminalProductionToolName(toolName) && isError !== true) {
        successfulProductionToolResultSeen = true;
      }
    }

    if (role === "assistant" && sessionKind === "book" && !successfulProductionToolResultSeen) {
      const assistant = event.message as AssistantMessage;
      if (looksLikeUnsavedChapterProse(extractTextFromAssistant(assistant))) {
        replaceAssistantText(assistant, bookRawChapterBoundaryText(language));
      }
    }

    const uuid = randomUUID();
    const isToolResult = role === "toolResult";
    const toolCallId = toolCallIdForMessage(event.message);
    await appendAgentTranscriptEvent(projectRoot, sessionId, (seq) => ({
      type: "message",
      version: 1,
      sessionId,
      requestId,
      uuid,
      parentUuid: isToolResult && lastAssistantUuid ? lastAssistantUuid : parentUuid,
      seq,
      role,
      timestamp: messageTimestamp(event.message),
      piTurnIndex,
      ...(toolCallId ? { toolCallId } : {}),
      ...(isToolResult && lastAssistantUuid
        ? { sourceToolAssistantUuid: lastAssistantUuid }
        : {}),
      message: event.message,
    }));

    if (role === "assistant") lastAssistantUuid = uuid;
    parentUuid = uuid;
  };

  // ----- Subscribe to events (transcript persistence + SSE forwarding) -----
  const unsubscribe = agent.subscribe(async (event: AgentEvent) => {
    await persistAgentEvent(event);
    onEvent?.(event);
  });

  // ----- Execute the turn -----
  let finalAssistant: AssistantMessage | undefined;
  let errorMessage: string | undefined;

  try {
    await agent.prompt(userMessage);

    finalAssistant = lastAssistantMessage(agent.state.messages);
    errorMessage = assistantErrorMessage(finalAssistant);
    if (errorMessage) {
      const failedError = errorMessage;
      await appendAgentTranscriptEvent(projectRoot, sessionId, (seq) => ({
        type: "request_failed",
        version: 1,
        sessionId,
        requestId,
        seq,
        timestamp: Date.now(),
        error: failedError,
      }));
      agentCache.delete(cacheKey);
    } else {
      const committed = await appendAgentTranscriptEvent(projectRoot, sessionId, (seq) => ({
        type: "request_committed",
        version: 1,
        sessionId,
        requestId,
        seq,
        timestamp: Date.now(),
      }));
      cached.lastCommittedSeq = committed.seq;
    }
  } catch (error) {
    await appendAgentTranscriptEvent(projectRoot, sessionId, (seq) => ({
      type: "request_failed",
      version: 1,
      sessionId,
      requestId,
      seq,
      timestamp: Date.now(),
      error: error instanceof Error ? error.message : String(error),
    }));
    agentCache.delete(cacheKey);
    throw error;
  } finally {
    unsubscribe();
  }

  // ----- Extract result -----
  const allMessages = agent.state.messages;
  finalAssistant ??= lastAssistantMessage(allMessages);
  const responseText = finalAssistant ? extractTextFromAssistant(finalAssistant) : "";
  errorMessage ??= assistantErrorMessage(finalAssistant);

  return {
    responseText,
    messages: allMessages.slice(),
    ...(errorMessage ? { errorMessage } : {}),
  };
}

// ---------------------------------------------------------------------------
// Cache management
// ---------------------------------------------------------------------------

/** Manually evict a cached Agent session. */
export function evictAgentCache(sessionId: string): boolean {
  let deleted = agentCache.delete(sessionId);
  for (const [key, entry] of agentCache) {
    if (entry.sessionId !== sessionId) continue;
    agentCache.delete(key);
    deleted = true;
  }
  return deleted;
}
