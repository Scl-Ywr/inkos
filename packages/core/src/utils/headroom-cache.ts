import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { LLMMessage, LLMResponse } from "../llm/provider.js";
import {
  INKOS_PROMPT_CACHE_POLICY,
  headroomLightCompress,
  normalizePromptForCache,
  type HeadroomLightMode,
} from "./prompt-optimizer.js";
import {
  compressWithOfficialHeadroom,
  getOfficialHeadroomStatus,
  retrieveFromOfficialHeadroom,
} from "./official-headroom.js";

const requireForSqlite = createRequire(import.meta.url);
const VECTOR_DIMS = 384;
const CACHE_MAINTENANCE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const OFFICIAL_OPTIMIZATION_SERVICE_ID = "official-optimization";
const HEADROOM_SECRET_KEY = `${OFFICIAL_OPTIMIZATION_SERVICE_ID}:headroom`;
const EMBEDDING_SECRET_KEY = `${OFFICIAL_OPTIMIZATION_SERVICE_ID}:embedding`;

interface CacheEntry {
  readonly key: string;
  readonly worldKey: string;
  readonly vector: Int8Array;
  readonly response: LLMResponse;
  readonly createdAt: number;
  lastAccessedAt: number;
  hits: number;
}

interface DiskCacheRow {
  cache_key: string;
  model: string;
  service: string;
  world_key: string;
  vector: number[];
  response_json: string;
  created_at: number;
  last_accessed_at: number;
  hits: number;
}

const l1 = new Map<string, CacheEntry>();
const validatedCacheRoots = new Set<string>();
const lastCacheMaintenanceAt = new Map<string, number>();

export interface HeadroomSavingsTelemetry {
  readonly semanticL1Hits: number;
  readonly semanticL2Hits: number;
  readonly semanticMisses: number;
  readonly cacheSkippedCalls: number;
  readonly ccrBlocksCompressed: number;
  readonly originalChars: number;
  readonly optimizedChars: number;
  readonly estimatedTokensSaved: number;
  readonly pipeline?: ReadonlyArray<TokenOptimizationEvent>;
  readonly lastEvent?: {
    readonly kind: "semantic-l1-hit" | "semantic-l2-hit" | "semantic-miss" | "ccr-compress";
    readonly originalChars?: number;
    readonly optimizedChars?: number;
    readonly estimatedTokensSaved?: number;
    readonly similarity?: number;
    readonly at: number;
  };
}

export type TokenOptimizationEventKind =
  | "standardized"
  | "compressed"
  | "headroom-official"
  | "headroom-fallback"
  | "embedding-external"
  | "embedding-fallback"
  | "compression-skipped"
  | "cache-check"
  | "cache-hit"
  | "cache-miss"
  | "llm-call"
  | "cache-write"
  | "cache-maintenance"
  | "cache-skip";

export interface TokenOptimizationEvent {
  readonly kind: TokenOptimizationEventKind;
  readonly label: string;
  readonly originalChars?: number;
  readonly optimizedChars?: number;
  readonly estimatedTokensSaved?: number;
  readonly similarity?: number;
  readonly at: number;
}

export interface TokenOptimizationReport {
  readonly messages: LLMMessage[];
  readonly events: ReadonlyArray<TokenOptimizationEvent>;
  readonly originalChars: number;
  readonly optimizedChars: number;
  readonly estimatedTokensSaved: number;
}

const telemetry: {
  semanticL1Hits: number;
  semanticL2Hits: number;
  semanticMisses: number;
  cacheSkippedCalls: number;
  ccrBlocksCompressed: number;
  originalChars: number;
  optimizedChars: number;
  estimatedTokensSaved: number;
  pipeline: TokenOptimizationEvent[];
  lastEvent?: HeadroomSavingsTelemetry["lastEvent"];
} = {
  semanticL1Hits: 0,
  semanticL2Hits: 0,
  semanticMisses: 0,
  cacheSkippedCalls: 0,
  ccrBlocksCompressed: 0,
  originalChars: 0,
  optimizedChars: 0,
  estimatedTokensSaved: 0,
  pipeline: [],
};

export interface HeadroomCacheContext {
  readonly projectRoot: string;
  readonly bookId?: string;
  readonly model: string;
  readonly service?: string;
  readonly variant?: string;
}

export interface SemanticCacheStorageStatus {
  readonly sqliteAvailable: boolean;
  readonly path: string;
  readonly fallbackPath: string;
  readonly error?: string;
}

export interface EmbeddingDiagnostics {
  readonly configured: boolean;
  readonly endpoint: string | null;
  readonly model: string;
  readonly lastExternalOk: boolean | null;
  readonly lastExternalAt: number | null;
  readonly lastFallbackAt: number | null;
  readonly lastError: string | null;
}

export interface SemanticCacheStats {
  readonly storage: SemanticCacheStorageStatus;
  readonly l1Entries: number;
  readonly l1Limit: number;
  readonly rowCount: number;
  readonly dbBytes: number;
  readonly fallbackRows: number;
  readonly fallbackBytes: number;
  readonly l3ArchiveBytes: number;
  readonly hitRate: number;
  readonly lastMaintenanceAt: number | null;
}

export interface SemanticCacheMaintenanceResult {
  readonly ok: boolean;
  readonly storage: SemanticCacheStorageStatus;
  readonly removedRows: number;
  readonly archivedRows: number;
  readonly checkpointed: boolean;
  readonly vacuumed: boolean;
  readonly error?: string;
  readonly stats: SemanticCacheStats;
}

export interface TokenDiagnostics {
  readonly headroom: ReturnType<typeof getOfficialHeadroomStatus>;
  readonly embedding: EmbeddingDiagnostics;
  readonly telemetry: HeadroomSavingsTelemetry;
  readonly semanticCache: SemanticCacheStats;
}

export interface OfficialOptimizationRuntimeConfig {
  readonly applied: boolean;
  readonly headroomConfigured: boolean;
  readonly embeddingConfigured: boolean;
}

const embeddingDiagnostics: {
  lastExternalOk: boolean | null;
  lastExternalAt: number | null;
  lastFallbackAt: number | null;
  lastError: string | null;
} = {
  lastExternalOk: null,
  lastExternalAt: null,
  lastFallbackAt: null,
  lastError: null,
};

export function alignMessagesForCache(messages: ReadonlyArray<LLMMessage>): LLMMessage[] {
  return messages.map((message) => ({
    ...message,
    content: normalizePromptForCache(message.content),
  }));
}

function readJsonObject(path: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function numberStringValue(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? String(Math.round(value))
    : typeof value === "string" && value.trim()
      ? value.trim()
      : "";
}

export function applyOfficialOptimizationConfig(projectRoot: string): OfficialOptimizationRuntimeConfig {
  const config = readJsonObject(join(projectRoot, "inkos.json"));
  const llm = config?.llm && typeof config.llm === "object" && !Array.isArray(config.llm)
    ? config.llm as Record<string, unknown>
    : {};
  const services = Array.isArray(llm.services) ? llm.services : [];
  const official = services.find((entry): entry is Record<string, unknown> =>
    Boolean(entry)
    && typeof entry === "object"
    && !Array.isArray(entry)
    && entry.service === OFFICIAL_OPTIMIZATION_SERVICE_ID,
  );
  const headroom = official?.headroom && typeof official.headroom === "object" && !Array.isArray(official.headroom)
    ? official.headroom as Record<string, unknown>
    : {};
  const embedding = official?.embedding && typeof official.embedding === "object" && !Array.isArray(official.embedding)
    ? official.embedding as Record<string, unknown>
    : {};
  const secrets = readJsonObject(join(projectRoot, ".inkos", "secrets.json"));
  const secretServices = secrets?.services && typeof secrets.services === "object" && !Array.isArray(secrets.services)
    ? secrets.services as Record<string, unknown>
    : {};
  const headroomSecret = secretServices[HEADROOM_SECRET_KEY] && typeof secretServices[HEADROOM_SECRET_KEY] === "object"
    ? secretServices[HEADROOM_SECRET_KEY] as Record<string, unknown>
    : {};
  const embeddingSecret = secretServices[EMBEDDING_SECRET_KEY] && typeof secretServices[EMBEDDING_SECRET_KEY] === "object"
    ? secretServices[EMBEDDING_SECRET_KEY] as Record<string, unknown>
    : {};

  const headroomEnabled = headroom.enabled === true;
  const headroomBaseUrl = stringValue(headroom.baseUrl);
  const headroomApiKey = stringValue(headroomSecret.apiKey);
  if (official) {
    delete process.env.HEADROOM_BASE_URL;
    delete process.env.HEADROOM_API_KEY;
    delete process.env.INKOS_HEADROOM_OFFICIAL;
    delete process.env.INKOS_HEADROOM_TIMEOUT_MS;
  }
  if (headroomEnabled && headroomBaseUrl) process.env.HEADROOM_BASE_URL = headroomBaseUrl;
  if (headroomEnabled && headroomApiKey) process.env.HEADROOM_API_KEY = headroomApiKey;
  const headroomTimeout = numberStringValue(headroom.timeoutMs);
  if (headroomEnabled && headroomTimeout) process.env.INKOS_HEADROOM_TIMEOUT_MS = headroomTimeout;
  if (headroomEnabled) process.env.INKOS_HEADROOM_OFFICIAL = "1";

  const embeddingEnabled = embedding.enabled === true;
  const embeddingEndpoint = stringValue(embedding.endpoint);
  const embeddingApiKey = stringValue(embeddingSecret.apiKey);
  const embeddingModel = stringValue(embedding.model);
  if (official) {
    delete process.env.INKOS_EMBEDDING_ENDPOINT;
    delete process.env.INKOS_EMBEDDING_API_KEY;
    delete process.env.INKOS_EMBEDDING_MODEL;
    delete process.env.INKOS_EMBEDDING_TIMEOUT_MS;
  }
  if (embeddingEnabled && embeddingEndpoint) process.env.INKOS_EMBEDDING_ENDPOINT = embeddingEndpoint;
  if (embeddingEnabled && embeddingApiKey) process.env.INKOS_EMBEDDING_API_KEY = embeddingApiKey;
  if (embeddingEnabled && embeddingModel) process.env.INKOS_EMBEDDING_MODEL = embeddingModel;
  const embeddingTimeout = numberStringValue(embedding.timeoutMs);
  if (embeddingEnabled && embeddingTimeout) process.env.INKOS_EMBEDDING_TIMEOUT_MS = embeddingTimeout;

  return {
    applied: Boolean(official),
    headroomConfigured: headroomEnabled && Boolean(headroomBaseUrl),
    embeddingConfigured: embeddingEnabled && Boolean(embeddingEndpoint),
  };
}

export function optimizeMessagesForTokenPipeline(
  messages: ReadonlyArray<LLMMessage>,
  options?: {
    readonly compress?: boolean;
    readonly preserveLastUserMessage?: boolean;
    readonly minCompressChars?: number;
  },
): TokenOptimizationReport {
  const compress = options?.compress ?? true;
  const preserveLastUserMessage = options?.preserveLastUserMessage ?? true;
  const minCompressChars = options?.minCompressChars ?? 600;
  const lastUserIndex = preserveLastUserMessage
    ? findLastIndex(messages, (message) => message.role === "user")
    : -1;
  const events: TokenOptimizationEvent[] = [];
  let originalChars = 0;
  let optimizedChars = 0;

  const optimizedMessages = messages.map((message, index) => {
    const normalized = normalizePromptForCache(message.content);
    originalChars += message.content.length;
    events.push({
      kind: "standardized",
      label: `Prompt 标准化：${message.role}`,
      originalChars: message.content.length,
      optimizedChars: normalized.length,
      estimatedTokensSaved: estimateTokenSavingsFromTexts(message.content, normalized),
      at: Date.now(),
    });

    if (!compress || index === lastUserIndex || normalized.length < minCompressChars) {
      optimizedChars += normalized.length;
      events.push({
        kind: "compression-skipped",
        label: index === lastUserIndex ? "保留当前用户指令原文" : "内容较短，无需压缩",
        originalChars: normalized.length,
        optimizedChars: normalized.length,
        estimatedTokensSaved: 0,
        at: Date.now(),
      });
      return { ...message, content: normalized };
    }

    const mode = inferCompressionMode(message, normalized);
    const compressed = headroomLightCompress(normalized, mode);
    const finalContent = compressed.length < normalized.length ? compressed : normalized;
    optimizedChars += finalContent.length;
    if (finalContent.length < normalized.length) {
      const estimatedTokensSaved = estimateTokenSavingsFromTexts(normalized, finalContent);
      events.push({
        kind: "compressed",
        label: `Headroom 压缩：${mode}`,
        originalChars: normalized.length,
        optimizedChars: finalContent.length,
        estimatedTokensSaved,
        at: Date.now(),
      });
      recordCompression(normalized.length, finalContent.length, estimatedTokensSaved);
    } else {
      events.push({
        kind: "compression-skipped",
        label: "压缩收益不足，保留标准化文本",
        originalChars: normalized.length,
        optimizedChars: normalized.length,
        estimatedTokensSaved: 0,
        at: Date.now(),
      });
    }
    return { ...message, content: finalContent };
  });

  const estimatedTokensSaved = estimateTokenSavingsFromMessages(messages, optimizedMessages);
  recordPipelineEvents(events);
  return { messages: optimizedMessages, events, originalChars, optimizedChars, estimatedTokensSaved };
}

export async function optimizeMessagesForTokenPipelineAsync(
  messages: ReadonlyArray<LLMMessage>,
  options?: {
    readonly model?: string;
    readonly compress?: boolean;
    readonly preserveLastUserMessage?: boolean;
    readonly minCompressChars?: number;
  },
): Promise<TokenOptimizationReport> {
  if (options?.compress !== false && options?.model) {
    const official = await compressWithOfficialHeadroom(messages, { model: options.model });
    if (official) {
      const originalChars = messages.reduce((sum, message) => sum + message.content.length, 0);
      const optimizedChars = official.messages.reduce((sum, message) => sum + message.content.length, 0);
      const estimatedTokensSaved = official.tokensSaved > 0
        ? official.tokensSaved
        : estimateTokenSavingsFromTexts(
            messages.map((message) => message.content).join("\n"),
            official.messages.map((message) => message.content).join("\n"),
          );
      const officialEvents: TokenOptimizationEvent[] = [{
        kind: "headroom-official",
        label: `官方 Headroom：${official.transformsApplied.join(", ") || "optimize"}`,
        originalChars,
        optimizedChars,
        estimatedTokensSaved,
        at: Date.now(),
      }];
      recordPipelineEvents(officialEvents);
      if (optimizedChars < originalChars) recordCompression(originalChars, optimizedChars, estimatedTokensSaved);
      return {
        messages: official.messages,
        events: officialEvents,
        originalChars,
        optimizedChars,
        estimatedTokensSaved,
      };
    }
    recordTokenOptimizationEvent({
      kind: "headroom-fallback",
      label: "官方 Headroom 不可用，使用本地 light 压缩",
    });
  }

  return optimizeMessagesForTokenPipeline(messages, options);
}

export function ensureSemanticCacheStorage(projectRoot: string): SemanticCacheStorageStatus {
  const path = join(projectRoot, ".inkos", "cache", "semantic-cache.db");
  const fallbackPath = diskCachePath(projectRoot);
  try {
    const db = openCacheDb(projectRoot);
    if (!db) {
      mkdirSync(dirname(fallbackPath), { recursive: true });
      if (!existsSync(fallbackPath)) writeFileSync(fallbackPath, JSON.stringify({ version: 1, rows: [] }), "utf-8");
      return {
        sqliteAvailable: false,
        path,
        fallbackPath,
        error: "node:sqlite DatabaseSync unavailable; using JSON fallback cache.",
      };
    }
    db.close();
    return { sqliteAvailable: true, path, fallbackPath };
  } catch (error) {
    mkdirSync(dirname(fallbackPath), { recursive: true });
    if (!existsSync(fallbackPath)) writeFileSync(fallbackPath, JSON.stringify({ version: 1, rows: [] }), "utf-8");
    return {
      sqliteAvailable: false,
      path,
      fallbackPath,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function getTokenDiagnostics(projectRoot: string): TokenDiagnostics {
  applyOfficialOptimizationConfig(projectRoot);
  return {
    headroom: getOfficialHeadroomStatus(),
    embedding: getEmbeddingDiagnostics(),
    telemetry: getHeadroomSavingsTelemetry(),
    semanticCache: getSemanticCacheStats(projectRoot),
  };
}

export function getEmbeddingDiagnostics(): EmbeddingDiagnostics {
  const endpoint = process.env.INKOS_EMBEDDING_ENDPOINT?.trim() || null;
  return {
    configured: Boolean(endpoint),
    endpoint,
    model: process.env.INKOS_EMBEDDING_MODEL ?? "BAAI/bge-small-zh-v1.5-int8",
    lastExternalOk: embeddingDiagnostics.lastExternalOk,
    lastExternalAt: embeddingDiagnostics.lastExternalAt,
    lastFallbackAt: embeddingDiagnostics.lastFallbackAt,
    lastError: embeddingDiagnostics.lastError,
  };
}

export function getSemanticCacheStats(projectRoot: string): SemanticCacheStats {
  const storage = ensureSemanticCacheStorage(projectRoot);
  const dbBytes = fileSize(storage.path);
  const fallbackBytes = fileSize(storage.fallbackPath);
  const fallbackRows = readDiskCacheRows(projectRoot).length;
  let rowCount = 0;

  const db = openCacheDb(projectRoot);
  if (db) {
    try {
      const row = db.prepare("SELECT COUNT(*) AS count FROM semantic_cache").get() as { count?: number | bigint } | undefined;
      const count = row?.count ?? 0;
      rowCount = typeof count === "bigint" ? Number(count) : Number(count);
    } catch {
      rowCount = 0;
    } finally {
      db.close();
    }
  }

  const hits = telemetry.semanticL1Hits + telemetry.semanticL2Hits;
  const checks = hits + telemetry.semanticMisses;
  return {
    storage,
    l1Entries: l1.size,
    l1Limit: INKOS_PROMPT_CACHE_POLICY.l1HotEntityLimit,
    rowCount,
    dbBytes,
    fallbackRows,
    fallbackBytes,
    l3ArchiveBytes: fileSize(join(projectRoot, ".inkos", "cache", "l3", "semantic-cache.jsonl"))
      + fileSize(join(projectRoot, ".inkos", "cache", "l3", "semantic-cache-fallback.jsonl")),
    hitRate: checks > 0 ? hits / checks : 0,
    lastMaintenanceAt: lastCacheMaintenanceAt.get(projectRoot) ?? null,
  };
}

export function maintainSemanticCache(projectRoot: string, options?: {
  readonly maxRows?: number;
  readonly vacuum?: boolean;
}): SemanticCacheMaintenanceResult {
  const now = Date.now();
  const storage = ensureSemanticCacheStorage(projectRoot);
  let removedRows = 0;
  let archivedRows = 0;
  let checkpointed = false;
  let vacuumed = false;

  try {
    const db = openCacheDb(projectRoot);
    if (db) {
      try {
        const before = readSqliteCount(db);
        archiveExpiredRows(db, projectRoot, now, true);
        const afterArchive = readSqliteCount(db);
        archivedRows += Math.max(0, before - afterArchive);
        const maxRows = Math.max(64, options?.maxRows ?? INKOS_PROMPT_CACHE_POLICY.l1HotEntityLimit * 8);
        const overflow = Math.max(0, afterArchive - maxRows);
        if (overflow > 0) {
          const victims = db.prepare(
            `SELECT cache_key FROM semantic_cache
             ORDER BY hits ASC, last_accessed_at ASC
             LIMIT ?`,
          ).all(overflow) as Array<{ cache_key: string }>;
          const remove = db.prepare("DELETE FROM semantic_cache WHERE cache_key = ?");
          db.exec("BEGIN IMMEDIATE");
          try {
            for (const victim of victims) remove.run(victim.cache_key);
            db.exec("COMMIT");
            removedRows += victims.length;
          } catch (error) {
            db.exec("ROLLBACK");
            throw error;
          }
        }
        db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
        checkpointed = true;
        if (options?.vacuum ?? true) {
          db.exec("VACUUM;");
          vacuumed = true;
        }
      } finally {
        db.close();
      }
    }

    const fallbackBefore = readDiskCacheRows(projectRoot);
    archiveExpiredDiskRows(projectRoot, fallbackBefore, now);
    const maxFallbackRows = Math.max(64, options?.maxRows ?? INKOS_PROMPT_CACHE_POLICY.l1HotEntityLimit * 8);
    const fallbackAfterArchive = readDiskCacheRows(projectRoot)
      .sort((left, right) => right.hits - left.hits || right.last_accessed_at - left.last_accessed_at);
    if (fallbackAfterArchive.length > maxFallbackRows) {
      writeDiskCacheRows(projectRoot, fallbackAfterArchive.slice(0, maxFallbackRows));
      removedRows += fallbackAfterArchive.length - maxFallbackRows;
    }

    lastCacheMaintenanceAt.set(projectRoot, now);
    recordTokenOptimizationEvent({
      kind: "cache-maintenance",
      label: `缓存维护完成：清理 ${removedRows}，归档 ${archivedRows}`,
    });
    return {
      ok: true,
      storage,
      removedRows,
      archivedRows,
      checkpointed,
      vacuumed,
      stats: getSemanticCacheStats(projectRoot),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    recordTokenOptimizationEvent({
      kind: "cache-maintenance",
      label: `缓存维护失败：${message}`,
    });
    return {
      ok: false,
      storage,
      removedRows,
      archivedRows,
      checkpointed,
      vacuumed,
      error: message,
      stats: getSemanticCacheStats(projectRoot),
    };
  }
}

export async function getSemanticCache(
  context: HeadroomCacheContext,
  messages: ReadonlyArray<LLMMessage>,
): Promise<LLMResponse | null> {
  const aligned = alignMessagesForCache(messages);
  const key = exactCacheKey(context, aligned);
  const now = Date.now();
  recordTokenOptimizationEvent({ kind: "cache-check", label: "语义缓存检查" });

  const exact = l1.get(key);
  if (exact) {
    touch(exact, now);
    recordSemanticHit("semantic-l1-hit", aligned, exact.response);
    return exact.response;
  }

  const worldKey = deriveWorldCacheKey(context, aligned);
  const vector = await embedMessagesInt8(aligned);
  const db = openCacheDb(context.projectRoot);
  if (!db) {
    const cached = getSemanticCacheFromDiskFallback(context, worldKey, vector, aligned, now);
    if (cached) return cached;
    recordSemanticMiss();
    return null;
  }

  try {
    archiveExpiredRows(db, context.projectRoot, now);
    const rows = db.prepare(
      `SELECT cache_key, world_key, vector, response_json, created_at, last_accessed_at, hits
       FROM semantic_cache
       WHERE model = ? AND service = ? AND world_key = ?
       ORDER BY last_accessed_at DESC
       LIMIT 64`,
    ).all(context.model, context.service ?? "", worldKey) as Array<{
      cache_key: string;
      world_key: string;
      vector: Buffer;
      response_json: string;
      created_at: number;
      last_accessed_at: number;
      hits: number;
    }>;

    let best: { readonly row: (typeof rows)[number]; readonly similarity: number } | null = null;
    for (const row of rows) {
      const similarity = cosineInt8(vector, new Int8Array(row.vector));
      if (!best || similarity > best.similarity) best = { row, similarity };
    }

    if (!best || best.similarity < INKOS_PROMPT_CACHE_POLICY.semanticSimilarityThreshold) {
      recordSemanticMiss();
      return null;
    }

    const response = JSON.parse(best.row.response_json) as LLMResponse;
    db.prepare(
      "UPDATE semantic_cache SET last_accessed_at = ?, hits = hits + 1 WHERE cache_key = ?",
    ).run(now, best.row.cache_key);
    rememberL1({
      key: best.row.cache_key,
      worldKey,
      vector: new Int8Array(best.row.vector),
      response,
      createdAt: best.row.created_at,
      lastAccessedAt: now,
      hits: best.row.hits + 1,
    });
    recordSemanticHit("semantic-l2-hit", aligned, response, best.similarity);
    return response;
  } finally {
    db.close();
  }
}

export async function putSemanticCache(
  context: HeadroomCacheContext,
  messages: ReadonlyArray<LLMMessage>,
  response: LLMResponse,
): Promise<void> {
  const aligned = alignMessagesForCache(messages);
  const key = exactCacheKey(context, aligned);
  const worldKey = deriveWorldCacheKey(context, aligned);
  const vector = await embedMessagesInt8(aligned);
  const now = Date.now();

  rememberL1({ key, worldKey, vector, response, createdAt: now, lastAccessedAt: now, hits: 1 });

  const db = openCacheDb(context.projectRoot);
  if (!db) {
    putSemanticCacheToDiskFallback(context.projectRoot, {
      cache_key: key,
      model: context.model,
      service: context.service ?? "",
      world_key: worldKey,
      vector: Array.from(vector),
      response_json: JSON.stringify(response),
      created_at: now,
      last_accessed_at: now,
      hits: 1,
    });
    recordTokenOptimizationEvent({ kind: "cache-write", label: "语义缓存写入：JSON fallback" });
    return;
  }
  try {
    db.prepare(
      `INSERT OR REPLACE INTO semantic_cache
       (cache_key, model, service, world_key, vector, response_json, created_at, last_accessed_at, hits)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, COALESCE((SELECT hits FROM semantic_cache WHERE cache_key = ?), 0) + 1)`,
    ).run(
      key,
      context.model,
      context.service ?? "",
      worldKey,
      Buffer.from(vector.buffer),
      JSON.stringify(response),
      now,
      now,
      key,
    );
    recordTokenOptimizationEvent({ kind: "cache-write", label: "语义缓存写入：SQLite" });
  } finally {
    db.close();
  }
}

export function compressWithCcr(params: {
  readonly projectRoot: string;
  readonly label: string;
  readonly content: string;
  readonly mode: HeadroomLightMode;
}): string {
  const normalized = normalizePromptForCache(params.content);
  const compressed = headroomLightCompress(normalized, params.mode);
  if (!normalized || compressed.length >= normalized.length * 0.92) {
    recordPipelineEvents([{
      kind: "compression-skipped",
      label: params.label,
      originalChars: normalized.length,
      optimizedChars: compressed.length,
      estimatedTokensSaved: 0,
      at: Date.now(),
    }]);
    return compressed;
  }

  const handle = storeCcrOriginalSync(params.projectRoot, params.label, normalized);
  const estimatedTokensSaved = estimateTokenSavingsFromTexts(normalized, compressed);
  recordPipelineEvents([{
    kind: "compressed",
    label: params.label,
    originalChars: normalized.length,
    optimizedChars: compressed.length,
    estimatedTokensSaved,
    at: Date.now(),
  }]);
  recordCompression(normalized.length, compressed.length, estimatedTokensSaved);
  return [
    compressed,
    "",
    `<!-- headroom:ccr ${handle} original_chars=${normalized.length} -->`,
  ].join("\n");
}

export function getHeadroomSavingsTelemetry(): HeadroomSavingsTelemetry {
  return {
    semanticL1Hits: telemetry.semanticL1Hits,
    semanticL2Hits: telemetry.semanticL2Hits,
    semanticMisses: telemetry.semanticMisses,
    cacheSkippedCalls: telemetry.cacheSkippedCalls,
    ccrBlocksCompressed: telemetry.ccrBlocksCompressed,
    originalChars: telemetry.originalChars,
    optimizedChars: telemetry.optimizedChars,
    estimatedTokensSaved: telemetry.estimatedTokensSaved,
    pipeline: telemetry.pipeline.slice(-24),
    ...(telemetry.lastEvent ? { lastEvent: telemetry.lastEvent } : {}),
  };
}

export function diffHeadroomSavingsTelemetry(
  before: HeadroomSavingsTelemetry,
  after: HeadroomSavingsTelemetry = getHeadroomSavingsTelemetry(),
): HeadroomSavingsTelemetry {
  const beforePipeline = before.pipeline ?? [];
  const afterPipeline = after.pipeline ?? [];
  const baselinePipelineIndex = findLastPipelineBaselineIndex(beforePipeline, afterPipeline);
  const baselineAt = beforePipeline.reduce((max, event) => Math.max(max, event.at), 0);
  const pipeline = baselinePipelineIndex >= 0
    ? afterPipeline.slice(baselinePipelineIndex + 1)
    : afterPipeline.filter((event) => event.at > baselineAt);

  return {
    semanticL1Hits: after.semanticL1Hits - before.semanticL1Hits,
    semanticL2Hits: after.semanticL2Hits - before.semanticL2Hits,
    semanticMisses: after.semanticMisses - before.semanticMisses,
    cacheSkippedCalls: after.cacheSkippedCalls - before.cacheSkippedCalls,
    ccrBlocksCompressed: after.ccrBlocksCompressed - before.ccrBlocksCompressed,
    originalChars: after.originalChars - before.originalChars,
    optimizedChars: after.optimizedChars - before.optimizedChars,
    estimatedTokensSaved: after.estimatedTokensSaved - before.estimatedTokensSaved,
    pipeline,
    ...(after.lastEvent && after.lastEvent.at !== before.lastEvent?.at ? { lastEvent: after.lastEvent } : {}),
  };
}

function findLastPipelineBaselineIndex(
  beforePipeline: ReadonlyArray<TokenOptimizationEvent>,
  afterPipeline: ReadonlyArray<TokenOptimizationEvent>,
): number {
  for (let beforeIndex = beforePipeline.length - 1; beforeIndex >= 0; beforeIndex -= 1) {
    const key = pipelineEventKey(beforePipeline[beforeIndex]!);
    for (let afterIndex = afterPipeline.length - 1; afterIndex >= 0; afterIndex -= 1) {
      if (pipelineEventKey(afterPipeline[afterIndex]!) === key) {
        return afterIndex;
      }
    }
  }
  return -1;
}

function pipelineEventKey(event: TokenOptimizationEvent): string {
  return [
    event.at,
    event.kind,
    event.label,
    event.originalChars ?? "",
    event.optimizedChars ?? "",
    event.estimatedTokensSaved ?? "",
    event.similarity ?? "",
  ].join("\u001f");
}

export function recordTokenOptimizationEvent(event: Omit<TokenOptimizationEvent, "at"> & { readonly at?: number }): void {
  recordPipelineEvents([{ ...event, at: event.at ?? Date.now() }]);
}

export async function headroomRetrieve(projectRoot: string, handle: string): Promise<string> {
  const safe = handle.trim();
  if (!/^[a-z0-9._:-]+$/i.test(safe)) {
    throw new Error(`Invalid headroom handle: ${handle}`);
  }
  const official = await retrieveFromOfficialHeadroom(safe);
  if (official) return official.originalContent;
  const file = join(headroomOriginalsDir(projectRoot), `${safe}.txt`);
  return readFile(file, "utf-8");
}

export async function clearIdleL1Caches(): Promise<number> {
  const now = Date.now();
  let removed = 0;
  for (const [key, entry] of l1) {
    if (now - entry.lastAccessedAt >= INKOS_PROMPT_CACHE_POLICY.l1IdleTtlMs) {
      l1.delete(key);
      removed += 1;
    }
  }
  return removed;
}

export function clearAllL1Caches(): number {
  const removed = l1.size;
  l1.clear();
  return removed;
}

export function recordTokenCompressionSavings(originalChars: number, optimizedChars: number): void {
  if (optimizedChars >= originalChars) return;
  recordCompression(originalChars, optimizedChars);
}

export async function installPresetSceneTemplates(projectRoot: string): Promise<void> {
  const templates = [
    ["battle", "战斗场景：目标、攻防节奏、代价、战后状态变化。"],
    ["daily", "日常场景：关系推进、生活细节、隐藏冲突露头。"],
    ["cultivation", "修炼场景：瓶颈、方法、代价、突破后的限制。"],
    ["inn", "客栈场景：消息流、陌生人压力、交易与试探。"],
    ["secret-realm", "秘境场景：规则、资源、危险、队伍分歧。"],
    ["sect-council", "宗门议事：立场冲突、利益交换、公开决议与暗线。"],
    ["romance", "感情场景：克制动作、误解、选择、关系状态变化。"],
    ["investigation", "探查场景：线索、误导、验证、下一步钩子。"],
    ["travel", "赶路场景：地理变化、补给、遭遇、心态过渡。"],
    ["payoff", "伏笔回收：原承诺、读者问题、现场答案、后续余波。"],
  ] as const;

  const dir = join(projectRoot, ".inkos", "scene-templates");
  await mkdir(dir, { recursive: true });
  await Promise.all(templates.map(([name, body]) =>
    writeFile(join(dir, `${name}.md`), `# ${name}\n\n${body}\n`, "utf-8"),
  ));
}

function openCacheDb(projectRoot: string): any | null {
  if (process.env.INKOS_DISABLE_NODE_SQLITE === "1") return null;
  let DatabaseSync: any;
  try {
    ({ DatabaseSync } = requireForSqlite("node:sqlite"));
  } catch {
    return null;
  }

  const dir = join(projectRoot, ".inkos", "cache");
  const dbPath = join(dir, "semantic-cache.db");
  mkdirSync(dir, { recursive: true });

  const open = () => {
    const db = new DatabaseSync(dbPath);
    try {
      db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 3000;");
      db.exec(`
        CREATE TABLE IF NOT EXISTS semantic_cache (
          cache_key TEXT PRIMARY KEY,
          model TEXT NOT NULL,
          service TEXT NOT NULL DEFAULT '',
          world_key TEXT NOT NULL,
          vector BLOB NOT NULL,
          response_json TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          last_accessed_at INTEGER NOT NULL,
          hits INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_semantic_cache_lookup
          ON semantic_cache(model, service, world_key, last_accessed_at);
      `);
      if (!validatedCacheRoots.has(projectRoot)) {
        const check = db.prepare("PRAGMA quick_check").get() as Record<string, unknown> | undefined;
        if (!check || !Object.values(check).includes("ok")) {
          throw new Error("semantic-cache.db failed SQLite quick_check");
        }
        validatedCacheRoots.add(projectRoot);
      }
      return db;
    } catch (error) {
      try {
        db.close();
      } catch {
        // Preserve the original SQLite error.
      }
      throw error;
    }
  };

  try {
    return open();
  } catch {
    quarantineCorruptCacheDb(projectRoot, dbPath);
    try {
      return open();
    } catch {
      return null;
    }
  }
}

function archiveExpiredRows(db: any, projectRoot: string, now: number, force = false): void {
  const lastMaintenance = lastCacheMaintenanceAt.get(projectRoot) ?? 0;
  if (!force && now - lastMaintenance < CACHE_MAINTENANCE_INTERVAL_MS) return;
  lastCacheMaintenanceAt.set(projectRoot, now);
  const cutoff = now - INKOS_PROMPT_CACHE_POLICY.l3ArchiveAfterDays * 24 * 60 * 60 * 1000;
  const rows = db.prepare(
    "SELECT cache_key, response_json, hits, last_accessed_at FROM semantic_cache WHERE last_accessed_at < ?",
  ).all(cutoff) as Array<{ cache_key: string; response_json: string; hits: number; last_accessed_at: number }>;
  if (rows.length === 0) return;

  const archiveDir = join(projectRoot, ".inkos", "cache", "l3");
  mkdirSync(archiveDir, { recursive: true });
  const archivePath = join(archiveDir, "semantic-cache.jsonl");
  writeFileSync(archivePath, rows.map((row) => `${JSON.stringify(row)}\n`).join(""), { flag: "a" });
  const remove = db.prepare("DELETE FROM semantic_cache WHERE cache_key = ?");
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const row of rows) remove.run(row.cache_key);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function readSqliteCount(db: any): number {
  const row = db.prepare("SELECT COUNT(*) AS count FROM semantic_cache").get() as { count?: number | bigint } | undefined;
  const count = row?.count ?? 0;
  return typeof count === "bigint" ? Number(count) : Number(count);
}

function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function quarantineCorruptCacheDb(projectRoot: string, dbPath: string): void {
  validatedCacheRoots.delete(projectRoot);
  const backupDir = join(projectRoot, ".inkos", "repair-backups");
  mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  for (const suffix of ["", "-wal", "-shm"]) {
    const source = `${dbPath}${suffix}`;
    if (!existsSync(source)) continue;
    const target = join(backupDir, `semantic-cache.db${suffix}.corrupt-${stamp}.bak`);
    try {
      renameSync(source, target);
    } catch {
      // A stale Android sidecar may still be locked; JSON fallback remains available.
    }
  }
}

function getSemanticCacheFromDiskFallback(
  context: HeadroomCacheContext,
  worldKey: string,
  vector: Int8Array,
  aligned: ReadonlyArray<LLMMessage>,
  now: number,
): LLMResponse | null {
  const rows = readDiskCacheRows(context.projectRoot);
  if (rows.length === 0) return null;

  archiveExpiredDiskRows(context.projectRoot, rows, now);
  const candidates = rows
    .filter((row) =>
      row.model === context.model
      && row.service === (context.service ?? "")
      && row.world_key === worldKey,
    )
    .sort((left, right) => right.last_accessed_at - left.last_accessed_at)
    .slice(0, 64);

  let best: { readonly row: DiskCacheRow; readonly similarity: number } | null = null;
  for (const row of candidates) {
    const similarity = cosineInt8(vector, Int8Array.from(row.vector));
    if (!best || similarity > best.similarity) best = { row, similarity };
  }

  if (!best || best.similarity < INKOS_PROMPT_CACHE_POLICY.semanticSimilarityThreshold) {
    return null;
  }

  best.row.last_accessed_at = now;
  best.row.hits += 1;
  writeDiskCacheRows(context.projectRoot, rows);
  const response = JSON.parse(best.row.response_json) as LLMResponse;
  rememberL1({
    key: best.row.cache_key,
    worldKey,
    vector: Int8Array.from(best.row.vector),
    response,
    createdAt: best.row.created_at,
    lastAccessedAt: now,
    hits: best.row.hits,
  });
  recordSemanticHit("semantic-l2-hit", aligned, response, best.similarity);
  return response;
}

function putSemanticCacheToDiskFallback(projectRoot: string, row: DiskCacheRow): void {
  const rows = readDiskCacheRows(projectRoot);
  const existing = rows.find((item) => item.cache_key === row.cache_key);
  if (existing) {
    existing.model = row.model;
    existing.service = row.service;
    existing.world_key = row.world_key;
    existing.vector = row.vector;
    existing.response_json = row.response_json;
    existing.last_accessed_at = row.last_accessed_at;
    existing.hits += 1;
  } else {
    rows.push(row);
  }
  rows.sort((left, right) => right.last_accessed_at - left.last_accessed_at);
  writeDiskCacheRows(projectRoot, rows.slice(0, Math.max(INKOS_PROMPT_CACHE_POLICY.l1HotEntityLimit * 4, 256)));
}

function readDiskCacheRows(projectRoot: string): DiskCacheRow[] {
  const file = diskCachePath(projectRoot);
  if (!existsSync(file)) return [];
  try {
    const raw = readFileSync(file, "utf-8");
    const parsed = JSON.parse(raw) as { rows?: DiskCacheRow[] };
    return Array.isArray(parsed.rows) ? parsed.rows.filter(isDiskCacheRow) : [];
  } catch {
    return [];
  }
}

function writeDiskCacheRows(projectRoot: string, rows: ReadonlyArray<DiskCacheRow>): void {
  const file = diskCachePath(projectRoot);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify({ version: 1, rows }, null, 0), "utf-8");
  renameSync(tmp, file);
}

function archiveExpiredDiskRows(projectRoot: string, rows: DiskCacheRow[], now: number): void {
  const cutoff = now - INKOS_PROMPT_CACHE_POLICY.l3ArchiveAfterDays * 24 * 60 * 60 * 1000;
  const expired = rows.filter((row) => row.last_accessed_at < cutoff);
  if (expired.length === 0) return;
  const archiveDir = join(projectRoot, ".inkos", "cache", "l3");
  mkdirSync(archiveDir, { recursive: true });
  const archivePath = join(archiveDir, "semantic-cache-fallback.jsonl");
  for (const row of expired) {
    writeFileSync(archivePath, `${JSON.stringify(row)}\n`, { flag: "a" });
  }
  const keep = rows.filter((row) => row.last_accessed_at >= cutoff);
  rows.splice(0, rows.length, ...keep);
  writeDiskCacheRows(projectRoot, rows);
}

function diskCachePath(projectRoot: string): string {
  return join(projectRoot, ".inkos", "cache", "semantic-cache.json");
}

function isDiskCacheRow(value: unknown): value is DiskCacheRow {
  if (!value || typeof value !== "object") return false;
  const row = value as Partial<DiskCacheRow>;
  return typeof row.cache_key === "string"
    && typeof row.model === "string"
    && typeof row.service === "string"
    && typeof row.world_key === "string"
    && Array.isArray(row.vector)
    && row.vector.every((item) => typeof item === "number")
    && typeof row.response_json === "string"
    && typeof row.created_at === "number"
    && typeof row.last_accessed_at === "number"
    && typeof row.hits === "number";
}

function rememberL1(entry: CacheEntry): void {
  l1.set(entry.key, entry);
  if (l1.size <= INKOS_PROMPT_CACHE_POLICY.l1HotEntityLimit) return;
  const victims = [...l1.values()]
    .sort((a, b) => a.hits - b.hits || a.lastAccessedAt - b.lastAccessedAt)
    .slice(0, l1.size - INKOS_PROMPT_CACHE_POLICY.l1HotEntityLimit);
  for (const victim of victims) l1.delete(victim.key);
}

function touch(entry: CacheEntry, now: number): void {
  entry.hits += 1;
  entry.lastAccessedAt = now;
}

function recordCompression(
  originalChars: number,
  optimizedChars: number,
  estimatedTokensSaved = estimateTokensFromTextLength(Math.max(0, originalChars - optimizedChars)),
): void {
  telemetry.ccrBlocksCompressed += 1;
  telemetry.originalChars += originalChars;
  telemetry.optimizedChars += optimizedChars;
  telemetry.estimatedTokensSaved += estimatedTokensSaved;
  telemetry.lastEvent = {
    kind: "ccr-compress",
    originalChars,
    optimizedChars,
    estimatedTokensSaved,
    at: Date.now(),
  };
}

function recordPipelineEvents(events: ReadonlyArray<TokenOptimizationEvent>): void {
  if (events.length === 0) return;
  telemetry.pipeline.push(...events);
  if (telemetry.pipeline.length > 80) {
    telemetry.pipeline.splice(0, telemetry.pipeline.length - 80);
  }
}

function recordSemanticHit(
  kind: "semantic-l1-hit" | "semantic-l2-hit",
  messages: ReadonlyArray<LLMMessage>,
  response: LLMResponse,
  similarity?: number,
): void {
  const originalChars = messages.reduce((sum, message) => sum + message.content.length, 0);
  const estimatedTokensSaved = response.usage.promptTokens > 0
    ? response.usage.promptTokens
    : estimateTokensFromMessages(messages);
  if (kind === "semantic-l1-hit") telemetry.semanticL1Hits += 1;
  else telemetry.semanticL2Hits += 1;
  telemetry.cacheSkippedCalls += 1;
  telemetry.originalChars += originalChars;
  telemetry.optimizedChars += 0;
  telemetry.estimatedTokensSaved += estimatedTokensSaved;
  telemetry.lastEvent = {
    kind,
    originalChars,
    optimizedChars: 0,
    estimatedTokensSaved,
    ...(similarity !== undefined ? { similarity } : {}),
    at: Date.now(),
  };
  recordTokenOptimizationEvent({
    kind: "cache-hit",
    label: kind === "semantic-l1-hit" ? "语义缓存命中：L1" : "语义缓存命中：L2",
    originalChars,
    optimizedChars: 0,
    estimatedTokensSaved,
    ...(similarity !== undefined ? { similarity } : {}),
  });
}

function recordSemanticMiss(): void {
  telemetry.semanticMisses += 1;
  telemetry.lastEvent = {
    kind: "semantic-miss",
    at: Date.now(),
  };
  recordTokenOptimizationEvent({ kind: "cache-miss", label: "语义缓存未命中" });
}

function estimateTokensFromTextLength(chars: number): number {
  return Math.max(0, Math.ceil(chars / 2));
}

function estimateTokensFromText(text: string): number {
  if (!text) return 0;
  let chineseChars = 0;
  let otherChars = 0;
  for (const char of text) {
    if (/\s/.test(char)) continue;
    if (/[\u4e00-\u9fff]/.test(char)) {
      chineseChars += 1;
    } else {
      otherChars += 1;
    }
  }
  return Math.max(0, Math.ceil(chineseChars + otherChars / 4));
}

function estimateTokensFromMessages(messages: ReadonlyArray<LLMMessage>): number {
  return messages.reduce((sum, message) => sum + estimateTokensFromText(message.content), 0);
}

function estimateTokenSavingsFromTexts(original: string, optimized: string): number {
  return Math.max(0, estimateTokensFromText(original) - estimateTokensFromText(optimized));
}

function estimateTokenSavingsFromMessages(
  original: ReadonlyArray<LLMMessage>,
  optimized: ReadonlyArray<LLMMessage>,
): number {
  const count = Math.max(original.length, optimized.length);
  let saved = 0;
  for (let index = 0; index < count; index += 1) {
    saved += estimateTokenSavingsFromTexts(
      original[index]?.content ?? "",
      optimized[index]?.content ?? "",
    );
  }
  return Math.max(0, saved);
}

function inferCompressionMode(message: LLMMessage, content: string): HeadroomLightMode {
  const trimmed = content.trim();
  if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
    return "json";
  }
  if (message.role === "assistant") return "narrative";
  return "setting";
}

function findLastIndex<T>(items: ReadonlyArray<T>, predicate: (item: T, index: number) => boolean): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (predicate(items[index]!, index)) return index;
  }
  return -1;
}

function exactCacheKey(context: HeadroomCacheContext, messages: ReadonlyArray<LLMMessage>): string {
  return sha256(JSON.stringify({
    projectRoot: context.projectRoot,
    model: context.model,
    service: context.service ?? "",
    bookId: context.bookId ?? "",
    variant: context.variant ?? "",
    worldKey: deriveWorldCacheKey(context, messages),
    messages,
  }));
}

function deriveWorldCacheKey(
  context: HeadroomCacheContext,
  messages: ReadonlyArray<LLMMessage>,
): string {
  const system = messages.find((message) => message.role === "system")?.content ?? "";
  const prefix = system.slice(0, Math.min(system.length, 16_000));
  return sha256(JSON.stringify({
    projectRoot: context.projectRoot,
    bookId: context.bookId ?? "",
    variant: context.variant ?? "",
    prefix,
  })).slice(0, 32);
}

async function embedMessagesInt8(messages: ReadonlyArray<LLMMessage>): Promise<Int8Array> {
  const text = messages.map((message) => `${message.role}\n${message.content}`).join("\n\n");
  return await embedTextInt8Async(text);
}

export function embedTextInt8(text: string): Int8Array {
  const buckets = new Int16Array(VECTOR_DIMS);
  for (const gram of ngrams(text)) {
    const hash = createHash("sha1").update(gram).digest();
    const index = hash.readUInt16BE(0) % VECTOR_DIMS;
    buckets[index] += hash[2] % 2 === 0 ? 1 : -1;
  }
  const max = Math.max(1, ...Array.from(buckets, Math.abs));
  return Int8Array.from(buckets, (value) => Math.max(-127, Math.min(127, Math.round((value / max) * 127))));
}

export async function embedTextInt8Async(text: string): Promise<Int8Array> {
  const external = await embedTextInt8FromEndpoint(text);
  if (external) return external;
  embeddingDiagnostics.lastFallbackAt = Date.now();
  recordTokenOptimizationEvent({
    kind: "embedding-fallback",
    label: process.env.INKOS_EMBEDDING_ENDPOINT?.trim()
      ? "Embedding 外部服务不可用，已回退本地向量"
      : "Embedding 未配置外部 bge，使用本地向量",
  });
  return embedTextInt8(text);
}

async function embedTextInt8FromEndpoint(text: string): Promise<Int8Array | null> {
  const endpoint = process.env.INKOS_EMBEDDING_ENDPOINT?.trim();
  if (!endpoint) return null;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Number(process.env.INKOS_EMBEDDING_TIMEOUT_MS ?? 3_000));
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(process.env.INKOS_EMBEDDING_API_KEY
            ? { Authorization: `Bearer ${process.env.INKOS_EMBEDDING_API_KEY}` }
            : {}),
        },
        body: JSON.stringify({
          input: text,
          model: process.env.INKOS_EMBEDDING_MODEL ?? "BAAI/bge-small-zh-v1.5-int8",
          encoding_format: "float",
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        embeddingDiagnostics.lastExternalOk = false;
        embeddingDiagnostics.lastExternalAt = Date.now();
        embeddingDiagnostics.lastError = `HTTP ${response.status}`;
        return null;
      }
      const payload = await response.json() as {
        embedding?: number[];
        data?: Array<{ embedding?: number[] }>;
      };
      const embedding = payload.embedding ?? payload.data?.[0]?.embedding;
      if (!Array.isArray(embedding) || embedding.length === 0) {
        embeddingDiagnostics.lastExternalOk = false;
        embeddingDiagnostics.lastExternalAt = Date.now();
        embeddingDiagnostics.lastError = "Embedding response did not include a vector.";
        return null;
      }
      embeddingDiagnostics.lastExternalOk = true;
      embeddingDiagnostics.lastExternalAt = Date.now();
      embeddingDiagnostics.lastError = null;
      recordTokenOptimizationEvent({
        kind: "embedding-external",
        label: `Embedding 外部 bge 已生效：${process.env.INKOS_EMBEDDING_MODEL ?? "BAAI/bge-small-zh-v1.5-int8"}`,
      });
      return quantizeEmbeddingToInt8(embedding, VECTOR_DIMS);
    } finally {
      clearTimeout(timeout);
    }
  } catch (error) {
    embeddingDiagnostics.lastExternalOk = false;
    embeddingDiagnostics.lastExternalAt = Date.now();
    embeddingDiagnostics.lastError = error instanceof Error ? error.message : String(error);
    return null;
  }
}

function quantizeEmbeddingToInt8(embedding: ReadonlyArray<number>, dims: number): Int8Array {
  const buckets = new Float32Array(dims);
  for (let i = 0; i < embedding.length; i += 1) {
    const value = Number.isFinite(embedding[i]) ? embedding[i]! : 0;
    buckets[i % dims] += value;
  }
  const max = Math.max(1e-6, ...Array.from(buckets, Math.abs));
  return Int8Array.from(buckets, (value) => Math.max(-127, Math.min(127, Math.round((value / max) * 127))));
}

function ngrams(text: string): string[] {
  const normalized = normalizePromptForCache(text).toLowerCase();
  const grams: string[] = [];
  for (let i = 0; i < normalized.length; i += 1) {
    const ch = normalized[i]!;
    if (/\s/.test(ch)) continue;
    grams.push(normalized.slice(i, i + 3));
  }
  return grams;
}

export function cosineInt8(a: Int8Array, b: Int8Array): number {
  let dot = 0;
  let a2 = 0;
  let b2 = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    dot += a[i]! * b[i]!;
    a2 += a[i]! * a[i]!;
    b2 += b[i]! * b[i]!;
  }
  if (a2 === 0 || b2 === 0) return 0;
  return dot / (Math.sqrt(a2) * Math.sqrt(b2));
}

function storeCcrOriginalSync(projectRoot: string, label: string, content: string): string {
  const handle = `${slug(label)}-${sha256(content).slice(0, 20)}`;
  const file = join(headroomOriginalsDir(projectRoot), `${handle}.txt`);
  mkdirSync(dirname(file), { recursive: true });
  if (!existsSync(file)) writeFileSync(file, content, "utf-8");
  return handle;
}

function headroomOriginalsDir(projectRoot: string): string {
  return join(projectRoot, ".inkos", "headroom", "originals");
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "block";
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
