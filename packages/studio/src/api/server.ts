import { Hono } from "hono";
import { cors } from "hono/cors";
import { bodyLimit } from "hono/body-limit";
import { streamSSE } from "hono/streaming";
import { serve } from "@hono/node-server";
import {
  StateManager,
  PipelineRunner,
  createLLMClient,
  createLogger,
  createInteractionToolsFromDeps,
  computeAnalytics,
  loadProjectConfig,
  loadProjectSession,
  processProjectInteractionRequest,
  resolveSessionActiveBook,
  listBookSessions,
  loadBookSession,
  appendManualSessionMessages,
  createAndPersistBookSession,
  renameBookSession,
  deleteBookSession,
  deleteBookSessionMessage,
  migrateBookSession,
  SessionAlreadyMigratedError,
  runAgentSession,
  resolveServicePreset,
  resolveServiceProviderFamily,
  resolveServiceModelsBaseUrl,
  guessServiceFromBaseUrl,
  resolveServiceModel,
  loadSecrets,
  saveSecrets,
  listModelsForService,
  isApiKeyOptionalForEndpoint,
  getAllEndpoints,
  probeModelsFromUpstream,
  verifyService,
  fetchWithProxy,
  chatCompletion,
  buildExportArtifact,
  evaluateBookQuality,
  ConsolidatorAgent,
  DetectionConfigSchema,
  InputGovernanceModeSchema,
  GLOBAL_ENV_PATH,
  COVER_PROVIDER_PRESETS,
  createPlayDB,
  PlayStore,
  buildPlayEntityImagePrompt,
  buildPlaySceneImagePrompt,
  generatePlayImage,
  readPlayImageManifest,
  deletePlayImageEntry,
  readPlayImageSettings,
  writePlayImageSettings,
  type PlayImageSettings,
  Scheduler,
  coverSecretKey,
  resolveCoverProviderPreset,
  SessionKindSchema,
  isExplicitWriteChapterCommand,
  isUsablePlayInitialScene,
  isWriteNextInstruction,
  normalizeActionSource as normalizeCoreActionSource,
  normalizeActionPayload as normalizeCoreActionPayload,
  normalizePlayMode as normalizeCorePlayMode,
  normalizeRequestedIntent as normalizeCoreRequestedIntent,
  inferLanguage,
  type ActionPayload,
  type ActionSource,
  createGenerateCoverTool,
  generateShortFictionCover,
  generateImageFromPrompt,
  resolveCoverGenerationRequest,
  createPlayStartTool,
  createShortFictionRunTool,
  createSubAgentTool,
  type ResolvedModel,
  type PipelineConfig,
  type PlayMode,
  type ProjectConfig,
  type LogSink,
  type LogEntry,
  type RequestedIntent,
  type LLMRequestDiagnostics,
  type AgentRequestDiagnostics,
  type SessionKind,
  KnowledgeStore,
} from "@actalk/inkos-core";
import { access, appendFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { isSafeBookId } from "./safety.js";
import { ApiError } from "./errors.js";
import { buildStudioBookConfig } from "./book-create.js";
import { initializeStudioProject, registerRuntimeRoutes } from "./runtime-routes.js";
import { HeadroomMcpManager } from "./headroom-mcp.js";
import { extractTextWithPython } from "./python-runtime.js";
import {
  LEGACY_SHIM_FILES,
  RUNTIME_DIAGNOSTIC_FILE_RE,
  RUNTIME_STATE_FILE_RE,
  listBookTruthFiles,
  listTruthFileHistory,
  readTruthFileHistory,
  resolveTruthFilePath,
} from "./truth-files.js";

// -- Pipeline stage definitions per agent type --

const PIPELINE_STAGES: Record<string, string[]> = {
  writer: [
    "准备章节输入", "撰写章节草稿", "落盘最终章节",
    "生成最终真相文件", "校验真相文件变更", "同步记忆索引",
    "更新章节索引与快照",
  ],
  architect: [
    "生成基础设定", "保存书籍配置", "写入基础设定文件",
    "初始化控制文档", "创建初始快照",
  ],
  reviser: [
    "加载修订上下文", "修订章节", "落盘修订结果",
    "更新索引与快照",
  ],
  "state-repair": [
    "读取降级章节与现有状态",
    "重新结算章节 truth/state",
    "校验状态变更",
    "保存真相文件与记忆索引",
    "恢复章节状态并创建快照",
  ],
  auditor: ["审计章节"],
};

const AGENT_LABELS: Record<string, string> = {
  architect: "建书", writer: "写作", auditor: "审计",
  reviser: "修订", exporter: "导出", "state-repair": "恢复章节状态",
};
const LARGE_MODEL_PROMPT_WARN_CHARS = 60_000;
const HUGE_MODEL_PROMPT_WARN_CHARS = 120_000;
const TOOL_LABELS: Record<string, string> = {
  read: "读取文件", edit: "编辑文件", grep: "搜索", ls: "列目录",
  propose_action: "确认动作",
  short_fiction_run: "短篇生产",
  generate_cover: "生成封面",
  play_edit: "编辑互动世界",
  play_start: "启动互动世界",
  play_revise: "重做互动回合",
  play_step: "推进互动世界",
};

function resolveToolLabel(tool: string, agent?: string): string {
  if (tool === "sub_agent" && agent) return AGENT_LABELS[agent] ?? agent;
  return TOOL_LABELS[tool] ?? tool;
}

function summarizeResult(result: unknown): string {
  if (typeof result === "string") return result.slice(0, 200);
  if (result && typeof result === "object") {
    const r = result as Record<string, unknown>;
    if (typeof r.content === "string") return r.content.slice(0, 200);
    if (typeof r.text === "string") return r.text.slice(0, 200);
  }
  return String(result).slice(0, 200);
}

function compareServiceListItems(
  left: { readonly service: string },
  right: { readonly service: string },
): number {
  const priority = ["kkaiapi", "openrouter", "newapi", "siliconcloud"];
  const leftPriority = priority.indexOf(left.service);
  const rightPriority = priority.indexOf(right.service);
  if (leftPriority !== -1 || rightPriority !== -1) {
    return (leftPriority === -1 ? 999 : leftPriority) - (rightPriority === -1 ? 999 : rightPriority);
  }
  return 0;
}

function isHeaderSafeApiKey(value: string): boolean {
  if (!value) return true;
  return /^[\x21-\x7E]+$/.test(value);
}

const NON_TEXT_MODEL_ID_PARTS = [
  "image",
  "embedding",
  "embed",
  "rerank",
  "tts",
  "speech",
  "audio",
  "moderation",
] as const;

const SERVICE_MODELS_PROBE_TIMEOUT_MS = 4_000;
const SERVICE_CHAT_PROBE_TIMEOUT_MS = 8_000;
// Hard ceiling for the whole /doctor connectivity probe (models + chat fallback
// loop) so the diagnostics page never spins on a slow/rate-limited upstream.
const DOCTOR_LLM_PROBE_BUDGET_MS = 9_000;
const MAX_DISCOVERED_MODELS_TO_PING = 2;
const MAX_GENERIC_FALLBACK_MODELS_TO_PING = 2;

function isTextChatModelId(modelId: string): boolean {
  const normalized = modelId.trim().toLowerCase();
  if (!normalized) return false;
  return !NON_TEXT_MODEL_ID_PARTS.some((part) => normalized.includes(part));
}

function filterTextChatModels<T extends { readonly id: string }>(models: ReadonlyArray<T>): T[] {
  return models.filter((model) => isTextChatModelId(model.id));
}

function normalizeApiBookId(value: unknown, fieldName: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new ApiError(400, "INVALID_BOOK_ID", `${fieldName} must be a string`);
  }
  const bookId = value.trim();
  if (!bookId) {
    throw new ApiError(400, "INVALID_BOOK_ID", `${fieldName} cannot be blank`);
  }
  if (!isSafeBookId(bookId)) {
    throw new ApiError(400, "INVALID_BOOK_ID", `Invalid ${fieldName}: "${bookId}"`);
  }
  return bookId;
}

function nonTextModelMessage(modelId: string): string {
  return `模型 ${modelId} 不适合文本聊天/写作。请在模型选择器中改用文本模型，例如 gemini-2.5-flash、gemini-2.5-pro 或对应服务的 chat 模型。`;
}

function extractToolError(result: unknown): string {
  if (typeof result === "string") return result.slice(0, 500);
  if (result && typeof result === "object") {
    const r = result as Record<string, unknown>;
    if (typeof r.content === "string") return r.content.slice(0, 500);
    if (r.content && Array.isArray(r.content)) {
      const textPart = r.content.find((c: any) => c.type === "text");
      if (textPart) return (textPart as any).text?.slice(0, 500) ?? "";
    }
  }
  return String(result).slice(0, 500);
}

function resolveProjectImageFile(root: string, rawPath: string): { readonly resolved: string; readonly contentType: string } {
  let relPath: string;
  try {
    relPath = decodeURIComponent(rawPath).replace(/^\/+/u, "");
  } catch {
    throw new ApiError(400, "INVALID_PROJECT_FILE_PATH", "Invalid project file path");
  }

  if (
    !relPath
    || relPath.includes("\0")
    || isAbsolute(relPath)
    || relPath.split(/[\\/]+/u).includes("..")
  ) {
    throw new ApiError(400, "INVALID_PROJECT_FILE_PATH", "Invalid project file path");
  }
  if (!relPath.startsWith("shorts/") && !relPath.startsWith("covers/") && !relPath.startsWith("wallpapers/")) {
    throw new ApiError(400, "INVALID_PROJECT_FILE_PATH", "Only generated shorts/, covers/, and wallpapers/ images can be previewed");
  }

  const ext = relPath.split(".").pop()?.toLowerCase() ?? "";
  const contentTypes: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    webp: "image/webp",
  };
  const contentType = contentTypes[ext];
  if (!contentType) {
    throw new ApiError(415, "UNSUPPORTED_PROJECT_FILE_TYPE", "Unsupported project file type");
  }

  const resolved = resolve(root, relPath);
  const rel = relative(root, resolved);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
    throw new ApiError(400, "INVALID_PROJECT_FILE_PATH", "Invalid project file path");
  }
  return { resolved, contentType };
}

type GeneratedImageLibraryItem = {
  readonly id: string;
  readonly source: "play" | "project";
  readonly kind: "scene" | "actor" | "item" | "cover" | "short" | "wallpaper" | "other";
  readonly status: "ready" | "failed";
  readonly title: string;
  readonly subtitle?: string;
  readonly url?: string;
  readonly error?: string;
  readonly updatedAt?: string;
  readonly worldId?: string;
  readonly runId?: string;
  readonly key?: string;
  readonly path?: string;
};

function projectFileUrl(relPath: string): string {
  return `/api/v1/project/files/${relPath.split("/").map(encodeURIComponent).join("/")}`;
}

function playImageUrl(worldId: string, runId: string, file?: string): string | undefined {
  return file ? `/api/v1/play/runs/${encodeURIComponent(worldId)}/${encodeURIComponent(runId)}/images/${encodeURIComponent(file)}` : undefined;
}

function classifyPlayImageKind(key: string): GeneratedImageLibraryItem["kind"] {
  if (key.startsWith("scene-turn-")) return "scene";
  const lowered = key.toLowerCase();
  if (lowered.includes("actor") || lowered.includes("character") || lowered.includes("player")) return "actor";
  if (lowered.includes("item") || lowered.includes("evidence") || lowered.includes("clue")) return "item";
  return "other";
}

function classifyProjectImageKind(relPath: string): GeneratedImageLibraryItem["kind"] {
  if (relPath.startsWith("covers/")) return "cover";
  if (relPath.startsWith("shorts/")) return "short";
  if (relPath.startsWith("wallpapers/")) return "wallpaper";
  return "other";
}

function isSupportedGeneratedImageFile(name: string): boolean {
  return /\.(?:png|jpe?g|webp)$/i.test(name);
}

function encodeLibraryId(parts: ReadonlyArray<string>): string {
  return parts.map((part) => encodeURIComponent(part)).join(":");
}

function decodeLibraryId(id: string): string[] {
  return id.split(":").map((part) => decodeURIComponent(part));
}

async function listProjectGeneratedImages(root: string): Promise<GeneratedImageLibraryItem[]> {
  const items: GeneratedImageLibraryItem[] = [];
  const roots = ["covers", "shorts", "wallpapers"] as const;

  async function walk(base: string, relDir: string): Promise<void> {
    let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
    try {
      entries = await readdir(join(base, relDir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;
      const fullPath = join(base, relPath);
      if (entry.isDirectory()) {
        await walk(base, relPath);
        continue;
      }
      if (!entry.isFile() || !isSupportedGeneratedImageFile(entry.name)) continue;
      const projectRelPath = relPath.replace(/\\/g, "/");
      const fileStat = await stat(fullPath).catch(() => null);
      const parts = projectRelPath.split("/");
      const parent = parts.length > 1 ? parts.at(-2) ?? "" : "";
      const title = entry.name.replace(/\.[^.]+$/u, "") || entry.name;
      items.push({
        id: encodeLibraryId(["project", projectRelPath]),
        source: "project",
        kind: classifyProjectImageKind(projectRelPath),
        status: "ready",
        title: title === "cover" && parent ? parent : title,
        subtitle: projectRelPath,
        url: projectFileUrl(projectRelPath),
        updatedAt: fileStat?.mtime.toISOString(),
        path: projectRelPath,
      });
    }
  }

  for (const folder of roots) {
    await walk(root, folder);
  }
  return items;
}

async function listPlayGeneratedImages(root: string): Promise<GeneratedImageLibraryItem[]> {
  const store = new PlayStore(root);
  const worlds = await store.listWorlds();
  const items: GeneratedImageLibraryItem[] = [];
  for (const world of worlds) {
    const runs = await store.listRuns(world.id);
    for (const run of runs) {
      const runDir = store.runDir(world.id, run.id);
      const manifest = await readPlayImageManifest(runDir);
      const manifestStat = await stat(join(runDir, "images", "manifest.json")).catch(() => null);
      for (const [key, entry] of Object.entries(manifest)) {
        if (entry.status === "deleted") continue;
        const kind = classifyPlayImageKind(key);
        items.push({
          id: encodeLibraryId(["play", world.id, run.id, key]),
          source: "play",
          kind,
          status: entry.status,
          title: key.startsWith("scene-turn-")
            ? `Turn ${key.replace(/^scene-turn-/u, "")}`
            : key,
          subtitle: [world.title, run.id].filter(Boolean).join(" / "),
          url: entry.status === "ready" ? playImageUrl(world.id, run.id, entry.file) : undefined,
          error: entry.error,
          updatedAt: manifestStat?.mtime.toISOString() ?? run.updatedAt,
          worldId: world.id,
          runId: run.id,
          key,
        });
      }
    }
  }
  return items;
}

function isLikelyFailedToolResult(exec: CollectedToolExec): boolean {
  if (exec.status === "error") return true;
  const text = `${exec.error ?? ""}\n${exec.result ?? ""}`.toLowerCase();
  return /\bfailed\b|\berror\b|失败|异常|出错/.test(text);
}

function hasSuccessfulSubAgentExec(
  execs: ReadonlyArray<CollectedToolExec>,
  agent: string,
): boolean {
  return execs.some((exec) =>
    exec.tool === "sub_agent"
    && exec.agent === agent
    && exec.status === "completed"
    && !isLikelyFailedToolResult(exec)
  );
}

function hasSuccessfulToolExec(
  execs: ReadonlyArray<CollectedToolExec>,
  tool: string,
): boolean {
  return execs.some((exec) =>
    exec.tool === tool
    && exec.status === "completed"
    && !isLikelyFailedToolResult(exec)
  );
}

function hasSuccessfulToolResult(execs: ReadonlyArray<CollectedToolExec>): boolean {
  return execs.some((exec) => exec.status === "completed" && !isLikelyFailedToolResult(exec));
}

function normalizeStudioSessionKind(value: unknown, fallback: SessionKind): SessionKind {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = SessionKindSchema.safeParse(value);
  if (!parsed.success) {
    throw new ApiError(400, "INVALID_SESSION_KIND", `Invalid sessionKind: ${String(value)}`);
  }
  return parsed.data;
}

function normalizeStudioActionSource(value: unknown): ActionSource {
  try {
    return normalizeCoreActionSource(value);
  } catch {
    throw new ApiError(400, "INVALID_ACTION_SOURCE", `Invalid actionSource: ${String(value)}`);
  }
}

function normalizeStudioRequestedIntent(value: unknown): RequestedIntent | undefined {
  try {
    return normalizeCoreRequestedIntent(value);
  } catch {
    throw new ApiError(400, "INVALID_REQUESTED_INTENT", `Invalid requestedIntent: ${String(value)}`);
  }
}

function normalizeStudioActionPayload(value: unknown): ActionPayload | undefined {
  try {
    return normalizeCoreActionPayload(value);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ApiError(400, "INVALID_ACTION_PAYLOAD", `Invalid actionPayload: ${message}`);
  }
}

function normalizeWriteKnowledgeOptions(value: unknown): { enabled?: boolean; sourceIds?: string[] } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const enabled = typeof record.enabled === "boolean" ? record.enabled : undefined;
  const sourceIds = Array.isArray(record.sourceIds)
    ? record.sourceIds.filter((item): item is string => typeof item === "string" && item.trim().length > 0).slice(0, 12)
    : undefined;
  if (enabled === undefined && (!sourceIds || sourceIds.length === 0)) return undefined;
  return {
    ...(enabled !== undefined ? { enabled } : {}),
    ...(sourceIds && sourceIds.length > 0 ? { sourceIds } : {}),
  };
}

function normalizeStudioPlayMode(value: unknown): PlayMode | undefined {
  try {
    return normalizeCorePlayMode(value);
  } catch {
    throw new ApiError(400, "INVALID_PLAY_MODE", `Invalid playMode: ${String(value)}`);
  }
}

function isExplicitCreateBookInstruction(instruction: string): boolean {
  const trimmed = instruction.trim();
  if (!trimmed) return false;
  if (
    /[\uFF1F?]\s*$/.test(trimmed)
    && /(?:\u80FD\u4E0D\u80FD|\u53EF\u4EE5|\u662F\u5426|\u600E\u4E48|\u5982\u4F55|\u5EFA\u8BAE)/u.test(trimmed)
  ) {
    return false;
  }

  const imperative = trimmed.replace(
    /^(?:\u8BF7|\u9EBB\u70E6|\u5E2E\u6211|\u7ED9\u6211|\u66FF\u6211|\u76F4\u63A5|\u73B0\u5728|\u5F00\u59CB|\u7ACB\u523B|\u9A6C\u4E0A)\s*/u,
    "",
  );
  if (
    /^(?:\u5EFA\u4E66|\u521B\u5EFA(?:\u4E00?\u672C)?(?:\u4E66|\u4E66\u7C4D|\u5C0F\u8BF4|\u957F\u7BC7|\u8FDE\u8F7D|\u4F5C\u54C1)|\u65B0\u5EFA(?:\u4E00?\u672C)?(?:\u4E66|\u4E66\u7C4D|\u5C0F\u8BF4|\u957F\u7BC7|\u8FDE\u8F7D|\u4F5C\u54C1)|\u751F\u6210(?:\u4E00?\u672C)?(?:\u4E66|\u4E66\u7C4D|\u5C0F\u8BF4|\u957F\u7BC7|\u8FDE\u8F7D|\u4F5C\u54C1))(?:\s|[\uFF0C\u3002,.!\uFF01?\uFF1F;\uFF1B:\uFF1A]|$)/u.test(imperative)
    || /^(?:\u521B\u5EFA|\u65B0\u5EFA|\u751F\u6210)(?:\u4E00?\u672C)?[\u3400-\u9fffA-Za-z0-9_\-\s]{0,40}(?:\u4E66|\u4E66\u7C4D|\u5C0F\u8BF4|\u957F\u7BC7|\u8FDE\u8F7D|\u4F5C\u54C1)(?:\s|[\uFF0C\u3002,.!\uFF01?\uFF1F;\uFF1B:\uFF1A]|$)/u.test(imperative)
  ) {
    return true;
  }

  return /^(?:please\s+)?(?:create|start|build|make|generate)\s+(?:me\s+)?(?:a\s+)?(?:new\s+)?(?:book|novel|long[-\s]?form|serial)(?:\b|$)/i.test(trimmed);
}

function shouldRouteChatCreateBookToBookCreate(args: {
  readonly instruction: string;
  readonly agentBookId: string | null | undefined;
  readonly sessionKind: SessionKind;
  readonly actionSource: ActionSource;
  readonly requestedIntent?: RequestedIntent;
}): boolean {
  return !args.agentBookId
    && args.sessionKind === "chat"
    && args.actionSource === "free-text"
    && !args.requestedIntent
    && isExplicitCreateBookInstruction(args.instruction);
}

function shouldRunDirectWriteNext(args: {
  readonly instruction: string;
  readonly agentBookId: string | null | undefined;
  readonly sessionKind: SessionKind;
  readonly actionSource: ActionSource;
  readonly requestedIntent?: RequestedIntent;
}): boolean {
  if (!args.agentBookId || args.sessionKind !== "book") return false;
  if (args.requestedIntent === "write_next") return true;
  if (args.actionSource === "free-text") return isExplicitWriteChapterCommand(args.instruction);
  return isWriteNextInstruction(args.instruction);
}

function requestedRepairChapter(instruction: string): number | null {
  const match = instruction.match(/(?:第\s*)?(\d+)\s*章/);
  if (!match) return null;
  const chapter = Number.parseInt(match[1]!, 10);
  return Number.isSafeInteger(chapter) && chapter > 0 ? chapter : null;
}

type ExternalChatEditResult = {
  readonly responseText: string;
  readonly activeBookId?: string;
};

const CHAT_EDIT_WARNING = "[warning] Chat external edit requires review before continuation.";
const CHAT_EDIT_TEXT_EXTENSIONS = /\.(md|txt|json|ya?ml)$/i;
const CHAT_EDIT_ALLOWED_ROOTS = new Set(["books", "shorts", "covers", "genres"]);

function parseReplacementInstruction(instruction: string): { oldText: string; newText: string } | null {
  const inFileQuoted = instruction.match(/(?:里|里的|中|中的|里面)\s*[「“"]([\s\S]+?)[」”"]\s*(?:改成|替换成|换成)\s*[「“"]([\s\S]+?)[」”"]/);
  if (inFileQuoted?.[1] && inFileQuoted[2] !== undefined) {
    return { oldText: inFileQuoted[1], newText: inFileQuoted[2] };
  }
  const quoted = instruction.match(/(?:把|将)\s*[「“"]([\s\S]+?)[」”"]\s*(?:改成|替换成|换成)\s*[「“"]([\s\S]+?)[」”"]/);
  if (quoted?.[1] && quoted[2] !== undefined) {
    return { oldText: quoted[1], newText: quoted[2] };
  }
  const plain = instruction.match(/(?:把|将)\s+([^\s，。；;]+)\s*(?:改成|替换成|换成)\s+([^\n，。；;]+)/);
  if (plain?.[1] && plain[2] !== undefined) {
    return { oldText: plain[1], newText: plain[2].trim() };
  }
  return null;
}

function isExplicitExternalChatEditInstruction(instruction: string): boolean {
  const trimmed = instruction.trim();
  if (!trimmed) return false;
  if (/[?？]\s*$/.test(trimmed)) return false;
  if (/^(?:请问|能否|能不能|可以|可不可以|是否|是不是|怎么|怎样|为什么|如果|假如|要不要|建议|讨论)\b/u.test(trimmed)) {
    return false;
  }

  const imperative = trimmed.replace(/^(?:请|麻烦|帮我|直接|现在)\s*/u, "");
  return /^(?:第\s*\d{1,4}\s*章\s*)?(?:把|将)\s*/u.test(imperative);
}

function parseChapterNumberForEdit(instruction: string): number | null {
  const match = instruction.match(/第\s*(\d{1,4})\s*章/);
  if (!match?.[1]) return null;
  const chapterNumber = Number.parseInt(match[1], 10);
  return Number.isInteger(chapterNumber) && chapterNumber > 0 ? chapterNumber : null;
}

function parseExplicitEditPath(instruction: string): string | null {
  const match = instruction.match(/(?:把|将)\s+([^「“"\s，。；;]+?\.[A-Za-z0-9]+)\s*(?:里|里的|中|中的|里面)/);
  return match?.[1]?.trim() ?? null;
}

function countContentUnits(content: string): number {
  const stripped = content
    .replace(/^#{1,6}\s+.*$/gm, "")
    .trim();
  if (!stripped) return 0;
  if (/[\u3400-\u9fff]/.test(stripped)) {
    return stripped.replace(/\s/g, "").length;
  }
  return stripped.split(/\s+/).filter(Boolean).length;
}

function resolveExternalChatEditPath(root: string, requestedPath: string): { path: string; rel: string } {
  if (isAbsolute(requestedPath)) {
    throw new ApiError(400, "UNSUPPORTED_CHAT_EDIT_TARGET", "Chat external edits only support project-relative content paths.");
  }
  const projectRoot = resolve(root);
  const resolved = resolve(projectRoot, requestedPath);
  const rel = relative(projectRoot, resolved).replace(/\\/g, "/");
  if (!rel || rel.startsWith("../") || rel === "..") {
    throw new ApiError(400, "UNSUPPORTED_CHAT_EDIT_TARGET", "Chat external edit path escapes the project root.");
  }
  const first = rel.split("/")[0] ?? "";
  if (!CHAT_EDIT_ALLOWED_ROOTS.has(first)) {
    throw new ApiError(400, "UNSUPPORTED_CHAT_EDIT_TARGET", "Chat external edits cannot modify source code, config, or arbitrary project files.");
  }
  if (rel.includes("/.inkos/") || rel.endsWith("/.inkos") || rel.includes("/secrets") || rel.endsWith(".env")) {
    throw new ApiError(400, "UNSUPPORTED_CHAT_EDIT_TARGET", "Chat external edits cannot modify secrets or runtime internals.");
  }
  if (!CHAT_EDIT_TEXT_EXTENSIONS.test(rel)) {
    throw new ApiError(400, "UNSUPPORTED_CHAT_EDIT_TARGET", "Chat external edits only support text content files.");
  }
  return { path: resolved, rel };
}

async function findChapterFile(root: string, bookId: string, chapterNumber: number): Promise<string | null> {
  const chaptersDir = join(root, "books", bookId, "chapters");
  const padded = String(chapterNumber).padStart(4, "0");
  const files = await readdir(chaptersDir).catch(() => []);
  const match = files.find((file) => file.startsWith(`${padded}_`) && file.endsWith(".md"));
  return match ? join(chaptersDir, match) : null;
}

function sanitizeChapterFilenameTitle(title: string): string {
  return title
    .replace(/[/\\?%*:|"<>]/g, "")
    .replace(/\s+/g, "_")
    .slice(0, 50)
    || "Untitled";
}

function buildChapterHeading(existingHeading: string | undefined, chapterNumber: number, title: string): string {
  if (existingHeading && /^#\s*第\s*\d+\s*章/.test(existingHeading)) {
    return `# 第${chapterNumber}章 ${title}`;
  }
  if (existingHeading && /^#\s*Chapter\s+\d+/i.test(existingHeading)) {
    return `# Chapter ${chapterNumber}: ${title}`;
  }
  return `# ${title}`;
}

function replaceChapterTitleInMarkdown(content: string, chapterNumber: number, title: string): string {
  const lines = content.split("\n");
  const headingIndex = lines.findIndex((line) => line.startsWith("# "));
  if (headingIndex >= 0) {
    lines[headingIndex] = buildChapterHeading(lines[headingIndex], chapterNumber, title);
    return lines.join("\n");
  }
  return `${buildChapterHeading(undefined, chapterNumber, title)}\n\n${content}`;
}

function parseBookChapterFromRelativePath(rel: string): { bookId: string; chapterNumber: number } | null {
  const match = rel.match(/^books\/([^/]+)\/chapters\/(\d{4})_[^/]+\.md$/);
  if (!match?.[1] || !match[2]) return null;
  const chapterNumber = Number.parseInt(match[2], 10);
  return Number.isInteger(chapterNumber) ? { bookId: match[1], chapterNumber } : null;
}

async function syncExternalChapterEdit(params: {
  readonly state: StateManager;
  readonly root: string;
  readonly bookId: string;
  readonly chapterNumber: number;
  readonly content: string;
}): Promise<void> {
  const now = new Date().toISOString();
  const index = [...(await params.state.loadChapterIndex(params.bookId))];
  const updated = index.map((chapter) => chapter.number === params.chapterNumber
    ? {
        ...chapter,
        status: "audit-failed" as const,
        wordCount: countContentUnits(params.content),
        updatedAt: now,
        auditIssues: [
          ...chapter.auditIssues.filter((issue) => issue !== CHAT_EDIT_WARNING),
          CHAT_EDIT_WARNING,
        ],
      }
    : chapter);
  if (updated.length > 0) {
    await params.state.saveChapterIndex(params.bookId, updated);
  }

  const runtimeDir = join(params.root, "books", params.bookId, "story", "runtime");
  const padded = String(params.chapterNumber).padStart(4, "0");
  const runtimeFiles = await readdir(runtimeDir).catch(() => []);
  await Promise.all(
    runtimeFiles
      .filter((file) => file.startsWith(`chapter-${padded}.`))
      .map((file) => rm(join(runtimeDir, file), { force: true })),
  );
}

async function tryHandleExternalChatEdit(params: {
  readonly root: string;
  readonly state: StateManager;
  readonly instruction: string;
  readonly activeBookId: string | null;
}): Promise<ExternalChatEditResult | null> {
  const replacement = parseReplacementInstruction(params.instruction);
  if (!replacement) return null;
  if (!isExplicitExternalChatEditInstruction(params.instruction)) return null;

  const explicitPath = parseExplicitEditPath(params.instruction);
  if (explicitPath) {
    const target = resolveExternalChatEditPath(params.root, explicitPath);
    const content = await readFile(target.path, "utf-8").catch((error) => {
      throw new ApiError(404, "CHAT_EDIT_TARGET_NOT_FOUND", error instanceof Error ? error.message : String(error));
    });
    const first = content.indexOf(replacement.oldText);
    if (first === -1) {
      throw new ApiError(400, "EDIT_TARGET_NOT_FOUND", "要替换的原文没有在目标文件中找到。");
    }
    if (content.indexOf(replacement.oldText, first + replacement.oldText.length) !== -1) {
      throw new ApiError(400, "EDIT_TARGET_AMBIGUOUS", "要替换的原文出现多次，请给出更具体的一段。");
    }
    const updated = content.slice(0, first) + replacement.newText + content.slice(first + replacement.oldText.length);
    await writeFile(target.path, updated, "utf-8");

    const chapterTarget = parseBookChapterFromRelativePath(target.rel);
    if (chapterTarget) {
      await syncExternalChapterEdit({
        state: params.state,
        root: params.root,
        bookId: chapterTarget.bookId,
        chapterNumber: chapterTarget.chapterNumber,
        content: updated,
      });
    }

    return {
      activeBookId: chapterTarget?.bookId ?? params.activeBookId ?? undefined,
      responseText: `已直接编辑 ${target.rel}${chapterTarget ? "，并标记为需要复核" : ""}。`,
    };
  }

  if (!params.activeBookId) return null;
  const chapterNumber = parseChapterNumberForEdit(params.instruction);
  if (!replacement || !chapterNumber) return null;

  const chapterPath = await findChapterFile(params.root, params.activeBookId, chapterNumber);
  if (!chapterPath) {
    throw new ApiError(404, "CHAPTER_NOT_FOUND", `Chapter ${chapterNumber} not found in ${params.activeBookId}`);
  }
  if (!CHAT_EDIT_TEXT_EXTENSIONS.test(chapterPath)) {
    throw new ApiError(400, "UNSUPPORTED_EDIT_TARGET", "Chat external edits only support text files.");
  }

  const content = await readFile(chapterPath, "utf-8");
  const first = content.indexOf(replacement.oldText);
  if (first === -1) {
    throw new ApiError(400, "EDIT_TARGET_NOT_FOUND", "要替换的原文没有在目标章节中找到。");
  }
  if (content.indexOf(replacement.oldText, first + replacement.oldText.length) !== -1) {
    throw new ApiError(400, "EDIT_TARGET_AMBIGUOUS", "要替换的原文出现多次，请给出更具体的一段。");
  }

  const updated = content.slice(0, first) + replacement.newText + content.slice(first + replacement.oldText.length);
  await writeFile(chapterPath, updated, "utf-8");
  await syncExternalChapterEdit({
    state: params.state,
    root: params.root,
    bookId: params.activeBookId,
    chapterNumber,
    content: updated,
  });

  return {
    activeBookId: params.activeBookId,
    responseText: `已直接编辑 ${params.activeBookId} 第 ${chapterNumber} 章，并标记为需要复核。`,
  };
}

function validateAgentActionExecution(args: {
  readonly instruction: string;
  readonly agentBookId: string | null | undefined;
  readonly requestedIntent?: RequestedIntent;
  readonly collectedToolExecs: ReadonlyArray<CollectedToolExec>;
}): string | undefined {
  const failedExec = args.collectedToolExecs.find(isLikelyFailedToolResult);
  if (failedExec) {
    return `${failedExec.label} 执行失败：${failedExec.error ?? failedExec.result ?? "未知错误"}`;
  }

  if (
    args.agentBookId
    && args.requestedIntent === "write_next"
    && !hasSuccessfulSubAgentExec(args.collectedToolExecs, "writer")
  ) {
    return "模型声称已完成下一章，但没有实际调用写作工具。请重试；如果仍失败，请检查模型是否支持工具调用。";
  }

  if (
    !args.agentBookId
    && args.requestedIntent === "create_book"
    && !hasSuccessfulSubAgentExec(args.collectedToolExecs, "architect")
  ) {
    return "已确认建书，但模型没有实际调用建书工具。请重试；如果仍失败，请检查模型是否支持工具调用。";
  }

  if (args.requestedIntent === "short_run" && !hasSuccessfulToolExec(args.collectedToolExecs, "short_fiction_run")) {
    return "已确认生成短篇，但模型没有实际调用短篇生产工具。请重试；如果仍失败，请检查模型是否支持工具调用。";
  }

  if (args.requestedIntent === "play_start" && !hasSuccessfulToolExec(args.collectedToolExecs, "play_start")) {
    return "已确认启动互动世界，但模型没有实际调用互动世界工具。请重试；如果仍失败，请检查模型是否支持工具调用。";
  }

  if (args.requestedIntent === "generate_cover" && !hasSuccessfulToolExec(args.collectedToolExecs, "generate_cover")) {
    return "已确认生成封面，但模型没有实际调用封面工具。请重试；如果仍失败，请检查模型是否支持工具调用。";
  }

  return undefined;
}

type AgentFailureKind = "llm" | "internal" | "unknown";

function classifyAgentFailure(message: string): AgentFailureKind {
  const text = message.trim();
  if (!text) return "unknown";
  if (
    /API\s*返回|上游|upstream|Bad Gateway|temporarily unavailable|rate limit|quota|API Key|unauthorized|forbidden|无法连接到 API|fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|LLM returned empty response|Provider finish_reason|reasoning_content/i.test(text)
  ) {
    return "llm";
  }
  if (
    /PlannerParseError|Architect output missing|required sections|missing YAML frontmatter|frontmatter delimiters|parseMemo|Book creation artifact is incomplete|Short-hit draft is incomplete|工具执行失败|执行失败|sub_agent|tool execution|RUNTIME_STATE_DELTA|JSON parse|解析失败/i.test(text)
  ) {
    return "internal";
  }
  return "unknown";
}

function formatAgentFailure(message: string): { readonly code: string; readonly message: string; readonly status: 500 | 502 } {
  const kind = classifyAgentFailure(message);
  if (kind === "llm") {
    return { code: "AGENT_LLM_ERROR", message, status: 502 };
  }
  if (kind === "internal") {
    return { code: "AGENT_INTERNAL_ERROR", message: `InkOS 内部流程错误：${message}`, status: 500 };
  }
  return { code: "AGENT_ERROR", message, status: 500 };
}

interface CollectedToolExec {
  id: string;
  tool: string;
  agent?: string;
  label: string;
  status: "running" | "completed" | "error";
  args?: Record<string, unknown>;
  result?: string;
  details?: unknown;
  error?: string;
  stages?: Array<{ label: string; status: "pending" | "completed" }>;
  startedAt: number;
  completedAt?: number;
}

class ConfirmedActionExecutionError extends Error {
  readonly exec: CollectedToolExec;

  constructor(message: string, exec: CollectedToolExec, cause?: unknown) {
    super(message);
    this.name = "ConfirmedActionExecutionError";
    this.exec = exec;
    if (cause !== undefined) {
      (this as { cause?: unknown }).cause = cause;
    }
  }
}

function suppressManualTextForTool(exec: CollectedToolExec): boolean {
  return exec.tool === "play_start" || exec.tool === "play_step" || exec.tool === "play_revise";
}

function manualToolAssistantMessage(
  responseText: string,
  exec: CollectedToolExec,
  provider: string,
  model: string,
): any {
  return {
    role: "assistant",
    content: [{ type: "text", text: suppressManualTextForTool(exec) ? "" : responseText }],
    api: "anthropic-messages",
    provider,
    model,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "toolUse",
    timestamp: Date.now(),
  };
}

function resolveManualToolRoute(config: ProjectConfig, exec: CollectedToolExec): {
  readonly provider: string;
  readonly model: string;
} {
  const fallbackProvider = config.llm.service ?? config.llm.provider;
  const fallback = { provider: fallbackProvider, model: config.llm.model };
  const agent = exec.agent === "state-repair" ? "writer" : exec.agent;
  if (!agent) return fallback;
  const override = config.modelOverrides?.[agent];
  if (!override) return fallback;
  if (typeof override === "string") {
    return { provider: fallbackProvider, model: override };
  }
  return {
    provider: override.service ?? override.provider ?? fallbackProvider,
    model: override.model,
  };
}

function manualToolAppendOptions(sessionKind: SessionKind, exec: CollectedToolExec): {
  readonly sessionKind: SessionKind;
  readonly legacyDisplay: { readonly toolExecutions: readonly CollectedToolExec[] };
} {
  return {
    sessionKind,
    legacyDisplay: { toolExecutions: [exec] },
  };
}

function isConfirmedProductionAction(args: {
  readonly actionSource: ActionSource;
  readonly requestedIntent?: RequestedIntent;
}): boolean {
  return (args.actionSource === "button" || args.actionSource === "slash")
    && (
      args.requestedIntent === "create_book"
      || args.requestedIntent === "short_run"
      || args.requestedIntent === "play_start"
      || args.requestedIntent === "generate_cover"
    );
}

function requirePayloadText(value: string | undefined, message: string): string {
  const text = value?.trim();
  if (!text) {
    throw new ApiError(400, "CONFIRMED_ACTION_PAYLOAD_INCOMPLETE", message);
  }
  return text;
}

function toolResultText(result: unknown): string {
  const text = extractToolError(result).trim();
  return text || "已完成。";
}

async function executeConfirmedProductionAction(args: {
  readonly pipeline: PipelineRunner;
  readonly root: string;
  readonly sessionId: string;
  readonly streamSessionId: string;
  readonly instruction: string;
  readonly requestedIntent: RequestedIntent;
  readonly actionPayload?: ActionPayload;
  readonly playMode?: PlayMode;
}): Promise<CollectedToolExec> {
  const id = `direct-${args.requestedIntent}-${Date.now().toString(36)}`;
  const actionPayload = args.actionPayload;
  let tool: ReturnType<typeof createSubAgentTool>
    | ReturnType<typeof createShortFictionRunTool>
    | ReturnType<typeof createGenerateCoverTool>
    | ReturnType<typeof createPlayStartTool>;
  let params: Record<string, unknown>;
  let agent: string | undefined;

  if (args.requestedIntent === "create_book") {
    const payload = actionPayload?.createBook;
    const title = requirePayloadText(payload?.title, "确认建书缺少书名，请重新生成确认卡。");
    tool = createSubAgentTool(args.pipeline, null, args.root, { actionPayload });
    agent = "architect";
    params = {
      agent,
      instruction: args.instruction,
      title,
      ...(payload?.genre ? { genre: payload.genre } : {}),
      ...(payload?.platform ? { platform: payload.platform } : {}),
      ...(payload?.language ? { language: payload.language } : {}),
      ...(payload?.targetChapters ? { targetChapters: payload.targetChapters } : {}),
      ...(payload?.chapterWordCount ? { chapterWordCount: payload.chapterWordCount } : {}),
    };
  } else if (args.requestedIntent === "short_run") {
    const payload = actionPayload?.shortRun;
    const direction = payload?.direction?.trim() || args.instruction.trim();
    if (!direction) throw new ApiError(400, "CONFIRMED_ACTION_PAYLOAD_INCOMPLETE", "确认短篇缺少方向，请重新生成确认卡。");
    tool = createShortFictionRunTool(args.pipeline, args.root, { actionPayload });
    params = {
      direction,
      ...(payload?.reference ? { reference: payload.reference } : {}),
      ...(payload?.storyId ? { storyId: payload.storyId } : {}),
      ...(payload?.chapters ? { chapters: payload.chapters } : {}),
      ...(payload?.charsPerChapter ? { charsPerChapter: payload.charsPerChapter } : {}),
      ...(payload?.cover !== undefined ? { cover: payload.cover } : {}),
    };
  } else if (args.requestedIntent === "generate_cover") {
    const payload = actionPayload?.generateCover;
    const title = requirePayloadText(payload?.title, "确认生成封面缺少标题，请重新生成确认卡。");
    tool = createGenerateCoverTool(args.root, { actionPayload });
    params = {
      title,
      ...(payload?.intro ? { intro: payload.intro } : {}),
      ...(payload?.sellingPoints ? { sellingPoints: payload.sellingPoints } : {}),
      ...(payload?.coverPrompt ? { coverPrompt: payload.coverPrompt } : {}),
      ...(payload?.outputDir ? { outputDir: payload.outputDir } : {}),
    };
  } else if (args.requestedIntent === "play_start") {
    const payload = actionPayload?.playStart;
    const title = requirePayloadText(payload?.title, "确认启动互动世界缺少标题，请重新生成确认卡。");
    const fallbackScene = [payload?.premise, args.instruction].filter((part): part is string => typeof part === "string" && part.trim().length > 0).join("\n\n");
    const initialScene = isUsablePlayInitialScene(payload?.initialScene)
      ? payload?.initialScene?.trim()
      : fallbackScene.trim();
    const confirmedActionPayload: ActionPayload | undefined = actionPayload
      ? {
        ...actionPayload,
        playStart: {
          ...payload,
          title,
          ...(initialScene ? { initialScene } : {}),
        },
      }
      : undefined;
    tool = createPlayStartTool(args.pipeline, args.root, args.sessionId, args.playMode, { actionPayload: confirmedActionPayload });
    params = {
      title,
      ...(payload?.premise ? { premise: payload.premise } : {}),
      ...(payload?.worldContract ? { worldContract: payload.worldContract } : {}),
      ...(payload?.visualContract ? { visualContract: payload.visualContract } : {}),
      ...(payload?.mode ? { mode: payload.mode } : {}),
      ...(initialScene ? { initialScene } : {}),
      ...(payload?.suggestedActions ? { suggestedActions: payload.suggestedActions } : {}),
    };
  } else {
    throw new ApiError(400, "UNSUPPORTED_CONFIRMED_ACTION", `Unsupported confirmed action: ${args.requestedIntent}`);
  }

  const exec: CollectedToolExec = {
    id,
    tool: tool.name,
    agent,
    label: resolveToolLabel(tool.name, agent),
    status: "running",
    args: params,
    stages: agent ? PIPELINE_STAGES[agent]?.map(label => ({ label, status: "pending" as const })) : undefined,
    startedAt: Date.now(),
  };

  broadcast("tool:start", {
    sessionId: args.streamSessionId,
    id,
    tool: tool.name,
    args: params,
    stages: exec.stages?.map(stage => stage.label),
  });

  try {
    const result = await tool.execute(
      id,
      params as never,
      undefined,
      (partialResult) => {
        broadcast("tool:update", {
          sessionId: args.streamSessionId,
          id,
          tool: tool.name,
          partialResult,
        });
      },
    );
    exec.status = "completed";
    exec.completedAt = Date.now();
    exec.result = toolResultText(result);
    exec.details = (result as { details?: unknown } | undefined)?.details;
    exec.stages = exec.stages?.map(stage => ({ ...stage, status: "completed" as const }));
    broadcast("tool:end", {
      sessionId: args.streamSessionId,
      id,
      tool: tool.name,
      result,
      details: exec.details,
      isError: false,
    });
    return exec;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const result = { content: [{ type: "text", text: message }] };
    exec.status = "error";
    exec.completedAt = Date.now();
    exec.error = message;
    broadcast("tool:end", {
      sessionId: args.streamSessionId,
      id,
      tool: tool.name,
      result,
      isError: true,
    });
    throw new ConfirmedActionExecutionError(message, exec, error);
  }
}

interface StudioBookListSummary {
  readonly id: string;
  readonly title: string;
  readonly genre: string;
  readonly status: string;
  readonly chaptersWritten: number;
  readonly [key: string]: unknown;
}

// --- Event bus for SSE ---

type EventHandler = (event: string, data: unknown) => void;
const subscribers = new Set<EventHandler>();
const bookCreateStatus = new Map<string, { status: "creating" | "error"; error?: string }>();

// Event ring buffer: replays recent events to new SSE connections.
// Only state-changing events are buffered (not high-frequency deltas).
const EVENT_BUFFER_MAX = 200;
const eventBuffer: Array<{ readonly event: string; readonly data: unknown; readonly ts: number }> = [];
const BUFFERED_EVENT_PREFIXES = [
  "write:", "draft:", "tool:", "agent:", "book:", "daemon:",
  "audit:", "revise:", "rewrite:", "resync:", "radar:",
  "import:", "style:", "fanfic:", "log", "llm:progress",
  "context:", "operations:",
];
const SKIP_EVENT_PATTERNS = [".delta", ":update"];

// 内存缓存：service -> 模型列表 + 更新时间戳；避免每次 sidebar 挂载时都打真实 LLM /models
const modelListCache = new Map<string, { models: Array<{ id: string; name: string }>; at: number }>();

interface ServiceConfigEntry {
  service: string;
  name?: string;
  baseUrl?: string;
  temperature?: number;
  apiFormat?: "chat" | "responses";
  stream?: boolean;
}

type LLMConfigSource = "env" | "studio";

interface EnvConfigSummary {
  detected: boolean;
  provider: string | null;
  service?: string | null;
  baseUrl: string | null;
  model: string | null;
  hasApiKey: boolean;
}

interface EnvConfigValues extends EnvConfigSummary {
  apiKey: string | null;
}

interface EnvConfigStatus {
  project: EnvConfigSummary;
  global: EnvConfigSummary;
  effectiveSource: "project" | "global" | null;
  runtimeUsesEnv: false;
}

interface ServiceProbeResult {
  ok: boolean;
  models: Array<{ id: string; name: string }>;
  selectedModel?: string;
  apiFormat?: "chat" | "responses";
  stream?: boolean;
  baseUrl?: string;
  modelsSource?: "api" | "fallback";
  error?: string;
}

function broadcast(event: string, data: unknown): void {
  for (const handler of subscribers) {
    handler(event, data);
  }
  // Buffer state-changing events for replay to new connections.
  const shouldBuffer = BUFFERED_EVENT_PREFIXES.some((prefix) => event.startsWith(prefix))
    && !SKIP_EVENT_PATTERNS.some((pattern) => event.includes(pattern));
  if (shouldBuffer) {
    eventBuffer.push({ event, data, ts: Date.now() });
    while (eventBuffer.length > EVENT_BUFFER_MAX) {
      eventBuffer.shift();
    }
  }
}

function deriveBookIdFromTitle(title: string): string {
  return title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30);
}

async function completeBookExists(bookDir: string): Promise<boolean> {
  try {
    await access(join(bookDir, "book.json"));
    await access(join(bookDir, "story", "story_bible.md"));
    return true;
  } catch {
    return false;
  }
}

async function ensureDefaultGlobalEnv(): Promise<void> {
  try {
    await access(GLOBAL_ENV_PATH);
    return;
  } catch {
    // continue
  }
  await mkdir(dirname(GLOBAL_ENV_PATH), { recursive: true });
  const template = [
    "# InkOS global LLM defaults",
    "# Studio service settings are saved in inkos.json and .inkos/secrets.json.",
    "# CLI tools can use these values when no project .env is present.",
    "",
    "INKOS_LLM_SERVICE=",
    "INKOS_LLM_PROVIDER=custom",
    "INKOS_LLM_BASE_URL=",
    "INKOS_LLM_MODEL=",
    "INKOS_LLM_API_KEY=",
    "INKOS_LLM_API_FORMAT=chat",
    "INKOS_LLM_STREAM=true",
    "",
    "# Optional cover generation fallback",
    "INKOS_COVER_BASE_URL=",
    "INKOS_COVER_MODEL=",
    "INKOS_COVER_API_KEY=",
    "",
  ].join("\n");
  await writeFile(GLOBAL_ENV_PATH, template, "utf-8");
}

function resolveArchitectBookIdFromArgs(args?: Record<string, unknown>): string | null {
  if (!args || args.agent !== "architect" || args.revise === true) return null;
  if (typeof args.bookId === "string" && args.bookId.trim()) return args.bookId.trim();
  if (typeof args.title === "string" && args.title.trim()) {
    return deriveBookIdFromTitle(args.title) || null;
  }
  return null;
}

function resolveCreatedBookIdFromToolExecs(execs: ReadonlyArray<CollectedToolExec>): string | null {
  for (let i = execs.length - 1; i >= 0; i -= 1) {
    const exec = execs[i];
    if (exec.tool !== "sub_agent" || exec.agent !== "architect" || exec.status !== "completed") continue;

    const details = exec.details as { kind?: unknown; bookId?: unknown } | undefined;
    if (details?.kind === "book_created" && typeof details.bookId === "string" && details.bookId.trim()) {
      return details.bookId.trim();
    }
  }
  return null;
}

function resolveCreatedBookIdFromDetails(details: Readonly<Record<string, unknown>> | undefined): string | null {
  if (details?.kind === "book_created" && typeof details.bookId === "string" && details.bookId.trim()) {
    return details.bookId.trim();
  }
  return null;
}

async function loadStudioBookListSummary(
  state: StateManager,
  bookId: string,
): Promise<StudioBookListSummary> {
  const book = await state.loadBookConfig(bookId);
  const nextChapter = await state.getNextChapterNumber(bookId);
  return { ...book, chaptersWritten: nextChapter - 1 };
}

function decodeRepeatedly(value: string): string {
  let current = value.trim();
  for (let i = 0; i < 3; i++) {
    try {
      const decoded = decodeURIComponent(current);
      if (decoded === current) break;
      current = decoded.trim();
    } catch {
      break;
    }
  }
  return current;
}

function normalizeServiceId(serviceId: string): string {
  return decodeRepeatedly(serviceId);
}

function isCustomServiceId(serviceId: string): boolean {
  const normalized = normalizeServiceId(serviceId);
  return normalized === "custom" || normalized.startsWith("custom:");
}

function serviceConfigKey(entry: ServiceConfigEntry): string {
  return entry.service === "custom" ? `custom:${entry.name ?? "Custom"}` : entry.service;
}

function normalizeServiceEntry(serviceId: string, value: Record<string, unknown>): ServiceConfigEntry {
  const normalizedServiceId = normalizeServiceId(serviceId);
  if (normalizedServiceId.startsWith("custom:")) {
    return {
      service: "custom",
      name: normalizedServiceId.slice("custom:".length),
      ...(typeof value.baseUrl === "string" && value.baseUrl.length > 0 ? { baseUrl: value.baseUrl } : {}),
      ...(typeof value.temperature === "number" ? { temperature: value.temperature } : {}),
      ...(value.apiFormat === "chat" || value.apiFormat === "responses" ? { apiFormat: value.apiFormat } : {}),
      ...(typeof value.stream === "boolean" ? { stream: value.stream } : {}),
    };
  }

  if (normalizedServiceId === "custom") {
    return {
      service: "custom",
      ...(typeof value.name === "string" && value.name.length > 0 ? { name: value.name } : {}),
      ...(typeof value.baseUrl === "string" && value.baseUrl.length > 0 ? { baseUrl: value.baseUrl } : {}),
      ...(typeof value.temperature === "number" ? { temperature: value.temperature } : {}),
      ...(value.apiFormat === "chat" || value.apiFormat === "responses" ? { apiFormat: value.apiFormat } : {}),
      ...(typeof value.stream === "boolean" ? { stream: value.stream } : {}),
    };
  }

  return {
    service: normalizedServiceId,
    ...(typeof value.name === "string" && value.name.length > 0 ? { name: value.name } : {}),
    ...(typeof value.baseUrl === "string" && value.baseUrl.length > 0 ? { baseUrl: value.baseUrl } : {}),
    ...(typeof value.temperature === "number" ? { temperature: value.temperature } : {}),
    ...(value.apiFormat === "chat" || value.apiFormat === "responses" ? { apiFormat: value.apiFormat } : {}),
    ...(typeof value.stream === "boolean" ? { stream: value.stream } : {}),
  };
}

function normalizeConfigSource(value: unknown): LLMConfigSource {
  return value === "studio" ? "studio" : "env";
}

function normalizeServiceConfig(raw: unknown): ServiceConfigEntry[] {
  if (Array.isArray(raw)) {
    return raw
      .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object")
      .map((entry) => normalizeServiceEntry(
        typeof entry.service === "string" && entry.service.length > 0 ? entry.service : "custom",
        entry,
      ));
  }

  if (raw && typeof raw === "object") {
    return Object.entries(raw as Record<string, unknown>)
      .filter(([, value]) => value && typeof value === "object")
      .map(([serviceId, value]) => normalizeServiceEntry(serviceId, value as Record<string, unknown>));
  }

  return [];
}

function mergeServiceConfig(existing: ServiceConfigEntry[], updates: ServiceConfigEntry[]): ServiceConfigEntry[] {
  const merged = new Map(existing.map((entry) => [serviceConfigKey(entry), entry]));
  for (const update of updates) {
    merged.set(serviceConfigKey(update), update);
  }
  return [...merged.values()];
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === "localhost" || normalized === "::1" || normalized === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(normalized);
}

function isCleartextExternalUrl(rawUrl: string | null | undefined): boolean {
  if (!rawUrl?.trim()) return false;
  try {
    const url = new URL(rawUrl.trim());
    return url.protocol === "http:" && !isLoopbackHostname(url.hostname);
  } catch {
    return false;
  }
}

function validateSecureServiceBaseUrls(services: readonly ServiceConfigEntry[]): string | null {
  const invalid = services.find((service) => isCleartextExternalUrl(service.baseUrl));
  if (!invalid) return null;
  return `服务 ${serviceConfigKey(invalid)} 的 Base URL 必须使用 HTTPS；只有 localhost/127.0.0.1 本地端点允许 HTTP。`;
}

function officialVerifierAuthError(verification: {
  readonly probe?: { readonly ok?: boolean; readonly error?: string };
  readonly chat?: { readonly ok?: boolean; readonly error?: string } | null;
}): string | null {
  const probeError = verification.probe?.ok === false ? verification.probe.error ?? "" : "";
  const chatError = verification.chat?.ok === false ? verification.chat.error ?? "" : "";
  const error = [probeError, chatError].find((value) => /\b(?:401|403)\b/i.test(value));
  return error ?? null;
}

function normalizeCoverConfig(raw: unknown): {
  service: string;
  model: string;
  baseUrl?: string;
  api?: "responses" | "images" | "gemini";
  label?: string;
} | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const record = raw as Record<string, unknown>;
  const service = typeof record.service === "string" ? record.service : "";
  const preset = resolveCoverProviderPreset(service);
  const requestedModel = typeof record.model === "string" ? record.model.trim() : "";
  if (!preset && service.startsWith("custom:")) {
    const baseUrl = typeof record.baseUrl === "string" ? record.baseUrl.trim() : "";
    const api = record.api === "responses" || record.api === "gemini" ? record.api : "images";
    if (!baseUrl || !requestedModel) return undefined;
    return {
      service,
      model: requestedModel,
      baseUrl,
      api,
      label: typeof record.label === "string" && record.label.trim()
        ? record.label.trim()
        : decodeURIComponent(service.slice("custom:".length)),
    };
  }
  if (!preset) return undefined;
  const model = requestedModel && preset.models.includes(requestedModel)
    ? requestedModel
    : preset.defaultModel;
  return { service: preset.service, model };
}

function syncTopLevelLlmMirror(llm: Record<string, unknown>): void {
  const selectedService = typeof llm.service === "string" ? llm.service : undefined;
  if (!selectedService) return;

  const services = normalizeServiceConfig(llm.services);
  const selectedEntry = services.find((entry) => serviceConfigKey(entry) === selectedService)
    ?? (!isCustomServiceId(selectedService) ? { service: selectedService } : undefined);
  if (!selectedEntry) return;

  const preset = resolveServicePreset(selectedEntry.service);
  llm.provider = resolveServiceProviderFamily(selectedEntry.service) ?? "openai";
  llm.baseUrl = selectedEntry.baseUrl ?? preset?.baseUrl ?? "";

  const defaultModel = typeof llm.defaultModel === "string" ? llm.defaultModel.trim() : "";
  if (defaultModel) llm.model = defaultModel;
  if (selectedEntry.temperature !== undefined) llm.temperature = selectedEntry.temperature;
  if (selectedEntry.apiFormat !== undefined) llm.apiFormat = selectedEntry.apiFormat;
  if (selectedEntry.stream !== undefined) llm.stream = selectedEntry.stream;
}

async function loadRawConfig(root: string): Promise<Record<string, unknown>> {
  const configPath = join(root, "inkos.json");
  const raw = await readFile(configPath, "utf-8");
  return JSON.parse(raw) as Record<string, unknown>;
}

async function saveRawConfig(root: string, config: Record<string, unknown>): Promise<void> {
  await writeFile(join(root, "inkos.json"), JSON.stringify(config, null, 2), "utf-8");
}

function unquoteEnvValue(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith("\"") && trimmed.endsWith("\"")) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function toEnvConfigSummary(values: EnvConfigValues): EnvConfigSummary {
  return {
    detected: values.detected,
    provider: values.provider,
    service: values.service ?? null,
    baseUrl: values.baseUrl,
    model: values.model,
    hasApiKey: values.hasApiKey,
  };
}

async function readEnvConfigValues(path: string): Promise<EnvConfigValues> {
  try {
    const raw = await readFile(path, "utf-8");
    const values = new Map<string, string>();

    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (!match) continue;
      const [, key, value] = match;
      values.set(key, unquoteEnvValue(value));
    }

    const provider = values.get("INKOS_LLM_PROVIDER") ?? null;
    const service = values.get("INKOS_LLM_SERVICE") ?? null;
    const baseUrl = values.get("INKOS_LLM_BASE_URL") ?? null;
    const model = values.get("INKOS_LLM_MODEL") ?? null;
    const apiKey = values.get("INKOS_LLM_API_KEY") ?? "";
    const detected = Boolean(provider || service || baseUrl || model || apiKey);

    return {
      detected,
      provider,
      service,
      baseUrl,
      model,
      hasApiKey: apiKey.length > 0,
      apiKey: apiKey.length > 0 ? apiKey : null,
    };
  } catch {
    return {
      detected: false,
      provider: null,
      service: null,
      baseUrl: null,
      model: null,
      hasApiKey: false,
      apiKey: null,
    };
  }
}

async function readEnvConfigStatus(root: string): Promise<EnvConfigStatus> {
  const project = await readEnvConfigValues(join(root, ".env"));
  const global = await readEnvConfigValues(GLOBAL_ENV_PATH);
  return {
    project: toEnvConfigSummary(project),
    global: toEnvConfigSummary(global),
    effectiveSource: project.detected ? "project" : global.detected ? "global" : null,
    runtimeUsesEnv: false,
  };
}

async function readEffectiveEnvConfigValues(root: string): Promise<{ source: "project" | "global"; values: EnvConfigValues } | null> {
  const project = await readEnvConfigValues(join(root, ".env"));
  if (project.detected) return { source: "project", values: project };
  const global = await readEnvConfigValues(GLOBAL_ENV_PATH);
  if (global.detected) return { source: "global", values: global };
  return null;
}

async function resolveConfiguredServiceBaseUrl(root: string, serviceId: string, inlineBaseUrl?: string): Promise<string | undefined> {
  if (inlineBaseUrl?.trim()) return inlineBaseUrl.trim();

  if (!isCustomServiceId(serviceId)) {
    return resolveServicePreset(serviceId)?.baseUrl;
  }

  try {
    const config = await loadRawConfig(root);
    const services = normalizeServiceConfig((config.llm as Record<string, unknown> | undefined)?.services);
    const matched = services.find((entry) => serviceConfigKey(entry) === serviceId);
    return matched?.baseUrl;
  } catch {
    return undefined;
  }
}

async function resolveConfiguredServiceEntry(root: string, serviceId: string): Promise<ServiceConfigEntry | undefined> {
  try {
    const config = await loadRawConfig(root);
    const services = normalizeServiceConfig((config.llm as Record<string, unknown> | undefined)?.services);
    return services.find((entry) => serviceConfigKey(entry) === serviceId);
  } catch {
    return undefined;
  }
}

function buildProbePlans(
  preferredApiFormat: "chat" | "responses" | undefined,
  preferredStream: boolean | undefined,
): Array<{ apiFormat: "chat" | "responses"; stream: boolean }> {
  const candidates: Array<{ apiFormat: "chat" | "responses"; stream: boolean }> = [];
  const seen = new Set<string>();
  const push = (apiFormat: "chat" | "responses", stream: boolean) => {
    const key = `${apiFormat}:${stream ? "1" : "0"}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({ apiFormat, stream });
  };

  if (preferredApiFormat) {
    push(preferredApiFormat, preferredStream ?? false);
    if (preferredStream) push(preferredApiFormat, false);
    return candidates;
  }

  push("chat", false);
  push("responses", false);
  return candidates;
}

function buildModelCandidates(args: {
  preferredModel?: string;
  configModel?: string;
  envModel?: string | null;
  discoveredModels: Array<{ id: string; name: string }>;
  includeGenericFallbacks?: boolean;
}): string[] {
  const seen = new Set<string>();
  const candidates: string[] = [];
  const push = (value: string | null | undefined) => {
    if (!value || value.trim().length === 0) return;
    const id = value.trim();
    if (seen.has(id)) return;
    seen.add(id);
    candidates.push(id);
  };

  push(args.preferredModel);
  push(args.configModel);
  push(args.envModel ?? undefined);
  for (const model of args.discoveredModels.slice(0, MAX_DISCOVERED_MODELS_TO_PING)) push(model.id);
  if (args.includeGenericFallbacks === false) return candidates;
  for (const fallback of [
    "gpt-5.4",
    "gpt-4o",
    "claude-sonnet-4-6",
    "MiniMax-M2.7",
    "kimi-k2.5",
  ].slice(0, MAX_GENERIC_FALLBACK_MODELS_TO_PING)) {
    push(fallback);
  }
  return candidates;
}

function yamlScalar(value: unknown): string {
  return JSON.stringify(String(value ?? ""));
}

function radarTimestampForFilename(value: string | undefined): string {
  const date = value ? new Date(value) : new Date();
  const safeDate = Number.isNaN(date.getTime()) ? new Date() : date;
  return safeDate.toISOString().replace(/[:.]/g, "-");
}

async function saveRadarScan(root: string, result: unknown): Promise<string> {
  const radarDir = join(root, "radar");
  await mkdir(radarDir, { recursive: true });
  const timestamp = typeof result === "object" && result !== null && "timestamp" in result
    ? String((result as { timestamp?: unknown }).timestamp ?? "")
    : "";
  const fileName = `scan-${radarTimestampForFilename(timestamp)}.json`;
  const filePath = join(radarDir, fileName);
  await writeFile(filePath, JSON.stringify(result, null, 2), "utf-8");
  return filePath;
}

async function loadRadarHistory(root: string): Promise<Array<{
  readonly file: string;
  readonly timestamp: string;
  readonly marketSummary: string;
  readonly summaryPreview: string;
  readonly result: unknown;
}>> {
  const radarDir = join(root, "radar");
  let files: string[] = [];
  try {
    files = await readdir(radarDir);
  } catch {
    return [];
  }

  const scans = await Promise.all(
    files
      .filter((file) => /^scan-.+\.json$/.test(file))
      .map(async (file) => {
        try {
          const raw = await readFile(join(radarDir, file), "utf-8");
          const result = JSON.parse(raw) as { timestamp?: unknown; marketSummary?: unknown };
          const timestamp = typeof result.timestamp === "string"
            ? result.timestamp
            : file.replace(/^scan-/, "").replace(/\.json$/, "");
          const marketSummary = typeof result.marketSummary === "string" ? result.marketSummary : "";
          return {
            file,
            timestamp,
            marketSummary,
            summaryPreview: marketSummary.slice(0, 100),
            result,
          };
        } catch {
          return null;
        }
      }),
  );

  return scans
    .filter((item): item is NonNullable<typeof item> => item !== null)
    .sort((a, b) => b.file.localeCompare(a.file));
}

function fallbackTextModelsForEndpoint(
  endpoint: ReturnType<typeof getAllEndpoints>[number] | undefined,
  preset: ReturnType<typeof resolveServicePreset> | undefined,
): Array<{ id: string; name: string }> {
  const endpointModels = endpoint?.models
    .filter((model) => model.enabled !== false)
    .filter((model) => isTextChatModelId(model.id))
    .map((model) => ({ id: model.id, name: model.id }))
    ?? [];
  if (endpointModels.length > 0) return endpointModels;
  return preset?.knownModels?.map((id) => ({ id, name: id })) ?? [];
}

function shouldTrustStaticModelsWhenLiveListUnavailable(endpoint: ReturnType<typeof getAllEndpoints>[number] | undefined): boolean {
  return endpoint?.group === "aggregator";
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label} 超时（${timeoutMs}ms）`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function formatServiceProbeError(args: {
  readonly service: string;
  readonly label?: string;
  readonly baseUrl: string;
  readonly model?: string;
  readonly apiFormat?: "chat" | "responses";
  readonly stream?: boolean;
  readonly error: string;
}): string {
  const rawDetail = args.error
    .replace(/\n\s*\(baseUrl:[\s\S]*?\)$/m, "")
    .trim();
  const upstreamDetail = rawDetail.includes("上游详情：")
    ? rawDetail
    : "";
  const context = [
    `服务商：${args.label ?? args.service}`,
    `测试模型：${args.model ?? "未确定"}`,
    `协议：${args.apiFormat === "responses" ? "Responses" : "Chat / Completions"}${typeof args.stream === "boolean" ? `，${args.stream ? "流式" : "非流式"}` : ""}`,
    `Base URL：${args.baseUrl}`,
  ].join("\n");

  if (args.service === "google") {
    return [
      "Google Gemini 测试连接失败。",
      context,
      "",
      "请优先检查：",
      "1. API Key 是否来自 Google AI Studio 的 Gemini API key，而不是 OAuth、Vertex AI 或其它 Google 服务凭据。",
      "2. 该 key 所属项目是否已启用 Gemini API，并且没有被限制到其它 API、来源或服务。",
      "3. 当前地区/账号是否允许访问 Gemini API。",
      "4. 如果 key 曾经泄露，请在 AI Studio 重新生成后再保存。",
      upstreamDetail ? `\n上游返回：${upstreamDetail}` : "",
    ].filter(Boolean).join("\n");
  }

  if (args.service === "moonshot" || args.service === "kimiCodingPlan" || args.service === "kimicode") {
    return [
      `${args.label ?? args.service} 测试连接失败。`,
      context,
      "",
      "请优先检查模型是否可用，以及 kimi-k2.x 这类模型是否需要 temperature=1。",
      rawDetail ? `\n上游返回：${rawDetail}` : "",
    ].filter(Boolean).join("\n");
  }

  return [
    `${args.label ?? args.service} 测试连接失败。`,
    context,
    "",
    "请检查 API Key、模型可用性、账号额度，以及协议类型是否匹配该服务商。",
    rawDetail ? `\n上游返回：${rawDetail}` : "",
  ].filter(Boolean).join("\n");
}

async function fetchModelsFromServiceBaseUrl(
  serviceId: string,
  baseUrl: string,
  apiKey: string,
  proxyUrl?: string,
): Promise<{ models: Array<{ id: string; name: string }>; error?: string; authFailed?: boolean }> {
  const endpoint = isCustomServiceId(serviceId)
    ? undefined
    : getAllEndpoints().find((ep) => ep.id === serviceId);
  const modelsBaseUrl = isCustomServiceId(serviceId)
    ? baseUrl
    : endpoint?.modelsBaseUrl ?? (endpoint ? baseUrl : resolveServiceModelsBaseUrl(serviceId) ?? baseUrl);
  const modelsUrl = modelsBaseUrl.replace(/\/$/, "") + "/models";
  try {
    const res = await fetchWithProxy(modelsUrl, {
      headers: buildBearerAuthHeaders(apiKey),
      signal: AbortSignal.timeout(SERVICE_MODELS_PROBE_TIMEOUT_MS),
    }, proxyUrl);
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return {
        models: [],
        error: `服务商返回 ${res.status}: ${body.slice(0, 200)}`,
        authFailed: res.status === 401 || res.status === 403,
      };
    }
    const json = await res.json() as { data?: Array<{ id: string }> };
    return {
      models: (json.data ?? []).map((m) => ({ id: m.id, name: m.id })),
    };
  } catch (error) {
    return {
      models: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function buildBearerAuthHeaders(apiKey: string | undefined): Record<string, string> {
  const trimmed = apiKey?.trim() ?? "";
  if (!trimmed) return {};
  if (!/^[\x20-\x7e]+$/.test(trimmed)) {
    throw new Error("API Key 只能包含英文、数字和常见 ASCII 符号，请检查是否误粘贴了中文说明。");
  }
  return { Authorization: `Bearer ${trimmed}` };
}

async function probeServiceCapabilities(args: {
  root: string;
  service: string;
  apiKey: string;
  baseUrl: string;
  preferredApiFormat?: "chat" | "responses";
  preferredStream?: boolean;
  preferredModel?: string;
  proxyUrl?: string;
}): Promise<ServiceProbeResult> {
  const rawConfig = await loadRawConfig(args.root).catch(() => ({} as Record<string, unknown>));
  const llm = (rawConfig.llm as Record<string, unknown> | undefined) ?? {};
  const envConfig = await readEnvConfigStatus(args.root);
  const envModel = envConfig.effectiveSource === "project"
    ? envConfig.project.model
    : envConfig.effectiveSource === "global"
      ? envConfig.global.model
      : null;

  const baseService = isCustomServiceId(args.service) ? "custom" : args.service;
  const modelsResponse = await fetchModelsFromServiceBaseUrl(baseService, args.baseUrl, args.apiKey, args.proxyUrl);
  if (modelsResponse.authFailed) {
    return {
      ok: false,
      models: [],
      error: modelsResponse.error ?? "API Key 无效或无权访问模型列表。",
    };
  }
  const discoveredModels = modelsResponse.models;
  const endpoint = getAllEndpoints().find((ep) => ep.id === baseService);
  const preset = resolveServicePreset(baseService);
  const discoveredFirstModel =
    discoveredModels.find((model) => isTextChatModelId(model.id))?.id
    ?? discoveredModels[0]?.id;
  if (discoveredModels.length > 0) {
    if (!discoveredFirstModel || !isTextChatModelId(discoveredFirstModel)) {
      return {
        ok: false,
        models: discoveredModels,
        error: "模型列表可访问，但没有发现可用于文本对话的模型。",
      };
    }
  }
  if (shouldTrustStaticModelsWhenLiveListUnavailable(endpoint)) {
    const models = fallbackTextModelsForEndpoint(endpoint, preset);
    const selectedModel =
      endpoint?.checkModel && models.some((model) => model.id === endpoint.checkModel)
        ? endpoint.checkModel
        : models[0]?.id;
    if (selectedModel) {
      return {
        ok: true,
        models,
        selectedModel,
        apiFormat: args.preferredApiFormat ?? "chat",
        stream: args.preferredStream ?? false,
        baseUrl: args.baseUrl,
        modelsSource: "fallback",
      };
    }
  }
  // Prefer live /models results; if unavailable, probe with the service's own check model before global defaults.
  const serviceFirstModel =
    discoveredFirstModel
    ?? endpoint?.checkModel
    ?? preset?.knownModels?.[0]
    ?? endpoint?.models.find((model) => model.enabled !== false)?.id;
  const useDynamicLocalModels = baseService === "ollama";
  const useEndpointCheckModel = !useDynamicLocalModels
    && !isCustomServiceId(args.service)
    && discoveredModels.length === 0
    && Boolean(endpoint?.checkModel);
  const configService = typeof llm.service === "string" ? llm.service : undefined;
  const configModel = !useEndpointCheckModel && configService === args.service
    ? typeof llm.defaultModel === "string"
      ? llm.defaultModel
      : typeof llm.model === "string"
        ? llm.model
        : undefined
    : undefined;
  const useCustomFallbacks = false;
  const modelCandidates = buildModelCandidates({
    preferredModel: args.preferredModel ?? serviceFirstModel,
    configModel,
    envModel: useCustomFallbacks ? envModel : undefined,
    discoveredModels: useEndpointCheckModel ? [] : discoveredModels,
    includeGenericFallbacks: useCustomFallbacks,
  });

  if (modelCandidates.length === 0) {
    return {
      ok: false,
      models: [],
      error: "无法自动确定模型，请先填写可用模型或提供支持 /models 的服务端点。",
    };
  }

  let lastError = modelsResponse.error ?? "自动探测失败";

  for (const model of modelCandidates) {
    for (const plan of buildProbePlans(args.preferredApiFormat, args.preferredStream)) {
      const client = createLLMClient({
        provider: resolveServiceProviderFamily(baseService) ?? "openai",
        service: baseService,
        configSource: "studio",
        baseUrl: args.baseUrl,
        apiKey: args.apiKey.trim(),
        model,
        temperature: 0.7,
        maxTokens: 16,
        thinkingBudget: 0,
        proxyUrl: args.proxyUrl,
        apiFormat: plan.apiFormat,
        stream: plan.stream,
      } as ProjectConfig["llm"]);

      try {
        await withTimeout(
          // A connectivity probe wants a fast pass/fail — never the transient
          // retry+backoff, which would multiply the time when the upstream is
          // rate-limiting (and make the diagnostics page hang).
          chatCompletion(client, model, [{ role: "user", content: "Reply with OK only." }], { maxTokens: 16, retry: false }),
          SERVICE_CHAT_PROBE_TIMEOUT_MS,
          "service connection test",
        );
        const models = discoveredModels.length > 0
          ? discoveredModels
          : fallbackTextModelsForEndpoint(endpoint, preset);
        return {
          ok: true,
          models: models.length > 0 ? models : [{ id: model, name: model }],
          selectedModel: model,
          apiFormat: plan.apiFormat,
          stream: plan.stream,
          baseUrl: args.baseUrl,
          modelsSource: discoveredModels.length > 0 ? "api" : "fallback",
        };
      } catch (error) {
        lastError = formatServiceProbeError({
          service: baseService,
          label: endpoint?.label ?? preset?.label,
          baseUrl: args.baseUrl,
          model,
          apiFormat: plan.apiFormat,
          stream: plan.stream,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  return {
    ok: false,
    models: discoveredModels,
    error: lastError,
  };
}

async function resolveKnowledgeUploadBody(body: {
  readonly name?: string;
  readonly content?: string;
  readonly fileBase64?: string;
}): Promise<{ readonly name: string; readonly content: string; readonly extraction?: unknown }> {
  const name = body.name?.trim();
  if (!name) throw new ApiError(400, "KNOWLEDGE_NAME_REQUIRED", "name is required");
  const fallbackContent = body.content?.trim() ?? "";
  if (body.fileBase64?.trim()) {
    const extracted = await extractTextWithPython({ name, base64: body.fileBase64.trim() });
    if (extracted?.ok && extracted.text.trim()) {
      return { name, content: extracted.text, extraction: extracted };
    }
    if (fallbackContent) {
      return { name, content: fallbackContent, extraction: extracted ?? { ok: false, method: "javascript:fallback", warnings: ["Python unavailable."] } };
    }
    throw new ApiError(
      400,
      "KNOWLEDGE_EXTRACTION_FAILED",
      extracted?.warnings.join("; ") || "Unable to extract text from file.",
    );
  }
  if (!fallbackContent) throw new ApiError(400, "KNOWLEDGE_CONTENT_REQUIRED", "content is required");
  return { name, content: fallbackContent };
}

// --- Server factory ---

export function createStudioServer(initialConfig: ProjectConfig, root: string) {
  const app = new Hono();
  const state = new StateManager(root);
  const knowledgeStore = new KnowledgeStore(root);
  const headroom = new HeadroomMcpManager();
  let cachedConfig = initialConfig;

  app.use("/*", cors());
  app.use("/*", async (c, next) => {
    const isKnowledgeUpload = new URL(c.req.url).pathname.endsWith("/knowledge/sources");
    return bodyLimit({ maxSize: isKnowledgeUpload ? 10 * 1024 * 1024 : 2 * 1024 * 1024 })(c, next);
  });

  // Structured error handler — ApiError returns typed JSON, others return 500
  app.onError((error, c) => {
    if (error instanceof ApiError) {
      return c.json({ error: { code: error.code, message: error.message } }, error.status as 400);
    }
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("LLM API key not set") || message.includes("INKOS_LLM_API_KEY not set")) {
      return c.json({ error: { code: "LLM_CONFIG_ERROR", message } }, 400);
    }
    console.error("[studio] Unexpected server error", error);
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

  const recentLogEntries: LogEntry[] = [];
  const logPath = join(root, "inkos.log");
  let logWriteQueue: Promise<void> = Promise.resolve();
  const rememberLogEntry = (entry: LogEntry): void => {
    const normalized = { ...entry, timestamp: entry.timestamp ?? new Date().toISOString() };
    recentLogEntries.push(normalized);
    if (recentLogEntries.length > 500) {
      recentLogEntries.splice(0, recentLogEntries.length - 500);
    }
    logWriteQueue = logWriteQueue
      .then(() => appendFile(logPath, `${JSON.stringify(normalized)}\n`, "utf-8"))
      .catch(() => undefined);
  };

  // Logger sink that broadcasts to SSE
  const sseSink: LogSink = {
    write(entry: LogEntry): void {
      const normalized = { ...entry, timestamp: entry.timestamp ?? new Date().toISOString() };
      rememberLogEntry(normalized);
      broadcast("log", {
        level: normalized.level,
        tag: normalized.tag,
        message: normalized.message,
        timestamp: normalized.timestamp,
      });
    },
  };

  // Logger sink that prints to server terminal
  const consoleSink: LogSink = {
    write(entry: LogEntry): void {
      const prefix = `[${entry.tag}]`;
      if (entry.level === "warn") console.warn(prefix, entry.message);
      else if (entry.level === "error") console.error(prefix, entry.message);
      else console.log(prefix, entry.message);
    },
  };

  function createStudioLLMClient(
    llm: ProjectConfig["llm"],
    options?: { readonly sessionId?: string },
  ) {
    return createLLMClient({
      ...llm,
      configSource: "studio",
      onRequestDiagnostics: (diagnostics) => emitModelRequestDiagnostics(diagnostics, options?.sessionId),
    });
  }

  async function resolvePipelineModelOverrides(
    currentConfig: ProjectConfig,
  ): Promise<PipelineConfig["modelOverrides"]> {
    if (!currentConfig.modelOverrides) return undefined;
    const secrets = await loadSecrets(root);
    const resolved: NonNullable<PipelineConfig["modelOverrides"]> = {};

    for (const [agent, override] of Object.entries(currentConfig.modelOverrides)) {
      if (typeof override === "string" || !override.service) {
        resolved[agent] = override;
        continue;
      }

      const serviceId = normalizeServiceId(override.service);
      const baseService = isCustomServiceId(serviceId) ? "custom" : serviceId;
      const entry = await resolveConfiguredServiceEntry(root, serviceId);
      const baseUrl = await resolveConfiguredServiceBaseUrl(root, serviceId, override.baseUrl);
      resolved[agent] = {
        ...override,
        service: baseService,
        provider: override.provider ?? resolveServiceProviderFamily(baseService) ?? "openai",
        ...(baseUrl ? { baseUrl } : {}),
        apiKey: secrets.services[serviceId]?.apiKey ?? "",
        proxyUrl: override.proxyUrl ?? currentConfig.llm.proxyUrl,
        apiFormat: override.apiFormat ?? entry?.apiFormat ?? currentConfig.llm.apiFormat,
        stream: override.stream ?? entry?.stream ?? currentConfig.llm.stream,
      };
    }

    return resolved;
  }

  const AGENTS_FOLLOWING_SELECTED_MODEL = [
    "architect",
    "foundation-reviewer",
    "planner",
    "composer",
    "writer",
    "state-repair",
    "auditor",
    "reviser",
    "state-validator",
    "length-normalizer",
    "play",
    "short-outline",
    "short-outline-review",
    "short-writer",
    "short-draft-review",
    "short-revise",
    "short-package",
  ] as const;

  function mergeSelectedModelOverrides(
    base: PipelineConfig["modelOverrides"],
    selected: {
      readonly service?: string;
      readonly model: ResolvedModel["model"];
      readonly apiKey?: string;
    } | undefined,
  ): PipelineConfig["modelOverrides"] {
    if (!selected) return base;
    const resolved = { ...(base ?? {}) };
    const modelRecord = selected.model as unknown as Record<string, unknown>;
    const selectedModelId = typeof modelRecord.id === "string"
      ? modelRecord.id
      : typeof modelRecord.modelId === "string"
        ? modelRecord.modelId
        : undefined;
    const modelId = selectedModelId ?? String(modelRecord.name ?? "");
    if (!modelId.trim()) return base;
    const service = selected.service?.trim();
    const serviceProvider = service ? resolveServiceProviderFamily(service) : undefined;
    const provider: "custom" | "openai" | "anthropic" | undefined =
      modelRecord.provider === "custom" || modelRecord.provider === "openai" || modelRecord.provider === "anthropic"
        ? modelRecord.provider
        : serviceProvider === "openai" || serviceProvider === "anthropic"
          ? serviceProvider
          : undefined;
    const baseUrl = typeof modelRecord.baseUrl === "string" ? modelRecord.baseUrl : undefined;
    const apiFormat: "chat" | "responses" | undefined = modelRecord.api === "openai-responses"
      ? "responses"
      : modelRecord.api === "openai-completions"
        ? "chat"
        : undefined;
    const selectedOverride = {
      model: modelId,
      ...(service ? { service } : {}),
      ...(provider ? { provider } : {}),
      ...(baseUrl ? { baseUrl } : {}),
      ...(selected.apiKey ? { apiKey: selected.apiKey } : {}),
      ...(apiFormat ? { apiFormat } : {}),
    };

    for (const agent of AGENTS_FOLLOWING_SELECTED_MODEL) {
      if (resolved[agent] === undefined) {
        resolved[agent] = selectedOverride;
      }
    }
    return resolved;
  }

  function normalizeModelOverrides(overrides: Record<string, unknown>): Record<string, unknown> {
    const normalized: Record<string, unknown> = {};
    for (const [agent, override] of Object.entries(overrides)) {
      if (!override || typeof override !== "object" || Array.isArray(override)) {
        normalized[agent] = override;
        continue;
      }
      const entry = { ...(override as Record<string, unknown>) };
      if (typeof entry.service === "string") {
        entry.service = normalizeServiceId(entry.service);
      }
      normalized[agent] = entry;
    }
    return normalized;
  }

  function emitRuntimeLog(entry: Pick<LogEntry, "level" | "tag" | "message"> & { readonly sessionId?: string }): void {
    const normalized: LogEntry = {
      level: entry.level,
      tag: entry.tag,
      message: entry.message,
      timestamp: new Date().toISOString(),
    };
    rememberLogEntry(normalized);
    broadcast("log", {
      ...(entry.sessionId ? { sessionId: entry.sessionId } : {}),
      level: normalized.level,
      tag: normalized.tag,
      message: normalized.message,
      timestamp: normalized.timestamp,
    });
    const prefix = `[${normalized.tag ?? "app"}]`;
    if (normalized.level === "warn") console.warn(prefix, normalized.message);
    else if (normalized.level === "error") console.error(prefix, normalized.message);
    else console.log(prefix, normalized.message);
  }

  function emitModelRequestDiagnostics(
    diagnostics: LLMRequestDiagnostics | AgentRequestDiagnostics,
    sessionId?: string,
  ): void {
    if (diagnostics.promptChars < LARGE_MODEL_PROMPT_WARN_CHARS) return;
    const estimatedTokens = Math.ceil(diagnostics.promptChars / 2);
    const level = diagnostics.promptChars >= HUGE_MODEL_PROMPT_WARN_CHARS ? "warn" : "info";
    const endpoint = "endpoint" in diagnostics ? diagnostics.endpoint : diagnostics.api;
    const service = "service" in diagnostics && diagnostics.service ? `${diagnostics.service}/` : "";
    const agent = "agent" in diagnostics && diagnostics.agent ? `agent=${diagnostics.agent}` : "";
    emitRuntimeLog({
      level,
      tag: "context",
      ...(sessionId ? { sessionId } : {}),
      message: [
        diagnostics.promptChars >= HUGE_MODEL_PROMPT_WARN_CHARS ? "极大上下文请求" : "大上下文请求",
        agent,
        `模型 ${service}${diagnostics.model}`,
        `接口 ${endpoint}`,
        `stream=${diagnostics.stream}`,
        `maxTokens=${diagnostics.maxTokens}`,
        `prompt=${diagnostics.promptChars.toLocaleString()} 字符`,
        `约 ${estimatedTokens.toLocaleString()} tokens`,
        "可能导致首字等待较久或上游超时",
      ].filter(Boolean).join(" · "),
    });
  }

  registerRuntimeRoutes(app, { root, state, broadcast, headroom });

  async function loadCurrentProjectConfig(
    options?: { readonly requireApiKey?: boolean },
  ): Promise<ProjectConfig> {
    const freshConfig = await loadProjectConfig(root, { ...options, consumer: "studio" });
    cachedConfig = freshConfig;
    return freshConfig;
  }

  async function buildPipelineConfig(
    overrides?: Partial<Pick<PipelineConfig, "externalContext" | "client" | "model">> & {
      readonly currentConfig?: ProjectConfig;
      readonly sessionIdForSSE?: string;
      readonly selectedModelRoute?: {
        readonly service?: string;
        readonly model: ResolvedModel["model"];
        readonly apiKey?: string;
      };
    },
  ): Promise<PipelineConfig> {
    const currentConfig = overrides?.currentConfig ?? await loadCurrentProjectConfig();
    const modelOverrides = mergeSelectedModelOverrides(
      await resolvePipelineModelOverrides(currentConfig),
      overrides?.selectedModelRoute,
    );
    const scopedSseSink: LogSink = overrides?.sessionIdForSSE
      ? {
          write(entry) {
            const normalized = { ...entry, timestamp: entry.timestamp ?? new Date().toISOString() };
            rememberLogEntry(normalized);
            broadcast("log", {
              sessionId: overrides.sessionIdForSSE,
              level: normalized.level,
              tag: normalized.tag,
              message: normalized.message,
              timestamp: normalized.timestamp,
            });
          },
        }
      : sseSink;
    const logger = createLogger({ tag: "studio", sinks: [scopedSseSink, consoleSink] });
    return {
      client: overrides?.client ?? createStudioLLMClient(currentConfig.llm, { sessionId: overrides?.sessionIdForSSE }),
      model: overrides?.model ?? currentConfig.llm.model,
      projectRoot: root,
      defaultLLMConfig: currentConfig.llm,
      foundationReviewRetries: currentConfig.foundation?.reviewRetries ?? 2,
      writingReviewRetries: currentConfig.writing?.reviewRetries ?? 1,
      chapterReviewMode: (currentConfig.writing as { readonly reviewMode?: string } | undefined)?.reviewMode === "manual" ? "manual" : "auto",
      modelOverrides,
      notifyChannels: currentConfig.notify,
      logger,
      onRequestDiagnostics: (diagnostics) =>
        emitModelRequestDiagnostics(diagnostics, overrides?.sessionIdForSSE),
      onContextCompression: (event) => {
        broadcast("context:compression", {
          ...(overrides?.sessionIdForSSE ? { sessionId: overrides.sessionIdForSSE } : {}),
          ...event,
        });
      },
      onStreamProgress: (progress) => {
        broadcast("llm:progress", {
          ...(overrides?.sessionIdForSSE ? { sessionId: overrides.sessionIdForSSE } : {}),
          status: progress.status,
          elapsedMs: progress.elapsedMs,
          totalChars: progress.totalChars,
          chineseChars: progress.chineseChars,
        });
      },
      onTextDelta: (text, agent) => {
        broadcast("llm:delta", {
          ...(overrides?.sessionIdForSSE ? { sessionId: overrides.sessionIdForSSE } : {}),
          ...(agent ? { agent } : {}),
          text,
        });
      },
      externalContext: overrides?.externalContext,
    };
  }

  // --- Books ---

  app.get("/api/v1/books", async (c) => {
    const bookIds = await state.listBooks();
    const books = await Promise.all(bookIds.map((id) => loadStudioBookListSummary(state, id)));
    return c.json({ books });
  });

  app.get("/api/v1/books/:id", async (c) => {
    const id = c.req.param("id");
    try {
      const book = await state.loadBookConfig(id);
      const chapters = await state.loadChapterIndex(id);
      const nextChapter = await state.getNextChapterNumber(id);
      let bookRules: Record<string, unknown> | null = null;
      try {
        const rulesRaw = await readFile(join(state.bookDir(id), "story", "book_rules.md"), "utf-8");
        const { parseBookRules } = await import("@actalk/inkos-core");
        const parsed = parseBookRules(rulesRaw);
        if (parsed) bookRules = parsed.rules as unknown as Record<string, unknown>;
      } catch { /* no book_rules.md — null is fine */ }
      return c.json({ book, chapters, nextChapter, bookRules });
    } catch {
      return c.json({ error: `Book "${id}" not found` }, 404);
    }
  });

  // --- Genres ---

  app.get("/api/v1/genres", async (c) => {
    const { listAvailableGenres, readGenreProfile } = await import("@actalk/inkos-core");
    const rawGenres = await listAvailableGenres(root);
    const genres = await Promise.all(
      rawGenres.map(async (g) => {
        try {
          const { profile } = await readGenreProfile(root, g.id);
          return { ...g, language: profile.language ?? "zh" };
        } catch {
          return { ...g, language: "zh" };
        }
      }),
    );
    return c.json({ genres });
  });

  // --- Book Create ---

  app.post("/api/v1/books/create", async (c) => {
    const body = await c.req.json<{
      title: string;
      genre: string;
      language?: string;
      platform?: string;
      chapterWordCount?: number;
      targetChapters?: number;
      blurb?: string;
    }>().catch(() => null);
    if (!body?.title?.trim()) {
      return c.json({ error: "title is required" }, 400);
    }
    if (body.title.length > 200) {
      return c.json({ error: "title must be 200 characters or fewer" }, 400);
    }
    if (body.blurb && body.blurb.length > 5000) {
      return c.json({ error: "blurb must be 5000 characters or fewer" }, 400);
    }

    const now = new Date().toISOString();
    const bookConfig = buildStudioBookConfig(body, now);
    const bookId = bookConfig.id;
    const bookDir = state.bookDir(bookId);

    if (!bookId) {
      return c.json({ error: "Could not derive a valid book id from title" }, 400);
    }
    if (await completeBookExists(bookDir)) {
      return c.json({ error: `Book "${bookId}" already exists` }, 409);
    }

    broadcast("book:creating", { bookId, title: body.title });
    bookCreateStatus.set(bookId, { status: "creating" });

    const pipeline = new PipelineRunner(await buildPipelineConfig());
    const tools = createInteractionToolsFromDeps(pipeline, state);
    processProjectInteractionRequest({
      projectRoot: root,
      request: {
        intent: "create_book",
        title: body.title,
        genre: body.genre,
        language: body.language === "en" ? "en" : body.language === "zh" ? "zh" : undefined,
        platform: body.platform,
        chapterWordCount: body.chapterWordCount,
        targetChapters: body.targetChapters,
        blurb: body.blurb,
      },
      tools,
    }).then(
      async (result: {
        readonly session: { readonly activeBookId?: string };
        readonly details?: Readonly<Record<string, unknown>>;
      }) => {
        const createdBookId = resolveCreatedBookIdFromDetails(result.details);
        if (!createdBookId) {
          const error = "Book creation did not produce a completed book artifact.";
          bookCreateStatus.set(bookId, { status: "error", error });
          broadcast("book:error", { bookId, error });
          return;
        }
        if (!await completeBookExists(join(root, "books", createdBookId))) {
          const error = "Book creation artifact is incomplete on disk.";
          bookCreateStatus.set(createdBookId, { status: "error", error });
          broadcast("book:error", { bookId: createdBookId, error });
          return;
        }
        const book = await loadStudioBookListSummary(state, createdBookId).catch(() => undefined);
        bookCreateStatus.delete(createdBookId);
        broadcast("book:created", { bookId: createdBookId, ...(book ? { book } : {}) });
      },
      (e: unknown) => {
        const error = e instanceof Error ? e.message : String(e);
        bookCreateStatus.set(bookId, { status: "error", error });
        broadcast("book:error", { bookId, error });
      },
    );

    return c.json({ status: "creating", bookId });
  });

  app.get("/api/v1/books/:id/create-status", async (c) => {
    const id = c.req.param("id");
    const status = bookCreateStatus.get(id);
    if (status) {
      return c.json(status);
    }
    // No in-memory entry. On success the entry is deleted, and a long architect
    // run (or a server restart) can also drop it — so a bare 404 is ambiguous
    // ("done" vs "never existed"). Check disk: if the foundation is fully
    // written, the book really is ready; report that truthfully.
    const { isBookFoundationComplete } = await import("@actalk/inkos-core");
    if (await isBookFoundationComplete(state.bookDir(id))) {
      return c.json({ status: "ready" });
    }
    return c.json({ status: "missing" }, 404);
  });

  // --- Chapters ---

  app.get("/api/v1/books/:id/chapters/:num", async (c) => {
    const id = c.req.param("id");
    const num = parseInt(c.req.param("num"), 10);
    const bookDir = state.bookDir(id);
    const chaptersDir = join(bookDir, "chapters");

    try {
      const files = await readdir(chaptersDir);
      const paddedNum = String(num).padStart(4, "0");
      const match = files.find((f) => f.startsWith(paddedNum) && f.endsWith(".md"));
      if (!match) return c.json({ error: "Chapter not found" }, 404);
      const content = await readFile(join(chaptersDir, match), "utf-8");
      return c.json({ chapterNumber: num, filename: match, content });
    } catch {
      return c.json({ error: "Chapter not found" }, 404);
    }
  });

  // --- Chapter Save ---

  app.put("/api/v1/books/:id/chapters/:num", async (c) => {
    const id = c.req.param("id");
    const num = parseInt(c.req.param("num"), 10);
    const bookDir = state.bookDir(id);
    const chaptersDir = join(bookDir, "chapters");
    const body = await c.req.json<{ content: string; title?: string }>().catch(() => null);
    if (!body || typeof body.content !== "string") {
      return c.json({ error: "content is required" }, 400);
    }
    if (body.content.length > 2_000_000) {
      return c.json({ error: "Chapter content must be 2MB or fewer" }, 400);
    }
    const { content, title } = body;
    const nextTitle = title?.trim();
    if (title !== undefined && !nextTitle) {
      return c.json({ error: "Chapter title cannot be empty" }, 400);
    }

    try {
      const files = await readdir(chaptersDir);
      const paddedNum = String(num).padStart(4, "0");
      const match = files.find((f) => f.startsWith(paddedNum) && f.endsWith(".md"));
      if (!match) return c.json({ error: "Chapter not found" }, 404);

      const currentPath = join(chaptersDir, match);
      const nextContent = nextTitle
        ? replaceChapterTitleInMarkdown(content, num, nextTitle)
        : content;
      const nextFilename = nextTitle
        ? `${paddedNum}_${sanitizeChapterFilenameTitle(nextTitle)}.md`
        : match;
      const nextPath = join(chaptersDir, nextFilename);

      await writeFile(nextPath, nextContent, "utf-8");
      if (nextFilename !== match && nextPath.toLowerCase() !== currentPath.toLowerCase()) {
        await rm(currentPath, { force: true });
      }

      if (nextTitle) {
        const now = new Date().toISOString();
        const index = await state.loadChapterIndex(id);
        const updated = index.map((chapter) => chapter.number === num
          ? {
              ...chapter,
              title: nextTitle,
              wordCount: countContentUnits(nextContent),
              updatedAt: now,
            }
          : chapter);
        await state.saveChapterIndex(id, updated);
      }

      return c.json({ ok: true, chapterNumber: num, filename: nextFilename });
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  // --- Truth files ---

  // Use `:file{.+}` wildcard so nested paths (outline/..., roles/.../...) match.
  app.get("/api/v1/books/:id/truth/:file{.+}", async (c) => {
    const file = c.req.param("file");
    const id = c.req.param("id");

    const bookDir = state.bookDir(id);
    const historyMatch = file.match(/^(.+)\/history(?:\/(\d+))?$/);
    if (historyMatch) {
      const truthFile = historyMatch[1]!;
      const chapterText = historyMatch[2];
      if (!resolveTruthFilePath(bookDir, truthFile)) {
        return c.json({ error: "Invalid truth file" }, 400);
      }
      if (chapterText === undefined) {
        const versions = await listTruthFileHistory(bookDir, truthFile);
        return c.json({ file: truthFile, versions });
      }
      const chapter = Number(chapterText);
      if (!Number.isInteger(chapter) || chapter < 0) {
        return c.json({ error: "Invalid snapshot chapter" }, 400);
      }
      const history = await readTruthFileHistory(bookDir, truthFile, chapter);
      return c.json(history, history.content === null ? 404 : 200);
    }

    const resolved = resolveTruthFilePath(bookDir, file);
    if (!resolved) {
      return c.json({ error: "Invalid truth file" }, 400);
    }

    // Phase 5: new-layout books keep the authoritative prose under outline/.
    // A legacy book may only have story_bible.md / book_rules.md on disk —
    // we still serve those for read-only display, but flag them so the UI
    // can warn users their edits won't reach the runtime.
    // Hotfix: only tag as legacy when the book actually HAS the new layout.
    // Pre-Phase-5 books use story_bible/book_rules as the authoritative source.
    const { isNewLayoutBook, tryParseBookRulesFrontmatter } = await import("@actalk/inkos-core");
    const legacy = LEGACY_SHIM_FILES.has(file) && await isNewLayoutBook(bookDir);

    try {
      const content = await readFile(resolved, "utf-8");
      // Files like outline/story_frame.md carry a YAML frontmatter block of
      // structured fields (protagonist / genreLock / prohibitions / ...). Parse
      // it here so the UI can render those as friendly cards instead of dumping
      // raw YAML at the reader. `content` stays raw so the editor round-trips it
      // unchanged; `body` is the prose with the frontmatter stripped.
      const parsed = tryParseBookRulesFrontmatter(content);
      const structured = parsed ? { frontmatter: parsed.rules, body: parsed.body } : {};
      const runtimeDiagnostic = RUNTIME_DIAGNOSTIC_FILE_RE.test(file);
      const runtimeState = RUNTIME_STATE_FILE_RE.test(file);
      return c.json({
        file,
        content,
        ...structured,
        ...(legacy ? { legacy: true } : {}),
        ...(runtimeDiagnostic ? { readonly: true, readonlyReason: "runtime-diagnostic" } : {}),
        ...(runtimeState ? { readonly: true, readonlyReason: "runtime-state" } : {}),
      });
    } catch {
      const runtimeDiagnostic = RUNTIME_DIAGNOSTIC_FILE_RE.test(file);
      const runtimeState = RUNTIME_STATE_FILE_RE.test(file);
      return c.json({
        file,
        content: null,
        ...(legacy ? { legacy: true } : {}),
        ...(runtimeDiagnostic ? { readonly: true, readonlyReason: "runtime-diagnostic" } : {}),
        ...(runtimeState ? { readonly: true, readonlyReason: "runtime-state" } : {}),
      });
    }
  });

  // --- Analytics ---

  app.get("/api/v1/books/:id/analytics", async (c) => {
    const id = c.req.param("id");
    try {
      const chapters = await state.loadChapterIndex(id);
      const book = await state.loadBookConfig(id).catch(() => null);
      return c.json(computeAnalytics(id, chapters, book ? { targetChapters: book.targetChapters, chapterWordCount: book.chapterWordCount } : undefined));
    } catch {
      return c.json({ error: `Book "${id}" not found` }, 404);
    }
  });

  app.get("/api/v1/books/:id/knowledge", async (c) => {
    const id = c.req.param("id");
    return c.json(await knowledgeStore.loadOverview("book", id));
  });

  app.post("/api/v1/books/:id/knowledge/sources", async (c) => {
    const id = c.req.param("id");
    const body: { name?: string; content?: string; fileBase64?: string } = await c.req.json<{ name?: string; content?: string; fileBase64?: string }>().catch(() => ({}));
    const upload = await resolveKnowledgeUploadBody(body);
    const result = await knowledgeStore.addSource("book", id, {
      name: upload.name,
      content: upload.content,
    });
    const library = await knowledgeStore.loadOverview("book", id);
    return c.json({ ...library, extraction: upload.extraction, truncated: result.truncated, originalCharCount: result.originalCharCount });
  });

  app.delete("/api/v1/books/:id/knowledge/sources/:sourceId", async (c) => {
    const id = c.req.param("id");
    const sourceId = c.req.param("sourceId");
    await knowledgeStore.removeSource("book", id, sourceId);
    return c.json(await knowledgeStore.loadOverview("book", id));
  });

  app.post("/api/v1/books/:id/knowledge/rebuild", async (c) => {
    const id = c.req.param("id");
    await knowledgeStore.rebuild("book", id);
    return c.json(await knowledgeStore.loadOverview("book", id));
  });

  app.post("/api/v1/books/:id/knowledge/search", async (c) => {
    const id = c.req.param("id");
    const body: { query?: string; limit?: number; sourceIds?: string[] } = await c.req.json<{ query?: string; limit?: number; sourceIds?: string[] }>().catch(() => ({}));
    return c.json(await knowledgeStore.search("book", id, body.query ?? "", body.limit ?? 6, { sourceIds: body.sourceIds }));
  });

  app.get("/api/v1/knowledge/project", async (c) => {
    return c.json(await knowledgeStore.loadOverview("project", "global"));
  });

  app.post("/api/v1/knowledge/project/sources", async (c) => {
    const body: { name?: string; content?: string; fileBase64?: string } = await c.req.json<{ name?: string; content?: string; fileBase64?: string }>().catch(() => ({}));
    const upload = await resolveKnowledgeUploadBody(body);
    const result = await knowledgeStore.addSource("project", "global", {
      name: upload.name,
      content: upload.content,
    });
    const library = await knowledgeStore.loadOverview("project", "global");
    return c.json({ ...library, extraction: upload.extraction, truncated: result.truncated, originalCharCount: result.originalCharCount });
  });

  app.delete("/api/v1/knowledge/project/sources/:sourceId", async (c) => {
    await knowledgeStore.removeSource("project", "global", c.req.param("sourceId"));
    return c.json(await knowledgeStore.loadOverview("project", "global"));
  });

  app.post("/api/v1/knowledge/project/rebuild", async (c) => {
    await knowledgeStore.rebuild("project", "global");
    return c.json(await knowledgeStore.loadOverview("project", "global"));
  });

  app.post("/api/v1/knowledge/project/search", async (c) => {
    const body: { query?: string; limit?: number; sourceIds?: string[] } = await c.req.json<{ query?: string; limit?: number; sourceIds?: string[] }>().catch(() => ({}));
    return c.json(await knowledgeStore.search("project", "global", body.query ?? "", body.limit ?? 6, { sourceIds: body.sourceIds }));
  });

  // --- Scratchpad (灵感速记) ---

  app.get("/api/v1/books/:id/scratchpad", async (c) => {
    const id = c.req.param("id");
    const bookDir = state.bookDir(id);
    const filePath = join(bookDir, "scratchpad.json");
    try {
      const raw = await readFile(filePath, "utf-8");
      return c.json(JSON.parse(raw));
    } catch {
      return c.json([]);
    }
  });

  app.post("/api/v1/books/:id/scratchpad", async (c) => {
    const id = c.req.param("id");
    const body: { text?: string; tags?: string[]; linkedChapter?: number } = await c.req.json<{ text?: string; tags?: string[]; linkedChapter?: number }>().catch(() => ({}));
    if (!body.text?.trim()) return c.json({ error: "text is required" }, 400);
    const bookDir = state.bookDir(id);
    const filePath = join(bookDir, "scratchpad.json");
    let entries: Array<{ id: string; text: string; tags: string[]; createdAt: string; linkedChapter?: number }>;
    try {
      entries = JSON.parse(await readFile(filePath, "utf-8"));
    } catch {
      entries = [];
    }
    const entry = {
      id: crypto.randomUUID(),
      text: body.text.trim(),
      tags: body.tags ?? [],
      createdAt: new Date().toISOString(),
      ...(body.linkedChapter != null ? { linkedChapter: body.linkedChapter } : {}),
    };
    entries.push(entry);
    await mkdir(bookDir, { recursive: true });
    await writeFile(filePath, JSON.stringify(entries, null, 2), "utf-8");
    return c.json(entries);
  });

  app.delete("/api/v1/books/:id/scratchpad/:entryId", async (c) => {
    const id = c.req.param("id");
    const entryId = c.req.param("entryId");
    const bookDir = state.bookDir(id);
    const filePath = join(bookDir, "scratchpad.json");
    let entries: Array<{ id: string; text: string; tags: string[]; createdAt: string; linkedChapter?: number }>;
    try {
      entries = JSON.parse(await readFile(filePath, "utf-8"));
    } catch {
      return c.json([]);
    }
    const filtered = entries.filter((e) => e.id !== entryId);
    await writeFile(filePath, JSON.stringify(filtered, null, 2), "utf-8");
    return c.json(filtered);
  });

  // --- Clipboard (素材悬浮剪贴板) ---

  app.get("/api/v1/books/:id/clipboard", async (c) => {
    const id = c.req.param("id");
    const bookDir = state.bookDir(id);
    const filePath = join(bookDir, "clipboard.json");
    try {
      const raw = await readFile(filePath, "utf-8");
      return c.json(JSON.parse(raw));
    } catch {
      return c.json([]);
    }
  });

  app.post("/api/v1/books/:id/clipboard", async (c) => {
    const id = c.req.param("id");
    const body: { text?: string; label?: string; category?: string } = await c.req.json<{ text?: string; label?: string; category?: string }>().catch(() => ({}));
    if (!body.text?.trim()) return c.json({ error: "text is required" }, 400);
    const bookDir = state.bookDir(id);
    const filePath = join(bookDir, "clipboard.json");
    let entries: Array<{ id: string; text: string; label: string; category: string; createdAt: string }>;
    try {
      entries = JSON.parse(await readFile(filePath, "utf-8"));
    } catch {
      entries = [];
    }
    const entry = {
      id: crypto.randomUUID(),
      text: body.text.trim(),
      label: body.label?.trim() || body.text.trim().slice(0, 20),
      category: body.category?.trim() || "general",
      createdAt: new Date().toISOString(),
    };
    entries.unshift(entry);
    // Keep max 50 entries
    if (entries.length > 50) entries = entries.slice(0, 50);
    await mkdir(bookDir, { recursive: true });
    await writeFile(filePath, JSON.stringify(entries, null, 2), "utf-8");
    return c.json(entries);
  });

  app.delete("/api/v1/books/:id/clipboard/:entryId", async (c) => {
    const id = c.req.param("id");
    const entryId = c.req.param("entryId");
    const bookDir = state.bookDir(id);
    const filePath = join(bookDir, "clipboard.json");
    let entries: Array<{ id: string; text: string; label: string; category: string; createdAt: string }>;
    try {
      entries = JSON.parse(await readFile(filePath, "utf-8"));
    } catch {
      return c.json([]);
    }
    const filtered = entries.filter((e) => e.id !== entryId);
    await writeFile(filePath, JSON.stringify(filtered, null, 2), "utf-8");
    return c.json(filtered);
  });

  // --- Writing Schedule Calendar (更新排班日历) ---

  app.get("/api/v1/books/:id/schedule", async (c) => {
    const id = c.req.param("id");
    const bookDir = state.bookDir(id);
    const schedulePath = join(bookDir, "schedule.json");

    // Load chapter index for activity data
    const index = await state.loadChapterIndex(id);

    // Build activity map from chapter updates
    const activityMap = new Map<string, { chaptersWritten: number; chaptersUpdated: number; wordsAdded: number }>();

    for (const chapter of index) {
      if (chapter.updatedAt) {
        const date = chapter.updatedAt.split("T")[0];
        const existing = activityMap.get(date) ?? { chaptersWritten: 0, chaptersUpdated: 0, wordsAdded: 0 };
        if (chapter.status === "drafted" || chapter.status === "approved") {
          existing.chaptersWritten++;
        }
        existing.chaptersUpdated++;
        existing.wordsAdded += chapter.wordCount ?? 0;
        activityMap.set(date, existing);
      }
    }

    // Load custom schedule entries
    let scheduleEntries: Array<{ id: string; date: string; title: string; type: "deadline" | "goal" | "milestone"; completed: boolean }> = [];
    try {
      scheduleEntries = JSON.parse(await readFile(schedulePath, "utf-8"));
    } catch {
      // No schedule file yet
    }

    // Build calendar data for last 90 days
    const today = new Date();
    const calendarDays: Array<{
      date: string;
      activity: { chaptersWritten: number; chaptersUpdated: number; wordsAdded: number } | null;
      schedule: Array<{ id: string; title: string; type: string; completed: boolean }>;
    }> = [];

    for (let i = 89; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const dateStr = d.toISOString().split("T")[0];
      calendarDays.push({
        date: dateStr,
        activity: activityMap.get(dateStr) ?? null,
        schedule: scheduleEntries.filter((e) => e.date === dateStr),
      });
    }

    // Calculate stats
    const totalDaysActive = activityMap.size;
    const totalWordsWritten = index.reduce((sum, ch) => sum + (ch.wordCount ?? 0), 0);
    const avgWordsPerDay = totalDaysActive > 0 ? Math.round(totalWordsWritten / totalDaysActive) : 0;

    // Calculate streak
    let currentStreak = 0;
    let maxStreak = 0;
    let tempStreak = 0;

    // Calculate max streak from the calendarDays (last 90 days)
    for (let i = 0; i < calendarDays.length; i++) {
      if (calendarDays[i].activity) {
        tempStreak++;
        if (tempStreak > maxStreak) maxStreak = tempStreak;
      } else {
        tempStreak = 0;
      }
    }

    // Current streak: count backwards from today/yesterday
    const todayStr = today.toISOString().split("T")[0];
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = yesterday.toISOString().split("T")[0];

    if (activityMap.has(todayStr) || activityMap.has(yesterdayStr)) {
      let d = activityMap.has(todayStr) ? new Date(today) : yesterday;
      while (activityMap.has(d.toISOString().split("T")[0])) {
        currentStreak++;
        d.setDate(d.getDate() - 1);
      }
    }

    return c.json({
      calendarDays,
      stats: {
        totalDaysActive,
        totalWordsWritten,
        avgWordsPerDay,
        currentStreak,
        maxStreak,
      },
      scheduleEntries,
    });
  });

  app.post("/api/v1/books/:id/schedule", async (c) => {
    const id = c.req.param("id");
    const body: { date?: string; title?: string; type?: "deadline" | "goal" | "milestone" } = await c.req.json().catch(() => ({}));
    if (!body.date || !body.title) return c.json({ error: "date and title are required" }, 400);

    const bookDir = state.bookDir(id);
    const schedulePath = join(bookDir, "schedule.json");
    let entries: Array<{ id: string; date: string; title: string; type: "deadline" | "goal" | "milestone"; completed: boolean }>;
    try {
      entries = JSON.parse(await readFile(schedulePath, "utf-8"));
    } catch {
      entries = [];
    }

    const entry = {
      id: crypto.randomUUID(),
      date: body.date,
      title: body.title.trim(),
      type: body.type ?? "goal",
      completed: false,
    };
    entries.push(entry);
    await mkdir(bookDir, { recursive: true });
    await writeFile(schedulePath, JSON.stringify(entries, null, 2), "utf-8");
    return c.json(entry);
  });

  app.put("/api/v1/books/:id/schedule/:entryId", async (c) => {
    const id = c.req.param("id");
    const entryId = c.req.param("entryId");
    const body: { completed?: boolean; title?: string; date?: string } = await c.req.json().catch(() => ({}));

    const bookDir = state.bookDir(id);
    const schedulePath = join(bookDir, "schedule.json");
    let entries: Array<{ id: string; date: string; title: string; type: string; completed: boolean }>;
    try {
      entries = JSON.parse(await readFile(schedulePath, "utf-8"));
    } catch {
      return c.json({ error: "Schedule not found" }, 404);
    }

    const index = entries.findIndex((e) => e.id === entryId);
    if (index === -1) return c.json({ error: "Entry not found" }, 404);

    if (body.completed !== undefined) entries[index].completed = body.completed;
    if (body.title) entries[index].title = body.title;
    if (body.date) entries[index].date = body.date;

    await writeFile(schedulePath, JSON.stringify(entries, null, 2), "utf-8");
    return c.json(entries[index]);
  });

  app.delete("/api/v1/books/:id/schedule/:entryId", async (c) => {
    const id = c.req.param("id");
    const entryId = c.req.param("entryId");

    const bookDir = state.bookDir(id);
    const schedulePath = join(bookDir, "schedule.json");
    let entries: Array<{ id: string; date: string; title: string; type: string; completed: boolean }>;
    try {
      entries = JSON.parse(await readFile(schedulePath, "utf-8"));
    } catch {
      return c.json({ error: "Schedule not found" }, 404);
    }

    entries = entries.filter((e) => e.id !== entryId);
    await writeFile(schedulePath, JSON.stringify(entries, null, 2), "utf-8");
    return c.json({ ok: true });
  });

  // --- Reader Comments Simulation (读者评论模拟分析) ---

  app.post("/api/v1/books/:id/chapters/:chapter/simulate-comments", async (c) => {
    const id = c.req.param("id");
    const chapterNum = parseInt(c.req.param("chapter"), 10);

    try {
      const bookDir = state.bookDir(id);
      const chaptersDir = join(bookDir, "chapters");
      const files = await readdir(chaptersDir);
      const paddedNum = String(chapterNum).padStart(4, "0");
      const match = files.find((f) => f.startsWith(paddedNum) && f.endsWith(".md"));
      if (!match) return c.json({ error: "Chapter not found" }, 404);

      const content = await readFile(join(chaptersDir, match), "utf-8");
      const book = await state.loadBookConfig(id);

      // Build prompt for simulating reader comments
      const prompt = `你是一个网文读者评论模拟器。请根据以下章节内容，模拟 5-8 条真实读者可能发表的评论。

要求：
1. 评论风格要像真实网文读者（口语化、有梗、有情绪）
2. 包含不同类型的读者：理性分析型、情感共鸣型、吐槽型、催更型、细节控
3. 每条评论包含：用户名（随机生成）、评论内容、情绪标签（正面/中性/负面）、点赞数（模拟）
4. 最后给出一段整体读者反馈总结

书名：${book.title}
章节号：第${chapterNum}章

章节内容：
${content.slice(0, 3000)}${content.length > 3000 ? "\n...(内容截断)" : ""}

请以JSON格式返回：
{
  "comments": [
    {
      "username": "用户名",
      "content": "评论内容",
      "sentiment": "positive|neutral|negative",
      "likes": 123,
      "timestamp": "模拟时间"
    }
  ],
  "summary": "整体读者反馈总结",
  "highlights": ["亮点1", "亮点2"],
  "concerns": ["问题1", "问题2"]
}`;

      // Use LLM to generate comments
      const pipelineConfig = await buildPipelineConfig();
      const response = await chatCompletion(pipelineConfig.client, pipelineConfig.model, [{ role: "user", content: prompt }]);
      const result = response.content;

      // Parse JSON from response
      let parsed;
      try {
        const jsonMatch = result.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          parsed = JSON.parse(jsonMatch[0]);
        }
      } catch {
        // If parsing fails, return raw text
        parsed = { rawResponse: result };
      }

      // Cache the result
      const cachePath = join(bookDir, "runtime", `chapter-${paddedNum}.comments.json`);
      await mkdir(join(bookDir, "runtime"), { recursive: true });
      await writeFile(cachePath, JSON.stringify(parsed, null, 2), "utf-8");

      return c.json(parsed);
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  app.get("/api/v1/books/:id/chapters/:chapter/comments", async (c) => {
    const id = c.req.param("id");
    const chapterNum = parseInt(c.req.param("chapter"), 10);

    try {
      const bookDir = state.bookDir(id);
      const paddedNum = String(chapterNum).padStart(4, "0");
      const cachePath = join(bookDir, "runtime", `chapter-${paddedNum}.comments.json`);

      try {
        const raw = await readFile(cachePath, "utf-8");
        return c.json(JSON.parse(raw));
      } catch {
        return c.json(null);
      }
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  // --- Chapter Translation (翻译转换) ---

  app.post("/api/v1/books/:id/chapters/:chapter/translate", async (c) => {
    const id = c.req.param("id");
    const chapterNum = parseInt(c.req.param("chapter"), 10);
    const body: { targetLanguage?: string; style?: "literal" | "literary" | "colloquial" } = await c.req.json().catch(() => ({}));
    const targetLanguage = body.targetLanguage ?? "en";
    const style = body.style ?? "literary";

    try {
      const bookDir = state.bookDir(id);
      const chaptersDir = join(bookDir, "chapters");
      const files = await readdir(chaptersDir);
      const paddedNum = String(chapterNum).padStart(4, "0");
      const match = files.find((f) => f.startsWith(paddedNum) && f.endsWith(".md"));
      if (!match) return c.json({ error: "Chapter not found" }, 404);

      const content = await readFile(join(chaptersDir, match), "utf-8");
      const book = await state.loadBookConfig(id);

      // Build translation prompt
      const styleDescriptions = {
        literal: "直译，保持原文结构和表达方式",
        literary: "文学翻译，注重意境和文采",
        colloquial: "口语化翻译，通俗易懂",
      };

      const languageNames: Record<string, string> = {
        en: "英语",
        ja: "日语",
        ko: "韩语",
        fr: "法语",
        de: "德语",
        es: "西班牙语",
        ru: "俄语",
      };

      const targetLangName = languageNames[targetLanguage] ?? targetLanguage;

      const prompt = `你是一位专业的文学翻译家。请将以下中文小说章节翻译成${targetLangName}。

翻译风格：${styleDescriptions[style]}

要求：
1. 保持原文的叙事节奏和情感基调
2. 人名音译要统一，首次出现时在括号内注明原文
3. 文化特定的表达要适当本地化，但保留原意
4. 对话要自然流畅，符合目标语言的表达习惯
5. 章节标题也要翻译

书名：${book.title}
章节号：第${chapterNum}章

原文：
${content}

请直接输出翻译结果，保持原文的Markdown格式。`;

      // Use LLM for translation
      const pipelineConfig = await buildPipelineConfig();
      const response = await chatCompletion(pipelineConfig.client, pipelineConfig.model, [{ role: "user", content: prompt }]);
      const result = response.content;

      // Save translated version
      const translatedDir = join(bookDir, "translations");
      await mkdir(translatedDir, { recursive: true });
      const translatedPath = join(translatedDir, `${paddedNum}_${targetLanguage}.md`);
      await writeFile(translatedPath, result, "utf-8");

      return c.json({
        translatedContent: result,
        savedPath: translatedPath,
        targetLanguage,
        style,
        wordCount: result.length,
      });
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  app.get("/api/v1/books/:id/chapters/:chapter/translations", async (c) => {
    const id = c.req.param("id");
    const chapterNum = parseInt(c.req.param("chapter"), 10);

    try {
      const bookDir = state.bookDir(id);
      const translatedDir = join(bookDir, "translations");
      const paddedNum = String(chapterNum).padStart(4, "0");

      try {
        const files = await readdir(translatedDir);
        const translations = files
          .filter((f) => f.startsWith(paddedNum) && f.endsWith(".md"))
          .map((f) => {
            const lang = f.replace(`${paddedNum}_`, "").replace(".md", "");
            return { language: lang, filename: f };
          });
        return c.json(translations);
      } catch {
        return c.json([]);
      }
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  // --- Audiobook Adaptation (有声书适配优化) ---

  app.post("/api/v1/books/:id/chapters/:chapter/audiobook-adapt", async (c) => {
    const id = c.req.param("id");
    const chapterNum = parseInt(c.req.param("chapter"), 10);
    const body: { voiceStyle?: string; pacing?: "slow" | "normal" | "fast" } = await c.req.json().catch(() => ({}));
    const voiceStyle = body.voiceStyle ?? "标准朗读";
    const pacing = body.pacing ?? "normal";

    try {
      const bookDir = state.bookDir(id);
      const chaptersDir = join(bookDir, "chapters");
      const files = await readdir(chaptersDir);
      const paddedNum = String(chapterNum).padStart(4, "0");
      const match = files.find((f) => f.startsWith(paddedNum) && f.endsWith(".md"));
      if (!match) return c.json({ error: "Chapter not found" }, 404);

      const content = await readFile(join(chaptersDir, match), "utf-8");
      const book = await state.loadBookConfig(id);

      // Build audiobook adaptation prompt
      const pacingDescriptions = {
        slow: "慢速朗读，适合抒情、描写段落",
        normal: "正常语速，适合一般叙述",
        fast: "快速朗读，适合紧张、动作场景",
      };

      const prompt = `你是一位专业的有声书制作顾问。请将以下小说章节优化为适合有声书朗读的版本。

朗读风格：${voiceStyle}
语速节奏：${pacingDescriptions[pacing]}

优化要求：
1. 添加适当的停顿标记（用"..."表示短停顿，"......"表示长停顿）
2. 为对话添加说话人提示（如：[旁白]、[角色名]）
3. 调整标点符号以符合口语表达习惯
4. 为特殊场景添加音效提示（如：[脚步声]、[风声]）
5. 将书面化的表达转换为更口语化的表达
6. 保持原文的核心内容和情感基调
7. 在章节开头添加章节标题朗读提示
8. 在章节结尾添加结束标记

书名：${book.title}
章节号：第${chapterNum}章

原文：
${content}

请输出优化后的有声书版本，并在最后附上：
1. 预计朗读时长（按每分钟200字计算）
2. 关键情感节点标注
3. 建议的背景音乐类型`;

      // Use LLM for adaptation
      const pipelineConfig = await buildPipelineConfig();
      const response = await chatCompletion(pipelineConfig.client, pipelineConfig.model, [{ role: "user", content: prompt }]);
      const result = response.content;

      // Save adapted version
      const adaptedDir = join(bookDir, "audiobook");
      await mkdir(adaptedDir, { recursive: true });
      const adaptedPath = join(adaptedDir, `${paddedNum}_adapted.md`);
      await writeFile(adaptedPath, result, "utf-8");

      // Calculate estimated duration
      const wordCount = result.length;
      const estimatedMinutes = Math.ceil(wordCount / 200);

      return c.json({
        adaptedContent: result,
        savedPath: adaptedPath,
        wordCount,
        estimatedDuration: `${estimatedMinutes}分钟`,
        voiceStyle,
        pacing,
      });
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  app.get("/api/v1/books/:id/chapters/:chapter/audiobook", async (c) => {
    const id = c.req.param("id");
    const chapterNum = parseInt(c.req.param("chapter"), 10);

    try {
      const bookDir = state.bookDir(id);
      const paddedNum = String(chapterNum).padStart(4, "0");
      const adaptedPath = join(bookDir, "audiobook", `${paddedNum}_adapted.md`);

      try {
        const content = await readFile(adaptedPath, "utf-8");
        return c.json({ content, path: adaptedPath });
      } catch {
        return c.json(null);
      }
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  // --- Auto Summary (自动摘要生成) ---

  app.post("/api/v1/books/:id/chapters/:chapter/summary", async (c) => {
    const id = c.req.param("id");
    const chapterNum = parseInt(c.req.param("chapter"), 10);
    const body: { style?: "brief" | "detailed" | "bullet" } = await c.req.json().catch(() => ({}));
    const style = body.style ?? "brief";

    try {
      const bookDir = state.bookDir(id);
      const chaptersDir = join(bookDir, "chapters");
      const files = await readdir(chaptersDir);
      const paddedNum = String(chapterNum).padStart(4, "0");
      const match = files.find((f) => f.startsWith(paddedNum) && f.endsWith(".md"));
      if (!match) return c.json({ error: "Chapter not found" }, 404);

      const content = await readFile(join(chaptersDir, match), "utf-8");
      const book = await state.loadBookConfig(id);

      const stylePrompts = {
        brief: "生成一段简洁的摘要（100-150字），概括主要情节",
        detailed: "生成详细摘要（300-500字），包含主要情节、角色互动和关键转折",
        bullet: "以要点列表形式生成摘要，包含：主要事件、角色变化、情感转折、伏笔线索",
      };

      const prompt = `你是一位专业的文学编辑。请为以下小说章节生成摘要。

书名：${book.title}
章节号：第${chapterNum}章

要求：${stylePrompts[style]}

章节内容：
${content.slice(0, 4000)}

请直接输出摘要内容。`;

      const pipelineConfig = await buildPipelineConfig();
      const response = await chatCompletion(pipelineConfig.client, pipelineConfig.model, [{ role: "user", content: prompt }]);
      const result = response.content;

      // Cache summary
      const cachePath = join(bookDir, "runtime", `chapter-${paddedNum}.summary.json`);
      await mkdir(join(bookDir, "runtime"), { recursive: true });
      await writeFile(cachePath, JSON.stringify({ summary: result, style, generatedAt: new Date().toISOString() }, null, 2), "utf-8");

      return c.json({ summary: result, style });
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  app.get("/api/v1/books/:id/chapters/:chapter/summary", async (c) => {
    const id = c.req.param("id");
    const chapterNum = parseInt(c.req.param("chapter"), 10);

    try {
      const bookDir = state.bookDir(id);
      const paddedNum = String(chapterNum).padStart(4, "0");
      const cachePath = join(bookDir, "runtime", `chapter-${paddedNum}.summary.json`);

      try {
        const raw = await readFile(cachePath, "utf-8");
        return c.json(JSON.parse(raw));
      } catch {
        return c.json(null);
      }
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  // --- Sensitive Content Detection (敏感内容检测) ---

  app.post("/api/v1/books/:id/chapters/:chapter/detect-sensitive", async (c) => {
    const id = c.req.param("id");
    const chapterNum = parseInt(c.req.param("chapter"), 10);

    try {
      const bookDir = state.bookDir(id);
      const chaptersDir = join(bookDir, "chapters");
      const files = await readdir(chaptersDir);
      const paddedNum = String(chapterNum).padStart(4, "0");
      const match = files.find((f) => f.startsWith(paddedNum) && f.endsWith(".md"));
      if (!match) return c.json({ error: "Chapter not found" }, 404);

      const content = await readFile(join(chaptersDir, match), "utf-8");

      // Built-in sensitive word patterns
      const sensitivePatterns = [
        { category: "政治敏感", pattern: /习近平|毛泽东|共产党|国民党|六四|天安门|法轮功|藏独|疆独|台独/gi },
        { category: "色情内容", pattern: /做爱|性交|淫荡|骚逼|鸡巴|阴茎|阴道|乳房|高潮|口交|肛交/gi },
        { category: "暴力血腥", pattern: /砍死|杀死|捅死|血流成河|肢解|虐杀|自杀|割腕|上吊/gi },
        { category: "赌博相关", pattern: /赌博|赌场|老虎机|扑克|麻将|赌钱|赌注|赌局/gi },
        { category: "毒品相关", pattern: /毒品|大麻|可卡因|冰毒|摇头丸|吸毒|贩毒|戒毒/gi },
        { category: "歧视用语", pattern: /黑鬼|白猪|支那|东亚病夫|残废|弱智|神经病/gi },
      ];

      const findings: Array<{ category: string; word: string; position: number; context: string }> = [];

      for (const { category, pattern } of sensitivePatterns) {
        let match;
        const regex = new RegExp(pattern.source, pattern.flags);
        while ((match = regex.exec(content)) !== null) {
          const start = Math.max(0, match.index - 20);
          const end = Math.min(content.length, match.index + match[0].length + 20);
          findings.push({
            category,
            word: match[0],
            position: match.index,
            context: content.slice(start, end),
          });
        }
      }

      // Cache results
      const cachePath = join(bookDir, "runtime", `chapter-${paddedNum}.sensitive.json`);
      await mkdir(join(bookDir, "runtime"), { recursive: true });
      await writeFile(cachePath, JSON.stringify({ findings, checkedAt: new Date().toISOString() }, null, 2), "utf-8");

      return c.json({
        findings,
        totalFindings: findings.length,
        categories: [...new Set(findings.map((f) => f.category))],
      });
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  // --- Style Consistency Check (风格一致性检查) ---

  app.post("/api/v1/books/:id/check-style-consistency", async (c) => {
    const id = c.req.param("id");

    try {
      const bookDir = state.bookDir(id);
      const chaptersDir = join(bookDir, "chapters");
      const files = await readdir(chaptersDir);
      const book = await state.loadBookConfig(id);

      // Sample up to 5 chapters for style analysis
      const chapterFiles = files
        .filter((f) => f.endsWith(".md") && /^\d{4}/.test(f))
        .sort()
        .slice(0, 5);

      if (chapterFiles.length < 2) {
        return c.json({ error: "需要至少2个章节进行风格分析" }, 400);
      }

      const chaptersContent: Array<{ number: number; content: string }> = [];
      for (const file of chapterFiles) {
        const chapterNum = parseInt(file.slice(0, 4), 10);
        const content = await readFile(join(chaptersDir, file), "utf-8");
        chaptersContent.push({ number: chapterNum, content: content.slice(0, 1500) });
      }

      const prompt = `你是一位文学风格分析专家。请分析以下${chaptersContent.length}个章节的写作风格一致性。

书名：${book.title}

${chaptersContent.map((ch) => `--- 第${ch.number}章 ---\n${ch.content}`).join("\n\n")}

请分析并返回JSON格式：
{
  "overallConsistency": 0.85,
  "aspects": {
    "vocabulary": { "score": 0.9, "notes": "用词风格分析" },
    "sentenceStructure": { "score": 0.8, "notes": "句式结构分析" },
    "tone": { "score": 0.85, "notes": "语气语调分析" },
    "narrativeStyle": { "score": 0.9, "notes": "叙事风格分析" }
  },
  "inconsistencies": [
    { "chapters": [1, 3], "issue": "具体不一致描述", "suggestion": "修改建议" }
  ],
  "summary": "整体风格一致性总结"
}`;

      const pipelineConfig = await buildPipelineConfig();
      const response = await chatCompletion(pipelineConfig.client, pipelineConfig.model, [{ role: "user", content: prompt }]);
      const result = response.content;

      let parsed;
      try {
        const jsonMatch = result.match(/\{[\s\S]*\}/);
        if (jsonMatch) parsed = JSON.parse(jsonMatch[0]);
      } catch {
        parsed = { rawResponse: result };
      }

      return c.json(parsed);
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  // --- Character Dialogue Analysis (角色对话风格分析) ---

  app.post("/api/v1/books/:id/chapters/:chapter/analyze-dialogue", async (c) => {
    const id = c.req.param("id");
    const chapterNum = parseInt(c.req.param("chapter"), 10);

    try {
      const bookDir = state.bookDir(id);
      const chaptersDir = join(bookDir, "chapters");
      const files = await readdir(chaptersDir);
      const paddedNum = String(chapterNum).padStart(4, "0");
      const match = files.find((f) => f.startsWith(paddedNum) && f.endsWith(".md"));
      if (!match) return c.json({ error: "Chapter not found" }, 404);

      const content = await readFile(join(chaptersDir, match), "utf-8");
      const book = await state.loadBookConfig(id);

      const prompt = `你是一位角色分析专家。请分析以下章节中的角色对话风格。

书名：${book.title}
章节号：第${chapterNum}章

要求：
1. 识别所有说话的角色
2. 分析每个角色的对话特点（语气、用词、句式）
3. 评估对话是否符合角色人设
4. 指出对话中的问题（如角色声音雷同、不符合性格等）

章节内容：
${content.slice(0, 4000)}

请返回JSON格式：
{
  "characters": [
    {
      "name": "角色名",
      "dialogueCount": 5,
      "style": "对话风格描述",
      "consistency": 0.85,
      "issues": ["问题1"]
    }
  ],
  "overallQuality": 0.8,
  "suggestions": ["建议1", "建议2"]
}`;

      const pipelineConfig = await buildPipelineConfig();
      const response = await chatCompletion(pipelineConfig.client, pipelineConfig.model, [{ role: "user", content: prompt }]);
      const result = response.content;

      let parsed;
      try {
        const jsonMatch = result.match(/\{[\s\S]*\}/);
        if (jsonMatch) parsed = JSON.parse(jsonMatch[0]);
      } catch {
        parsed = { rawResponse: result };
      }

      return c.json(parsed);
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  // --- Plot Pacing Analysis (剧情节奏分析) ---

  app.post("/api/v1/books/:id/analyze-pacing", async (c) => {
    const id = c.req.param("id");

    try {
      const bookDir = state.bookDir(id);
      const chaptersDir = join(bookDir, "chapters");
      const files = await readdir(chaptersDir);
      const book = await state.loadBookConfig(id);
      const index = await state.loadChapterIndex(id);

      // Get chapter summaries for pacing analysis
      const chaptersData: Array<{ number: number; wordCount: number; content: string }> = [];
      const chapterFiles = files
        .filter((f) => f.endsWith(".md") && /^\d{4}/.test(f))
        .sort()
        .slice(0, 10);

      for (const file of chapterFiles) {
        const chapterNum = parseInt(file.slice(0, 4), 10);
        const content = await readFile(join(chaptersDir, file), "utf-8");
        const meta = index.find((ch) => ch.number === chapterNum);
        chaptersData.push({
          number: chapterNum,
          wordCount: meta?.wordCount ?? content.length,
          content: content.slice(0, 800),
        });
      }

      const prompt = `你是一位剧情节奏分析专家。请分析以下小说的剧情节奏。

书名：${book.title}
章节数：${chaptersData.length}章

章节数据：
${chaptersData.map((ch) => `第${ch.number}章 (${ch.wordCount}字): ${ch.content.slice(0, 200)}...`).join("\n")}

请分析并返回JSON格式：
{
  "overallPacing": "fast|medium|slow|mixed",
  "pacingCurve": [
    { "chapter": 1, "pacing": "fast", "tension": 0.8 }
  ],
  "issues": [
    { "type": "too_fast|too_slow|uneven", "chapters": [3, 4], "description": "问题描述" }
  ],
  "suggestions": ["建议1"],
  "summary": "整体节奏分析总结"
}`;

      const pipelineConfig = await buildPipelineConfig();
      const response = await chatCompletion(pipelineConfig.client, pipelineConfig.model, [{ role: "user", content: prompt }]);
      const result = response.content;

      let parsed;
      try {
        const jsonMatch = result.match(/\{[\s\S]*\}/);
        if (jsonMatch) parsed = JSON.parse(jsonMatch[0]);
      } catch {
        parsed = { rawResponse: result };
      }

      return c.json(parsed);
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  // --- Plot Conflict Detection (剧情冲突检测) ---

  app.post("/api/v1/books/:id/detect-conflicts", async (c) => {
    const id = c.req.param("id");

    try {
      const bookDir = state.bookDir(id);
      const chaptersDir = join(bookDir, "chapters");
      const files = await readdir(chaptersDir);
      const book = await state.loadBookConfig(id);

      // Load truth files for context
      const truthDir = join(bookDir, "story");
      let truthContent = "";
      try {
        const truthFiles = await readdir(truthDir);
        for (const file of truthFiles.slice(0, 3)) {
          if (file.endsWith(".md")) {
            truthContent += await readFile(join(truthDir, file), "utf-8") + "\n";
          }
        }
      } catch { /* ignore */ }

      // Sample chapters
      const chapterFiles = files
        .filter((f) => f.endsWith(".md") && /^\d{4}/.test(f))
        .sort()
        .slice(0, 6);

      const chaptersContent: Array<{ number: number; content: string }> = [];
      for (const file of chapterFiles) {
        const chapterNum = parseInt(file.slice(0, 4), 10);
        const content = await readFile(join(chaptersDir, file), "utf-8");
        chaptersContent.push({ number: chapterNum, content: content.slice(0, 1000) });
      }

      const prompt = `你是一位剧情逻辑分析专家。请检测以下小说中的剧情冲突和逻辑问题。

书名：${book.title}

背景设定：
${truthContent.slice(0, 1500)}

章节内容：
${chaptersContent.map((ch) => `--- 第${ch.number}章 ---\n${ch.content}`).join("\n\n")}

请检测以下类型的冲突：
1. 时间线矛盾（事件顺序不合理）
2. 角色行为矛盾（角色行为与人设不符）
3. 设定矛盾（前后设定不一致）
4. 因果关系问题（事件缺乏合理因果）

请返回JSON格式：
{
  "conflicts": [
    {
      "type": "timeline|character|setting|causality",
      "severity": "high|medium|low",
      "chapters": [1, 3],
      "description": "冲突描述",
      "suggestion": "修复建议"
    }
  ],
  "totalConflicts": 3,
  "summary": "整体逻辑性评估"
}`;

      const pipelineConfig = await buildPipelineConfig();
      const response = await chatCompletion(pipelineConfig.client, pipelineConfig.model, [{ role: "user", content: prompt }]);
      const result = response.content;

      let parsed;
      try {
        const jsonMatch = result.match(/\{[\s\S]*\}/);
        if (jsonMatch) parsed = JSON.parse(jsonMatch[0]);
      } catch {
        parsed = { rawResponse: result };
      }

      return c.json(parsed);
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  // --- Foreshadowing Tracking (伏笔/线索追踪) ---

  app.get("/api/v1/books/:id/foreshadowing", async (c) => {
    const id = c.req.param("id");

    try {
      const bookDir = state.bookDir(id);
      const filePath = join(bookDir, "foreshadowing.json");

      try {
        const raw = await readFile(filePath, "utf-8");
        return c.json(JSON.parse(raw));
      } catch {
        return c.json({ items: [] });
      }
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  app.post("/api/v1/books/:id/foreshadowing/scan", async (c) => {
    const id = c.req.param("id");

    try {
      const bookDir = state.bookDir(id);
      const chaptersDir = join(bookDir, "chapters");
      const files = await readdir(chaptersDir);
      const book = await state.loadBookConfig(id);

      const chapterFiles = files
        .filter((f) => f.endsWith(".md") && /^\d{4}/.test(f))
        .sort();

      const chaptersContent: Array<{ number: number; content: string }> = [];
      for (const file of chapterFiles.slice(0, 8)) {
        const chapterNum = parseInt(file.slice(0, 4), 10);
        const content = await readFile(join(chaptersDir, file), "utf-8");
        chaptersContent.push({ number: chapterNum, content: content.slice(0, 1000) });
      }

      const prompt = `你是一位伏笔分析专家。请分析以下小说中的伏笔和线索。

书名：${book.title}

章节内容：
${chaptersContent.map((ch) => `--- 第${ch.number}章 ---\n${ch.content}`).join("\n\n")}

请识别：
1. 已埋设的伏笔（未回收）
2. 已回收的伏笔
3. 潜在的线索
4. 伏笔的强弱程度

请返回JSON格式：
{
  "items": [
    {
      "type": "planted|resolved|clue",
      "content": "伏笔内容描述",
      "plantedChapter": 1,
      "resolvedChapter": null,
      "strength": "strong|medium|weak",
      "importance": "high|medium|low"
    }
  ],
  "summary": "伏笔分布总结"
}`;

      const pipelineConfig = await buildPipelineConfig();
      const response = await chatCompletion(pipelineConfig.client, pipelineConfig.model, [{ role: "user", content: prompt }]);
      const result = response.content;

      let parsed;
      try {
        const jsonMatch = result.match(/\{[\s\S]*\}/);
        if (jsonMatch) parsed = JSON.parse(jsonMatch[0]);
      } catch {
        parsed = { items: [] };
      }

      // Save to file
      const filePath = join(bookDir, "foreshadowing.json");
      await writeFile(filePath, JSON.stringify(parsed, null, 2), "utf-8");

      return c.json(parsed);
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  app.post("/api/v1/books/:id/foreshadowing", async (c) => {
    const id = c.req.param("id");
    const body: { type?: string; content?: string; plantedChapter?: number; importance?: string } = await c.req.json().catch(() => ({}));

    if (!body.content) return c.json({ error: "content is required" }, 400);

    try {
      const bookDir = state.bookDir(id);
      const filePath = join(bookDir, "foreshadowing.json");

      let data: { items: Array<{ id: string; type: string; content: string; plantedChapter: number; resolvedChapter: number | null; strength: string; importance: string }> };
      try {
        data = JSON.parse(await readFile(filePath, "utf-8"));
      } catch {
        data = { items: [] };
      }

      data.items.push({
        id: crypto.randomUUID(),
        type: body.type ?? "planted",
        content: body.content,
        plantedChapter: body.plantedChapter ?? 0,
        resolvedChapter: null,
        strength: "medium",
        importance: body.importance ?? "medium",
      });

      await writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
      return c.json(data);
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  app.put("/api/v1/books/:id/foreshadowing/:itemId", async (c) => {
    const id = c.req.param("id");
    const itemId = c.req.param("itemId");
    const body: { type?: string; content?: string; plantedChapter?: number; resolvedChapter?: number | null; strength?: string; importance?: string } = await c.req.json().catch(() => ({}));

    try {
      const bookDir = state.bookDir(id);
      const filePath = join(bookDir, "foreshadowing.json");

      let data: { items: Array<{ id: string; type: string; content: string; plantedChapter: number; resolvedChapter: number | null; strength: string; importance: string }> };
      try {
        data = JSON.parse(await readFile(filePath, "utf-8"));
      } catch {
        return c.json({ error: "foreshadowing.json not found" }, 404);
      }

      const idx = data.items.findIndex((item) => item.id === itemId);
      if (idx === -1) return c.json({ error: "item not found" }, 404);

      const existing = data.items[idx];
      data.items[idx] = {
        ...existing,
        ...(body.type !== undefined && { type: body.type }),
        ...(body.content !== undefined && { content: body.content }),
        ...(body.plantedChapter !== undefined && { plantedChapter: body.plantedChapter }),
        ...(body.resolvedChapter !== undefined && { resolvedChapter: body.resolvedChapter }),
        ...(body.strength !== undefined && { strength: body.strength }),
        ...(body.importance !== undefined && { importance: body.importance }),
      };

      await writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
      return c.json(data);
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  app.delete("/api/v1/books/:id/foreshadowing/:itemId", async (c) => {
    const id = c.req.param("id");
    const itemId = c.req.param("itemId");

    try {
      const bookDir = state.bookDir(id);
      const filePath = join(bookDir, "foreshadowing.json");

      let data: { items: Array<{ id: string; [key: string]: unknown }> };
      try {
        data = JSON.parse(await readFile(filePath, "utf-8"));
      } catch {
        return c.json({ error: "foreshadowing.json not found" }, 404);
      }

      data.items = data.items.filter((item) => item.id !== itemId);
      await writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
      return c.json(data);
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  // --- Character Relationship Graph (角色关系图谱) ---

  app.get("/api/v1/books/:id/character-graph", async (c) => {
    const id = c.req.param("id");

    try {
      const bookDir = state.bookDir(id);
      const filePath = join(bookDir, "character-graph.json");

      try {
        const raw = await readFile(filePath, "utf-8");
        return c.json(JSON.parse(raw));
      } catch {
        return c.json({ characters: [], relationships: [] });
      }
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  app.post("/api/v1/books/:id/character-graph/build", async (c) => {
    const id = c.req.param("id");

    try {
      const bookDir = state.bookDir(id);
      const chaptersDir = join(bookDir, "chapters");
      const files = await readdir(chaptersDir);
      const book = await state.loadBookConfig(id);

      // Load character files if available
      const truthDir = join(bookDir, "story");
      let characterContent = "";
      try {
        const truthFiles = await readdir(truthDir);
        for (const file of truthFiles) {
          if (file.includes("character") || file.includes("角色")) {
            characterContent += await readFile(join(truthDir, file), "utf-8") + "\n";
          }
        }
      } catch { /* ignore */ }

      const chapterFiles = files
        .filter((f) => f.endsWith(".md") && /^\d{4}/.test(f))
        .sort()
        .slice(0, 5);

      const chaptersContent: Array<{ number: number; content: string }> = [];
      for (const file of chapterFiles) {
        const chapterNum = parseInt(file.slice(0, 4), 10);
        const content = await readFile(join(chaptersDir, file), "utf-8");
        chaptersContent.push({ number: chapterNum, content: content.slice(0, 1500) });
      }

      const prompt = `你是一位角色关系分析专家。请分析以下小说中的角色关系。

书名：${book.title}

角色设定：
${characterContent.slice(0, 2000) || "（无角色设定文件）"}

章节内容：
${chaptersContent.map((ch) => `--- 第${ch.number}章 ---\n${ch.content}`).join("\n\n")}

请返回JSON格式：
{
  "characters": [
    {
      "id": "char_1",
      "name": "角色名",
      "role": "主角|配角|反派|龙套",
      "description": "简短描述"
    }
  ],
  "relationships": [
    {
      "source": "char_1",
      "target": "char_2",
      "type": "friend|enemy|lover|family|colleague|rival",
      "strength": 0.8,
      "description": "关系描述"
    }
  ]
}`;

      const pipelineConfig = await buildPipelineConfig();
      const response = await chatCompletion(pipelineConfig.client, pipelineConfig.model, [{ role: "user", content: prompt }]);
      const result = response.content;

      let parsed;
      try {
        const jsonMatch = result.match(/\{[\s\S]*\}/);
        if (jsonMatch) parsed = JSON.parse(jsonMatch[0]);
      } catch {
        parsed = { characters: [], relationships: [] };
      }

      // Save to file
      const filePath = join(bookDir, "character-graph.json");
      await writeFile(filePath, JSON.stringify(parsed, null, 2), "utf-8");

      return c.json(parsed);
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  app.post("/api/v1/books/:id/character-graph/character", async (c) => {
    const id = c.req.param("id");
    const body: { name?: string; role?: string; description?: string } = await c.req.json().catch(() => ({}));

    if (!body.name) return c.json({ error: "name is required" }, 400);

    try {
      const bookDir = state.bookDir(id);
      const filePath = join(bookDir, "character-graph.json");

      let data: { characters: Array<{ id: string; name: string; role: string; description: string }>; relationships: Array<{ source: string; target: string; type: string; strength: number; description: string }> };
      try {
        data = JSON.parse(await readFile(filePath, "utf-8"));
      } catch {
        data = { characters: [], relationships: [] };
      }

      const newChar = {
        id: `char_${crypto.randomUUID().slice(0, 8)}`,
        name: body.name,
        role: body.role ?? "配角",
        description: body.description ?? "",
      };

      data.characters.push(newChar);
      await writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
      return c.json(data);
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  app.post("/api/v1/books/:id/character-graph/relationship", async (c) => {
    const id = c.req.param("id");
    const body: { source?: string; target?: string; type?: string; description?: string } = await c.req.json().catch(() => ({}));

    if (!body.source || !body.target) return c.json({ error: "source and target are required" }, 400);

    try {
      const bookDir = state.bookDir(id);
      const filePath = join(bookDir, "character-graph.json");

      let data: { characters: Array<{ id: string; name: string; role: string; description: string }>; relationships: Array<{ source: string; target: string; type: string; strength: number; description: string }> };
      try {
        data = JSON.parse(await readFile(filePath, "utf-8"));
      } catch {
        return c.json({ error: "Character graph not found. Build it first." }, 404);
      }

      data.relationships.push({
        source: body.source,
        target: body.target,
        type: body.type ?? "friend",
        strength: 0.5,
        description: body.description ?? "",
      });

      await writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
      return c.json(data);
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  app.put("/api/v1/books/:id/character-graph/character/:charId", async (c) => {
    const id = c.req.param("id");
    const charId = c.req.param("charId");
    const body: { name?: string; role?: string; description?: string } = await c.req.json().catch(() => ({}));

    try {
      const bookDir = state.bookDir(id);
      const filePath = join(bookDir, "character-graph.json");

      let data: { characters: Array<{ id: string; name: string; role: string; description: string }>; relationships: Array<{ source: string; target: string; type: string; strength: number; description: string }> };
      try {
        data = JSON.parse(await readFile(filePath, "utf-8"));
      } catch {
        return c.json({ error: "Character graph not found" }, 404);
      }

      const idx = data.characters.findIndex((ch) => ch.id === charId);
      if (idx === -1) return c.json({ error: "Character not found" }, 404);

      const existing = data.characters[idx];
      data.characters[idx] = {
        ...existing,
        ...(body.name !== undefined && { name: body.name }),
        ...(body.role !== undefined && { role: body.role }),
        ...(body.description !== undefined && { description: body.description }),
      };

      await writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
      return c.json(data);
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  app.delete("/api/v1/books/:id/character-graph/character/:charId", async (c) => {
    const id = c.req.param("id");
    const charId = c.req.param("charId");

    try {
      const bookDir = state.bookDir(id);
      const filePath = join(bookDir, "character-graph.json");

      let data: { characters: Array<{ id: string; [key: string]: unknown }>; relationships: Array<{ source: string; target: string; [key: string]: unknown }> };
      try {
        data = JSON.parse(await readFile(filePath, "utf-8"));
      } catch {
        return c.json({ error: "Character graph not found" }, 404);
      }

      data.characters = data.characters.filter((ch) => ch.id !== charId);
      data.relationships = data.relationships.filter((r) => r.source !== charId && r.target !== charId);

      await writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
      return c.json(data);
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  app.delete("/api/v1/books/:id/character-graph/relationship", async (c) => {
    const id = c.req.param("id");
    const body: { source?: string; target?: string } = await c.req.json().catch(() => ({}));

    if (!body.source || !body.target) return c.json({ error: "source and target are required" }, 400);

    try {
      const bookDir = state.bookDir(id);
      const filePath = join(bookDir, "character-graph.json");

      let data: { characters: unknown[]; relationships: Array<{ source: string; target: string; [key: string]: unknown }> };
      try {
        data = JSON.parse(await readFile(filePath, "utf-8"));
      } catch {
        return c.json({ error: "Character graph not found" }, 404);
      }

      data.relationships = data.relationships.filter(
        (r) => !(r.source === body.source && r.target === body.target) && !(r.source === body.target && r.target === body.source)
      );

      await writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
      return c.json(data);
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  // --- Multiple Endings Management (多结局分支管理) ---

  app.get("/api/v1/books/:id/endings", async (c) => {
    const id = c.req.param("id");

    try {
      const bookDir = state.bookDir(id);
      const filePath = join(bookDir, "endings.json");

      try {
        const raw = await readFile(filePath, "utf-8");
        return c.json(JSON.parse(raw));
      } catch {
        return c.json({ endings: [], activeEnding: null });
      }
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  app.post("/api/v1/books/:id/endings", async (c) => {
    const id = c.req.param("id");
    const body: { name?: string; description?: string; type?: "good" | "bad" | "neutral" | "hidden" } = await c.req.json().catch(() => ({}));

    if (!body.name) return c.json({ error: "name is required" }, 400);

    try {
      const bookDir = state.bookDir(id);
      const filePath = join(bookDir, "endings.json");

      let data: { endings: Array<{ id: string; name: string; description: string; type: string; chapters: number[]; createdAt: string }>; activeEnding: string | null };
      try {
        data = JSON.parse(await readFile(filePath, "utf-8"));
      } catch {
        data = { endings: [], activeEnding: null };
      }

      const newEnding = {
        id: crypto.randomUUID(),
        name: body.name,
        description: body.description ?? "",
        type: body.type ?? "neutral",
        chapters: [],
        createdAt: new Date().toISOString(),
      };

      data.endings.push(newEnding);
      if (!data.activeEnding) data.activeEnding = newEnding.id;

      await writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
      return c.json(data);
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  app.put("/api/v1/books/:id/endings/:endingId", async (c) => {
    const id = c.req.param("id");
    const endingId = c.req.param("endingId");
    const body: { name?: string; description?: string; chapters?: number[]; isActive?: boolean } = await c.req.json().catch(() => ({}));

    try {
      const bookDir = state.bookDir(id);
      const filePath = join(bookDir, "endings.json");

      let data: { endings: Array<{ id: string; name: string; description: string; type: string; chapters: number[]; createdAt: string }>; activeEnding: string | null };
      try {
        data = JSON.parse(await readFile(filePath, "utf-8"));
      } catch {
        return c.json({ error: "Endings file not found" }, 404);
      }

      const endingIndex = data.endings.findIndex((e) => e.id === endingId);
      if (endingIndex === -1) return c.json({ error: "Ending not found" }, 404);

      if (body.name) data.endings[endingIndex].name = body.name;
      if (body.description) data.endings[endingIndex].description = body.description;
      if (body.chapters) data.endings[endingIndex].chapters = body.chapters;
      if (body.isActive) data.activeEnding = endingId;

      await writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
      return c.json(data);
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  app.delete("/api/v1/books/:id/endings/:endingId", async (c) => {
    const id = c.req.param("id");
    const endingId = c.req.param("endingId");

    try {
      const bookDir = state.bookDir(id);
      const filePath = join(bookDir, "endings.json");

      let data: { endings: Array<{ id: string; name: string; description: string; type: string; chapters: number[]; createdAt: string }>; activeEnding: string | null };
      try {
        data = JSON.parse(await readFile(filePath, "utf-8"));
      } catch {
        return c.json({ error: "Endings file not found" }, 404);
      }

      data.endings = data.endings.filter((e) => e.id !== endingId);
      if (data.activeEnding === endingId) {
        data.activeEnding = data.endings[0]?.id ?? null;
      }

      await writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
      return c.json(data);
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  // --- World Setting Management (世界观设定管理) ---

  app.get("/api/v1/books/:id/world-settings", async (c) => {
    const id = c.req.param("id");

    try {
      const bookDir = state.bookDir(id);
      const filePath = join(bookDir, "world-settings.json");

      try {
        const raw = await readFile(filePath, "utf-8");
        return c.json(JSON.parse(raw));
      } catch {
        return c.json({ categories: [] });
      }
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  app.post("/api/v1/books/:id/world-settings/category", async (c) => {
    const id = c.req.param("id");
    const body: { name?: string; description?: string } = await c.req.json().catch(() => ({}));

    if (!body.name) return c.json({ error: "name is required" }, 400);

    try {
      const bookDir = state.bookDir(id);
      const filePath = join(bookDir, "world-settings.json");

      let data: { categories: Array<{ id: string; name: string; description: string; settings: Array<{ id: string; key: string; value: string; notes: string }> }> };
      try {
        data = JSON.parse(await readFile(filePath, "utf-8"));
      } catch {
        data = { categories: [] };
      }

      data.categories.push({
        id: crypto.randomUUID(),
        name: body.name,
        description: body.description ?? "",
        settings: [],
      });

      await writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
      return c.json(data);
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  app.post("/api/v1/books/:id/world-settings/setting", async (c) => {
    const id = c.req.param("id");
    const body: { categoryId?: string; key?: string; value?: string; notes?: string } = await c.req.json().catch(() => ({}));

    if (!body.categoryId || !body.key) return c.json({ error: "categoryId and key are required" }, 400);

    try {
      const bookDir = state.bookDir(id);
      const filePath = join(bookDir, "world-settings.json");

      let data: { categories: Array<{ id: string; name: string; description: string; settings: Array<{ id: string; key: string; value: string; notes: string }> }> };
      try {
        data = JSON.parse(await readFile(filePath, "utf-8"));
      } catch {
        return c.json({ error: "World settings not found. Create a category first." }, 404);
      }

      const category = data.categories.find((c) => c.id === body.categoryId);
      if (!category) return c.json({ error: "Category not found" }, 404);

      category.settings.push({
        id: crypto.randomUUID(),
        key: body.key,
        value: body.value ?? "",
        notes: body.notes ?? "",
      });

      await writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
      return c.json(data);
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  app.put("/api/v1/books/:id/world-settings/setting/:settingId", async (c) => {
    const id = c.req.param("id");
    const settingId = c.req.param("settingId");
    const body: { value?: string; notes?: string } = await c.req.json().catch(() => ({}));

    try {
      const bookDir = state.bookDir(id);
      const filePath = join(bookDir, "world-settings.json");

      let data: { categories: Array<{ id: string; name: string; description: string; settings: Array<{ id: string; key: string; value: string; notes: string }> }> };
      try {
        data = JSON.parse(await readFile(filePath, "utf-8"));
      } catch {
        return c.json({ error: "World settings not found" }, 404);
      }

      for (const category of data.categories) {
        const setting = category.settings.find((s) => s.id === settingId);
        if (setting) {
          if (body.value !== undefined) setting.value = body.value;
          if (body.notes !== undefined) setting.notes = body.notes;
          break;
        }
      }

      await writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
      return c.json(data);
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  app.delete("/api/v1/books/:id/world-settings/setting/:settingId", async (c) => {
    const id = c.req.param("id");
    const settingId = c.req.param("settingId");

    try {
      const bookDir = state.bookDir(id);
      const filePath = join(bookDir, "world-settings.json");

      let data: { categories: Array<{ id: string; name: string; description: string; settings: Array<{ id: string; key: string; value: string; notes: string }> }> };
      try {
        data = JSON.parse(await readFile(filePath, "utf-8"));
      } catch {
        return c.json({ error: "World settings not found" }, 404);
      }

      for (const category of data.categories) {
        category.settings = category.settings.filter((s) => s.id !== settingId);
      }

      await writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
      return c.json(data);
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  // --- Book Rules Lexicon (词库写入 book_rules.md) ---

  app.put("/api/v1/books/:id/book-rules/lexicon", async (c) => {
    const id = c.req.param("id");
    const body: {
      bannedWords?: string[];
      preferredWords?: Array<{ avoid: string; prefer: string }>;
      domainTerms?: Array<{ term: string; definition?: string }>;
    } = await c.req.json().catch(() => ({}));
    try {
      const bookDir = state.bookDir(id);
      const rulesPath = join(bookDir, "story", "book_rules.md");
      const raw = await readFile(rulesPath, "utf-8");
      const { parseBookRules } = await import("@actalk/inkos-core");
      const parsed = parseBookRules(raw);
      if (!parsed) {
        return c.json({ error: "Could not parse book_rules.md" }, 400);
      }
      const nextRules = {
        ...parsed.rules,
        ...(body.bannedWords !== undefined ? { bannedWords: body.bannedWords } : {}),
        ...(body.preferredWords !== undefined ? { preferredWords: body.preferredWords } : {}),
        ...(body.domainTerms !== undefined ? { domainTerms: body.domainTerms } : {}),
      };
      // Reconstruct frontmatter: dynamic-import js-yaml from core's deps
      let yamlDump: (obj: unknown, opts?: Record<string, unknown>) => string;
      try {
        const yaml = await Function("return require('js-yaml')")() as { dump: (obj: unknown, opts?: Record<string, unknown>) => string };
        yamlDump = yaml.dump;
      } catch {
        // Fallback: simple JSON-based serializer for frontmatter
        yamlDump = (obj) => JSON.stringify(obj, null, 2);
      }
      const fm = `---\n${yamlDump(nextRules, { lineWidth: -1 })}---\n\n${parsed.body}`;
      await writeFile(rulesPath, fm, "utf-8");
      return c.json({ ok: true, rules: nextRules });
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  // --- Book Detail endpoint returns book_rules too ---

  app.post("/api/v1/books/:id/write-next", async (c) => {
    const id = c.req.param("id");
    const body: { wordCount?: number; mode?: string; knowledge?: { enabled?: boolean; sourceIds?: string[] } } = await c.req.json<{ wordCount?: number; mode?: string; knowledge?: { enabled?: boolean; sourceIds?: string[] } }>()
      .catch(() => ({ wordCount: undefined }));
    const mode = body.mode === "quick" ? "quick" : "full";
    const knowledge = normalizeWriteKnowledgeOptions(body.knowledge);

    broadcast("write:start", { bookId: id });

    // Fire and forget — progress/completion/errors pushed via SSE
    const pipeline = new PipelineRunner(await buildPipelineConfig());
    pipeline.writeNextChapter(id, { wordCount: body.wordCount, mode, ...(knowledge ? { knowledge } : {}) }).then(
      (result) => {
        broadcast("write:complete", { bookId: id, chapterNumber: result.chapterNumber, status: result.status, title: result.title, wordCount: result.wordCount });
      },
      (e) => {
        broadcast("write:error", { bookId: id, error: e instanceof Error ? e.message : String(e) });
      },
    );

    return c.json({ status: "writing", bookId: id });
  });

  app.post("/api/v1/books/:id/draft", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json<{ wordCount?: number; context?: string }>().catch(() => ({ wordCount: undefined, context: undefined }));

    broadcast("draft:start", { bookId: id });

    const pipeline = new PipelineRunner(await buildPipelineConfig());
    pipeline.writeDraft(id, body.context, body.wordCount).then(
      (result) => {
        broadcast("draft:complete", { bookId: id, chapterNumber: result.chapterNumber, title: result.title, wordCount: result.wordCount });
      },
      (e) => {
        broadcast("draft:error", { bookId: id, error: e instanceof Error ? e.message : String(e) });
      },
    );

    return c.json({ status: "drafting", bookId: id });
  });

  app.get("/api/v1/books/:id/eval", async (c) => {
    const id = c.req.param("id");
    const chapters = c.req.query("chapters");
    try {
      return c.json(await evaluateBookQuality({ state, bookId: id, chapters }));
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  app.post("/api/v1/books/:id/consolidate", async (c) => {
    const id = c.req.param("id");
    try {
      const pipelineConfig = await buildPipelineConfig();
      const consolidator = new ConsolidatorAgent({
        client: pipelineConfig.client,
        model: pipelineConfig.model,
        projectRoot: root,
      });
      const result = await consolidator.consolidate(state.bookDir(id));
      broadcast("consolidate:complete", { bookId: id, ...result });
      return c.json(result);
    } catch (e) {
      broadcast("consolidate:error", { bookId: id, error: String(e) });
      return c.json({ error: String(e) }, 500);
    }
  });

  app.post("/api/v1/books/:id/plan", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json<{ context?: string }>().catch(() => ({ context: undefined }));
    try {
      const pipeline = new PipelineRunner(await buildPipelineConfig());
      return c.json(await pipeline.planChapter(id, body.context));
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  app.post("/api/v1/books/:id/compose", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json<{ context?: string }>().catch(() => ({ context: undefined }));
    try {
      const pipeline = new PipelineRunner(await buildPipelineConfig());
      return c.json(await pipeline.composeChapter(id, body.context));
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  app.post("/api/v1/books/:id/repair-state/:chapter", async (c) => {
    const id = c.req.param("id");
    const chapterNum = parseInt(c.req.param("chapter"), 10);
    try {
      const pipeline = new PipelineRunner(await buildPipelineConfig());
      const result = await pipeline.repairChapterState(id, chapterNum);
      broadcast("repair-state:complete", { bookId: id, chapter: chapterNum });
      return c.json(result);
    } catch (e) {
      broadcast("repair-state:error", { bookId: id, chapter: chapterNum, error: String(e) });
      return c.json({ error: String(e) }, 500);
    }
  });

  app.post("/api/v1/books/:id/foundation/revise", async (c) => {
    const id = c.req.param("id");
    const { feedback } = await c.req.json<{ feedback?: string }>().catch(() => ({ feedback: undefined }));
    if (!feedback?.trim()) {
      return c.json({ error: "feedback is required" }, 400);
    }
    try {
      const pipeline = new PipelineRunner(await buildPipelineConfig());
      await pipeline.reviseFoundation(id, feedback.trim());
      broadcast("foundation:revised", { bookId: id });
      return c.json({ ok: true });
    } catch (e) {
      broadcast("foundation:error", { bookId: id, error: String(e) });
      return c.json({ error: String(e) }, 500);
    }
  });

  app.post("/api/v1/books/:id/chapters/:num/approve", async (c) => {
    const id = c.req.param("id");
    const num = parseInt(c.req.param("num"), 10);

    try {
      const index = await state.loadChapterIndex(id);
      const updated = index.map((ch) =>
        ch.number === num ? { ...ch, status: "approved" as const } : ch,
      );
      await state.saveChapterIndex(id, updated);
      return c.json({ ok: true, chapterNumber: num, status: "approved" });
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  // --- Batch chapter operations ---

  app.post("/api/v1/books/:id/chapters/batch", async (c) => {
    const id = c.req.param("id");
    const body: {
      chapterNumbers: number[];
      action: "approve" | "reject" | "normalize" | "delete-empty-lines";
    } = await c.req.json().catch(() => ({ chapterNumbers: [], action: "approve" }));

    if (!body.chapterNumbers?.length) {
      return c.json({ error: "chapterNumbers is required" }, 400);
    }

    try {
      if (body.action === "approve") {
        const index = await state.loadChapterIndex(id);
        const nums = new Set(body.chapterNumbers);
        const updated = index.map((ch) =>
          nums.has(ch.number) ? { ...ch, status: "approved" as const } : ch,
        );
        await state.saveChapterIndex(id, updated);
        broadcast("batch:complete", { bookId: id, action: "approve", count: body.chapterNumbers.length });
        return c.json({ ok: true, action: "approve", count: body.chapterNumbers.length });
      }

      if (body.action === "reject") {
        const index = await state.loadChapterIndex(id);
        const nums = new Set(body.chapterNumbers);
        const filtered = index.filter((ch) => !nums.has(ch.number));
        await state.saveChapterIndex(id, filtered);
        broadcast("batch:complete", { bookId: id, action: "reject", count: body.chapterNumbers.length });
        return c.json({ ok: true, action: "reject", count: body.chapterNumbers.length });
      }

      if (body.action === "normalize" || body.action === "delete-empty-lines") {
        const bookDir = state.bookDir(id);
        const chaptersDir = join(bookDir, "chapters");
        const files = await readdir(chaptersDir).catch(() => [] as string[]);
        const normalizeModule = await import("@actalk/inkos-core");
        const normalize = normalizeModule.normalizePostWriteSurface;
        let processed = 0;
        for (const num of body.chapterNumbers) {
          const padded = String(num).padStart(4, "0");
          const match = files.find((f) => f.startsWith(padded) && f.endsWith(".md"));
          if (!match) continue;
          const filePath = join(chaptersDir, match);
          try {
            const content = await readFile(filePath, "utf-8");
            let result = content;
            if (body.action === "normalize") {
              result = normalize(result);
            }
            if (body.action === "delete-empty-lines") {
              result = result.replace(/\n{4,}/g, "\n\n\n");
            }
            if (result !== content) {
              await writeFile(filePath, result, "utf-8");
              processed++;
            }
          } catch { /* skip unreadable chapters */ }
        }
        broadcast("batch:complete", { bookId: id, action: body.action, count: processed });
        return c.json({ ok: true, action: body.action, count: processed });
      }

      return c.json({ error: `Unknown action: ${body.action}` }, 400);
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  app.post("/api/v1/books/:id/chapters/:num/reject", async (c) => {
    const id = c.req.param("id");
    const num = parseInt(c.req.param("num"), 10);

    try {
      const index = await state.loadChapterIndex(id);
      const target = index.find((ch) => ch.number === num);
      if (!target) {
        return c.json({ error: `Chapter ${num} not found` }, 404);
      }

      const rollbackTarget = num - 1;
      const discarded = await state.rollbackToChapter(id, rollbackTarget);
      return c.json({
        ok: true,
        chapterNumber: num,
        status: "rejected",
        rolledBackTo: rollbackTarget,
        discarded,
      });
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  // --- SSE ---

  app.get("/api/v1/events", (c) => {
    return streamSSE(c, async (stream) => {
      const handler: EventHandler = (event, data) => {
        stream.writeSSE({ event, data: JSON.stringify(data) });
      };
      subscribers.add(handler);
      await stream.writeSSE({ event: "ping", data: "" });

      // Replay buffered events so new connections catch up on recent state.
      const buffered = [...eventBuffer];
      if (buffered.length > 0) {
        await stream.writeSSE({ event: "events:replay:start", data: JSON.stringify({ count: buffered.length }) });
        for (const entry of buffered) {
          try {
            await stream.writeSSE({ event: entry.event, data: JSON.stringify(entry.data) });
          } catch {
            break;
          }
        }
        await stream.writeSSE({ event: "events:replay:end", data: "" });
      }

      // Keep alive
      const keepAlive = setInterval(() => {
        stream.writeSSE({ event: "ping", data: "" });
      }, 30000);

      stream.onAbort(() => {
        subscribers.delete(handler);
        clearInterval(keepAlive);
      });

      // Block until aborted
      await new Promise(() => {});
    });
  });

  // --- Model discovery ---

  app.get("/api/v1/services", async (c) => {
    const secrets = await loadSecrets(root);
    const endpoints = getAllEndpoints().filter((ep) => ep.id !== "custom");

    // Fast: only check connection status from secrets, no external API calls.
    const services = endpoints.map((ep) => ({
      service: ep.id,
      label: ep.label,
      group: ep.group,
      connected: Boolean(secrets.services[ep.id]?.apiKey),
    })).sort(compareServiceListItems);

    // Add custom services from inkos.json
    try {
      const config = await loadRawConfig(root);
      for (const svc of normalizeServiceConfig((config.llm as Record<string, unknown> | undefined)?.services)) {
        if (svc.service === "custom") {
          const secretKey = `custom:${svc.name}`;
          services.push({
            service: secretKey,
            label: svc.name ?? "Custom",
            group: undefined,
            connected: Boolean(secrets.services[secretKey]?.apiKey),
          });
        }
      }
    } catch { /* no config file */ }

    return c.json({ services });
  });

  app.get("/api/v1/services/config", async (c) => {
    const config = await loadRawConfig(root);
    const llm = (config.llm as Record<string, unknown> | undefined) ?? {};
    const services = normalizeServiceConfig(llm.services);
    const envConfig = await readEnvConfigStatus(root);
    return c.json({
      services,
      service: typeof llm.service === "string" ? llm.service : null,
      defaultModel: llm.defaultModel ?? null,
      configSource: "studio" satisfies LLMConfigSource,
      storedConfigSource: normalizeConfigSource(llm.configSource),
      envConfig,
    });
  });

  app.post("/api/v1/services/config/import-env", async (c) => {
    const env = await readEffectiveEnvConfigValues(root);
    if (!env || !env.values.apiKey) {
      return c.json({
        error: "未检测到可导入的 LLM 环境变量配置，或缺少 INKOS_LLM_API_KEY。",
      }, 400);
    }

    const config = await loadRawConfig(root);
    config.llm = config.llm ?? {};
    const llm = config.llm as Record<string, unknown>;
    const existingServices = normalizeServiceConfig(llm.services);
    const explicitService = env.values.service?.trim();
    const guessedService = env.values.baseUrl ? guessServiceFromBaseUrl(env.values.baseUrl) : null;
    const service = explicitService || guessedService || "custom";
    if (isCleartextExternalUrl(env.values.baseUrl)) {
      return c.json({
        error: "Base URL 必须使用 HTTPS；只有 localhost/127.0.0.1 本地端点允许 HTTP。",
      }, 400);
    }

    const entry: ServiceConfigEntry = service === "custom"
      ? {
          service: "custom",
          name: "Env LLM",
          ...(env.values.baseUrl ? { baseUrl: env.values.baseUrl } : {}),
        }
      : { service };
    const serviceKey = serviceConfigKey(entry);

    llm.services = mergeServiceConfig(existingServices, [entry]);
    llm.service = serviceKey;
    llm.configSource = "studio";
    if (env.values.model) llm.defaultModel = env.values.model;
    syncTopLevelLlmMirror(llm);

    const secrets = await loadSecrets(root);
    secrets.services[serviceKey] = { apiKey: env.values.apiKey };
    await saveSecrets(root, secrets);
    await saveRawConfig(root, config);

    return c.json({
      ok: true,
      source: env.source,
      service: serviceKey,
      defaultModel: env.values.model ?? null,
    });
  });

  app.put("/api/v1/services/config", async (c) => {
    const body = await c.req.json<{ services?: unknown; defaultModel?: string; configSource?: LLMConfigSource; service?: string }>();
    const config = await loadRawConfig(root);
    config.llm = config.llm ?? {};
    const llm = config.llm as Record<string, unknown>;
    if (body.services !== undefined) {
      const existingServices = normalizeServiceConfig(llm.services);
      const incomingServices = normalizeServiceConfig(body.services);
      const securityError = validateSecureServiceBaseUrls(incomingServices);
      if (securityError) {
        return c.json({ error: securityError }, 400);
      }
      llm.services = mergeServiceConfig(existingServices, incomingServices);
    }
    if (body.defaultModel !== undefined) {
      llm.defaultModel = body.defaultModel;
    }
    if (body.configSource === "env") {
      return c.json({
        error: "Studio 运行时不支持切换到 env；env 只在 CLI/daemon/部署运行时作为覆盖层使用。",
      }, 400);
    }
    if (body.configSource !== undefined) {
      llm.configSource = normalizeConfigSource(body.configSource);
    }
    if (body.service !== undefined) {
      llm.service = body.service;
    }
    syncTopLevelLlmMirror(llm);
    await saveRawConfig(root, config);
    return c.json({ ok: true });
  });

  app.get("/api/v1/cover/config", async (c) => {
    const config = await loadRawConfig(root);
    const llm = (config.llm as Record<string, unknown> | undefined) ?? {};
    const cover = normalizeCoverConfig(llm.cover);
    const secrets = await loadSecrets(root);
    const keyFor = (service: string): boolean =>
      Boolean(secrets.services[coverSecretKey(service)]?.apiKey || secrets.services[service]?.apiKey);
    // "Configured" = a cover service is selected AND has a key, OR a cover
    // endpoint is provided via env (the CLI/power-user path). This is the gate
    // for the Play auto-illustration toggles.
    const envConfigured = Boolean(
      (process.env.INKOS_COVER_BASE_URL || process.env.INKOS_COVER_ENDPOINT)
      && (process.env.INKOS_COVER_API_KEY || keyFor("kkaiapi")),
    );
    const configured = Boolean(cover?.service && keyFor(cover.service)) || envConfigured;
    return c.json({
      service: cover?.service ?? null,
      model: cover?.model ?? null,
      configured,
      providers: [
        ...COVER_PROVIDER_PRESETS.map((provider) => ({
        service: provider.service,
        label: provider.label,
        baseUrl: provider.baseUrl,
        api: provider.api,
        defaultModel: provider.defaultModel,
        models: provider.models,
        connected: keyFor(provider.service),
        })),
        ...(cover?.service.startsWith("custom:") && cover.baseUrl ? [{
        service: cover.service,
        label: cover.label ?? decodeURIComponent(cover.service.slice("custom:".length)),
        baseUrl: cover.baseUrl,
        api: cover.api ?? "images",
        defaultModel: cover.model,
        models: [cover.model],
        connected: keyFor(cover.service),
        }] : []),
      ],
    });
  });

  app.put("/api/v1/cover/config", async (c) => {
    const body = await c.req.json<{
      service?: string;
      model?: string;
      label?: string;
      baseUrl?: string;
      api?: "responses" | "images" | "gemini";
    }>();
    const preset = resolveCoverProviderPreset(body.service);
    const isCustomCover = typeof body.service === "string" && body.service.startsWith("custom:");
    if (!preset && !isCustomCover) {
      return c.json({ error: "Unsupported cover service" }, 400);
    }
    const customBaseUrl = body.baseUrl?.trim() ?? "";
    const customModel = body.model?.trim() ?? "";
    if (isCustomCover && (!customBaseUrl || !customModel)) {
      return c.json({ error: "Custom cover service requires Base URL and model" }, 400);
    }
    const model = preset
      ? typeof body.model === "string" && preset.models.includes(body.model)
        ? body.model
        : preset.defaultModel
      : customModel;

    const config = await loadRawConfig(root);
    config.llm = config.llm ?? {};
    const llm = config.llm as Record<string, unknown>;
    llm.cover = preset
      ? { service: preset.service, model }
      : {
          service: body.service,
          label: body.label?.trim() || decodeURIComponent(body.service!.slice("custom:".length)),
          baseUrl: customBaseUrl,
          api: body.api === "responses" || body.api === "gemini" ? body.api : "images",
          model,
        };
    await saveRawConfig(root, config);
    return c.json({ ok: true, service: preset?.service ?? body.service, model });
  });

  app.post("/api/v1/cover/generate", async (c) => {
    type GenerateCoverBody = {
      title?: string;
      intro?: string;
      coverPrompt?: string;
    };
    const body = await c.req.json<GenerateCoverBody>().catch(() => ({} as GenerateCoverBody));
    const title = body.title?.trim() ?? "";
    if (!title) {
      return c.json({ error: "Cover title is required" }, 400);
    }
    try {
      const result = await generateShortFictionCover({
        projectRoot: root,
        title,
        intro: body.intro?.trim(),
        coverPrompt: body.coverPrompt?.trim(),
        outputDir: join("covers", `manual-${Date.now().toString(36)}`),
      });
      return c.json({ ok: true, ...result });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  });

  app.get("/api/v1/cover/secret/:service", async (c) => {
    const service = c.req.param("service");
    if (!resolveCoverProviderPreset(service) && !service.startsWith("custom:")) {
      return c.json({ error: "Unsupported cover service" }, 400);
    }
    const secrets = await loadSecrets(root);
    return c.json({ apiKey: secrets.services[coverSecretKey(service)]?.apiKey ?? "" });
  });

  app.put("/api/v1/cover/secret/:service", async (c) => {
    const service = c.req.param("service");
    if (!resolveCoverProviderPreset(service) && !service.startsWith("custom:")) {
      return c.json({ error: "Unsupported cover service" }, 400);
    }
    const body = await c.req.json<{ apiKey?: string }>();
    const trimmedKey = body.apiKey?.trim() ?? "";
    if (trimmedKey && !isHeaderSafeApiKey(trimmedKey)) {
      return c.json({ error: "API Key 包含不能放入 HTTP Authorization header 的字符，请只粘贴原始密钥。" }, 400);
    }

    const secrets = await loadSecrets(root);
    const key = coverSecretKey(service);
    if (trimmedKey) {
      secrets.services[key] = { apiKey: trimmedKey };
    } else {
      delete secrets.services[key];
    }
    await saveSecrets(root, secrets);
    return c.json({ ok: true, service });
  });

  app.delete("/api/v1/services/:service", async (c) => {
    const service = c.req.param("service");
    const config = await loadRawConfig(root);
    const llm = (config.llm as Record<string, unknown> | undefined) ?? {};
    const existingServices = normalizeServiceConfig(llm.services);
    const nextServices = existingServices.filter((entry) => serviceConfigKey(entry) !== service);

    if (!config.llm) config.llm = {};
    const nextLlm = config.llm as Record<string, unknown>;
    nextLlm.services = nextServices;
    if (nextLlm.service === service) {
      delete nextLlm.service;
      delete nextLlm.defaultModel;
    }
    await saveRawConfig(root, config);

    const secrets = await loadSecrets(root);
    delete secrets.services[service];
    await saveSecrets(root, secrets);
    modelListCache.clear();
    return c.json({ ok: true, service });
  });

  app.post("/api/v1/services/:service/test", async (c) => {
    const service = c.req.param("service");
    const { apiKey, baseUrl, apiFormat, stream, model } = await c.req.json<{
      apiKey: string;
      baseUrl?: string;
      apiFormat?: "chat" | "responses";
      stream?: boolean;
      model?: string;
    }>();

    const resolvedBaseUrl = await resolveConfiguredServiceBaseUrl(root, service, baseUrl);
    if (!resolvedBaseUrl) {
      return c.json({ ok: false, error: `未知服务商: ${service}` }, 400);
    }
    if (isCleartextExternalUrl(resolvedBaseUrl)) {
      return c.json({
        ok: false,
        error: "Base URL 必须使用 HTTPS；只有 localhost/127.0.0.1 本地端点允许 HTTP。",
      }, 400);
    }

    const baseService = isCustomServiceId(service) ? "custom" : service;
    const apiKeyOptional = isApiKeyOptionalForEndpoint({
      provider: resolveServiceProviderFamily(baseService) ?? "openai",
      baseUrl: resolvedBaseUrl,
    });
    if (!apiKey?.trim() && !apiKeyOptional) {
      return c.json({
        ok: false,
        error: "API Key 不能为空",
      }, 400);
    }

    const rawConfig = await loadRawConfig(root).catch(() => ({} as Record<string, unknown>));
    const llm = (rawConfig.llm as Record<string, unknown> | undefined) ?? {};
    const proxyUrl = typeof llm.proxyUrl === "string" ? llm.proxyUrl : undefined;
    if (!isCustomServiceId(service) && apiKey?.trim()) {
      const endpoint = getAllEndpoints().find((ep) => ep.id === baseService);
      const official = await verifyService(baseService, apiKey.trim(), {
        ...(typeof model === "string" && model.trim()
          ? { checkModel: model.trim() }
          : endpoint?.checkModel ? { checkModel: endpoint.checkModel } : {}),
        baseUrl: resolvedBaseUrl,
        proxyUrl,
      });
      const authError = officialVerifierAuthError(official);
      if (authError) {
        return c.json({
          ok: false,
          error: `官方连接验证失败：${authError}`,
          official,
          probe: {
            ok: false,
            models: official.probe?.models ?? 0,
            error: authError,
          },
          chat: official.chat ?? null,
        }, 400);
      }
    }
    const probe = await probeServiceCapabilities({
      root,
      service,
      apiKey: apiKey?.trim() ?? "",
      baseUrl: resolvedBaseUrl,
      preferredApiFormat: apiFormat,
      preferredStream: stream,
      preferredModel: typeof model === "string" && model.trim() ? model.trim() : undefined,
      proxyUrl,
    });

    // B12: 升级响应 shape 为 { probe, chat, ... }，同时保留老字段供 UI 过渡期兼容
    const probeStatus = {
      ok: probe.ok,
      models: probe.models?.length ?? 0,
      ...(probe.ok ? {} : { error: probe.error ?? "连接失败" }),
    };

    if (!probe.ok) {
      return c.json({
        ok: false,
        error: probe.error ?? "连接失败",
        probe: probeStatus,
        chat: null,
      }, 400);
    }

    return c.json({
      ok: true,
      modelCount: probe.models.length,
      models: probe.models,
      selectedModel: probe.selectedModel,
      detected: {
        apiFormat: probe.apiFormat,
        stream: probe.stream,
        baseUrl: probe.baseUrl,
        modelsSource: probe.modelsSource,
      },
      // B12 新字段：两步验证状态
      probe: probeStatus,
      chat: null,  // probeServiceCapabilities 本身只做 probe，chat hello 在 Studio 的 follow-up 调用里单独触发
    });
  });

  app.put("/api/v1/services/:service/secret", async (c) => {
    const service = c.req.param("service");
    const body = await c.req.json<{ apiKey: string }>().catch(() => null);
    if (!body) {
      return c.json({ ok: false, error: "Invalid JSON body" }, 400);
    }
    const { apiKey } = body;
    const secrets = await loadSecrets(root);
    const trimmedKey = apiKey?.trim() ?? "";
    if (trimmedKey) {
      if (!isHeaderSafeApiKey(trimmedKey)) {
        return c.json({
          ok: false,
          error: "API Key 只能包含可放进 HTTP Authorization header 的非空白 ASCII 字符；请不要粘贴连接失败提示或诊断文本。",
        }, 400);
      }
      secrets.services[service] = { apiKey: trimmedKey };
    } else {
      delete secrets.services[service];
    }
    await saveSecrets(root, secrets);
    return c.json({ ok: true });
  });

  app.get("/api/v1/services/:service/secret", async (c) => {
    const service = c.req.param("service");
    const secrets = await loadSecrets(root);
    return c.json({
      apiKey: secrets.services[service]?.apiKey ?? "",
    });
  });

  app.get("/api/v1/services/models", async (c) => {
    const secrets = await loadSecrets(root);
    const endpoints = getAllEndpoints()
      .filter((ep) => ep.id !== "custom" && Boolean(secrets.services[ep.id]?.apiKey));

    const groups = endpoints.map((ep) => ({
      service: ep.id,
      label: ep.label,
      models: ep.models
        .filter((m) => m.enabled !== false)
        .filter((m) => isTextChatModelId(m.id))
        .map((m) => ({
          id: m.id,
          name: m.id,
          ...(typeof m.maxOutput === "number" ? { maxOutput: m.maxOutput } : {}),
          ...(m.contextWindowTokens > 0 ? { contextWindow: m.contextWindowTokens } : {}),
        })),
    }));

    return c.json({ groups });
  });

  app.get("/api/v1/services/models/custom", async (c) => {
    const secrets = await loadSecrets(root);
    let config: Record<string, unknown> = {};
    try {
      config = await loadRawConfig(root);
    } catch {
      // no config file
    }

    const customs = normalizeServiceConfig((config.llm as Record<string, unknown> | undefined)?.services)
      .filter((s) => s.service === "custom")
      .map((s) => ({
        id: `custom:${s.name ?? "Custom"}`,
        baseUrl: s.baseUrl ?? "",
        label: s.name ?? "Custom",
      }))
      .filter((s) => s.baseUrl && Boolean(secrets.services[s.id]?.apiKey));

    const groups = await Promise.all(customs.map(async (s) => ({
      service: s.id,
      label: s.label,
      models: filterTextChatModels(
        await probeModelsFromUpstream(s.baseUrl, secrets.services[s.id].apiKey, 10_000),
      ),
    })));

    return c.json({ groups });
  });

  app.get("/api/v1/services/:service/models", async (c) => {
    const service = c.req.param("service");
    const refresh = c.req.query("refresh") === "1";
    const secrets = await loadSecrets(root);
    const apiKey = c.req.query("apiKey") || secrets.services[service]?.apiKey || "";

    const resolvedBaseUrl = await resolveConfiguredServiceBaseUrl(root, service);
    const baseService = isCustomServiceId(service) ? "custom" : service;
    const apiKeyOptional = isApiKeyOptionalForEndpoint({
      provider: resolveServiceProviderFamily(baseService) ?? "openai",
      baseUrl: resolvedBaseUrl,
    });

    // No key = no models, except local/self-hosted endpoints such as Ollama.
    if (!apiKey && !apiKeyOptional) return c.json({ models: [] });

    // Cache by service + resolved baseUrl + apiKey fingerprint; valid for 10 min unless ?refresh=1
    const cacheKey = `${service}::${resolvedBaseUrl ?? ""}::${apiKey.slice(-8)}`;
    if (!refresh) {
      const cached = modelListCache.get(cacheKey);
      if (cached && Date.now() - cached.at < 10 * 60 * 1000) {
        return c.json({ models: cached.models });
      }
    }

    // B13: 走 listModelsForService 走 live probe + bank 交叉，返回带元数据的 models
    const enriched = await listModelsForService(
      isCustomServiceId(service) ? "custom" : service,
      apiKey,
      isCustomServiceId(service) ? resolvedBaseUrl ?? undefined : undefined,
    );
    const models = filterTextChatModels(enriched).map((m) => ({
      id: m.id,
      name: m.name,
      ...(m.maxOutput !== undefined ? { maxOutput: m.maxOutput } : {}),
      ...(m.contextWindow > 0 ? { contextWindow: m.contextWindow } : {}),
    }));
    modelListCache.set(cacheKey, { models, at: Date.now() });
    return c.json({ models });
  });

  // --- Project info ---

  app.get("/api/v1/project", async (c) => {
    const currentConfig = await loadCurrentProjectConfig({ requireApiKey: false });
    // Check if language was explicitly set in inkos.json (not just the schema default)
    const raw = JSON.parse(await readFile(join(root, "inkos.json"), "utf-8"));
    const languageExplicit = "language" in raw && raw.language !== "";

    return c.json({
      name: currentConfig.name,
      language: currentConfig.language,
      languageExplicit,
      model: currentConfig.llm.model,
      provider: currentConfig.llm.provider,
      baseUrl: currentConfig.llm.baseUrl,
      stream: currentConfig.llm.stream,
      temperature: currentConfig.llm.temperature,
    });
  });

  app.get("/api/v1/project/files/:file{.+}", async (c) => {
    const file = resolveProjectImageFile(root, c.req.param("file"));

    try {
      const content = await readFile(file.resolved);
      return new Response(content, {
        headers: {
          "Content-Type": file.contentType,
          "Cache-Control": "no-store",
        },
      });
    } catch {
      return c.notFound();
    }
  });

  // --- Config editing ---

  app.put("/api/v1/project", async (c) => {
    const updates = await c.req.json<Record<string, unknown>>();
    const configPath = join(root, "inkos.json");
    try {
      const raw = await readFile(configPath, "utf-8");
      const existing = JSON.parse(raw);
      // Merge LLM settings
      if (updates.temperature !== undefined) {
        existing.llm.temperature = updates.temperature;
      }
      if (updates.stream !== undefined) {
        existing.llm.stream = updates.stream;
      }
      if (updates.language === "zh" || updates.language === "en") {
        existing.language = updates.language;
      }
      const { writeFile: writeFileFs } = await import("node:fs/promises");
      await writeFileFs(configPath, JSON.stringify(existing, null, 2), "utf-8");
      return c.json({ ok: true });
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  app.get("/api/v1/project/input-governance-mode", async (c) => {
    try {
      const raw = JSON.parse(await readFile(join(root, "inkos.json"), "utf-8"));
      return c.json({ mode: raw.inputGovernanceMode === "legacy" ? "legacy" : "v2" });
    } catch {
      return c.json({ mode: "v2" });
    }
  });

  app.put("/api/v1/project/input-governance-mode", async (c) => {
    const { mode } = await c.req.json<{ mode?: unknown }>().catch(() => ({ mode: undefined }));
    const parsed = InputGovernanceModeSchema.safeParse(mode);
    if (!parsed.success) {
      return c.json({ error: "mode must be legacy or v2" }, 400);
    }
    try {
      const configPath = join(root, "inkos.json");
      const raw = JSON.parse(await readFile(configPath, "utf-8"));
      raw.inputGovernanceMode = parsed.data;
      const { writeFile: writeFileFs } = await import("node:fs/promises");
      await writeFileFs(configPath, JSON.stringify(raw, null, 2), "utf-8");
      return c.json({ ok: true, mode: parsed.data });
    } catch {
      return c.json({ error: "Failed to read or update inkos.json" }, 500);
    }
  });

  app.get("/api/v1/project/detection", async (c) => {
    try {
      const raw = JSON.parse(await readFile(join(root, "inkos.json"), "utf-8"));
      return c.json({ detection: raw.detection ?? null });
    } catch {
      return c.json({ detection: null });
    }
  });

  app.put("/api/v1/project/detection", async (c) => {
    const { detection } = await c.req.json<{ detection?: unknown }>().catch(() => ({ detection: undefined }));
    try {
      const configPath = join(root, "inkos.json");
      const raw = JSON.parse(await readFile(configPath, "utf-8"));
      if (detection === null) {
        delete raw.detection;
      } else {
        const parsed = DetectionConfigSchema.safeParse(detection);
        if (!parsed.success) {
          return c.json({ error: parsed.error.issues.map((issue) => issue.message).join("; ") }, 400);
        }
        raw.detection = parsed.data;
      }
      const { writeFile: writeFileFs } = await import("node:fs/promises");
      await writeFileFs(configPath, JSON.stringify(raw, null, 2), "utf-8");
      return c.json({ ok: true, detection: raw.detection ?? null });
    } catch {
      return c.json({ error: "Failed to read or update inkos.json" }, 500);
    }
  });

  // --- Truth files browser ---

  app.get("/api/v1/books/:id/truth", async (c) => {
    const id = c.req.param("id");
    const bookDir = state.bookDir(id);

    try {
      return c.json({ files: await listBookTruthFiles(bookDir) });
    } catch {
      return c.json({ files: [] });
    }
  });

  // --- Daemon control ---

  let schedulerInstance: Scheduler | null = null;

  app.get("/api/v1/daemon", (c) => {
    return c.json({
      running: schedulerInstance?.isRunning ?? false,
    });
  });

  app.post("/api/v1/daemon/start", async (c) => {
    if (schedulerInstance?.isRunning) {
      return c.json({ error: "Daemon already running" }, 400);
    }
    try {
      const currentConfig = await loadCurrentProjectConfig();
      const scheduler = new Scheduler({
        ...(await buildPipelineConfig()),
        radarCron: currentConfig.daemon.schedule.radarCron,
        writeCron: currentConfig.daemon.schedule.writeCron,
        maxConcurrentBooks: currentConfig.daemon.maxConcurrentBooks,
        chaptersPerCycle: currentConfig.daemon.chaptersPerCycle,
        retryDelayMs: currentConfig.daemon.retryDelayMs,
        cooldownAfterChapterMs: currentConfig.daemon.cooldownAfterChapterMs,
        maxChaptersPerDay: currentConfig.daemon.maxChaptersPerDay,
        onChapterComplete: (bookId, chapter, status) => {
          broadcast("daemon:chapter", { bookId, chapter, status });
        },
        onError: (bookId, error) => {
          broadcast("daemon:error", { bookId, error: error.message });
        },
      });
      schedulerInstance = scheduler;
      broadcast("daemon:started", {});
      void scheduler.start().catch((e) => {
        const error = e instanceof Error ? e : new Error(String(e));
        if (schedulerInstance === scheduler) {
          scheduler.stop();
          schedulerInstance = null;
          broadcast("daemon:stopped", {});
        }
        broadcast("daemon:error", { bookId: "scheduler", error: error.message });
      });
      return c.json({ ok: true, running: true });
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  app.post("/api/v1/daemon/stop", (c) => {
    if (!schedulerInstance?.isRunning) {
      return c.json({ error: "Daemon not running" }, 400);
    }
    schedulerInstance.stop();
    schedulerInstance = null;
    broadcast("daemon:stopped", {});
    return c.json({ ok: true, running: false });
  });

  // --- Logs ---

  app.get("/api/v1/logs", async (c) => {
    await logWriteQueue;
    try {
      const content = await readFile(logPath, "utf-8");
      const lines = content.trim().split("\n").filter(Boolean).slice(-500);
      const fileEntries = lines.map((line) => {
        try { return JSON.parse(line); } catch { return { message: line }; }
      });
      const seen = new Set<string>();
      const entries = [...fileEntries, ...recentLogEntries]
        .filter((entry) => {
          const key = `${entry.timestamp ?? ""}\u0000${entry.level ?? ""}\u0000${entry.tag ?? ""}\u0000${entry.message}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        })
        .slice(-500);
      return c.json({ entries });
    } catch {
      return c.json({ entries: recentLogEntries.slice(-500) });
    }
  });

  app.delete("/api/v1/logs", async (c) => {
    await logWriteQueue;
    recentLogEntries.length = 0;
    await writeFile(logPath, "", "utf-8").catch(() => undefined);
    broadcast("logs:clear", { timestamp: new Date().toISOString() });
    return c.json({ status: "cleared" });
  });

  // --- Agent chat ---

  app.get("/api/v1/interaction/session", async (c) => {
    const session = await loadProjectSession(root);
    const activeBookId = await resolveSessionActiveBook(root, session);
    return c.json({
      session: activeBookId && session.activeBookId !== activeBookId
        ? { ...session, activeBookId }
        : session,
      activeBookId,
    });
  });

  // Play worlds are created and advanced by the play_start / play_step agent
  // tools (worldId === sessionId). The HUD only needs to read a run's state,
  // so just the run-detail endpoint remains; the old save-slot list/create
  // endpoints were only used by the removed standalone play page.
  app.get("/api/v1/play/runs/:worldId/:runId", async (c) => {
    const worldId = normalizeApiBookId(c.req.param("worldId"), "worldId") ?? "default-world";
    const runId = normalizeApiBookId(c.req.param("runId"), "runId") ?? "default-run";
    const store = new PlayStore(root);
    const db = createPlayDB(store.runDir(worldId, runId));
    const [transcript, currentState, world] = await Promise.all([
      store.readTranscript(worldId, runId),
      store.loadCurrentState(worldId, runId).catch(() => null),
      store.loadWorld(worldId).catch(() => null),
    ]);
    const graph = db.snapshot();
    db.close?.();

    // Merge generated illustrations (decoupled sidecar) onto entities so the
    // HUD can render portraits/stills without touching the event-sourced graph.
    const runDir = store.runDir(worldId, runId);
    const [manifest, imageSettings] = await Promise.all([
      readPlayImageManifest(runDir),
      readPlayImageSettings(runDir),
    ]);
    const imageUrlFor = (file?: string): string | undefined => playImageUrl(worldId, runId, file);
    const sceneImageUrls = Object.fromEntries(
      Object.entries(manifest)
        .filter(([key, entry]) => key.startsWith("scene-turn-") && entry.status === "ready" && entry.file)
        .map(([key, entry]) => [key, imageUrlFor(entry.file)]),
    );
    const deletedImageKeys = Object.entries(manifest)
      .filter(([, entry]) => entry.status === "deleted")
      .map(([key]) => key);
    const entitiesWithImages = (graph.entities ?? []).map((entity: { id: string }) => {
      const entry = manifest[entity.id];
      return entry?.status === "ready" && entry.file
        ? { ...entity, imageUrl: imageUrlFor(entry.file) }
        : entity;
    });

    // Illustration of the current moment, if one was generated for this turn.
    const sceneTurn = (currentState as { turn?: number } | null)?.turn ?? 0;
    const sceneEntry = manifest[`scene-turn-${sceneTurn}`];
    const sceneImageUrl = sceneEntry?.status === "ready" ? imageUrlFor(sceneEntry.file) : undefined;

    return c.json({
      worldId,
      runId,
      title: world?.title ?? null,
      transcript,
      currentState,
      graph: { ...graph, entities: entitiesWithImages },
      imageSettings,
      sceneImageUrls,
      deletedImageKeys,
      ...(sceneImageUrl ? { sceneImageUrl } : {}),
    });
  });

  // --- Interactive-world illustration (Play auto-config images) ---

  app.put("/api/v1/play/runs/:worldId/:runId/image-settings", async (c) => {
    const worldId = normalizeApiBookId(c.req.param("worldId"), "worldId") ?? "default-world";
    const runId = normalizeApiBookId(c.req.param("runId"), "runId") ?? "default-run";
    const body = await c.req.json<Partial<PlayImageSettings>>().catch(() => ({} as Partial<PlayImageSettings>));
    const settings: PlayImageSettings = {
      actors: Boolean(body.actors),
      moments: Boolean(body.moments),
      inventory: Boolean(body.inventory),
    };
    const runDir = new PlayStore(root).runDir(worldId, runId);
    await writePlayImageSettings(runDir, settings);
    return c.json({ ok: true, imageSettings: settings });
  });

  app.post("/api/v1/play/runs/:worldId/:runId/generate-image", async (c) => {
    const worldId = normalizeApiBookId(c.req.param("worldId"), "worldId") ?? "default-world";
    const runId = normalizeApiBookId(c.req.param("runId"), "runId") ?? "default-run";
    type GenerateImageBody = {
      target: "entity" | "scene";
      entityId?: string;
      sceneText?: string;
      sceneKey?: string;
    };
    const body = await c.req.json<GenerateImageBody>().catch(() => ({ target: "entity" } as GenerateImageBody));

    const store = new PlayStore(root);
    const runDir = store.runDir(worldId, runId);
    const [world, currentState] = await Promise.all([
      store.loadWorld(worldId).catch(() => null),
      store.loadCurrentState(worldId, runId).catch(() => null),
    ]);
    const worldContext = world
      ? {
        premise: world.premise,
        worldContract: world.worldContract,
        visualContract: world.visualContract,
      }
      : undefined;

    let key: string;
    let prompt: string;
    if (body.target === "scene") {
      // The current moment defaults to the rendered scene projection so the UI
      // can offer a one-tap "illustrate this moment" without re-sending prose.
      const sceneText = (
        (body.sceneText ?? "").trim()
        || (await store.readProjection(worldId, runId, "projections/scene.md").catch(() => "")).trim()
      );
      if (!sceneText) return c.json({ error: "no current scene to illustrate" }, 400);
      key = body.sceneKey?.trim() || `scene-turn-${(currentState as { turn?: number } | null)?.turn ?? 0}`;
      prompt = buildPlaySceneImagePrompt(sceneText, worldContext);
    } else {
      const entityId = body.entityId?.trim();
      if (!entityId) return c.json({ error: "entityId is required for an entity image" }, 400);
      const db = createPlayDB(runDir);
      const graph = db.snapshot();
      db.close?.();
      const entity = (graph.entities ?? []).find((e: { id: string }) => e.id === entityId) as
        | { id: string; type: string; label: string; summary?: string }
        | undefined;
      if (!entity) return c.json({ error: `entity not found: ${entityId}` }, 404);
      key = entity.id;
      prompt = buildPlayEntityImagePrompt(entity, worldContext);
    }

    try {
      const entry = await generatePlayImage({ root, runDir, key, prompt });
      const url = entry.status === "ready" && entry.file
        ? playImageUrl(worldId, runId, entry.file)
        : undefined;
      return c.json({ key, ok: entry.status === "ready", ...entry, ...(url ? { url } : {}) });
    } catch (e) {
      // Resolution failure = cover API not configured.
      return c.json({ error: e instanceof Error ? e.message : String(e), needsCoverConfig: true }, 400);
    }
  });

  app.get("/api/v1/play/runs/:worldId/:runId/images/:file", async (c) => {
    const worldId = normalizeApiBookId(c.req.param("worldId"), "worldId") ?? "default-world";
    const runId = normalizeApiBookId(c.req.param("runId"), "runId") ?? "default-run";
    const file = c.req.param("file");
    if (!file || file.includes("/") || file.includes("..") || file.includes("\0")) {
      return c.json({ error: "Invalid image file" }, 400);
    }
    const runDir = new PlayStore(root).runDir(worldId, runId);
    try {
      const { readFile: readFileFs } = await import("node:fs/promises");
      const content = await readFileFs(join(runDir, "images", file));
      const ext = file.split(".").pop()?.toLowerCase() ?? "";
      const contentType = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : "image/png";
      return new Response(content, { headers: { "Content-Type": contentType, "Cache-Control": "no-store" } });
    } catch {
      return c.notFound();
    }
  });

  app.get("/api/v1/images/library", async (c) => {
    const [playItems, projectItems] = await Promise.all([
      listPlayGeneratedImages(root),
      listProjectGeneratedImages(root),
    ]);
    const items = [...playItems, ...projectItems]
      .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "") || a.title.localeCompare(b.title));
    return c.json({ items });
  });

  app.post("/api/v1/images/library/wallpapers", async (c) => {
    const body = await c.req.json<{ name?: string; dataUrl?: string }>().catch(() => null);
    const dataUrl = body?.dataUrl?.trim() ?? "";
    const match = /^data:image\/(png|jpe?g|webp);base64,([a-z0-9+/=\s]+)$/iu.exec(dataUrl);
    if (!match) return c.json({ error: "A PNG, JPEG, or WebP image is required" }, 400);

    const content = Buffer.from(match[2].replace(/\s/g, ""), "base64");
    if (content.length === 0 || content.length > 12 * 1024 * 1024) {
      return c.json({ error: "Wallpaper must be between 1 byte and 12 MB" }, 400);
    }

    const rawExt = match[1].toLowerCase();
    const ext = rawExt === "jpeg" ? "jpg" : rawExt;
    const originalTitle = body?.name?.replace(/\.[^.]+$/u, "").trim();
    const title = (originalTitle || "wallpaper")
      .replace(/[<>:"/\\|?*\u0000-\u001f]/gu, " ")
      .replace(/\s+/gu, " ")
      .replace(/[.\s]+$/gu, "")
      .trim()
      .slice(0, 80) || "wallpaper";
    let fileName = `${title}.${ext}`;
    let duplicateIndex = 2;
    while (await access(join(root, "wallpapers", fileName)).then(() => true).catch(() => false)) {
      fileName = `${title} (${duplicateIndex}).${ext}`;
      duplicateIndex += 1;
    }
    const relPath = `wallpapers/${fileName}`;
    const fullPath = join(root, "wallpapers", fileName);
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, content);
    const updatedAt = new Date().toISOString();
    const item: GeneratedImageLibraryItem = {
      id: encodeLibraryId(["project", relPath]),
      source: "project",
      kind: "wallpaper",
      status: "ready",
      title,
      subtitle: relPath,
      url: projectFileUrl(relPath),
      updatedAt,
      path: relPath,
    };
    return c.json({ item }, 201);
  });

  app.post("/api/v1/images/generate", async (c) => {
    type GenerateImageBody = { prompt?: string; title?: string; size?: string };
    const body = await c.req.json<GenerateImageBody>().catch(() => ({} as GenerateImageBody));
    const prompt = body.prompt?.trim() ?? "";
    if (!prompt) return c.json({ error: "Prompt is required" }, 400);

    try {
      const request = await resolveCoverGenerationRequest({ root });
      const size = body.size?.trim() || "1024x1024";
      const { buffer, extension } = await generateImageFromPrompt(request, prompt, size);

      const ext = extension || "png";
      const rawTitle = body.title?.trim()
        .replace(/[<>:"/\\|?* -]/gu, " ")
        .replace(/\s+/gu, " ")
        .replace(/[.\s]+$/gu, "")
        .trim()
        .slice(0, 80) || prompt.slice(0, 40).replace(/[<>:"/\\|?* -]/gu, " ").replace(/\s+/gu, " ").trim() || "image";
      let fileName = `${rawTitle}.${ext}`;
      let duplicateIndex = 2;
      while (await access(join(root, "wallpapers", fileName)).then(() => true).catch(() => false)) {
        fileName = `${rawTitle} (${duplicateIndex}).${ext}`;
        duplicateIndex += 1;
      }
      const relPath = `wallpapers/${fileName}`;
      const fullPath = join(root, "wallpapers", fileName);
      await mkdir(dirname(fullPath), { recursive: true });
      await writeFile(fullPath, buffer);
      const updatedAt = new Date().toISOString();
      const item: GeneratedImageLibraryItem = {
        id: encodeLibraryId(["project", relPath]),
        source: "project",
        kind: "wallpaper",
        status: "ready",
        title: rawTitle,
        subtitle: relPath,
        url: projectFileUrl(relPath),
        updatedAt,
        path: relPath,
      };
      return c.json({ item }, 201);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const needsCoverConfig = message.includes("cover") || message.includes("COVER") || message.includes("api key") || message.includes("apiKey");
      return c.json({ error: message, needsCoverConfig }, 400);
    }
  });

  app.patch("/api/v1/images/library", async (c) => {
    const body = await c.req.json<{ id?: string; title?: string }>().catch(() => null);
    const id = body?.id?.trim() ?? "";
    const requestedTitle = body?.title?.trim() ?? "";
    const parts = decodeLibraryId(id);
    const relPath = parts[0] === "project" ? parts[1] : undefined;
    if (!relPath?.startsWith("wallpapers/")) {
      return c.json({ error: "Only wallpapers can be renamed" }, 400);
    }

    const title = requestedTitle
      .replace(/[<>:"/\\|?*\u0000-\u001f]/gu, " ")
      .replace(/\s+/gu, " ")
      .replace(/[.\s]+$/gu, "")
      .trim()
      .slice(0, 80);
    if (!title) return c.json({ error: "Wallpaper name is required" }, 400);

    const currentFile = resolveProjectImageFile(root, relPath);
    const ext = relPath.split(".").pop()?.toLowerCase() ?? "";
    let fileName = `${title}.${ext}`;
    let nextRelPath = `wallpapers/${fileName}`;
    let duplicateIndex = 2;
    while (
      nextRelPath !== relPath
      && await access(join(root, nextRelPath)).then(() => true).catch(() => false)
    ) {
      fileName = `${title} (${duplicateIndex}).${ext}`;
      nextRelPath = `wallpapers/${fileName}`;
      duplicateIndex += 1;
    }

    if (nextRelPath !== relPath) {
      await rename(currentFile.resolved, join(root, nextRelPath));
    }
    const fileStat = await stat(join(root, nextRelPath));
    const item: GeneratedImageLibraryItem = {
      id: encodeLibraryId(["project", nextRelPath]),
      source: "project",
      kind: "wallpaper",
      status: "ready",
      title: fileName.replace(/\.[^.]+$/u, ""),
      subtitle: nextRelPath,
      url: projectFileUrl(nextRelPath),
      updatedAt: fileStat.mtime.toISOString(),
      path: nextRelPath,
    };
    return c.json({ item });
  });

  app.delete("/api/v1/images/library", async (c) => {
    const id = c.req.query("id")?.trim();
    if (!id) return c.json({ error: "Image id is required" }, 400);
    const parts = decodeLibraryId(id);
    const source = parts[0];
    if (source === "play") {
      const [, worldId, runId, key] = parts;
      if (!worldId || !runId || !key) return c.json({ error: "Invalid image id" }, 400);
      const store = new PlayStore(root);
      await deletePlayImageEntry(store.runDir(worldId, runId), key, { rememberDeleted: true });
      return c.json({ ok: true });
    }
    if (source === "project") {
      const relPath = parts[1];
      if (!relPath) return c.json({ error: "Invalid image id" }, 400);
      const file = resolveProjectImageFile(root, relPath);
      await rm(file.resolved, { force: true });
      return c.json({ ok: true });
    }
    return c.json({ error: "Invalid image id" }, 400);
  });

  // -- Per-book session endpoints --

  app.get("/api/v1/sessions", async (c) => {
    const bookId = c.req.query("bookId");
    const sessions = await listBookSessions(root, bookId === undefined ? null : bookId === "null" ? null : bookId);
    return c.json({ sessions });
  });

  app.get("/api/v1/sessions/:sessionId", async (c) => {
    const session = await loadBookSession(root, c.req.param("sessionId"));
    if (!session) return c.json({ error: "Session not found" }, 404);
    return c.json({ session });
  });

  app.post("/api/v1/sessions", async (c) => {
    const body = await c.req.json<{ bookId?: string | null; sessionId?: string; sessionKind?: string; playMode?: string }>().catch(() => ({}));
    const bookId = normalizeApiBookId((body as { bookId?: unknown }).bookId, "bookId");
    const sessionKind = normalizeStudioSessionKind(
      (body as { sessionKind?: unknown }).sessionKind,
      bookId ? "book" : "chat",
    );
    const playMode = normalizeStudioPlayMode((body as { playMode?: unknown }).playMode);
    const sessionId = (body as { sessionId?: string }).sessionId;
    // sessionId 只允许 timestamp-random 格式；防止注入任意文件名
    const safeSessionId = sessionId && /^[0-9]+-[a-z0-9]+$/.test(sessionId) ? sessionId : undefined;
    const session = await createAndPersistBookSession(
      root,
      bookId,
      safeSessionId,
      sessionKind,
      ...(playMode ? [{ playMode }] as const : []),
    );
    return c.json({ session });
  });

  app.put("/api/v1/sessions/:sessionId/play-mode", async (c) => {
    const body = await c.req.json<{ playMode?: string }>().catch(() => ({}));
    const playMode = normalizeStudioPlayMode((body as { playMode?: unknown }).playMode);
    if (!playMode) {
      throw new ApiError(400, "INVALID_PLAY_MODE", "playMode is required");
    }
    const existing = await loadBookSession(root, c.req.param("sessionId"));
    if (!existing) return c.json({ error: "Session not found" }, 404);
    const session = await createAndPersistBookSession(
      root,
      existing.bookId,
      existing.sessionId,
      existing.sessionKind,
      { playMode },
    );
    if (existing.sessionKind === "play") {
      const playStore = new PlayStore(root);
      const world = await playStore.loadWorld(existing.sessionId);
      if (world && world.mode !== playMode) {
        await playStore.updateWorld(existing.sessionId, { mode: playMode });
      }
    }
    return c.json({ session });
  });

  app.put("/api/v1/sessions/:sessionId", async (c) => {
    const sessionId = c.req.param("sessionId");
    const body = await c.req.json<{ title?: string }>().catch(() => ({}) as { title?: string });
    const title = body.title?.trim();
    if (!title) {
      throw new ApiError(400, "INVALID_SESSION_TITLE", "Session title is required");
    }

    const session = await renameBookSession(root, sessionId, title);
    if (!session) {
      return c.json({ error: "Session not found" }, 404);
    }
    return c.json({ session });
  });

  app.delete("/api/v1/sessions/:sessionId", async (c) => {
    const sessionId = c.req.param("sessionId");
    const session = await loadBookSession(root, sessionId);
    await deleteBookSession(root, sessionId);
    if (session?.sessionKind === "play") {
      await new PlayStore(root).deleteWorld(sessionId);
    }
    return c.json({ ok: true });
  });

  app.delete("/api/v1/sessions/:sessionId/messages", async (c) => {
    const body = await c.req.json<{
      role?: unknown;
      content?: unknown;
      timestamp?: unknown;
      messageIndex?: unknown;
    }>().catch((): {
      role?: unknown;
      content?: unknown;
      timestamp?: unknown;
      messageIndex?: unknown;
    } => ({}));
    const role = body.role === "user" || body.role === "assistant" ? body.role : null;
    const content = typeof body.content === "string" ? body.content : "";
    const timestamp = typeof body.timestamp === "number" && Number.isFinite(body.timestamp)
      ? body.timestamp
      : Date.now();
    const messageIndex = typeof body.messageIndex === "number" && Number.isInteger(body.messageIndex)
      ? body.messageIndex
      : undefined;
    if (!role) {
      throw new ApiError(400, "INVALID_MESSAGE_ROLE", "role must be user or assistant");
    }
    const session = await deleteBookSessionMessage(root, c.req.param("sessionId"), {
      role,
      content,
      timestamp,
      ...(messageIndex !== undefined ? { messageIndex } : {}),
    });
    if (!session) return c.json({ error: "Session or message not found" }, 404);
    return c.json({ ok: true, session });
  });

  app.post("/api/v1/agent", async (c) => {
    const {
      instruction,
      activeBookId,
      sessionId: reqSessionId,
      sessionKind: reqSessionKind,
      actionSource: reqActionSource,
      requestedIntent: reqRequestedIntent,
      actionPayload: reqActionPayload,
      playMode: reqPlayMode,
      model: reqModel,
      service: reqService,
    } = await c.req.json<{
      instruction: string;
      activeBookId?: string;
      sessionId?: string;
      sessionKind?: string;
      actionSource?: string;
      requestedIntent?: string;
      actionPayload?: unknown;
      playMode?: string;
      model?: string;
      service?: string;
    }>();
    const sessionId = reqSessionId;
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

    const actionSource = normalizeStudioActionSource(reqActionSource);
    const requestedIntent = normalizeStudioRequestedIntent(reqRequestedIntent);
    const actionPayload = normalizeStudioActionPayload(reqActionPayload);
    const playMode = normalizeStudioPlayMode(reqPlayMode);

    broadcast("agent:start", { instruction, activeBookId, sessionId, actionSource, requestedIntent });
    emitRuntimeLog({
      level: "info",
      tag: "agent",
      sessionId,
      message: `开始请求 · 会话 ${sessionId} · 类型 ${reqSessionKind ?? "auto"} · 模式 ${playMode ?? "-"} · 模型 ${reqService ?? "default"}/${reqModel ?? "default"} · 指令 ${instruction.trim().length} 字符`,
    });

    try {
      // Load config + create LLM client (pipeline created after model resolution)
      const config = await loadCurrentProjectConfig({ requireApiKey: false });
      const client = createStudioLLMClient(config.llm, { sessionId });

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
      const requestedSessionKind = normalizeStudioSessionKind(
        reqSessionKind,
        bookSession.sessionKind ?? (agentBookId ? "book" : "chat"),
      );
      const sessionKind = shouldRouteChatCreateBookToBookCreate({
        instruction,
        agentBookId,
        sessionKind: requestedSessionKind,
        actionSource,
        requestedIntent,
      }) ? "book-create" : requestedSessionKind;
      if (bookSession.sessionKind !== sessionKind || (playMode && bookSession.playMode !== playMode)) {
        const updatedSession = await createAndPersistBookSession(
          root,
          bookSession.bookId,
          bookSession.sessionId,
          sessionKind,
          ...(playMode ? [{ playMode }] as const : []),
        );
        bookSession = updatedSession;
      }
      let activeBookConfig: { readonly language?: string } | null = null;
      if (agentBookId) {
        try {
          activeBookConfig = await state.loadBookConfig(agentBookId);
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

      const externalEdit = requestedIntent === "edit_artifact" || sessionKind === "edit"
        ? await tryHandleExternalChatEdit({
            root,
            state,
            instruction,
            activeBookId: agentBookId,
          })
        : null;
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
        }], instruction, { sessionKind });
        await refreshBookSessionFromTranscript();
        broadcast("agent:complete", { instruction, activeBookId: externalEdit.activeBookId, sessionId: bookSession.sessionId, sessionKind });
        return c.json({
          response: externalEdit.responseText,
          session: {
            sessionId: bookSession.sessionId,
            sessionKind,
            ...(externalEdit.activeBookId ? { activeBookId: externalEdit.activeBookId } : {}),
          },
        });
      }

      // Resolve model — multi-service resolution
      let resolvedModel: ResolvedModel["model"] | undefined;
      let resolvedApiKey: string | undefined;

      if (reqService && reqModel) {
        // 1. Frontend explicitly selected a service+model — fail loudly if no key
        try {
          const configuredEntry = await resolveConfiguredServiceEntry(root, reqService);
          const resolved = await resolveServiceModel(
            reqService,
            reqModel,
            root,
            await resolveConfiguredServiceBaseUrl(root, reqService),
            configuredEntry?.apiFormat,
          );
          resolvedModel = resolved.model;
          resolvedApiKey = resolved.apiKey;
        } catch (e: any) {
          const msg = e?.message ?? String(e);
          if (/API key/i.test(msg)) {
            return c.json({
              error: `请先为 ${reqService} 配置 API Key`,
              response: `请先在模型配置中为 ${reqService} 填写 API Key，然后再试。`,
            }, 400);
          }
          throw e;
        }
      }

      if (!resolvedModel) {
        // 2. Try defaultModel from new config format
        const rawConfig = config.llm as unknown as Record<string, unknown>;
        const defaultModel = rawConfig.defaultModel as string | undefined;
        const servicesArr = normalizeServiceConfig(rawConfig.services);
        const firstService = servicesArr[0];
        if (firstService?.service && defaultModel && isTextChatModelId(defaultModel)) {
          try {
            const resolved = await resolveServiceModel(
              serviceConfigKey(firstService),
              defaultModel,
              root,
              firstService.baseUrl,
              firstService.apiFormat,
            );
            resolvedModel = resolved.model;
            resolvedApiKey = resolved.apiKey;
          } catch { /* fall through */ }
        }
      }

      if (!resolvedModel) {
        // 3. Try first connected service from secrets
        const secrets = await loadSecrets(root);
        for (const [svcName, svcData] of Object.entries(secrets.services)) {
          if (svcData?.apiKey) {
            try {
              const models = await listModelsForService(svcName, svcData.apiKey);
              const textModels = filterTextChatModels(models);
              if (textModels.length > 0) {
                const configuredEntry = await resolveConfiguredServiceEntry(root, svcName);
                const resolved = await resolveServiceModel(
                  svcName,
                  textModels[0].id,
                  root,
                  await resolveConfiguredServiceBaseUrl(root, svcName),
                  configuredEntry?.apiFormat,
                );
                resolvedModel = resolved.model;
                resolvedApiKey = resolved.apiKey;
                break;
              }
            } catch { /* try next */ }
          }
        }
      }

      if (!resolvedModel) {
        // 4. Legacy fallback: use createLLMClient
        resolvedModel = client._piModel
          ? client._piModel
          : { provider: config.llm.provider ?? "anthropic", modelId: config.llm.model } as any;
        resolvedApiKey = client._apiKey;
      }

      const model = resolvedModel!;
      const agentApiKey = resolvedApiKey;
      const keepProjectProductionRoute = Boolean(
        requestedIntent
        && requestedIntent !== "create_book"
        && requestedIntent !== "play_start",
      );
      // Interactive Play/book-creation tools follow the current chat selection.
      // Direct production actions such as write-next retain the project's routing table.
      const pipeline = new PipelineRunner(await buildPipelineConfig({
        currentConfig: config,
        sessionIdForSSE: bookSession.sessionId,
        ...(reqModel && !keepProjectProductionRoute ? {
          selectedModelRoute: {
            ...(reqService ? { service: reqService } : {}),
            model,
            ...(agentApiKey ? { apiKey: agentApiKey } : {}),
          },
        } : {}),
      }));

      if (requestedIntent && isConfirmedProductionAction({ actionSource, requestedIntent })) {
        const pendingBookId = requestedIntent === "create_book" && actionPayload?.createBook?.title
          ? deriveBookIdFromTitle(actionPayload.createBook.title)
          : null;
        if (pendingBookId) {
          bookCreateStatus.set(pendingBookId, { status: "creating" });
          broadcast("book:creating", {
            bookId: pendingBookId,
            title: actionPayload?.createBook?.title ?? pendingBookId,
            sessionId: streamSessionId,
          });
        }

        try {
          const exec = await executeConfirmedProductionAction({
            pipeline,
            root,
            sessionId: bookSession.sessionId,
            streamSessionId,
            instruction,
            requestedIntent,
            actionPayload,
            ...(playMode ? { playMode } : {}),
          });

          let createdBookId: string | null = null;
          if (exec.tool === "sub_agent" && exec.agent === "architect" && exec.status === "completed") {
            createdBookId = resolveCreatedBookIdFromToolExecs([exec]);
            if (createdBookId) {
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
            }
          }

          const responseText = exec.result ?? "已完成。";
          await appendManualSessionMessages(root, bookSession.sessionId, [
            manualToolAssistantMessage(
              responseText,
              exec,
              resolveManualToolRoute(config, exec).provider,
              resolveManualToolRoute(config, exec).model,
            ),
          ], instruction, manualToolAppendOptions(sessionKind, exec));
          await refreshBookSessionFromTranscript();
          broadcast("agent:complete", { instruction, activeBookId: createdBookId ?? agentBookId, sessionId: bookSession.sessionId, sessionKind });
          return c.json({
            response: responseText,
            session: {
              sessionId: bookSession.sessionId,
              sessionKind,
              ...(createdBookId ?? agentBookId ? { activeBookId: createdBookId ?? agentBookId } : {}),
            },
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (pendingBookId) {
            bookCreateStatus.set(pendingBookId, { status: "error", error: message });
            broadcast("book:error", { bookId: pendingBookId, sessionId: streamSessionId, error: message });
          }
          if (error instanceof ConfirmedActionExecutionError) {
            await appendManualSessionMessages(root, bookSession.sessionId, [
              manualToolAssistantMessage(
                message,
                error.exec,
                resolveManualToolRoute(config, error.exec).provider,
                resolveManualToolRoute(config, error.exec).model,
              ),
            ], instruction, manualToolAppendOptions(sessionKind, error.exec)).catch(() => undefined);
            await refreshBookSessionFromTranscript().catch(() => undefined);
          }
          broadcast("agent:error", { instruction, activeBookId: agentBookId, sessionId: bookSession.sessionId, sessionKind, error: message });
          return c.json({
            error: { code: "AGENT_ACTION_FAILED", message },
            response: message,
          }, 502);
        }
      }

      if (requestedIntent === "repair_state") {
        const repairBookId = agentBookId;
        const repairChapter = requestedRepairChapter(instruction);
        if (!repairBookId) {
          throw new ApiError(400, "BOOK_ID_REQUIRED", "repair_state requires an active book");
        }
        if (!repairChapter) {
          throw new ApiError(400, "CHAPTER_REQUIRED", "repair_state requires a chapter number");
        }

        const toolCallId = `repair-state-${repairChapter}-${Date.now().toString(36)}`;
        const toolArgs = { agent: "state-repair", bookId: repairBookId, chapterNumber: repairChapter };
        broadcast("tool:start", {
          sessionId: streamSessionId,
          id: toolCallId,
          tool: "sub_agent",
          args: toolArgs,
          stages: PIPELINE_STAGES["state-repair"],
        });

        try {
          const repairResult = await pipeline.repairChapterState(repairBookId, repairChapter);
          {
            const repairIssue = repairResult.auditResult?.issues?.[0];
            const repairStatus = repairResult.status ?? "ready-for-review";
            const repairIncomplete = repairStatus === "state-degraded";
            const repairReason = repairIssue?.description ? `\n原因：${repairIssue.description}` : "";
            const repairSuggestion = repairIssue?.suggestion ? `\n建议：${repairIssue.suggestion}` : "";
            const responseText = repairIncomplete
              ? `第 ${repairChapter} 章状态恢复未完成，仍处于 ${repairStatus}。${repairReason}${repairSuggestion}`
              : `第 ${repairChapter} 章的 truth/state 已重新整理，章节状态已恢复为 ${repairStatus}。`;
            const details = {
              kind: repairIncomplete ? "chapter_state_repair_failed" : "chapter_state_repaired",
              bookId: repairBookId,
              chapterNumber: repairChapter,
              status: repairStatus,
              auditPassed: repairResult.auditResult?.passed,
              issueCount: repairResult.auditResult?.issues?.length ?? 0,
              firstIssue: repairIssue,
            };
            const toolResult = {
              content: [{ type: "text", text: responseText }],
              details,
            };
            broadcast("tool:end", {
              sessionId: streamSessionId,
              id: toolCallId,
              tool: "sub_agent",
              result: toolResult,
              details,
              isError: repairIncomplete,
            });
            const exec: CollectedToolExec = {
              id: toolCallId,
              tool: "sub_agent",
              agent: "state-repair",
              label: resolveToolLabel("sub_agent", "state-repair"),
              status: repairIncomplete ? "error" : "completed",
              args: toolArgs,
              result: responseText,
              details,
              startedAt: Date.now(),
              completedAt: Date.now(),
            };
            const route = resolveManualToolRoute(config, exec);
            await appendManualSessionMessages(root, bookSession.sessionId, [
              manualToolAssistantMessage(
                responseText,
                exec,
                route.provider,
                route.model,
              ),
            ], instruction, manualToolAppendOptions(sessionKind, exec));
            await refreshBookSessionFromTranscript();
            if (repairIncomplete) {
              broadcast("agent:error", {
                instruction,
                activeBookId: repairBookId,
                sessionId: bookSession.sessionId,
                sessionKind,
                error: responseText,
              });
            } else {
              broadcast("agent:complete", {
                instruction,
                activeBookId: repairBookId,
                sessionId: bookSession.sessionId,
                sessionKind,
              });
            }
            return c.json({
              response: responseText,
              session: {
                sessionId: bookSession.sessionId,
                sessionKind,
                activeBookId: repairBookId,
              },
            });
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const toolResult = { content: [{ type: "text", text: message }] };
          const exec: CollectedToolExec = {
            id: toolCallId,
            tool: "sub_agent",
            agent: "state-repair",
            label: resolveToolLabel("sub_agent", "state-repair"),
            status: "error",
            args: toolArgs,
            error: message,
            startedAt: Date.now(),
            completedAt: Date.now(),
          };
          broadcast("tool:end", {
            sessionId: streamSessionId,
            id: toolCallId,
            tool: "sub_agent",
            result: toolResult,
            isError: true,
          });
          await appendManualSessionMessages(root, bookSession.sessionId, [
            manualToolAssistantMessage(
              message,
              exec,
              resolveManualToolRoute(config, exec).provider,
              resolveManualToolRoute(config, exec).model,
            ),
          ], instruction, manualToolAppendOptions(sessionKind, exec)).catch(() => undefined);
          await refreshBookSessionFromTranscript().catch(() => undefined);
          broadcast("agent:error", {
            instruction,
            activeBookId: repairBookId,
            sessionId: bookSession.sessionId,
            sessionKind,
            error: message,
          });
          return c.json({
            error: { code: "REPAIR_STATE_FAILED", message },
            response: message,
          }, 502);
        }
      }

      if (shouldRunDirectWriteNext({ instruction, agentBookId, sessionKind, actionSource, requestedIntent })) {
        const directWriteBookId = agentBookId;
        if (!directWriteBookId) {
          throw new ApiError(400, "BOOK_ID_REQUIRED", "write_next requires an active book");
        }
        const toolCallId = `direct-writer-${Date.now().toString(36)}`;
        const toolArgs = { agent: "writer", bookId: directWriteBookId };
        broadcast("tool:start", {
          sessionId: streamSessionId,
          id: toolCallId,
          tool: "sub_agent",
          args: toolArgs,
          stages: PIPELINE_STAGES.writer,
        });

        try {
          const writeKnowledge = normalizeWriteKnowledgeOptions(actionPayload?.writeNext?.knowledge);
          const writeResult = await pipeline.writeNextChapter(directWriteBookId, writeKnowledge ? { knowledge: writeKnowledge } : undefined);
          const writeNeedsReview = Boolean(writeResult.status && writeResult.status !== "ready-for-review");
          const responseText = writeNeedsReview
            ? [
                `已为 ${directWriteBookId} 写出第 ${writeResult.chapterNumber} 章`,
                writeResult.title ? `《${writeResult.title}》` : "",
                `，字数 ${writeResult.wordCount}，但审稿未通过，状态 ${writeResult.status}，需要复核后再继续。`,
              ].join("")
            : [
                `已为 ${directWriteBookId} 完成第 ${writeResult.chapterNumber} 章`,
                writeResult.title ? `《${writeResult.title}》` : "",
                `，字数 ${writeResult.wordCount}，状态 ${writeResult.status}。`,
              ].join("");
          const toolResult = {
            content: [{ type: "text", text: responseText }],
            details: {
              kind: "chapter_written",
              bookId: directWriteBookId,
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
            isError: writeNeedsReview,
          });
          const exec: CollectedToolExec = {
            id: toolCallId,
            tool: "sub_agent",
            agent: "writer",
            label: resolveToolLabel("sub_agent", "writer"),
            status: writeNeedsReview ? "error" : "completed",
            args: toolArgs,
            result: responseText,
            details: toolResult.details,
            startedAt: Date.now(),
            completedAt: Date.now(),
          };
          await appendManualSessionMessages(root, bookSession.sessionId, [
            manualToolAssistantMessage(
              responseText,
              exec,
              resolveManualToolRoute(config, exec).provider,
              resolveManualToolRoute(config, exec).model,
            ),
          ], instruction, manualToolAppendOptions(sessionKind, exec));
          await refreshBookSessionFromTranscript();
          broadcast("agent:complete", { instruction, activeBookId: directWriteBookId, sessionId: bookSession.sessionId, sessionKind });
          return c.json({
            response: responseText,
            session: {
              sessionId: bookSession.sessionId,
              sessionKind,
              activeBookId: directWriteBookId,
            },
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const toolResult = { content: [{ type: "text", text: message }] };
          const exec: CollectedToolExec = {
            id: toolCallId,
            tool: "sub_agent",
            agent: "writer",
            label: resolveToolLabel("sub_agent", "writer"),
            status: "error",
            args: toolArgs,
            error: message,
            startedAt: Date.now(),
            completedAt: Date.now(),
          };
          broadcast("tool:end", {
            sessionId: streamSessionId,
            id: toolCallId,
            tool: "sub_agent",
            result: toolResult,
            isError: true,
          });
          await appendManualSessionMessages(root, bookSession.sessionId, [
            manualToolAssistantMessage(
              message,
              exec,
              resolveManualToolRoute(config, exec).provider,
              resolveManualToolRoute(config, exec).model,
            ),
          ], instruction, manualToolAppendOptions(sessionKind, exec)).catch(() => undefined);
          await refreshBookSessionFromTranscript().catch(() => undefined);
          broadcast("agent:error", { instruction, activeBookId: agentBookId, sessionId: bookSession.sessionId, sessionKind, error: message });
          return c.json({
            error: { code: "AGENT_ACTION_FAILED", message },
            response: message,
          }, 502);
        }
      }

      // The surface agent should speak the user's language, not just the project default.
      // Pre-commitment surfaces (chat / play / short / book-create, no book yet) infer it
      // from the instruction; committed book/edit sessions keep the configured language.
      // Without this, an English request on a zh-default project gets Chinese replies — and
      // a Chinese play world, because play_start then infers from the rewritten premise.
      const configLanguage = config.language === "en" ? "en" : "zh";
      const bookLanguage = activeBookConfig?.language === "en" ? "en" : activeBookConfig?.language === "zh" ? "zh" : undefined;
      const surfaceLanguage = agentBookId ? (bookLanguage ?? configLanguage) : inferLanguage(instruction);

      // Run pi-agent session
      const collectedToolExecs: CollectedToolExec[] = [];
      const result = await runAgentSession(
        {
          model,
          apiKey: agentApiKey,
          pipeline,
          projectRoot: root,
          bookId: agentBookId,
          sessionKind,
          playMode,
          actionSource,
          requestedIntent,
          actionPayload,
          sessionId: bookSession.sessionId,
          language: surfaceLanguage,
          requestHeaders: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          },
          onContextCompression: (event) => {
            broadcast("context:compression", {
              sessionId: streamSessionId,
              ...event,
            });
          },
          compressContext: (content) => headroom.compress(content),
          onRequestDiagnostics: (diagnostics) => {
            emitModelRequestDiagnostics(diagnostics, streamSessionId);
          },
          onEvent: (event) => {
            if (event.type === "message_update") {
              const ame = event.assistantMessageEvent;
              if (ame.type === "text_delta") {
                broadcast("draft:delta", { sessionId: streamSessionId, text: ame.delta });
              } else if (ame.type === "thinking_delta") {
                broadcast("thinking:delta", { sessionId: streamSessionId, text: (ame as any).delta });
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
              emitRuntimeLog({
                level: "info",
                tag: "tool",
                sessionId: streamSessionId,
                message: `开始 ${resolveToolLabel(event.toolName, agent)}${agent ? ` (${agent})` : ""}`,
              });
            }
            if (event.type === "tool_execution_update") {
              broadcast("tool:update", {
                sessionId: streamSessionId,
                id: event.toolCallId,
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
              emitRuntimeLog({
                level: event.isError ? "error" : "info",
                tag: "tool",
                sessionId: streamSessionId,
                message: `${event.isError ? "失败" : "完成"} ${resolveToolLabel(event.toolName, exec?.agent)}${exec?.error ? ` · ${exec.error}` : ""}`,
              });
            }
          },
        },
        instruction,
      );

      if (result.responseText) {
        const actionExecutionError = validateAgentActionExecution({
          instruction,
          agentBookId,
          requestedIntent,
          collectedToolExecs,
        });
        if (actionExecutionError) {
          return c.json({
            error: { code: "AGENT_ACTION_NOT_EXECUTED", message: actionExecutionError },
            response: actionExecutionError,
          }, 502);
        }
      }

      let broadcastedCreatedBookId: string | null = null;
      const finalizeCreatedBook = async (): Promise<string | null> => {
        if (agentBookId) return null;
        const createdBookId = resolveCreatedBookIdFromToolExecs(collectedToolExecs);
        if (!createdBookId) return null;
        if (broadcastedCreatedBookId === createdBookId) return createdBookId;
        if (!await completeBookExists(join(root, "books", createdBookId))) {
          const error = "Book creation artifact is incomplete on disk.";
          bookCreateStatus.set(createdBookId, { status: "error", error });
          broadcast("book:error", { bookId: createdBookId, sessionId: bookSession.sessionId, error });
          return null;
        }

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
        if (hasSuccessfulToolExec(collectedToolExecs, "propose_action")) {
          await refreshBookSessionFromTranscript();
          broadcast("agent:complete", { instruction, activeBookId, sessionId: bookSession.sessionId, sessionKind });
          return c.json({
            response: "",
            session: {
              sessionId: bookSession.sessionId,
              sessionKind,
              ...(bookSession.bookId ? { activeBookId: bookSession.bookId } : {}),
            },
          });
        }

        if (result.errorMessage) {
          if (resolveCreatedBookIdFromToolExecs(collectedToolExecs)) {
            await finalizeCreatedBook();
          }
          const failure = formatAgentFailure(result.errorMessage);
          return c.json({
            error: { code: failure.code, message: failure.message },
            response: failure.message,
          }, failure.status);
        }

        const actionExecutionError = validateAgentActionExecution({
          instruction,
          agentBookId,
          requestedIntent,
          collectedToolExecs,
        });
        if (actionExecutionError) {
          return c.json({
            error: { code: "AGENT_ACTION_NOT_EXECUTED", message: actionExecutionError },
            response: actionExecutionError,
          }, 502);
        }

        await refreshBookSessionFromTranscript();
        const createdBookId = await finalizeCreatedBook();
        if (requestedIntent || createdBookId || hasSuccessfulToolResult(collectedToolExecs)) {
          const responseSessionKind = bookSession.sessionKind ?? sessionKind;
          broadcast("agent:complete", { instruction, activeBookId, sessionId: bookSession.sessionId, sessionKind: responseSessionKind });
          return c.json({
            response: "",
            session: {
              sessionId: bookSession.sessionId,
              sessionKind: responseSessionKind,
              ...(createdBookId ?? bookSession.bookId ? { activeBookId: createdBookId ?? bookSession.bookId } : {}),
            },
          });
        }

        const emptyMessage = "模型未返回文本内容。请检查协议类型（chat/responses）、流式开关或上游服务兼容性。";
        if (resolveCreatedBookIdFromToolExecs(collectedToolExecs)) {
          await finalizeCreatedBook();
        }
        return c.json({
          error: { code: "AGENT_EMPTY_RESPONSE", message: emptyMessage },
          response: emptyMessage,
        }, 502);
      }
      await refreshBookSessionFromTranscript();
      await finalizeCreatedBook();

      const responseSessionKind = bookSession.sessionKind ?? sessionKind;
      broadcast("agent:complete", { instruction, activeBookId, sessionId: bookSession.sessionId, sessionKind: responseSessionKind });

      return c.json({
        response: result.responseText,
        session: {
          sessionId: bookSession.sessionId,
          sessionKind: responseSessionKind,
          ...(bookSession.bookId ? { activeBookId: bookSession.bookId } : {}),
        },
      });
    } catch (e) {
      if (e instanceof ApiError) {
        throw e;
      }
      if (e instanceof SessionAlreadyMigratedError) {
        const migratedMessage = e instanceof Error ? e.message : String(e);
        throw new ApiError(409, "SESSION_ALREADY_MIGRATED", migratedMessage);
      }
      const msg = e instanceof Error ? e.message : String(e);
      broadcast("agent:error", { instruction, activeBookId, sessionId, sessionKind: reqSessionKind, error: msg });

      // Agent busy — return 429 with user-friendly message
      if (/already processing|prompt.*queue/i.test(msg)) {
        return c.json({
          error: { code: "AGENT_BUSY", message: "正在处理中，请等待当前操作完成" },
          response: "正在处理中，请等待当前操作完成后再发送。",
        }, 429);
      }

      const failure = formatAgentFailure(msg);
      return c.json(
        { error: { code: failure.code, message: failure.message } },
        failure.status,
      );
    }
  });

  // --- Language setup ---

  app.post("/api/v1/project/language", async (c) => {
    const { language } = await c.req.json<{ language: "zh" | "en" }>();
    const configPath = join(root, "inkos.json");
    try {
      const raw = await readFile(configPath, "utf-8");
      const existing = JSON.parse(raw);
      existing.language = language;
      const { writeFile: writeFileFs } = await import("node:fs/promises");
      await writeFileFs(configPath, JSON.stringify(existing, null, 2), "utf-8");
      return c.json({ ok: true, language });
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  // --- Chapter Highlights ---

  app.post("/api/v1/books/:id/chapters/:num/highlights", async (c) => {
    const id = c.req.param("id");
    const chapterNum = parseInt(c.req.param("num"), 10);
    try {
      const bookDir = state.bookDir(id);
      const chaptersDir = join(bookDir, "chapters");
      const files = await readdir(chaptersDir);
      const paddedNum = String(chapterNum).padStart(4, "0");
      const match = files.find((f) => f.startsWith(paddedNum) && f.endsWith(".md"));
      if (!match) {
        return c.json({ error: `Chapter ${chapterNum} not found` }, 404);
      }
      const content = await readFile(join(chaptersDir, match), "utf-8");
      const book = await state.loadBookConfig(id);

      const { ChapterAnalyzerAgent } = await import("@actalk/inkos-core");
      const pipelineConfig = await buildPipelineConfig();
      const agent = new ChapterAnalyzerAgent(pipelineConfig);
      const result = await agent.generateHighlights({
        book,
        bookDir,
        chapterNumber: chapterNum,
        chapterContent: content,
      });

      // Cache to runtime file
      const runtimeDir = join(bookDir, "runtime");
      await mkdir(runtimeDir, { recursive: true });
      await writeFile(
        join(runtimeDir, `chapter-${paddedNum}.highlights.json`),
        JSON.stringify(result, null, 2),
        "utf-8",
      );

      return c.json(result);
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  app.get("/api/v1/books/:id/chapters/:num/highlights", async (c) => {
    const id = c.req.param("id");
    const chapterNum = parseInt(c.req.param("num"), 10);
    try {
      const bookDir = state.bookDir(id);
      const paddedNum = String(chapterNum).padStart(4, "0");
      const filePath = join(bookDir, "runtime", `chapter-${paddedNum}.highlights.json`);
      const raw = await readFile(filePath, "utf-8");
      return c.json(JSON.parse(raw));
    } catch {
      return c.json(null);
    }
  });

  // --- Satisfaction Beats (爽点标记) ---

  app.post("/api/v1/books/:id/chapters/:num/beats", async (c) => {
    const id = c.req.param("id");
    const chapterNum = parseInt(c.req.param("num"), 10);
    try {
      const bookDir = state.bookDir(id);
      const chaptersDir = join(bookDir, "chapters");
      const files = await readdir(chaptersDir);
      const paddedNum = String(chapterNum).padStart(4, "0");
      const match = files.find((f) => f.startsWith(paddedNum) && f.endsWith(".md"));
      if (!match) {
        return c.json({ error: `Chapter ${chapterNum} not found` }, 404);
      }
      const content = await readFile(join(chaptersDir, match), "utf-8");
      const book = await state.loadBookConfig(id);

      const { ChapterAnalyzerAgent } = await import("@actalk/inkos-core");
      const pipelineConfig = await buildPipelineConfig();
      const agent = new ChapterAnalyzerAgent(pipelineConfig);
      const beats = await agent.generateSatisfactionBeats({
        book,
        bookDir,
        chapterNumber: chapterNum,
        chapterContent: content,
      });

      // Cache to runtime file
      const runtimeDir = join(bookDir, "runtime");
      await mkdir(runtimeDir, { recursive: true });
      await writeFile(
        join(runtimeDir, `chapter-${paddedNum}.beats.json`),
        JSON.stringify(beats, null, 2),
        "utf-8",
      );

      return c.json(beats);
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  app.get("/api/v1/books/:id/chapters/:num/beats", async (c) => {
    const id = c.req.param("id");
    const chapterNum = parseInt(c.req.param("num"), 10);
    try {
      const bookDir = state.bookDir(id);
      const paddedNum = String(chapterNum).padStart(4, "0");
      const filePath = join(bookDir, "runtime", `chapter-${paddedNum}.beats.json`);
      const raw = await readFile(filePath, "utf-8");
      return c.json(JSON.parse(raw));
    } catch {
      return c.json([]);
    }
  });

  // --- Audit ---

  // --- Timeline (时间线计算器) ---

  app.get("/api/v1/books/:id/timeline", async (c) => {
    const id = c.req.param("id");
    try {
      const { loadTimeline } = await import("@actalk/inkos-core");
      const bookDir = state.bookDir(id);
      const data = await loadTimeline(bookDir);
      if (!data.bookId) data.bookId = id;
      return c.json(data);
    } catch {
      return c.json({ bookId: id, anchors: [] });
    }
  });

  app.post("/api/v1/books/:id/timeline/rebuild", async (c) => {
    const id = c.req.param("id");
    try {
      const { loadTimeline, saveTimeline, extractTimelineAnchors } = await import("@actalk/inkos-core");
      const bookDir = state.bookDir(id);
      const chaptersDir = join(bookDir, "chapters");
      const files = await readdir(chaptersDir);
      const allAnchors: Array<{ chapter: number; timeDescription: string; parsedDate?: string; charactersPresent: string[]; eventSummary: string }> = [];

      for (const file of files) {
        if (!file.endsWith(".md") || !/^\d{4}/.test(file)) continue;
        const chapterNum = parseInt(file.slice(0, 4), 10);
        const content = await readFile(join(chaptersDir, file), "utf-8");
        const anchors = extractTimelineAnchors(chapterNum, content);
        allAnchors.push(...anchors);
      }

      // Sort by chapter number
      allAnchors.sort((a, b) => a.chapter - b.chapter);

      const data = {
        bookId: id,
        anchors: allAnchors,
        lastRebuilt: new Date().toISOString(),
      };
      await saveTimeline(bookDir, data);
      return c.json(data);
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  app.get("/api/v1/books/:id/timeline/validate", async (c) => {
    const id = c.req.param("id");
    try {
      const { loadTimeline, validateTimelineConsistency } = await import("@actalk/inkos-core");
      const bookDir = state.bookDir(id);
      const data = await loadTimeline(bookDir);
      const issues = validateTimelineConsistency(data.anchors);
      return c.json({ issues });
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  app.post("/api/v1/books/:id/audit/:chapter", async (c) => {
    const id = c.req.param("id");
    const chapterNum = parseInt(c.req.param("chapter"), 10);
    const bookDir = state.bookDir(id);

    broadcast("audit:start", { bookId: id, chapter: chapterNum });
    try {
      const chaptersDir = join(bookDir, "chapters");
      const files = await readdir(chaptersDir);
      const paddedNum = String(chapterNum).padStart(4, "0");
      const match = files.find((f) => f.startsWith(paddedNum) && f.endsWith(".md"));
      if (!match) return c.json({ error: "Chapter not found" }, 404);

      const pipeline = new PipelineRunner(await buildPipelineConfig());
      const result = await pipeline.auditDraft(id, chapterNum);
      broadcast("audit:complete", { bookId: id, chapter: chapterNum, passed: result.passed });
      return c.json(result);
    } catch (e) {
      broadcast("audit:error", { bookId: id, error: String(e) });
      return c.json({ error: String(e) }, 500);
    }
  });

  // --- Revise ---

  app.post("/api/v1/books/:id/revise/:chapter", async (c) => {
    const id = c.req.param("id");
    const chapterNum = parseInt(c.req.param("chapter"), 10);
    const bookDir = state.bookDir(id);
    const body = await c.req
      .json<{ mode?: string; brief?: string }>()
      .catch(() => ({ mode: "spot-fix", brief: undefined }));

    broadcast("revise:start", { bookId: id, chapter: chapterNum });
    try {
      const book = await state.loadBookConfig(id);
      const chaptersDir = join(bookDir, "chapters");
      const files = await readdir(chaptersDir);
      const paddedNum = String(chapterNum).padStart(4, "0");
      const match = files.find((f) => f.startsWith(paddedNum) && f.endsWith(".md"));
      if (!match) return c.json({ error: "Chapter not found" }, 404);

      const pipeline = new PipelineRunner(await buildPipelineConfig({
        externalContext: body.brief,
      }));
      const normalizedMode = body.mode ?? "spot-fix";
      const result = await pipeline.reviseDraft(
        id,
        chapterNum,
        normalizedMode as "polish" | "rewrite" | "rework" | "spot-fix" | "anti-detect",
      );
      broadcast("revise:complete", { bookId: id, chapter: chapterNum });
      return c.json(result);
    } catch (e) {
      broadcast("revise:error", { bookId: id, error: String(e) });
      return c.json({ error: String(e) }, 500);
    }
  });

  // --- Format Chapter (local, no LLM) ---
  app.post("/api/v1/books/:id/format/:chapter", async (c) => {
    const id = c.req.param("id");
    const chapterNum = parseInt(c.req.param("chapter"), 10);
    const body = await c.req.json<{ preset?: string }>().catch(() => ({ preset: undefined }));
    const preset = (body.preset ?? "web-novel") as "web-novel" | "publish" | "screenplay" | "short-story";

    try {
      const bookDir = state.bookDir(id);
      const chaptersDir = join(bookDir, "chapters");
      const files = await readdir(chaptersDir);
      const paddedNum = String(chapterNum).padStart(4, "0");
      const match = files.find((f) => f.startsWith(paddedNum) && f.endsWith(".md"));
      if (!match) return c.json({ error: "Chapter not found" }, 404);

      const content = await readFile(join(chaptersDir, match), "utf-8");
      const { ReviserAgent } = await import("@actalk/inkos-core");
      const pipelineConfig = await buildPipelineConfig();
      const agent = new ReviserAgent(pipelineConfig);
      const result = agent.formatChapter(content, preset);

      // Save formatted content back
      await writeFile(join(chaptersDir, match), result.revisedContent, "utf-8");

      // Update chapter index
      const index = await state.loadChapterIndex(id);
      const updatedIndex = index.map((ch) =>
        ch.number === chapterNum ? { ...ch, wordCount: result.wordCount, updatedAt: new Date().toISOString() } : ch
      );
      await state.saveChapterIndex(id, updatedIndex);

      return c.json(result);
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  // --- Expand Chapter (uses LLM) ---
  app.post("/api/v1/books/:id/expand/:chapter", async (c) => {
    const id = c.req.param("id");
    const chapterNum = parseInt(c.req.param("chapter"), 10);

    broadcast("expand:start", { bookId: id, chapter: chapterNum });
    try {
      const bookDir = state.bookDir(id);
      const chaptersDir = join(bookDir, "chapters");
      const files = await readdir(chaptersDir);
      const paddedNum = String(chapterNum).padStart(4, "0");
      const match = files.find((f) => f.startsWith(paddedNum) && f.endsWith(".md"));
      if (!match) return c.json({ error: "Chapter not found" }, 404);

      const content = await readFile(join(chaptersDir, match), "utf-8");
      const { ReviserAgent } = await import("@actalk/inkos-core");
      const pipelineConfig = await buildPipelineConfig();
      const agent = new ReviserAgent(pipelineConfig);
      const result = await agent.expandChapter(bookDir, content, chapterNum);

      // Save expanded content back
      await writeFile(join(chaptersDir, match), result.revisedContent, "utf-8");

      // Update chapter index
      const index = await state.loadChapterIndex(id);
      const updatedIndex = index.map((ch) =>
        ch.number === chapterNum ? { ...ch, wordCount: result.wordCount, updatedAt: new Date().toISOString() } : ch
      );
      await state.saveChapterIndex(id, updatedIndex);

      broadcast("expand:complete", { bookId: id, chapter: chapterNum });
      return c.json(result);
    } catch (e) {
      broadcast("expand:error", { bookId: id, error: String(e) });
      return c.json({ error: String(e) }, 500);
    }
  });

  // --- Condense Chapter (uses LLM) ---
  app.post("/api/v1/books/:id/condense/:chapter", async (c) => {
    const id = c.req.param("id");
    const chapterNum = parseInt(c.req.param("chapter"), 10);

    broadcast("condense:start", { bookId: id, chapter: chapterNum });
    try {
      const bookDir = state.bookDir(id);
      const chaptersDir = join(bookDir, "chapters");
      const files = await readdir(chaptersDir);
      const paddedNum = String(chapterNum).padStart(4, "0");
      const match = files.find((f) => f.startsWith(paddedNum) && f.endsWith(".md"));
      if (!match) return c.json({ error: "Chapter not found" }, 404);

      const content = await readFile(join(chaptersDir, match), "utf-8");
      const { ReviserAgent } = await import("@actalk/inkos-core");
      const pipelineConfig = await buildPipelineConfig();
      const agent = new ReviserAgent(pipelineConfig);
      const result = await agent.condenseChapter(bookDir, content, chapterNum);

      // Save condensed content back
      await writeFile(join(chaptersDir, match), result.revisedContent, "utf-8");

      // Update chapter index
      const index = await state.loadChapterIndex(id);
      const updatedIndex = index.map((ch) =>
        ch.number === chapterNum ? { ...ch, wordCount: result.wordCount, updatedAt: new Date().toISOString() } : ch
      );
      await state.saveChapterIndex(id, updatedIndex);

      broadcast("condense:complete", { bookId: id, chapter: chapterNum });
      return c.json(result);
    } catch (e) {
      broadcast("condense:error", { bookId: id, error: String(e) });
      return c.json({ error: String(e) }, 500);
    }
  });

  // --- Export ---

  app.get("/api/v1/books/:id/export", async (c) => {
    const id = c.req.param("id");
    const format = (c.req.query("format") ?? "txt") as string;
    const approvedOnly = c.req.query("approvedOnly") === "true";
    try {
      const artifact = await buildExportArtifact(state, id, {
        format: format as "txt" | "md" | "epub" | "pdf",
        approvedOnly,
      });
      const responseBody = typeof artifact.payload === "string"
        ? artifact.payload
        : new Uint8Array(artifact.payload);
      return new Response(responseBody, {
        headers: {
          "Content-Type": artifact.contentType,
          "Content-Disposition": `attachment; filename="${artifact.fileName}"`,
        },
      });
    } catch {
      return c.json({ error: "Export failed" }, 500);
    }
  });

  // --- Export to file (save to project dir) ---

  app.post("/api/v1/books/:id/export-save", async (c) => {
    const id = c.req.param("id");
    const { format, approvedOnly } = await c.req.json<{ format?: string; approvedOnly?: boolean }>().catch(() => ({ format: "txt", approvedOnly: false }));
    const fmt = format ?? "txt";

    try {
      const pipeline = new PipelineRunner(await buildPipelineConfig());
      const tools = createInteractionToolsFromDeps(pipeline, state);
      const bookDir = state.bookDir(id);
      const outputPath = join(bookDir, `${id}.${fmt === "epub" ? "epub" : fmt}`);
      const result = await processProjectInteractionRequest({
        projectRoot: root,
        request: {
          intent: "export_book",
          bookId: id,
          format: fmt as "txt" | "md" | "epub" | "pdf",
          approvedOnly,
          outputPath,
        },
        tools,
        activeBookId: id,
      });
      return c.json({
        ok: true,
        path: (result.details?.outputPath as string | undefined) ?? outputPath,
        format: fmt,
        chapters: (result.details?.chaptersExported as number | undefined) ?? 0,
      });
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  // --- Volume Export (分卷打包导出) ---

  app.post("/api/v1/books/:id/export-volumes", async (c) => {
    const id = c.req.param("id");
    const body: {
      format?: string;
      approvedOnly?: boolean;
      chaptersPerVolume?: number;
      volumeNames?: string[];
    } = await c.req.json().catch(() => ({}));
    const format = body.format ?? "txt";
    const chaptersPerVolume = body.chaptersPerVolume ?? 30;

    try {
      const { writeVolumeExportArtifacts } = await import("@actalk/inkos-core");
      const bookDir = state.bookDir(id);
      const outputDir = join(bookDir, "exports");

      const results = await writeVolumeExportArtifacts(state, id, {
        format: format as "txt" | "md" | "epub" | "pdf",
        approvedOnly: body.approvedOnly,
        chaptersPerVolume,
        volumeNames: body.volumeNames,
        outputDir,
      });

      return c.json({
        ok: true,
        volumes: results.map((r) => ({
          volumeNumber: r.volumeNumber,
          volumeTitle: r.volumeTitle,
          chaptersIncluded: r.chaptersIncluded,
          startChapter: r.startChapter,
          endChapter: r.endChapter,
          totalWords: r.totalWords,
          path: r.outputPath,
        })),
        totalVolumes: results.length,
      });
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  // --- Genre detail + copy ---

  app.get("/api/v1/genres/:id", async (c) => {
    const genreId = c.req.param("id");
    try {
      const { readGenreProfile } = await import("@actalk/inkos-core");
      const { profile, body } = await readGenreProfile(root, genreId);
      return c.json({ profile, body });
    } catch (e) {
      return c.json({ error: String(e) }, 404);
    }
  });

  app.post("/api/v1/genres/:id/copy", async (c) => {
    const genreId = c.req.param("id");
    if (/[/\\\0]/.test(genreId) || genreId.includes("..")) {
      throw new ApiError(400, "INVALID_GENRE_ID", `Invalid genre ID: "${genreId}"`);
    }
    try {
      const { getBuiltinGenresDir } = await import("@actalk/inkos-core");
      const { mkdir: mkdirFs, copyFile } = await import("node:fs/promises");
      const builtinDir = getBuiltinGenresDir();
      const projectGenresDir = join(root, "genres");
      await mkdirFs(projectGenresDir, { recursive: true });
      await copyFile(join(builtinDir, `${genreId}.md`), join(projectGenresDir, `${genreId}.md`));
      return c.json({ ok: true, path: `genres/${genreId}.md` });
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  // --- Model overrides ---

  app.get("/api/v1/project/model-overrides", async (c) => {
    const raw = JSON.parse(await readFile(join(root, "inkos.json"), "utf-8"));
    return c.json({ overrides: normalizeModelOverrides(raw.modelOverrides ?? {}) });
  });

  app.put("/api/v1/project/model-overrides", async (c) => {
    const { overrides } = await c.req.json<{ overrides: Record<string, unknown> }>();
    const configPath = join(root, "inkos.json");
    const raw = JSON.parse(await readFile(configPath, "utf-8"));
    raw.modelOverrides = normalizeModelOverrides(overrides);
    const { writeFile: writeFileFs } = await import("node:fs/promises");
    await writeFileFs(configPath, JSON.stringify(raw, null, 2), "utf-8");
    return c.json({ ok: true });
  });

  // --- Chapter review mode (C4a: auto pipeline vs manual checkpoint) ---

  app.get("/api/v1/project/chapter-review-mode", async (c) => {
    const raw = JSON.parse(await readFile(join(root, "inkos.json"), "utf-8"));
    return c.json({ mode: raw.writing?.reviewMode === "manual" ? "manual" : "auto" });
  });

  app.put("/api/v1/project/chapter-review-mode", async (c) => {
    const { mode } = await c.req.json<{ mode?: string }>();
    const next = mode === "manual" ? "manual" : "auto";
    const configPath = join(root, "inkos.json");
    const raw = JSON.parse(await readFile(configPath, "utf-8"));
    raw.writing = { ...(raw.writing ?? {}), reviewMode: next };
    const { writeFile: writeFileFs } = await import("node:fs/promises");
    await writeFileFs(configPath, JSON.stringify(raw, null, 2), "utf-8");
    return c.json({ ok: true, mode: next });
  });

  // --- Notify channels ---

  app.get("/api/v1/project/notify", async (c) => {
    const raw = JSON.parse(await readFile(join(root, "inkos.json"), "utf-8"));
    return c.json({ channels: raw.notify ?? [] });
  });

  app.put("/api/v1/project/notify", async (c) => {
    const { channels } = await c.req.json<{ channels: unknown[] }>();
    const configPath = join(root, "inkos.json");
    const raw = JSON.parse(await readFile(configPath, "utf-8"));
    raw.notify = channels;
    const { writeFile: writeFileFs } = await import("node:fs/promises");
    await writeFileFs(configPath, JSON.stringify(raw, null, 2), "utf-8");
    return c.json({ ok: true });
  });

  // --- AIGC Detection ---

  app.post("/api/v1/books/:id/detect/:chapter", async (c) => {
    const id = c.req.param("id");
    const chapterNum = parseInt(c.req.param("chapter"), 10);
    const bookDir = state.bookDir(id);

    try {
      const chaptersDir = join(bookDir, "chapters");
      const files = await readdir(chaptersDir);
      const paddedNum = String(chapterNum).padStart(4, "0");
      const match = files.find((f) => f.startsWith(paddedNum) && f.endsWith(".md"));
      if (!match) return c.json({ error: "Chapter not found" }, 404);

      const content = await readFile(join(chaptersDir, match), "utf-8");
      const { analyzeAITells } = await import("@actalk/inkos-core");
      const result = analyzeAITells(content);
      return c.json({ chapterNumber: chapterNum, ...result });
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  // --- Truth file edit ---

  app.put("/api/v1/books/:id/truth/:file{.+}", async (c) => {
    const id = c.req.param("id");
    const file = c.req.param("file");
    const bookDir = state.bookDir(id);
    const resolved = resolveTruthFilePath(bookDir, file);
    if (!resolved) {
      return c.json({ error: "Invalid truth file" }, 400);
    }
    // Legacy pointer shims are read-only in new-layout books: writing
    // story_bible.md or book_rules.md does nothing at runtime (the pipeline
    // reads outline/ instead). For pre-Phase-5 books these ARE authoritative.
    if (LEGACY_SHIM_FILES.has(file)) {
      const { isNewLayoutBook } = await import("@actalk/inkos-core");
      if (await isNewLayoutBook(bookDir)) {
        return c.json(
          { error: "Legacy compat shim; edit outline/story_frame.md instead" },
          400,
        );
      }
    }
    if (RUNTIME_DIAGNOSTIC_FILE_RE.test(file)) {
      return c.json({ error: "Runtime diagnostic files are read-only" }, 400);
    }
    if (RUNTIME_STATE_FILE_RE.test(file)) {
      return c.json({ error: "Runtime state files are read-only" }, 400);
    }
    const { content } = await c.req.json<{ content: string }>();
    const { writeFile: writeFileFs, mkdir: mkdirFs } = await import("node:fs/promises");
    const { dirname: dirnameFs } = await import("node:path");
    await mkdirFs(dirnameFs(resolved), { recursive: true });
    await writeFileFs(resolved, content, "utf-8");
    return c.json({ ok: true });
  });

  // =============================================
  // NEW ENDPOINTS — CLI parity
  // =============================================

  // --- Book Delete ---

  app.delete("/api/v1/books/:id", async (c) => {
    const id = c.req.param("id");
    const bookDir = state.bookDir(id);
    try {
      const { rm } = await import("node:fs/promises");
      await rm(bookDir, { recursive: true, force: true });
      broadcast("book:deleted", { bookId: id });
      return c.json({ ok: true, bookId: id });
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  // --- Book Update ---

  app.put("/api/v1/books/:id", async (c) => {
    const id = c.req.param("id");
    const updates = await c.req.json<{
      chapterWordCount?: number;
      targetChapters?: number;
      status?: string;
      language?: string;
    }>();
    try {
      const book = await state.loadBookConfig(id);
      const updated = {
        ...book,
        ...(updates.chapterWordCount !== undefined ? { chapterWordCount: Number(updates.chapterWordCount) } : {}),
        ...(updates.targetChapters !== undefined ? { targetChapters: Number(updates.targetChapters) } : {}),
        ...(updates.status !== undefined ? { status: updates.status as typeof book.status } : {}),
        ...(updates.language !== undefined ? { language: updates.language as "zh" | "en" } : {}),
        updatedAt: new Date().toISOString(),
      };
      await state.saveBookConfig(id, updated);
      return c.json({ ok: true, book: updated });
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  // --- Write Rewrite (specific chapter) ---

  app.post("/api/v1/books/:id/rewrite/:chapter", async (c) => {
    const id = c.req.param("id");
    const chapterNum = parseInt(c.req.param("chapter"), 10);
    const body: { brief?: string } = await c.req
      .json<{ brief?: string }>()
      .catch(() => ({}));

    broadcast("rewrite:start", { bookId: id, chapter: chapterNum });
    try {
      const rollbackTarget = chapterNum - 1;
      const discarded = await state.rollbackToChapter(id, rollbackTarget);
      const pipeline = new PipelineRunner(await buildPipelineConfig({
        externalContext: body.brief,
      }));
      pipeline.writeNextChapter(id).then(
        (result) => broadcast("rewrite:complete", { bookId: id, chapterNumber: result.chapterNumber, title: result.title, wordCount: result.wordCount }),
        (e) => broadcast("rewrite:error", { bookId: id, error: e instanceof Error ? e.message : String(e) }),
      );
      return c.json({ status: "rewriting", bookId: id, chapter: chapterNum, rolledBackTo: rollbackTarget, discarded });
    } catch (e) {
      broadcast("rewrite:error", { bookId: id, error: String(e) });
      return c.json({ error: String(e) }, 500);
    }
  });

  app.post("/api/v1/books/:id/resync/:chapter", async (c) => {
    const id = c.req.param("id");
    const chapterNum = parseInt(c.req.param("chapter"), 10);
    const body: { brief?: string } = await c.req
      .json<{ brief?: string }>()
      .catch(() => ({}));

    try {
      const pipeline = new PipelineRunner(await buildPipelineConfig({
        externalContext: body.brief,
      }));
      const result = await pipeline.resyncChapterArtifacts(id, chapterNum);
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

  // --- Genre Create ---

  app.post("/api/v1/genres/create", async (c) => {
    const body = await c.req.json<{
      id: string; name: string; language?: string;
      chapterTypes?: string[]; fatigueWords?: string[];
      numericalSystem?: boolean; powerScaling?: boolean; eraResearch?: boolean;
      pacingRule?: string; satisfactionTypes?: string[]; auditDimensions?: number[];
      body?: string;
    }>();

    if (!body.id || !body.name) {
      return c.json({ error: "id and name are required" }, 400);
    }
    if (/[/\\\0]/.test(body.id) || body.id.includes("..")) {
      throw new ApiError(400, "INVALID_GENRE_ID", `Invalid genre ID: "${body.id}"`);
    }

    const { writeFile: writeFileFs, mkdir: mkdirFs } = await import("node:fs/promises");
    const genresDir = join(root, "genres");
    await mkdirFs(genresDir, { recursive: true });

    const frontmatter = [
      "---",
      `name: ${yamlScalar(body.name)}`,
      `id: ${yamlScalar(body.id)}`,
      `language: ${yamlScalar(body.language ?? "zh")}`,
      `chapterTypes: ${JSON.stringify(body.chapterTypes ?? [])}`,
      `fatigueWords: ${JSON.stringify(body.fatigueWords ?? [])}`,
      `numericalSystem: ${body.numericalSystem ?? false}`,
      `powerScaling: ${body.powerScaling ?? false}`,
      `eraResearch: ${body.eraResearch ?? false}`,
      `pacingRule: ${yamlScalar(body.pacingRule ?? "")}`,
      `satisfactionTypes: ${JSON.stringify(body.satisfactionTypes ?? [])}`,
      `auditDimensions: ${JSON.stringify(body.auditDimensions ?? [])}`,
      "---",
      "",
      body.body ?? "",
    ].join("\n");

    await writeFileFs(join(genresDir, `${body.id}.md`), frontmatter, "utf-8");
    return c.json({ ok: true, id: body.id });
  });

  // --- Genre Edit ---

  app.put("/api/v1/genres/:id", async (c) => {
    const genreId = c.req.param("id");
    if (/[/\\\0]/.test(genreId) || genreId.includes("..")) {
      throw new ApiError(400, "INVALID_GENRE_ID", `Invalid genre ID: "${genreId}"`);
    }

    const body = await c.req.json<{ profile: Record<string, unknown>; body: string }>();
    const { writeFile: writeFileFs, mkdir: mkdirFs } = await import("node:fs/promises");
    const genresDir = join(root, "genres");
    await mkdirFs(genresDir, { recursive: true });

    const p = body.profile;
    const frontmatter = [
      "---",
      `name: ${yamlScalar(p.name ?? genreId)}`,
      `id: ${yamlScalar(p.id ?? genreId)}`,
      `language: ${yamlScalar(p.language ?? "zh")}`,
      `chapterTypes: ${JSON.stringify(p.chapterTypes ?? [])}`,
      `fatigueWords: ${JSON.stringify(p.fatigueWords ?? [])}`,
      `numericalSystem: ${p.numericalSystem ?? false}`,
      `powerScaling: ${p.powerScaling ?? false}`,
      `eraResearch: ${p.eraResearch ?? false}`,
      `pacingRule: ${yamlScalar(p.pacingRule ?? "")}`,
      `satisfactionTypes: ${JSON.stringify(p.satisfactionTypes ?? [])}`,
      `auditDimensions: ${JSON.stringify(p.auditDimensions ?? [])}`,
      "---",
      "",
      body.body ?? "",
    ].join("\n");

    await writeFileFs(join(genresDir, `${genreId}.md`), frontmatter, "utf-8");
    return c.json({ ok: true, id: genreId });
  });

  // --- Genre Delete (project-level only) ---

  app.delete("/api/v1/genres/:id", async (c) => {
    const genreId = c.req.param("id");
    if (/[/\\\0]/.test(genreId) || genreId.includes("..")) {
      throw new ApiError(400, "INVALID_GENRE_ID", `Invalid genre ID: "${genreId}"`);
    }

    const filePath = join(root, "genres", `${genreId}.md`);
    try {
      const { rm } = await import("node:fs/promises");
      await rm(filePath);
      return c.json({ ok: true, id: genreId });
    } catch (e) {
      return c.json({ error: `Genre "${genreId}" not found in project` }, 404);
    }
  });

  // --- Style Analyze ---

  app.post("/api/v1/style/analyze", async (c) => {
    const { text, sourceName } = await c.req.json<{ text: string; sourceName: string }>();
    if (!text?.trim()) return c.json({ error: "text is required" }, 400);

    try {
      const { analyzeStyle } = await import("@actalk/inkos-core");
      const profile = analyzeStyle(text, sourceName ?? "unknown");
      return c.json(profile);
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  // --- Style Import to Book ---

  app.post("/api/v1/books/:id/style/import", async (c) => {
    const id = c.req.param("id");
    const { text, sourceName } = await c.req.json<{ text: string; sourceName: string }>();
    if (!text?.trim()) return c.json({ error: "text is required" }, 400);

    broadcast("style:start", { bookId: id });
    try {
      const pipeline = new PipelineRunner(await buildPipelineConfig());
      const result = await pipeline.generateStyleGuide(id, text, sourceName ?? "unknown");
      broadcast("style:complete", { bookId: id });
      return c.json({ ok: true, result });
    } catch (e) {
      broadcast("style:error", { bookId: id, error: String(e) });
      return c.json({ error: String(e) }, 500);
    }
  });

  // --- Import Chapters ---

  app.post("/api/v1/books/:id/import/chapters", async (c) => {
    const id = c.req.param("id");
    const { text, splitRegex } = await c.req.json<{ text: string; splitRegex?: string }>();
    if (!text?.trim()) return c.json({ error: "text is required" }, 400);

    broadcast("import:start", { bookId: id, type: "chapters" });
    try {
      const { splitChapters } = await import("@actalk/inkos-core");
      const chapters = [...splitChapters(text, splitRegex)];

      const pipeline = new PipelineRunner(await buildPipelineConfig());
      const result = await pipeline.importChapters({ bookId: id, chapters });
      broadcast("import:complete", { bookId: id, type: "chapters", count: result.importedCount });
      return c.json(result);
    } catch (e) {
      broadcast("import:error", { bookId: id, error: String(e) });
      return c.json({ error: String(e) }, 500);
    }
  });

  // --- Import Canon ---

  app.post("/api/v1/books/:id/import/canon", async (c) => {
    const id = c.req.param("id");
    const { fromBookId } = await c.req.json<{ fromBookId: string }>();
    if (!fromBookId) return c.json({ error: "fromBookId is required" }, 400);

    broadcast("import:start", { bookId: id, type: "canon" });
    try {
      const pipeline = new PipelineRunner(await buildPipelineConfig());
      await pipeline.importCanon(id, fromBookId);
      broadcast("import:complete", { bookId: id, type: "canon" });
      return c.json({ ok: true });
    } catch (e) {
      broadcast("import:error", { bookId: id, error: String(e) });
      return c.json({ error: String(e) }, 500);
    }
  });

  // --- Fanfic Init ---

  app.post("/api/v1/fanfic/init", async (c) => {
    const body = await c.req.json<{
      title: string; sourceText: string; sourceName?: string;
      mode?: string; genre?: string; platform?: string;
      targetChapters?: number; chapterWordCount?: number; language?: string;
    }>();
    if (!body.title || !body.sourceText) {
      return c.json({ error: "title and sourceText are required" }, 400);
    }

    const now = new Date().toISOString();
    const bookId = body.title.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, "-").replace(/-+/g, "-").slice(0, 30);

    const bookConfig = {
      id: bookId,
      title: body.title,
      platform: (body.platform ?? "other") as "other",
      genre: (body.genre ?? "other") as "xuanhuan",
      status: "outlining" as const,
      targetChapters: body.targetChapters ?? 100,
      chapterWordCount: body.chapterWordCount ?? 3000,
      fanficMode: (body.mode ?? "canon") as "canon",
      ...(body.language ? { language: body.language as "zh" | "en" } : {}),
      createdAt: now,
      updatedAt: now,
    };

    broadcast("fanfic:start", { bookId, title: body.title });
    try {
      const pipeline = new PipelineRunner(await buildPipelineConfig());
      await pipeline.initFanficBook(bookConfig, body.sourceText, body.sourceName ?? "source", (body.mode ?? "canon") as "canon");
      broadcast("fanfic:complete", { bookId });
      return c.json({ ok: true, bookId });
    } catch (e) {
      broadcast("fanfic:error", { bookId, error: String(e) });
      return c.json({ error: String(e) }, 500);
    }
  });

  // --- Fanfic Show (read canon) ---

  app.get("/api/v1/books/:id/fanfic", async (c) => {
    const id = c.req.param("id");
    const bookDir = state.bookDir(id);
    try {
      const content = await readFile(join(bookDir, "story", "fanfic_canon.md"), "utf-8");
      return c.json({ bookId: id, content });
    } catch {
      return c.json({ bookId: id, content: null });
    }
  });

  // --- Fanfic Refresh ---

  app.post("/api/v1/books/:id/fanfic/refresh", async (c) => {
    const id = c.req.param("id");
    const { sourceText, sourceName } = await c.req.json<{ sourceText: string; sourceName?: string }>();
    if (!sourceText?.trim()) return c.json({ error: "sourceText is required" }, 400);

    broadcast("fanfic:refresh:start", { bookId: id });
    try {
      const book = await state.loadBookConfig(id);
      const pipeline = new PipelineRunner(await buildPipelineConfig());
      await pipeline.importFanficCanon(id, sourceText, sourceName ?? "source", (book.fanficMode ?? "canon") as "canon");
      broadcast("fanfic:refresh:complete", { bookId: id });
      return c.json({ ok: true });
    } catch (e) {
      broadcast("fanfic:refresh:error", { bookId: id, error: String(e) });
      return c.json({ error: String(e) }, 500);
    }
  });

  // --- Side-story (番外) init: companion book inheriting a parent's canon ---

  app.post("/api/v1/spinoff/init", async (c) => {
    const body = await c.req.json<{
      title: string; parentBookId: string; direction?: string;
      genre?: string; platform?: string;
      targetChapters?: number; chapterWordCount?: number; language?: string;
    }>();
    if (!body.title?.trim() || !body.parentBookId?.trim()) {
      return c.json({ error: "title and parentBookId are required" }, 400);
    }
    let parent;
    try {
      parent = await state.loadBookConfig(body.parentBookId);
    } catch {
      return c.json({ error: `Parent book "${body.parentBookId}" not found` }, 404);
    }
    const language = (body.language ?? parent.language) as "zh" | "en" | undefined;
    const now = new Date().toISOString();
    const bookConfig = buildStudioBookConfig({
      title: body.title,
      genre: body.genre ?? parent.genre ?? "other",
      platform: body.platform ?? parent.platform,
      targetChapters: body.targetChapters ?? parent.targetChapters,
      chapterWordCount: body.chapterWordCount ?? parent.chapterWordCount,
      ...(language ? { language } : {}),
    }, now);
    const bookId = bookConfig.id;
    if (!bookId) {
      return c.json({ error: "Could not derive a valid book id from title" }, 400);
    }
    if (await completeBookExists(state.bookDir(bookId))) {
      return c.json({ error: `Book "${bookId}" already exists` }, 409);
    }
    broadcast("spinoff:start", { bookId, title: body.title, parentBookId: body.parentBookId });
    bookCreateStatus.set(bookId, { status: "creating" });
    void (async () => {
      try {
        const pipeline = new PipelineRunner(await buildPipelineConfig());
        await pipeline.initSpinoffBook(bookConfig, body.parentBookId, body.direction);
        const book = await loadStudioBookListSummary(state, bookId).catch(() => undefined);
        bookCreateStatus.delete(bookId);
        broadcast("spinoff:complete", { bookId });
        broadcast("book:created", { bookId, ...(book ? { book } : {}) });
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        bookCreateStatus.set(bookId, { status: "error", error });
        broadcast("spinoff:error", { bookId, error });
        broadcast("book:error", { bookId, error });
      }
    })();
    return c.json({ status: "creating", bookId });
  });

  // --- Imitation (仿写) init: original story imitating a reference work's style ---

  app.post("/api/v1/imitation/init", async (c) => {
    const body = await c.req.json<{
      title: string; referenceText: string; storyIdea: string; sourceName?: string;
      genre?: string; platform?: string;
      targetChapters?: number; chapterWordCount?: number; language?: string;
    }>();
    if (!body.title?.trim() || !body.referenceText?.trim() || !body.storyIdea?.trim()) {
      return c.json({ error: "title, referenceText and storyIdea are required" }, 400);
    }
    const now = new Date().toISOString();
    const bookConfig = buildStudioBookConfig({
      title: body.title,
      genre: body.genre ?? "other",
      platform: body.platform,
      targetChapters: body.targetChapters,
      chapterWordCount: body.chapterWordCount,
      ...(body.language ? { language: body.language as "zh" | "en" } : {}),
    }, now);
    const bookId = bookConfig.id;
    if (!bookId) {
      return c.json({ error: "Could not derive a valid book id from title" }, 400);
    }
    if (await completeBookExists(state.bookDir(bookId))) {
      return c.json({ error: `Book "${bookId}" already exists` }, 409);
    }
    broadcast("imitation:start", { bookId, title: body.title });
    bookCreateStatus.set(bookId, { status: "creating" });
    void (async () => {
      try {
        const pipeline = new PipelineRunner(await buildPipelineConfig());
        await pipeline.initImitationBook(bookConfig, body.referenceText, body.storyIdea, body.sourceName);
        const book = await loadStudioBookListSummary(state, bookId).catch(() => undefined);
        bookCreateStatus.delete(bookId);
        broadcast("imitation:complete", { bookId });
        broadcast("book:created", { bookId, ...(book ? { book } : {}) });
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        bookCreateStatus.set(bookId, { status: "error", error });
        broadcast("imitation:error", { bookId, error });
        broadcast("book:error", { bookId, error });
      }
    })();
    return c.json({ status: "creating", bookId });
  });

  // --- Radar Scan ---

  app.post("/api/v1/radar/scan", async (c) => {
    broadcast("radar:start", {});
    try {
      const pipeline = new PipelineRunner(await buildPipelineConfig());
      const result = await pipeline.runRadar();
      await saveRadarScan(root, result);
      broadcast("radar:complete", { result });
      return c.json(result);
    } catch (e) {
      broadcast("radar:error", { error: String(e) });
      return c.json({ error: String(e) }, 500);
    }
  });

  app.get("/api/v1/radar/history", async (c) => {
    try {
      const items = await loadRadarHistory(root);
      return c.json({ items });
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  // --- Doctor (environment health check) ---

  app.get("/api/v1/doctor", async (c) => {
    const { existsSync } = await import("node:fs");
    await ensureDefaultGlobalEnv();

    const checks = {
      inkosJson: existsSync(join(root, "inkos.json")),
      projectEnv: existsSync(join(root, ".env")),
      globalEnv: existsSync(GLOBAL_ENV_PATH),
      booksDir: existsSync(join(root, "books")),
      llmConnected: false,
      bookCount: 0,
    };

    try {
      const books = await state.listBooks();
      checks.bookCount = books.length;
    } catch { /* ignore */ }

    try {
      const currentConfig = await loadCurrentProjectConfig({ requireApiKey: false });
      const service = currentConfig.llm.service ?? currentConfig.llm.provider;
      // Hard overall budget so the diagnostics page never hangs on a slow /
      // rate-limited upstream — if we can't confirm connectivity quickly, report
      // it as not-connected rather than spinning.
      const probe = await withTimeout(
        probeServiceCapabilities({
          root,
          service,
          apiKey: currentConfig.llm.apiKey,
          baseUrl: currentConfig.llm.baseUrl,
          preferredApiFormat: currentConfig.llm.apiFormat,
          preferredStream: currentConfig.llm.stream,
          preferredModel: currentConfig.llm.model,
          proxyUrl: currentConfig.llm.proxyUrl,
        }),
        DOCTOR_LLM_PROBE_BUDGET_MS,
        "doctor llm probe",
      );
      checks.llmConnected = probe.ok;
    } catch { /* slow/unreachable upstream — leave llmConnected false */ }

    return c.json(checks);
  });

  return app;
}

// --- Standalone runner ---

export async function startStudioServer(
  root: string,
  port = 4567,
  options?: { readonly staticDir?: string },
): Promise<void> {
  await initializeStudioProject(root);
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
      const indexHtml = await readFileFs(indexPath, "utf-8");
      app.get("*", (c) => {
        if (c.req.path.startsWith("/api/v1/")) return c.notFound();
        return c.html(indexHtml);
      });
    }
  }

  console.log(`InkOS Studio running on http://localhost:${port}`);
  serve({ fetch: app.fetch, port });
}
