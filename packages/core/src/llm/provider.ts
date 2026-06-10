import type { LLMConfig } from "../models/project.js";
import {
  streamSimple as piStreamSimple,
  stream as piStream,
  completeSimple as piCompleteSimple,
  complete as piComplete,
} from "@mariozechner/pi-ai";
import type {
  Api as PiApi,
  Model as PiModel,
  Context as PiContext,
  AssistantMessageEvent,
  Tool as PiTool,
  TextContent as PiTextContent,
  ToolCall as PiToolCall,
} from "@mariozechner/pi-ai";
import { resolveServicePreset } from "./service-presets.js";
import { getEndpoint } from "./providers/index.js";
import { lookupModel } from "./providers/lookup.js";
import { fetchWithProxy } from "../utils/proxy-fetch.js";
import { isApiKeyOptionalForEndpoint } from "../utils/llm-endpoint-auth.js";
import {
  applyOfficialOptimizationConfig,
  getSemanticCache,
  optimizeMessagesForTokenPipelineAsync,
  putSemanticCache,
  recordTokenCompressionSavings,
  recordTokenOptimizationEvent,
} from "../utils/headroom-cache.js";
import { headroomLightCompress, normalizePromptForCache, type HeadroomLightMode } from "../utils/prompt-optimizer.js";


// === Streaming Monitor Types ===

export interface StreamProgress {
  readonly elapsedMs: number;
  readonly totalChars: number;
  readonly chineseChars: number;
  readonly status: "streaming" | "done";
}

export type OnStreamProgress = (progress: StreamProgress) => void;

const INKOS_USER_AGENT = "InkOS/1.3.5";
const UNKNOWN_MODEL_FALLBACK_MAX_TOKENS = 16_384;
/** Dedicated max output tokens for creative writing agents (writer / settler). */
export const WRITING_MAX_OUTPUT_TOKENS = 24_576;
const TRANSIENT_LLM_RETRIES = 2;
const RETRY_INITIAL_DELAY_MS = 1000;
const RETRY_BACKOFF_MULTIPLIER = 2;
const RETRY_MAX_ATTEMPTS_RATE_LIMIT = 5;
const STABLE_PI_CONTEXT_TIMESTAMP = 0;
const DEFAULT_LLM_CALL_TIMEOUT_MS = 60 * 60 * 1000;
const BOOK_CREATE_TIMEOUT_MS = 90 * 60 * 1000;
const CHAPTER_WRITE_TIMEOUT_MS = 75 * 60 * 1000;
const AUDIT_TIMEOUT_MS = 30 * 60 * 1000;

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const reason = signal.reason;
  if (reason instanceof Error) throw reason;
  throw new Error(typeof reason === "string" && reason.trim() ? reason : "用户已停止当前生成。");
}

function isByteString(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    if (value.charCodeAt(i) > 255) return false;
  }
  return true;
}

function isValidHeaderName(value: string): boolean {
  return /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(value);
}

function sanitizeHttpHeaders(headers?: Record<string, string>): Record<string, string> | undefined {
  if (!headers) return undefined;
  const sanitized: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!isValidHeaderName(key)) continue;
    if (!isByteString(value)) continue;
    sanitized[key] = value;
  }
  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

function mergeUserAgent(headers?: Record<string, string>): Record<string, string> {
  return { "User-Agent": INKOS_USER_AGENT, ...(sanitizeHttpHeaders(headers) ?? {}) };
}

export function createStreamMonitor(
  onProgress?: OnStreamProgress,
  intervalMs: number = 2000,
): { readonly onChunk: (text: string) => void; readonly stop: () => void } {
  let totalChars = 0;
  let chineseChars = 0;
  const startTime = Date.now();
  let timer: ReturnType<typeof setInterval> | undefined;

  if (onProgress) {
    timer = setInterval(() => {
      onProgress({
        elapsedMs: Date.now() - startTime,
        totalChars,
        chineseChars,
        status: "streaming",
      });
    }, intervalMs);
  }

  return {
    onChunk(text: string): void {
      totalChars += text.length;
      chineseChars += (text.match(/[\u4e00-\u9fff]/g) || []).length;
    },
    stop(): void {
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
      onProgress?.({
        elapsedMs: Date.now() - startTime,
        totalChars,
        chineseChars,
        status: "done",
      });
    },
  };
}

// === Shared Types ===

export interface LLMResponse {
  readonly content: string;
  readonly usage: {
    readonly promptTokens: number;
    readonly completionTokens: number;
    readonly totalTokens: number;
  };
}

function resolveLLMCallTimeoutMs(taskType?: 'book-create' | 'chapter-write' | 'audit' | 'default'): number {
  let defaultTimeout = DEFAULT_LLM_CALL_TIMEOUT_MS;

  if (taskType === 'book-create') defaultTimeout = BOOK_CREATE_TIMEOUT_MS;
  else if (taskType === 'chapter-write') defaultTimeout = CHAPTER_WRITE_TIMEOUT_MS;
  else if (taskType === 'audit') defaultTimeout = AUDIT_TIMEOUT_MS;

  const raw = Number(process.env.INKOS_LLM_CALL_TIMEOUT_MS ?? defaultTimeout);
  if (!Number.isFinite(raw) || raw <= 0) return defaultTimeout;
  return Math.max(30_000, Math.trunc(raw));
}

function createChildAbortSignal(
  parent: AbortSignal | undefined,
  timeoutMs: number,
  label: string,
): { readonly signal: AbortSignal; readonly dispose: () => void } {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(parent?.reason ?? new Error("用户已停止当前生成。"));
  const timer = setTimeout(() => {
    controller.abort(new Error(`${label} 超时（${Math.round(timeoutMs / 1000)} 秒无完成响应）。请稍后重试，或减少任务规模/切换更稳定的模型。`));
  }, timeoutMs);

  if (parent?.aborted) {
    abortFromParent();
  } else {
    parent?.addEventListener("abort", abortFromParent, { once: true });
  }

  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      parent?.removeEventListener("abort", abortFromParent);
    },
  };
}

async function awaitAbortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  throwIfAborted(signal);
  let onAbort: (() => void) | undefined;
  const abortPromise = new Promise<T>((_, reject) => {
    onAbort = () => {
      const reason = signal.reason;
      reject(reason instanceof Error ? reason : new Error(typeof reason === "string" ? reason : "用户已停止当前生成。"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([promise, abortPromise]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

export interface LLMMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

export interface LLMClient {
  readonly provider: "openai" | "anthropic";
  readonly service?: string;
  readonly configSource?: LLMConfig["configSource"];
  readonly apiFormat: "chat" | "responses";
  readonly stream: boolean;
  readonly proxyUrl?: string;
  readonly _piModel?: PiModel<PiApi>;
  readonly _apiKey?: string;
  readonly defaults: {
    readonly temperature: number;
    /**
     * Per-call fallback: 当 agent 调 chat() 不传 options.maxTokens 时用这个值。
     * 命中模型卡时来自 providers bank 的 modelCard.maxOutput；未知模型走写作兜底预算。
     */
    readonly maxTokens: number;
    /**
     * Legacy mock compatibility only. v2 provider resolution no longer caps
     * per-call maxTokens from project config; model max output comes from the
     * provider bank.
     */
    readonly maxTokensCap?: number | null;
    readonly thinkingBudget: number;
    readonly extra: Record<string, unknown>;
  };
}

export interface TokenOptimizationOptions {
  readonly enabled?: boolean;
  readonly projectRoot?: string;
  readonly bookId?: string;
  readonly compress?: boolean;
  readonly cache?: boolean;
  /**
   * Disable semantic cache reads for creative/side-effectful requests while
   * keeping compression and cache writes enabled for diagnostics/statistics.
   */
  readonly cacheRead?: boolean;
  readonly cacheWrite?: boolean;
}

// === Tool-calling Types ===

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
}

export interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: string;
}

export type AgentMessage =
  | { readonly role: "system"; readonly content: string }
  | { readonly role: "user"; readonly content: string }
  | { readonly role: "assistant"; readonly content: string | null; readonly toolCalls?: ReadonlyArray<ToolCall> }
  | { readonly role: "tool"; readonly toolCallId: string; readonly content: string };

export interface ChatWithToolsResult {
  readonly content: string;
  readonly toolCalls: ReadonlyArray<ToolCall>;
}

// === Factory ===

export function createLLMClient(config: LLMConfig): LLMClient {
  // C1 (v2.0.0)：config.maxTokens / maxTokensCap 已删除；defaults.maxTokens 完全从 modelCard 推导。
  const _earlyCard = lookupModel(config.service ?? "custom", config.model);
  const defaults = {
    temperature: config.temperature ?? 0.7,
    maxTokens: _earlyCard?.maxOutput ?? UNKNOWN_MODEL_FALLBACK_MAX_TOKENS,
    thinkingBudget: config.thinkingBudget ?? 0,
    extra: config.extra ?? {},
  };

  const apiFormat = config.apiFormat ?? "chat";
  const stream = config.stream ?? true;

  // --- Build pi-ai Model object ---
  const serviceName = config.service ?? "custom";
  const preset = resolveServicePreset(serviceName);
  const inkosProvider = getEndpoint(serviceName);
  const modelCard = lookupModel(serviceName, config.model);

  const piApi = resolvePiApi(serviceName, config.apiFormat, (inkosProvider?.api ?? preset?.api) as PiApi) as PiApi;
  const baseUrl = config.baseUrl || inkosProvider?.baseUrl || preset?.baseUrl || "";
  const extraHeaders = sanitizeHttpHeaders(config.headers ?? parseEnvHeaders());
  const compat = piApi === "openai-completions"
    ? resolveProviderCompat(inkosProvider, baseUrl)
    : undefined;

  const provider = config.provider === "anthropic" ? "anthropic" : "openai";
  // pi-ai provider 字段：大多数情况 pi-ai 会按 baseUrl 自动嗅探（openrouter.ai / api.z.ai /
  // api.x.ai / deepseek.com / anthropic.com 等）。这里只列 pi-ai 嗅探不到、需要显式指定的少数情况。
  let piProvider: string;
  if (inkosProvider?.id === "google") piProvider = "google";
  else if (inkosProvider?.id === "zhipu") piProvider = "zai";
  else if (inkosProvider?.id === "openrouter") piProvider = "openrouter";
  else if (inkosProvider?.id === "githubCopilot") piProvider = "githubCopilot";
  else if (inkosProvider?.id === "ollama") piProvider = "ollama";
  else if (inkosProvider?.api === "anthropic-messages") piProvider = "anthropic";
  else piProvider = provider;

  const piModel: PiModel<PiApi> = {
    id: modelCard?.deploymentName ?? config.model,
    name: config.model,
    api: piApi,
    provider: piProvider,
    baseUrl,
    // 注意：piModel.reasoning 是"激活 reasoning 模式"标志（会让 pi-ai 把 system 改成 developer role 等），
    // 不是"模型能力"标签。只有用户显式配了 thinkingBudget > 0 才启用 reasoning mode。
    // 千万不要从 lobe abilities.reasoning 自动推导，否则 Moonshot 这类不支持 developer role 的服务
    // 会把 content 吃掉，只返回 reasoning_content（见 R4 bug 1 诊断）。
    reasoning: (config.thinkingBudget ?? 0) > 0,
    input: ["text"] as ("text" | "image")[],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: modelCard?.contextWindowTokens ?? 128_000,
    maxTokens: modelCard?.maxOutput ?? UNKNOWN_MODEL_FALLBACK_MAX_TOKENS,
    ...(extraHeaders ? { headers: extraHeaders } : {}),
    ...(compat ? { compat } : {}),
  };

  return {
    provider,
    service: serviceName,
    configSource: config.configSource,
    apiFormat,
    stream,
    proxyUrl: config.proxyUrl,
    _piModel: piModel,
    _apiKey: config.apiKey,
    defaults,
  };
}

function resolveTokenOptimization(options?: TokenOptimizationOptions): TokenOptimizationOptions | undefined {
  if (options?.enabled === false) return options;
  const projectRoot = options?.projectRoot ?? process.env.INKOS_PROJECT_ROOT;
  if (!projectRoot) return options;
  return { ...options, projectRoot };
}

function resolveTokenOptimizationContext(
  options: TokenOptimizationOptions | undefined,
  client: LLMClient,
  model: string,
  variant?: string,
): {
  readonly projectRoot: string;
  readonly bookId?: string;
  readonly model: string;
  readonly service?: string;
  readonly variant?: string;
} | null {
  const projectRoot = options?.projectRoot ?? process.env.INKOS_PROJECT_ROOT;
  if (!projectRoot) return null;
  return {
    projectRoot,
    ...(options?.bookId ? { bookId: options.bookId } : {}),
    model,
    service: client.service,
    ...(variant ? { variant } : {}),
  };
}

function optimizeAgentMessagesForTokenPipeline(
  messages: ReadonlyArray<AgentMessage>,
  options?: TokenOptimizationOptions,
): ReadonlyArray<AgentMessage> {
  const compress = options?.compress ?? true;
  const lastUserIndex = findLastAgentUserIndex(messages);
  return messages.map((message, index) => {
    if (typeof message.content !== "string") return message;
    const normalized = normalizePromptForCache(message.content);
    recordTokenOptimizationEvent({
      kind: "standardized",
      label: `Prompt 标准化：${message.role}`,
      originalChars: message.content.length,
      optimizedChars: normalized.length,
      estimatedTokensSaved: Math.max(0, Math.ceil((message.content.length - normalized.length) / 2)),
    });
    if (!compress || index === lastUserIndex || normalized.length < 600) {
      recordTokenOptimizationEvent({
        kind: "compression-skipped",
        label: index === lastUserIndex ? "保留当前用户指令原文" : "内容较短，无需压缩",
        originalChars: normalized.length,
        optimizedChars: normalized.length,
        estimatedTokensSaved: 0,
      });
      return { ...message, content: normalized } as AgentMessage;
    }
    const mode = inferAgentCompressionMode(message.role, normalized);
    const compressed = headroomLightCompress(normalized, mode);
    const content = compressed.length < normalized.length ? compressed : normalized;
    recordTokenCompressionSavings(normalized.length, content.length);
    recordTokenOptimizationEvent({
      kind: content.length < normalized.length ? "compressed" : "compression-skipped",
      label: content.length < normalized.length ? `Headroom 压缩：${mode}` : "压缩收益不足，保留标准化文本",
      originalChars: normalized.length,
      optimizedChars: content.length,
      estimatedTokensSaved: Math.max(0, Math.ceil((normalized.length - content.length) / 2)),
    });
    return { ...message, content } as AgentMessage;
  });
}

function inferAgentCompressionMode(role: AgentMessage["role"], content: string): HeadroomLightMode {
  const trimmed = content.trim();
  if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
    return "json";
  }
  if (role === "assistant") return "narrative";
  return "setting";
}

function findLastAgentUserIndex(messages: ReadonlyArray<AgentMessage>): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") return index;
  }
  return -1;
}

function resolvePiApi(
  serviceName: string,
  apiFormat: LLMConfig["apiFormat"] | undefined,
  presetApi: PiApi | undefined,
): PiApi {
  if (serviceName === "custom") {
    return apiFormat === "responses" ? "openai-responses" : "openai-completions";
  }
  return (presetApi ?? "openai-completions") as PiApi;
}

function resolveProviderCompat(
  provider: ReturnType<typeof getEndpoint>,
  baseUrl: string,
): Record<string, unknown> | undefined {
  const compat = {
    ...(provider?.compat ?? {}),
    ...(baseUrl.includes("generativelanguage.googleapis.com") ? { supportsStore: false } : {}),
  };
  return Object.keys(compat).length > 0 ? compat : undefined;
}

function parseEnvHeaders(): Record<string, string> | undefined {
  const raw = process.env.INKOS_LLM_HEADERS;
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, string>;
    }
  } catch {
    // not JSON — treat as single "Key: Value" pair
    const idx = raw.indexOf(":");
    if (idx > 0) {
      return { [raw.slice(0, idx).trim()]: raw.slice(idx + 1).trim() };
    }
  }
  return undefined;
}

// === Partial Response (stream interrupted but usable content received) ===

export class PartialResponseError extends Error {
  readonly partialContent: string;
  constructor(partialContent: string, cause: unknown) {
    super(`Stream interrupted after ${partialContent.length} chars: ${String(cause)}`);
    this.name = "PartialResponseError";
    this.partialContent = partialContent;
  }
}

/** Minimum chars to consider a partial response salvageable (Chinese ~2 chars/word → 500 chars ≈ 250 words) */
const MIN_SALVAGEABLE_CHARS = 500;

/** Keys managed by the provider layer — prevent extra from overriding them. */
const RESERVED_KEYS = new Set(["max_tokens", "temperature", "model", "messages", "stream"]);

function stripReservedKeys(extra: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(extra)) {
    if (!RESERVED_KEYS.has(key)) result[key] = value;
  }
  return result;
}

// === Fixed-Temperature Model Clamp ===
//
// 部分 thinking 模型（如 Moonshot kimi-k2.5/k2.6、kimi-k2-thinking）的 API
// 硬要求 temperature === 1，其他值会被直接 400 拒绝（Moonshot 返回
// `invalid temperature: only 1 is allowed for this model`）。
//
// inkos 让 writer/validator/architect 各自带 per-call 温度（0.1~1.5），
// 所以 provider 层统一夹制：如果 bank 里模型卡标了 temperature 字段，
// 就把 per-call 温度 clamp 到那个值，并对每个模型名打一次 warning。
//
// 这个字段只表达"服务端硬约束"，普通模型不要标，避免误伤 per-call 调参。

const warnedFixedTemperatureModels = new Set<string>();

function clampTemperatureForModel(
  service: string | undefined,
  model: string,
  requested: number,
): number {
  const card = service ? lookupModel(service, model) : undefined;
  if (card?.temperature === undefined) return requested;
  const locked = card.temperature;
  if (requested === locked) return locked;
  if (!warnedFixedTemperatureModels.has(model)) {
    warnedFixedTemperatureModels.add(model);
    console.warn(
      `[inkos] 模型 "${model}" API 要求 temperature=${locked}，已 clamp（原值 ${requested}）`,
    );
  }
  return locked;
}

// 仅测试用：清空 warning 去重集合。
export function __resetFixedTemperatureWarnings(): void {
  warnedFixedTemperatureModels.clear();
}

// === Error Wrapping ===

function wrapLLMError(error: unknown, context?: { readonly baseUrl?: string; readonly model?: string; readonly service?: string }): Error {
  const msg = String(error);
  const ctxLine = context
    ? `\n  (baseUrl: ${context.baseUrl}, model: ${context.model})`
    : "";

  if (msg.includes("400")) {
    // 抽上游 error body 的 message / reason / code（和下方 5xx 一致），让真实错因浮到用户面前
    let detail = "";
    if (error && typeof error === "object") {
      const err = error as { error?: unknown; body?: unknown; message?: string };
      const bodyLike = err.error ?? err.body;
      if (bodyLike && typeof bodyLike === "object") {
        const b = bodyLike as { reason?: string; message?: string; code?: number | string; type?: string };
        if (b.message) detail = b.type ? `${b.type}: ${b.message}` : b.message;
        else if (b.reason) detail = b.reason;
      }
    }
    return new Error(
      `API 返回 400（请求参数错误）。${detail ? `上游详情：${detail}。\n` : ""}` +
      `常见原因：\n` +
      `  1. temperature / max_tokens 超出模型约束（如 Moonshot kimi-k2.X 强制 temperature=1）\n` +
      `  2. 模型名称不正确或未上架\n` +
      `  3. 消息格式不兼容（部分服务不支持 system role 或 developer role）${ctxLine}`,
    );
  }
  if (msg.includes("403")) {
    const normalized = msg.toLowerCase();
    const likelyModelAccess =
      normalized.includes("model")
      || normalized.includes("not access")
      || normalized.includes("permission")
      || normalized.includes("forbidden")
      || normalized.includes("无权")
      || normalized.includes("权限")
      || normalized.includes("未开通")
      || normalized.includes("不可用");
    return new Error(
      `API 返回 403 (请求被拒绝)。可能原因：\n` +
      (likelyModelAccess
        ? `  1. 当前账号/API Key 没有访问该模型的权限，或该模型在服务商侧未开通/已下线\n`
        : `  1. API Key 无效、过期，或当前账号没有访问该模型的权限\n`) +
      `  2. API 提供方的内容审查拦截了请求（公益/免费 API 常见）\n` +
      `  3. 账户余额不足或套餐不支持该模型\n` +
      `  建议：在模型选择器换用同服务下的稳定文本模型，或到服务商控制台确认该模型已开通；也可用 inkos doctor 测试 API 连通性${ctxLine}`,
    );
  }
  if (msg.includes("401")) {
    return new Error(
      `API 返回 401 (未授权)。请检查 .env 中的 INKOS_LLM_API_KEY 是否正确。${ctxLine}`,
    );
  }
  if (msg.includes("429")) {
    return new Error(
      `API 返回 429 (请求过多)。请稍后重试，或检查 API 配额。${ctxLine}`,
    );
  }
  if (
    msg.includes("Connection error")
    || msg.includes("ECONNREFUSED")
    || msg.includes("ENOTFOUND")
    || msg.includes("fetch failed")
    || msg.includes("terminated")
    || msg.includes("UND_ERR_SOCKET")
    || msg.includes("ECONNRESET")
    || msg.includes("ETIMEDOUT")
    || msg.includes("EPIPE")
  ) {
    return new Error(
      `无法连接到 API 服务。可能原因：\n` +
      `  1. baseUrl 地址不正确（当前：${context?.baseUrl ?? "未知"}）\n` +
      `  2. 网络不通或被防火墙拦截\n` +
      `  3. API 服务暂时不可用\n` +
      `  建议：检查 INKOS_LLM_BASE_URL 是否包含完整路径（如 /v1）`,
    );
  }
  // R4 Bug 2: 5xx "status code (no body)" — 尝试从 OpenAI SDK APIError 里抽 body 给用户看具体原因
  // （如 PPIO 的 {"code":500,"reason":"MODEL_NOT_AVAILABLE","message":"model not available"}）
  if (msg.includes("status code") && msg.includes("no body")) {
    let detail = "";
    if (error && typeof error === "object") {
      const err = error as { error?: unknown; body?: unknown; message?: string };
      const bodyLike = err.error ?? err.body;
      if (bodyLike && typeof bodyLike === "object") {
        const b = bodyLike as { reason?: string; message?: string; code?: number | string };
        if (b.reason) detail = `${b.reason}${b.message ? `: ${b.message}` : ""}`;
        else if (b.message) detail = b.message;
      }
    }
    return new Error(
      `API 返回 5xx（上游服务异常）。${detail ? `上游详情：${detail}。` : ""}\n` +
      `可能原因：\n` +
      `  1. 模型在 /models 列表但 inference 未上架（如 PPIO 返回 MODEL_NOT_AVAILABLE）\n` +
      `  2. 服务端临时故障，稍后重试\n` +
      `  3. 当前 apikey 无权限调用该模型${ctxLine}`,
    );
  }
  return error instanceof Error ? error : new Error(msg);
}

function collectErrorText(error: unknown, depth = 0): string {
  if (depth > 4 || error === null || error === undefined) return "";
  const parts = [String(error)];
  if (error instanceof Error) {
    parts.push(error.name, error.message);
    const cause = (error as Error & { cause?: unknown }).cause;
    if (cause) parts.push(collectErrorText(cause, depth + 1));
  } else if (typeof error === "object") {
    const err = error as { code?: unknown; cause?: unknown; message?: unknown; name?: unknown };
    if (err.name) parts.push(String(err.name));
    if (err.message) parts.push(String(err.message));
    if (err.code) parts.push(String(err.code));
    if (err.cause) parts.push(collectErrorText(err.cause, depth + 1));
  }
  return parts.join("\n");
}

function isTransientLLMTransportError(error: unknown): boolean {
  const text = collectErrorText(error);
  return [
    "terminated",
    "UND_ERR_SOCKET",
    "ECONNRESET",
    "ETIMEDOUT",
    "EPIPE",
    "socket hang up",
    "other side closed",
    "network socket disconnected",
  ].some((needle) => text.includes(needle));
}

function shouldRetryError(error: unknown, attempt: number): { retry: boolean; delayMs: number } {
  const errorStr = String(error);

  if (errorStr.includes('429') || errorStr.toLowerCase().includes('rate limit')) {
    const maxAttempts = RETRY_MAX_ATTEMPTS_RATE_LIMIT;
    if (attempt >= maxAttempts) return { retry: false, delayMs: 0 };
    const delayMs = RETRY_INITIAL_DELAY_MS * Math.pow(RETRY_BACKOFF_MULTIPLIER, attempt);
    return { retry: true, delayMs: Math.min(delayMs, 30000) };
  }

  if (errorStr.includes('500') || errorStr.includes('502') || errorStr.includes('503')) {
    if (attempt >= TRANSIENT_LLM_RETRIES) return { retry: false, delayMs: 0 };
    return { retry: true, delayMs: RETRY_INITIAL_DELAY_MS * (attempt + 1) };
  }

  if (errorStr.includes('400') || errorStr.includes('401') || errorStr.includes('403')) {
    return { retry: false, delayMs: 0 };
  }

  if (attempt >= TRANSIENT_LLM_RETRIES) return { retry: false, delayMs: 0 };
  return { retry: isTransientLLMTransportError(error), delayMs: 0 };
}

async function withTransientLLMRetry<T>(
  run: () => Promise<T>,
  options?: { readonly enabled?: boolean },
): Promise<T> {
  const enabled = options?.enabled ?? true;
  let lastError: unknown;
  for (let attempt = 0; attempt <= RETRY_MAX_ATTEMPTS_RATE_LIMIT; attempt++) {
    try {
      return await run();
    } catch (error) {
      lastError = error;
      if (!enabled || error instanceof PartialResponseError) {
        throw error;
      }

      const retryDecision = shouldRetryError(error, attempt);
      if (!retryDecision.retry) {
        throw error;
      }

      if (retryDecision.delayMs > 0) {
        await new Promise(resolve => setTimeout(resolve, retryDecision.delayMs));
      }
    }
  }
  throw lastError;
}

function shouldUseNativeCustomTransport(client: LLMClient): boolean {
  if (client.service === "kkaiapi" && client.provider === "openai") {
    return true;
  }
  if (client.service === "custom") {
    if (
      client.configSource === "studio"
      && (client.provider === "openai" || client.provider === "anthropic")
    ) {
      return true;
    }
    return client.provider === "openai" && shouldUseNativeLocalOpenAICompatibleTransport(client);
  }
  return client.service === "ollama"
    && client.provider === "openai"
    && shouldUseNativeLocalOpenAICompatibleTransport(client);
}

function shouldUseNativeLocalOpenAICompatibleTransport(client: LLMClient): boolean {
  return !client._apiKey
    && isApiKeyOptionalForEndpoint({
      provider: client.provider,
      baseUrl: client._piModel?.baseUrl,
    });
}

function buildCustomHeaders(client: LLMClient): Record<string, string> {
  const apiKey = sanitizeHeaderApiKey(client._apiKey);
  return sanitizeHttpHeaders({
    "Content-Type": "application/json",
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    ...(client._piModel?.headers ?? {}),
  }) ?? { "Content-Type": "application/json" };
}

function sanitizeHeaderApiKey(apiKey: string | undefined): string {
  const trimmed = apiKey?.trim() ?? "";
  if (!trimmed) return "";
  if (!/^[\x20-\x7e]+$/.test(trimmed)) {
    throw new Error("API Key contains non-ASCII characters; please remove any pasted Chinese notes or whitespace.");
  }
  return trimmed;
}

function joinSystemPrompt(messages: ReadonlyArray<LLMMessage>): string | undefined {
  const systemParts = messages
    .filter((message) => message.role === "system" && message.content.trim().length > 0)
    .map((message) => message.content.trim());
  return systemParts.length > 0 ? systemParts.join("\n\n") : undefined;
}

function buildChatMessages(messages: ReadonlyArray<LLMMessage>): Array<{ role: string; content: string }> {
  return messages
    .filter((message) => message.role !== "system")
    .map((message) => ({
      role: message.role,
      content: message.content,
    }));
}

function buildAnthropicMessages(messages: ReadonlyArray<LLMMessage>): Array<{ role: "user" | "assistant"; content: string }> {
  return messages
    .filter((message): message is Readonly<LLMMessage> & { role: "user" | "assistant" } => message.role === "user" || message.role === "assistant")
    .map((message) => ({
      role: message.role,
      content: message.content,
    }));
}

function buildResponsesInput(messages: ReadonlyArray<LLMMessage>): Array<{ role: string; content: Array<{ type: "input_text"; text: string }> }> {
  return messages
    .filter((message) => message.role !== "system")
    .map((message) => ({
      role: message.role,
      content: [{ type: "input_text", text: message.content }],
    }));
}

function hasSystemMessages(messages: ReadonlyArray<LLMMessage>): boolean {
  return messages.some((message) => message.role === "system" && message.content.trim().length > 0);
}

function foldSystemMessagesIntoFirstUser(messages: ReadonlyArray<LLMMessage>): LLMMessage[] {
  const system = joinSystemPrompt(messages);
  const nonSystemMessages = messages.filter((message) => message.role !== "system");
  if (!system) return [...nonSystemMessages];

  const firstUserIndex = nonSystemMessages.findIndex((message) => message.role === "user");
  const prefix = `System instructions:\n${system}\n\nUser request:\n`;
  if (firstUserIndex < 0) {
    return [{ role: "user", content: `System instructions:\n${system}` }, ...nonSystemMessages];
  }

  return nonSystemMessages.map((message, index) => index === firstUserIndex
    ? { ...message, content: `${prefix}${message.content}` }
    : message);
}

function isSystemRoleUnsupportedErrorText(text: string): boolean {
  const normalized = text.toLowerCase();
  const mentionsSystemRole = normalized.includes("system") && normalized.includes("role");
  if (!mentionsSystemRole) return false;
  return normalized.includes("unsupported")
    || normalized.includes("not support")
    || normalized.includes("does not support")
    || normalized.includes("invalid")
    || normalized.includes("不支持")
    || normalized.includes("不允许");
}

function isOpenAICompatibleRequestParameterErrorText(text: string): boolean {
  const normalized = text.toLowerCase();
  if (!normalized.includes("400")) return false;
  return normalized.includes("parameter")
    || normalized.includes("param")
    || normalized.includes("max_tokens")
    || normalized.includes("temperature")
    || normalized.includes("messages")
    || normalized.includes("role")
    || normalized.includes("请求参数")
    || normalized.includes("参数");
}

function shouldRetryWithConservativeChatPayload(
  detail: string,
  messages: ReadonlyArray<LLMMessage>,
  resolved: { readonly temperature: number; readonly maxTokens: number },
  compatibilityFallbackLevel: number,
): boolean {
  if (!isOpenAICompatibleRequestParameterErrorText(detail)) return false;
  if (compatibilityFallbackLevel >= 2) return false;
  if (compatibilityFallbackLevel > 0) return true;
  return hasSystemMessages(messages) || resolved.maxTokens > 4096 || resolved.temperature !== 1;
}

function conservativeChatResolved(
  resolved: { readonly temperature: number; readonly maxTokens: number; readonly extra: Record<string, unknown> },
  compatibilityFallbackLevel: number,
): { readonly temperature: number; readonly maxTokens: number; readonly extra: Record<string, unknown> } {
  const maxTokens = compatibilityFallbackLevel >= 2 ? 2048 : 4096;
  return {
    ...resolved,
    temperature: 1,
    maxTokens: Math.min(resolved.maxTokens, maxTokens),
    extra: {},
  };
}

async function readErrorResponse(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  try {
    const json = JSON.parse(text) as { error?: { message?: string } | string; detail?: string };
    if (typeof json.error === "string" && json.error) return `${res.status} ${json.error}`;
    if (json.error && typeof json.error === "object" && typeof json.error.message === "string") {
      return `${res.status} ${json.error.message}`;
    }
    if (typeof json.detail === "string" && json.detail) return `${res.status} ${json.detail}`;
  } catch {
    // fall through
  }
  return `${res.status} ${text || res.statusText}`.trim();
}

type ParsedSseEvent = {
  readonly event?: string;
  readonly data?: string;
};

function parseSseEvents(buffer: string): { readonly events: ParsedSseEvent[]; readonly rest: string } {
  const chunks = buffer.split(/\n\n/);
  const rest = chunks.pop() ?? "";
  const events: ParsedSseEvent[] = [];

  for (const chunk of chunks) {
    const lines = chunk.split(/\r?\n/);
    let eventName: string | undefined;
    const dataLines: string[] = [];
    for (const line of lines) {
      if (line.startsWith("event:")) {
        eventName = line.slice("event:".length).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice("data:".length).trimStart());
      }
    }
    if (eventName || dataLines.length > 0) {
      events.push({
        ...(eventName ? { event: eventName } : {}),
        ...(dataLines.length > 0 ? { data: dataLines.join("\n") } : {}),
      });
    }
  }

  return { events, rest };
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readJsonPath(value: unknown, path: ReadonlyArray<string | number>): unknown {
  let current = value;
  for (const segment of path) {
    if (typeof segment === "number") {
      if (!Array.isArray(current)) return undefined;
      current = current[segment];
      continue;
    }
    if (!isJsonRecord(current)) return undefined;
    current = current[segment];
  }
  return current;
}

function readJsonString(value: unknown, path: ReadonlyArray<string | number>): string | undefined {
  const candidate = readJsonPath(value, path);
  return typeof candidate === "string" ? candidate : undefined;
}

function readJsonNumber(value: unknown, path: ReadonlyArray<string | number>): number | undefined {
  const candidate = readJsonPath(value, path);
  return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : undefined;
}

function extractOpenAITextPart(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (!isJsonRecord(item)) return "";
        if (typeof item.text === "string") return item.text;
        if (typeof item.content === "string") return item.content;
        return "";
      })
      .join("");
  }
  return "";
}

function extractChatContent(json: unknown): string {
  return extractOpenAITextPart(readJsonPath(json, ["choices", 0, "message", "content"]))
    || extractOpenAITextPart(readJsonPath(json, ["choices", 0, "message", "reasoning_content"]));
}

function extractChatDeltaContent(json: unknown): string {
  return extractOpenAITextPart(readJsonPath(json, ["choices", 0, "delta", "content"]));
}

function extractChatDeltaReasoningContent(json: unknown): string {
  return extractOpenAITextPart(readJsonPath(json, ["choices", 0, "delta", "reasoning_content"]));
}

function extractResponsesContent(json: unknown): string {
  const output = readJsonPath(json, ["output"]);
  const outputItems = Array.isArray(output) ? output : [];
  return outputItems
    .flatMap((item) => {
      if (!isJsonRecord(item) || !Array.isArray(item.content)) return [];
      return item.content;
    })
    .map((part) => {
      if (!isJsonRecord(part)) return "";
      if (typeof part.text === "string") return part.text;
      if (typeof part.content === "string") return part.content;
      if (typeof part.output_text === "string") return part.output_text;
      return "";
    })
    .join("");
}

function extractAnthropicContent(json: unknown): string {
  const rawContent = readJsonPath(json, ["content"]);
  const content = Array.isArray(rawContent) ? rawContent : [];
  return content
    .map((part) => isJsonRecord(part) && typeof part.text === "string" ? part.text : "")
    .join("");
}

async function chatCompletionViaCustomAnthropicCompatible(
  client: LLMClient,
  model: string,
  messages: ReadonlyArray<LLMMessage>,
  resolved: { readonly temperature: number; readonly maxTokens: number; readonly extra: Record<string, unknown> },
  onStreamProgress?: OnStreamProgress,
  onTextDelta?: (text: string) => void,
  signal?: AbortSignal,
): Promise<LLMResponse> {
  const baseUrl = client._piModel?.baseUrl ?? "";
  const errorCtx = { baseUrl, model, service: client.service };
  const extra = stripReservedKeys(resolved.extra);
  const payload: Record<string, unknown> = {
    model,
    messages: buildAnthropicMessages(messages),
    stream: client.stream,
    max_tokens: resolved.maxTokens,
    temperature: resolved.temperature,
    ...extra,
  };
  const system = joinSystemPrompt(messages);
  if (system) payload.system = system;

  const apiKey = sanitizeHeaderApiKey(client._apiKey);
  const response = await fetchWithProxy(`${baseUrl.replace(/\/$/, "")}/messages`, {
    method: "POST",
    headers: sanitizeHttpHeaders({
      "User-Agent": INKOS_USER_AGENT,
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      ...(client._piModel?.headers ?? {}),
    }) ?? { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal,
  }, client.proxyUrl);

  if (!response.ok) {
    throw wrapLLMError(new Error(await readErrorResponse(response)), errorCtx);
  }

  if (!client.stream) {
    const json = await response.json() as unknown;
    const content = extractAnthropicContent(json);
    if (!content) {
      throw wrapLLMError(new Error("LLM returned empty response"), errorCtx);
    }
    const promptTokens = readJsonNumber(json, ["usage", "input_tokens"]) ?? 0;
    const completionTokens = readJsonNumber(json, ["usage", "output_tokens"]) ?? 0;
    return {
      content,
      usage: {
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
      },
    };
  }

  const reader = response.body?.getReader();
  if (!reader) throw wrapLLMError(new Error("Streaming body unavailable"), errorCtx);
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  const monitor = createStreamMonitor(onStreamProgress);

  try {
    while (true) {
      throwIfAborted(signal);
      const { value, done } = await reader.read();
      throwIfAborted(signal);
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parsed = parseSseEvents(buffer);
      buffer = parsed.rest;
      for (const event of parsed.events) {
        if (!event.data) continue;
        const json = JSON.parse(event.data) as unknown;
        const type = readJsonString(json, ["type"]);
        if (type === "message_start") {
          usage.promptTokens = readJsonNumber(json, ["message", "usage", "input_tokens"]) ?? usage.promptTokens;
        }
        if (type === "content_block_delta" && readJsonString(json, ["delta", "type"]) === "text_delta") {
          const text = readJsonString(json, ["delta", "text"]);
          if (text) {
            content += text;
            monitor.onChunk(text);
            onTextDelta?.(text);
          }
        }
        if (type === "message_delta") {
          usage.completionTokens = readJsonNumber(json, ["usage", "output_tokens"]) ?? usage.completionTokens;
        }
        if (type === "message_stop") {
          usage.totalTokens = usage.promptTokens + usage.completionTokens;
        }
      }
    }
  } finally {
    monitor.stop();
  }

  if (!content) {
    throw wrapLLMError(new Error("LLM returned empty response from stream"), errorCtx);
  }
  if (!usage.totalTokens) {
    usage.totalTokens = usage.promptTokens + usage.completionTokens;
  }
  return { content, usage };
}

async function chatCompletionViaCustomOpenAICompatible(
  client: LLMClient,
  model: string,
  messages: ReadonlyArray<LLMMessage>,
  resolved: { readonly temperature: number; readonly maxTokens: number; readonly extra: Record<string, unknown> },
  onStreamProgress?: OnStreamProgress,
  onTextDelta?: (text: string) => void,
  signal?: AbortSignal,
  compatibilityFallbackLevel = 0,
): Promise<LLMResponse> {
  if (client.provider === "anthropic") {
    return chatCompletionViaCustomAnthropicCompatible(client, model, messages, resolved, onStreamProgress, onTextDelta, signal);
  }
  const baseUrl = client._piModel?.baseUrl ?? "";
  const headers = buildCustomHeaders(client);
  const errorCtx = { baseUrl, model, service: client.service };
  const extra = stripReservedKeys(resolved.extra);

  if (client.apiFormat === "responses") {
    const payload: Record<string, unknown> = {
      model,
      input: buildResponsesInput(messages),
      stream: client.stream,
      store: false,
      max_output_tokens: resolved.maxTokens,
      temperature: resolved.temperature,
      ...extra,
    };
    const instructions = joinSystemPrompt(messages);
    if (instructions) payload.instructions = instructions;

    const response = await fetchWithProxy(`${baseUrl.replace(/\/$/, "")}/responses`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal,
    }, client.proxyUrl);
    if (!response.ok) {
      throw wrapLLMError(new Error(await readErrorResponse(response)), errorCtx);
    }

    if (!client.stream) {
      const json = await response.json() as unknown;
      const content = extractResponsesContent(json);
      if (!content) {
        throw wrapLLMError(new Error("LLM returned empty response"), errorCtx);
      }
      return {
        content,
        usage: {
          promptTokens: readJsonNumber(json, ["usage", "input_tokens"]) ?? 0,
          completionTokens: readJsonNumber(json, ["usage", "output_tokens"]) ?? 0,
          totalTokens: readJsonNumber(json, ["usage", "total_tokens"]) ?? 0,
        },
      };
    }

    const reader = response.body?.getReader();
    if (!reader) throw wrapLLMError(new Error("Streaming body unavailable"), errorCtx);
    const decoder = new TextDecoder();
    let buffer = "";
    let content = "";
    let usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    const monitor = createStreamMonitor(onStreamProgress);

    try {
      while (true) {
        throwIfAborted(signal);
        const { value, done } = await reader.read();
        throwIfAborted(signal);
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parsed = parseSseEvents(buffer);
        buffer = parsed.rest;
        for (const event of parsed.events) {
          if (!event.data) continue;
          const json = JSON.parse(event.data) as unknown;
          const type = readJsonString(json, ["type"]);
          if (type === "response.output_text.delta") {
            const delta = readJsonString(json, ["delta"]);
            if (delta) {
              content += delta;
              monitor.onChunk(delta);
              onTextDelta?.(delta);
            }
          }
          if (type === "response.completed") {
            usage = {
              promptTokens: readJsonNumber(json, ["response", "usage", "input_tokens"]) ?? 0,
              completionTokens: readJsonNumber(json, ["response", "usage", "output_tokens"]) ?? 0,
              totalTokens: readJsonNumber(json, ["response", "usage", "total_tokens"]) ?? 0,
            };
            if (!content) {
              content = extractResponsesContent(readJsonPath(json, ["response"]));
            }
          }
        }
      }
    } finally {
      monitor.stop();
    }

    if (!content) {
      throw wrapLLMError(new Error("LLM returned empty response from stream"), errorCtx);
    }
    return { content, usage };
  }

  const payload: Record<string, unknown> = {
    model,
    messages: [
      ...messages
        .filter((message) => message.role === "system")
        .map((message) => ({ role: "system", content: message.content })),
      ...buildChatMessages(messages),
    ],
    stream: client.stream,
    temperature: resolved.temperature,
    max_tokens: resolved.maxTokens,
    ...extra,
  };
  if (client.stream && compatibilityFallbackLevel === 0) {
    payload.stream_options = { include_usage: true };
  }

  const response = await fetchWithProxy(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    signal,
  }, client.proxyUrl);
  if (!response.ok) {
    const detail = await readErrorResponse(response);
    const nextFallbackLevel = compatibilityFallbackLevel + 1;
    if (shouldRetryWithConservativeChatPayload(detail, messages, resolved, compatibilityFallbackLevel)) {
      return chatCompletionViaCustomOpenAICompatible(
        client,
        model,
        hasSystemMessages(messages) ? foldSystemMessagesIntoFirstUser(messages) : messages,
        conservativeChatResolved(resolved, nextFallbackLevel),
        onStreamProgress,
        onTextDelta,
        signal,
        nextFallbackLevel,
      );
    }
    if (compatibilityFallbackLevel === 0 && hasSystemMessages(messages) && isSystemRoleUnsupportedErrorText(detail)) {
      return chatCompletionViaCustomOpenAICompatible(
        client,
        model,
        foldSystemMessagesIntoFirstUser(messages),
        resolved,
        onStreamProgress,
        onTextDelta,
        signal,
        nextFallbackLevel,
      );
    }
    throw wrapLLMError(new Error(detail), errorCtx);
  }

  if (!client.stream) {
    const json = await response.json() as unknown;
    const content = extractChatContent(json);
    if (!content) {
      throw wrapLLMError(new Error("LLM returned empty response"), errorCtx);
    }
    return {
      content,
      usage: {
        promptTokens: readJsonNumber(json, ["usage", "prompt_tokens"]) ?? 0,
        completionTokens: readJsonNumber(json, ["usage", "completion_tokens"]) ?? 0,
        totalTokens: readJsonNumber(json, ["usage", "total_tokens"]) ?? 0,
      },
    };
  }

  const reader = response.body?.getReader();
  if (!reader) throw wrapLLMError(new Error("Streaming body unavailable"), errorCtx);
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let reasoningContent = "";
  let usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  const monitor = createStreamMonitor(onStreamProgress);

  try {
    while (true) {
      throwIfAborted(signal);
      const { value, done } = await reader.read();
      throwIfAborted(signal);
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parsed = parseSseEvents(buffer);
      buffer = parsed.rest;
      for (const event of parsed.events) {
        if (!event.data || event.data === "[DONE]") continue;
        const json = JSON.parse(event.data) as unknown;
        const delta = extractChatDeltaContent(json);
        if (delta) {
          content += delta;
          monitor.onChunk(delta);
          onTextDelta?.(delta);
        } else {
          const reasoningDelta = extractChatDeltaReasoningContent(json);
          if (reasoningDelta) {
            reasoningContent += reasoningDelta;
            monitor.onChunk(reasoningDelta);
          }
        }
        if (isJsonRecord(readJsonPath(json, ["usage"]))) {
          usage = {
            promptTokens: readJsonNumber(json, ["usage", "prompt_tokens"]) ?? usage.promptTokens,
            completionTokens: readJsonNumber(json, ["usage", "completion_tokens"]) ?? usage.completionTokens,
            totalTokens: readJsonNumber(json, ["usage", "total_tokens"]) ?? usage.totalTokens,
          };
        }
      }
    }
  } finally {
    monitor.stop();
  }

  const finalContent = content || reasoningContent;
  if (!finalContent) {
    throw wrapLLMError(new Error("LLM returned empty response from stream"), errorCtx);
  }
  return { content: finalContent, usage };
}

// === Simple Chat (used by all agents via BaseAgent.chat()) ===

export async function chatCompletion(
  client: LLMClient,
  model: string,
  messages: ReadonlyArray<LLMMessage>,
  options?: {
    readonly temperature?: number;
    readonly maxTokens?: number;
    readonly webSearch?: boolean;
    readonly onStreamProgress?: OnStreamProgress;
    readonly onTextDelta?: (text: string) => void;
    readonly signal?: AbortSignal;
    readonly tokenOptimization?: TokenOptimizationOptions;
    readonly targetWordCount?: number;
    readonly taskType?: 'book-create' | 'chapter-write' | 'audit' | 'default';
  },
): Promise<LLMResponse> {
  // C1 (v2.0.0)：删除 maxTokensCap 机制。per-call 显式传的 maxTokens 永远不被裁剪。
  let effectiveMaxTokens = options?.maxTokens ?? client.defaults.maxTokens;
  if (options?.targetWordCount && options.targetWordCount > 10000) {
    const estimatedTokens = Math.ceil(options.targetWordCount * 2);
    effectiveMaxTokens = Math.max(effectiveMaxTokens, Math.min(estimatedTokens * 1.2, 128000));
  }
  const resolved = {
    temperature: clampTemperatureForModel(
      client.service,
      model,
      options?.temperature ?? client.defaults.temperature,
    ),
    maxTokens: effectiveMaxTokens,
    extra: client.defaults.extra,
  };
  const onStreamProgress = options?.onStreamProgress;
  const onTextDelta = options?.onTextDelta;
  const timeoutMs = resolveLLMCallTimeoutMs(options?.taskType);
  const callAbort = createChildAbortSignal(options?.signal, timeoutMs, `LLM 调用 ${model}`);
  const signal = callAbort.signal;
  const errorCtx = { baseUrl: client._piModel?.baseUrl ?? "(unknown)", model, service: client.service };
  const tokenOptimization = resolveTokenOptimization(options?.tokenOptimization);
  const optimizationContext = tokenOptimization?.enabled === false
    ? null
    : resolveTokenOptimizationContext(
        tokenOptimization,
        client,
        model,
        JSON.stringify({
          temperature: resolved.temperature,
          maxTokens: resolved.maxTokens,
          webSearch: options?.webSearch === true,
          extra: resolved.extra,
        }),
      );
  if (optimizationContext) {
    applyOfficialOptimizationConfig(optimizationContext.projectRoot);
  }
  const optimized = optimizationContext
    ? await optimizeMessagesForTokenPipelineAsync(messages, {
        model,
        compress: tokenOptimization?.compress ?? true,
      })
    : { messages: [...messages], events: [], originalChars: 0, optimizedChars: 0, estimatedTokensSaved: 0 };
  const cacheEnabled = tokenOptimization?.cache !== false;
  const cacheReadEnabled = cacheEnabled && tokenOptimization?.cacheRead !== false;
  const cacheWriteEnabled = cacheEnabled && tokenOptimization?.cacheWrite !== false;
  if (optimizationContext && cacheReadEnabled) {
    const cached = await getSemanticCache(optimizationContext, optimized.messages);
    if (cached) {
      onTextDelta?.(cached.content);
      return cached;
    }
  } else if (optimizationContext && cacheEnabled && !cacheReadEnabled) {
    recordTokenOptimizationEvent({
      kind: "cache-check",
      label: "语义缓存检查：创作请求只写不读",
    });
    recordTokenOptimizationEvent({
      kind: "cache-skip",
      label: "语义缓存读取跳过：创作请求不复用旧生成结果",
    });
  } else if (optimizationContext) {
    recordTokenOptimizationEvent({ kind: "cache-skip", label: "语义缓存跳过：当前请求关闭缓存" });
  }

  try {
    return await withTransientLLMRetry(
      async () => {
        throwIfAborted(signal);
        recordTokenOptimizationEvent({ kind: "llm-call", label: "LLM 调用：缓存未命中后请求模型" });
        let response: LLMResponse;
        if (shouldUseNativeCustomTransport(client)) {
          response = await awaitAbortable(
            chatCompletionViaCustomOpenAICompatible(client, model, optimized.messages, resolved, onStreamProgress, onTextDelta, signal),
            signal,
          );
        } else {
          response = await awaitAbortable(
            chatCompletionViaPiAi(client, model, optimized.messages, resolved, onStreamProgress, onTextDelta, signal),
            signal,
          );
        }
        if (optimizationContext && cacheWriteEnabled) {
          await putSemanticCache(optimizationContext, optimized.messages, response).catch(() => undefined);
        }
        return response;
      },
      // Retrying after UI text deltas have been emitted can duplicate visible text.
      { enabled: !onTextDelta },
    );
  } catch (error) {
    // Stream interrupted but partial content is usable — return truncated response
    if (error instanceof PartialResponseError) {
      return {
        content: error.partialContent,
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      };
    }
    throw wrapLLMError(error, errorCtx);
  } finally {
    callAbort.dispose();
  }
}

// === Tool-calling Chat (used by agent loop) ===

export async function chatWithTools(
  client: LLMClient,
  model: string,
  messages: ReadonlyArray<AgentMessage>,
  tools: ReadonlyArray<ToolDefinition>,
  options?: {
    readonly temperature?: number;
    readonly maxTokens?: number;
    readonly tokenOptimization?: TokenOptimizationOptions;
  },
): Promise<ChatWithToolsResult> {
  const errorCtx = { baseUrl: client._piModel?.baseUrl ?? "(unknown)", model, service: client.service };
  try {
    const resolved = {
      temperature: clampTemperatureForModel(
        client.service,
        model,
        options?.temperature ?? client.defaults.temperature,
      ),
      maxTokens: options?.maxTokens ?? client.defaults.maxTokens,
    };
    const tokenOptimization = resolveTokenOptimization(options?.tokenOptimization);
    const optimizedMessages = tokenOptimization?.enabled === false
      ? messages
      : optimizeAgentMessagesForTokenPipeline(messages, tokenOptimization);
    if (tokenOptimization?.enabled !== false) {
      recordTokenOptimizationEvent({ kind: "cache-check", label: "语义缓存检查：工具请求" });
      recordTokenOptimizationEvent({ kind: "cache-skip", label: "工具调用请求不跳过 LLM，避免跳过工具执行" });
      recordTokenOptimizationEvent({ kind: "llm-call", label: "LLM 工具调用请求" });
    }
    if (shouldUseNativeCustomTransport(client) && client.provider === "openai") {
      return await chatWithToolsViaNativeOpenAICompatible(client, model, optimizedMessages, tools, resolved);
    }
    return await chatWithToolsViaPiAi(client, model, optimizedMessages, tools, resolved);
  } catch (error) {
    throw wrapLLMError(error, errorCtx);
  }
}

// === pi-ai Unified Implementation ===

/**
 * Build a pi-ai Model<Api> for a specific per-call model name.
 * The base template comes from client._piModel (created in createLLMClient);
 * we override .id / .name when the caller passes a different model string
 * (e.g. agent overrides).
 */
function resolvePiModel(client: LLMClient, model: string): PiModel<PiApi> {
  const base = client._piModel!;
  if (base.id === model || base.name === model) return base;
  const modelCard = lookupModel(client.service ?? "custom", model);
  return {
    ...base,
    id: modelCard?.deploymentName ?? model,
    name: model,
    contextWindow: modelCard?.contextWindowTokens ?? base.contextWindow,
    maxTokens: modelCard?.maxOutput ?? base.maxTokens,
  };
}

/** Convert inkos LLMMessage[] to pi-ai Context. */
function toPiContext(messages: ReadonlyArray<LLMMessage>): PiContext {
  const systemParts = messages.filter((m) => m.role === "system").map((m) => m.content);
  const systemPrompt = systemParts.length > 0 ? systemParts.join("\n\n") : undefined;
  const piMessages = messages
    .filter((m) => m.role !== "system")
    .map((m) => {
      if (m.role === "user") {
        return { role: "user" as const, content: m.content, timestamp: STABLE_PI_CONTEXT_TIMESTAMP };
      }
      // assistant
      return {
        role: "assistant" as const,
        content: [{ type: "text" as const, text: m.content }],
        api: "openai-completions" as PiApi,
        provider: "openai",
        model: "",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "stop" as const,
        timestamp: STABLE_PI_CONTEXT_TIMESTAMP,
      };
    });
  return { systemPrompt, messages: piMessages };
}

/** Convert inkos AgentMessage[] to pi-ai Context (with tool calls/results). */
function agentMessagesToPiContext(messages: ReadonlyArray<AgentMessage>): PiContext {
  const systemParts = messages.filter((m) => m.role === "system").map((m) => (m as { content: string }).content);
  const systemPrompt = systemParts.length > 0 ? systemParts.join("\n\n") : undefined;
  const piMessages: PiContext["messages"] = [];
  for (const msg of messages) {
    if (msg.role === "system") continue;
    if (msg.role === "user") {
      piMessages.push({ role: "user", content: msg.content, timestamp: STABLE_PI_CONTEXT_TIMESTAMP });
      continue;
    }
    if (msg.role === "assistant") {
      const content: (PiTextContent | PiToolCall)[] = [];
      if (msg.content) content.push({ type: "text", text: msg.content });
      if (msg.toolCalls) {
        for (const tc of msg.toolCalls) {
          content.push({
            type: "toolCall",
            id: tc.id,
            name: tc.name,
            arguments: JSON.parse(tc.arguments),
          });
        }
      }
      if (content.length === 0) content.push({ type: "text", text: "" });
      piMessages.push({
        role: "assistant",
        content,
        api: "openai-completions" as PiApi,
        provider: "openai",
        model: "",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "stop",
        timestamp: STABLE_PI_CONTEXT_TIMESTAMP,
      });
      continue;
    }
    if (msg.role === "tool") {
      piMessages.push({
        role: "toolResult",
        toolCallId: msg.toolCallId,
        toolName: "",
        content: [{ type: "text", text: msg.content }],
        isError: false,
        timestamp: STABLE_PI_CONTEXT_TIMESTAMP,
      });
    }
  }
  return { systemPrompt, messages: piMessages };
}

/** Convert inkos ToolDefinition[] to pi-ai Tool[]. */
function toPiTools(tools: ReadonlyArray<ToolDefinition>): PiTool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters as PiTool["parameters"],
  }));
}

function agentMessagesToOpenAIChatMessages(messages: ReadonlyArray<AgentMessage>): Array<Record<string, unknown>> {
  return messages.map((message) => {
    if (message.role === "assistant") {
      return {
        role: "assistant",
        content: message.content ?? null,
        ...(message.toolCalls && message.toolCalls.length > 0
          ? {
              tool_calls: message.toolCalls.map((toolCall) => ({
                id: toolCall.id,
                type: "function",
                function: {
                  name: toolCall.name,
                  arguments: toolCall.arguments,
                },
              })),
            }
          : {}),
      };
    }
    if (message.role === "tool") {
      return {
        role: "tool",
        tool_call_id: message.toolCallId,
        content: message.content,
      };
    }
    return { role: message.role, content: message.content };
  });
}

function toOpenAITools(tools: ReadonlyArray<ToolDefinition>): Array<Record<string, unknown>> {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

function extractOpenAIToolCalls(json: unknown): ToolCall[] {
  const choices = readJsonPath(json, ["choices"]);
  if (!Array.isArray(choices)) return [];
  const message = readJsonPath(choices[0], ["message"]);
  if (!isJsonRecord(message)) return [];
  const rawToolCalls = readJsonPath(message, ["tool_calls"]);
  if (!Array.isArray(rawToolCalls)) return [];
  return rawToolCalls.flatMap((item): ToolCall[] => {
    if (!isJsonRecord(item)) return [];
    const id = readJsonString(item, ["id"]);
    const name = readJsonString(item, ["function", "name"]);
    const args = readJsonString(item, ["function", "arguments"]) ?? "{}";
    if (!id || !name) return [];
    return [{ id, name, arguments: args }];
  });
}

async function chatWithToolsViaNativeOpenAICompatible(
  client: LLMClient,
  model: string,
  messages: ReadonlyArray<AgentMessage>,
  tools: ReadonlyArray<ToolDefinition>,
  resolved: { readonly temperature: number; readonly maxTokens: number },
): Promise<ChatWithToolsResult> {
  const baseUrl = client._piModel?.baseUrl ?? "";
  const errorCtx = { baseUrl, model, service: client.service };
  const payload: Record<string, unknown> = {
    model: resolvePiModel(client, model).id,
    messages: agentMessagesToOpenAIChatMessages(messages),
    tools: toOpenAITools(tools),
    tool_choice: "auto",
    stream: client.stream,
    temperature: resolved.temperature,
    max_tokens: resolved.maxTokens,
  };
  if (client.stream) {
    payload.stream_options = { include_usage: true };
  }

  const response = await fetchWithProxy(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: buildCustomHeaders(client),
    body: JSON.stringify(payload),
  }, client.proxyUrl);
  if (!response.ok) {
    throw wrapLLMError(new Error(await readErrorResponse(response)), errorCtx);
  }

  if (!client.stream) {
    const json = await response.json() as unknown;
    return {
      content: extractChatContent(json) || "",
      toolCalls: extractOpenAIToolCalls(json),
    };
  }

  const reader = response.body?.getReader();
  if (!reader) throw wrapLLMError(new Error("Streaming body unavailable"), errorCtx);
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  const toolCallParts = new Map<number, { id: string; name: string; arguments: string }>();

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parsed = parseSseEvents(buffer);
    buffer = parsed.rest;
    for (const event of parsed.events) {
      if (!event.data || event.data === "[DONE]") continue;
      const json = JSON.parse(event.data) as unknown;
      const delta = extractChatDeltaContent(json);
      if (delta) content += delta;
      const choices = readJsonPath(json, ["choices"]);
      if (!Array.isArray(choices)) continue;
      const rawToolCalls = readJsonPath(choices[0], ["delta", "tool_calls"]);
      if (!Array.isArray(rawToolCalls)) continue;
      for (const raw of rawToolCalls) {
        if (!isJsonRecord(raw)) continue;
        const index = readJsonNumber(raw, ["index"]) ?? 0;
        const current = toolCallParts.get(index) ?? { id: "", name: "", arguments: "" };
        const id = readJsonString(raw, ["id"]);
        const name = readJsonString(raw, ["function", "name"]);
        const args = readJsonString(raw, ["function", "arguments"]);
        toolCallParts.set(index, {
          id: id ?? current.id,
          name: name ?? current.name,
          arguments: current.arguments + (args ?? ""),
        });
      }
    }
  }

  return {
    content,
    toolCalls: [...toolCallParts.values()]
      .filter((toolCall) => toolCall.id && toolCall.name)
      .map((toolCall) => ({
        id: toolCall.id,
        name: toolCall.name,
        arguments: toolCall.arguments || "{}",
      })),
  };
}

async function chatCompletionViaPiAi(
  client: LLMClient,
  model: string,
  messages: ReadonlyArray<LLMMessage>,
  resolved: { readonly temperature: number; readonly maxTokens: number; readonly extra: Record<string, unknown> },
  onStreamProgress?: OnStreamProgress,
  onTextDelta?: (text: string) => void,
  signal?: AbortSignal,
): Promise<LLMResponse> {
  const piModel = resolvePiModel(client, model);
  const context = toPiContext(messages);
  const streamOpts = {
    temperature: resolved.temperature,
    maxTokens: resolved.maxTokens,
    apiKey: client._apiKey,
    headers: mergeUserAgent(piModel.headers),
  };

  if (!client.stream) {
    throwIfAborted(signal);
    const response = await piCompleteSimple(piModel, context, streamOpts);
    throwIfAborted(signal);
    if (response.stopReason === "error" && response.errorMessage) {
      throw new Error(response.errorMessage);
    }
    const content = response.content
      .filter((block): block is { type: "text"; text: string } => block.type === "text")
      .map((block) => block.text)
      .join("");
    if (!content) {
      const diag = `usage=${response.usage.input}+${response.usage.output}`;
      console.warn(`[inkos] LLM 非流式响应无文本内容 (${diag})`);
      throw new Error(`LLM returned empty response (${diag})`);
    }
    return {
      content,
      usage: {
        promptTokens: response.usage.input,
        completionTokens: response.usage.output,
        totalTokens: response.usage.totalTokens,
      },
    };
  }

  const eventStream = piStreamSimple(piModel, context, streamOpts);
  const chunks: string[] = [];
  const monitor = createStreamMonitor(onStreamProgress);
  let inputTokens = 0;
  let outputTokens = 0;

  try {
    for await (const event of eventStream) {
      throwIfAborted(signal);
      if (event.type === "text_delta") {
        chunks.push(event.delta);
        monitor.onChunk(event.delta);
        onTextDelta?.(event.delta);
      }
      if (event.type === "done" || event.type === "error") {
        const msg = event.type === "done" ? event.message : event.error;
        inputTokens = msg.usage.input;
        outputTokens = msg.usage.output;
        if (event.type === "error" && msg.errorMessage) {
          const partial = chunks.join("");
          if (partial.length >= MIN_SALVAGEABLE_CHARS) {
            throw new PartialResponseError(partial, new Error(msg.errorMessage));
          }
          throw new Error(msg.errorMessage);
        }
      }
    }
  } catch (streamError) {
    monitor.stop();
    if (streamError instanceof PartialResponseError) throw streamError;
    const partial = chunks.join("");
    if (partial.length >= MIN_SALVAGEABLE_CHARS) {
      throw new PartialResponseError(partial, streamError);
    }
    throw streamError;
  } finally {
    monitor.stop();
  }

  const content = chunks.join("");
  if (!content) {
    const diag = `usage=${inputTokens}+${outputTokens}`;
    console.warn(`[inkos] LLM 流式响应无文本内容 (${diag})`);
    throw new Error(`LLM returned empty response from stream (${diag})`);
  }

  return {
    content,
    usage: {
      promptTokens: inputTokens,
      completionTokens: outputTokens,
      totalTokens: inputTokens + outputTokens,
    },
  };
}

async function chatWithToolsViaPiAi(
  client: LLMClient,
  model: string,
  messages: ReadonlyArray<AgentMessage>,
  tools: ReadonlyArray<ToolDefinition>,
  resolved: { readonly temperature: number; readonly maxTokens: number },
): Promise<ChatWithToolsResult> {
  const piModel = resolvePiModel(client, model);
  const context = agentMessagesToPiContext(messages);
  context.tools = toPiTools(tools);
  const streamOpts = {
    temperature: resolved.temperature,
    maxTokens: resolved.maxTokens,
    apiKey: client._apiKey,
    headers: mergeUserAgent(piModel.headers),
  };

  if (!client.stream) {
    const response = await piComplete(piModel, context, streamOpts);
    if (response.stopReason === "error" && response.errorMessage) {
      throw new Error(response.errorMessage);
    }
    const content = response.content
      .filter((block): block is { type: "text"; text: string } => block.type === "text")
      .map((block) => block.text)
      .join("");
    const toolCalls = response.content
      .filter((block): block is PiToolCall => block.type === "toolCall")
      .map((block) => ({
        id: block.id,
        name: block.name,
        arguments: JSON.stringify(block.arguments),
      }));
    return { content, toolCalls };
  }

  const eventStream = piStream(piModel, context, streamOpts);
  let content = "";
  const toolCalls: ToolCall[] = [];

  for await (const event of eventStream) {
    if (event.type === "text_delta") {
      content += event.delta;
    }
    if (event.type === "toolcall_end") {
      toolCalls.push({
        id: event.toolCall.id,
        name: event.toolCall.name,
        arguments: JSON.stringify(event.toolCall.arguments),
      });
    }
    if (event.type === "error" && event.error.errorMessage) {
      throw new Error(event.error.errorMessage);
    }
  }

  return { content, toolCalls };
}
