import { KnowledgeStore, listBookSessions, PlayStore, type StateManager } from "@actalk/inkos-core";
import type { Hono } from "hono";
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { gzip } from "node:zlib";
import { promisify } from "node:util";
import type { HeadroomMcpManager } from "./headroom-mcp.js";
import { detectPythonRuntime, extractTextWithPython, runMaintenanceScan, analyzeTextQuality } from "./python-runtime.js";

const DEFAULT_UPDATE_MANIFEST_URL = "https://github.com/Scl-Ywr/inkos/releases/latest/download/update.json";
const UPDATE_SOURCE_TIMEOUT_MS = 8_000;
const gzipAsync = promisify(gzip);
const OLD_LOG_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const LARGE_LOG_BYTES = 5 * 1024 * 1024;
const BACKUP_COMPRESS_MIN_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const GITHUB_UPDATE_MIRROR_PREFIXES = [
  "https://ghproxy.net/",
  "https://ghfast.top/",
  "https://gh-proxy.com/",
  "https://githubproxy.cc/",
] as const;
export const PROJECT_DIRS = [
  ".inkos",
  ".inkos/sessions",
  ".inkos/backups",
  "books",
  "genres",
  "worlds",
  "runtime",
  "radar",
  "covers",
  "shorts",
  "exports",
  "logs",
] as const;

const NODE_TOOL_CAPABILITIES = [
  "agent.architect",
  "agent.writer",
  "agent.auditor",
  "agent.reviser",
  "agent.exporter",
  "play.actionInterpreter",
  "play.worldMutator",
  "play.sceneRenderer",
  "play.sceneReconciler",
  "short_fiction_run",
  "generate_cover",
].map((id) => ({ id, runtime: "embedded-node", status: "implemented" }));

const MAINTENANCE_REPAIR_ACTIONS = [
  "cleanup-old-logs",
  "prune-orphan-worlds",
  "rebuild-knowledge-indexes",
  "compress-backups",
] as const;

type MaintenanceRepairAction = typeof MAINTENANCE_REPAIR_ACTIONS[number];

interface MaintenanceRepairPlanItem {
  readonly action: MaintenanceRepairAction;
  readonly title: string;
  readonly detail: string;
  readonly count: number;
  readonly bytes: number;
  readonly enabled: boolean;
  readonly severity: "info" | "warning" | "danger";
}

interface MaintenanceRepairPlan {
  readonly ok: true;
  readonly root: string;
  readonly actions: readonly MaintenanceRepairPlanItem[];
}

interface AndroidUpdateManifest {
  readonly channel: string;
  readonly versionName: string;
  readonly versionCode: number;
  readonly minVersionCode: number;
  readonly apkUrl: string;
  readonly apkMirrorUrls?: string[];
  readonly apkSha256: string;
  readonly size: number;
  readonly notes: string[];
  readonly publishedAt: string;
}

interface RuntimeRoutesDeps {
  readonly root: string;
  readonly state: StateManager;
  readonly broadcast: (event: string, data: unknown) => void;
  readonly headroom: HeadroomMcpManager;
}

interface MaintenanceRepairRequest {
  readonly confirm: boolean;
  readonly actions: readonly MaintenanceRepairAction[];
}

function envEnabled(name: string, fallback: boolean): boolean {
  const raw = String(process.env[name] ?? "").trim().toLowerCase();
  if (!raw) return fallback;
  return !["0", "false", "no", "off"].includes(raw);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function parseMaintenanceRepairRequest(value: unknown): MaintenanceRepairRequest {
  if (!isRecord(value)) {
    return { confirm: false, actions: [] };
  }
  const actions = Array.isArray(value.actions)
    ? value.actions.filter(isRepairAction)
    : [];
  return {
    confirm: value.confirm === true,
    actions,
  };
}

function readAndroidVersionCode(): number {
  const raw = Number(process.env.INKOS_ANDROID_VERSION_CODE ?? 0);
  return Number.isInteger(raw) && raw > 0 ? raw : 0;
}

function readAndroidVersionName(): string {
  return String(process.env.INKOS_ANDROID_VERSION_NAME ?? "").trim();
}

function parseUpdateManifest(value: unknown): AndroidUpdateManifest {
  if (!value || typeof value !== "object") throw new Error("Update manifest is not a JSON object.");
  const record = value as Record<string, unknown>;
  const versionCode = Number(record.versionCode);
  const minVersionCode = Number(record.minVersionCode ?? 1);
  const size = Number(record.size ?? 0);
  const versionName = String(record.versionName ?? "").trim();
  const channel = String(record.channel ?? "stable").trim() || "stable";
  const apkUrl = String(record.apkUrl ?? "").trim();
  const apkMirrorUrls = Array.isArray(record.apkMirrorUrls)
    ? record.apkMirrorUrls
      .map((url) => String(url).trim())
      .filter((url) => /^https:\/\//i.test(url))
    : [];
  const apkSha256 = String(record.apkSha256 ?? "").trim().toLowerCase();
  const publishedAt = String(record.publishedAt ?? "").trim();
  const notes = Array.isArray(record.notes)
    ? record.notes.map((note) => String(note).trim()).filter(Boolean)
    : [];

  if (!Number.isInteger(versionCode) || versionCode <= 0) throw new Error("Update manifest versionCode must be positive.");
  if (!Number.isInteger(minVersionCode) || minVersionCode <= 0) throw new Error("Update manifest minVersionCode must be positive.");
  if (!versionName) throw new Error("Update manifest versionName is required.");
  if (!/^https:\/\//i.test(apkUrl)) throw new Error("Update manifest apkUrl must use HTTPS.");
  if (!/^[a-f0-9]{64}$/i.test(apkSha256)) throw new Error("Update manifest apkSha256 must be a SHA-256 digest.");
  if (!Number.isFinite(size) || size <= 0) throw new Error("Update manifest size must be positive.");

  return {
    channel,
    versionName,
    versionCode,
    minVersionCode,
    apkUrl,
    ...(apkMirrorUrls.length > 0 ? { apkMirrorUrls: [...new Set(apkMirrorUrls)] } : {}),
    apkSha256,
    size: Math.floor(size),
    notes,
    publishedAt,
  };
}

export function buildUpdateManifestCandidates(primaryUrl: string): string[] {
  const configured = String(process.env.INKOS_UPDATE_MANIFEST_URLS ?? "")
    .split(/[\r\n,;]+/)
    .map((url) => url.trim())
    .filter((url) => /^https:\/\//i.test(url));
  const candidates = [primaryUrl, ...configured];
  if (/^https:\/\/github\.com\//i.test(primaryUrl)) {
    candidates.push(...GITHUB_UPDATE_MIRROR_PREFIXES.map((prefix) => `${prefix}${primaryUrl}`));
  }
  return [...new Set(candidates)];
}

async function fetchUpdateManifest(
  candidates: ReadonlyArray<string>,
): Promise<{ readonly manifestUrl: string; readonly update: AndroidUpdateManifest }> {
  const attempts = candidates.map(async (manifestUrl) => {
    const response = await fetch(manifestUrl, {
      headers: { Accept: "application/json", "User-Agent": "InkOS-Studio-Android/1.5" },
      signal: AbortSignal.timeout(UPDATE_SOURCE_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`${manifestUrl} returned HTTP ${response.status}`);
    }
    return { manifestUrl, update: parseUpdateManifest(await response.json()) };
  });
  try {
    return await Promise.any(attempts);
  } catch (error) {
    const details = error instanceof AggregateError
      ? error.errors.map((item) => item instanceof Error ? item.message : String(item)).join(" | ")
      : error instanceof Error ? error.message : String(error);
    throw new Error(`无法连接在线更新源。已尝试 ${candidates.length} 个地址。${details ? ` ${details}` : ""}`);
  }
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false);
}

export async function ensureProjectStorage(root: string): Promise<void> {
  await Promise.all(PROJECT_DIRS.map((dir) => mkdir(join(root, dir), { recursive: true })));
}

export async function initializeStudioProject(root: string): Promise<void> {
  await ensureProjectStorage(root);
  const configPath = join(root, "inkos.json");
  if (await exists(configPath)) return;

  const config = {
    name: basename(root),
    version: "0.1.0",
    language: "zh",
    llm: {
      provider: "openai",
      service: "custom",
      configSource: "studio",
      baseUrl: "",
      model: "",
      apiFormat: "chat",
      stream: true,
    },
    notify: [],
    inputGovernanceMode: "v2",
    daemon: {
      schedule: {
        radarCron: "0 */6 * * *",
        writeCron: "*/15 * * * *",
      },
      maxConcurrentBooks: 3,
    },
  };

  try {
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf-8", flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

async function backupUpgradeMetadata(root: string): Promise<string> {
  const backupDir = join(root, ".inkos", "backups", `upgrade-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  await mkdir(backupDir, { recursive: true });
  for (const relativePath of ["inkos.json", "manifest.json", "inkos-db.json", ".inkos/secrets.json"]) {
    const source = join(root, relativePath);
    if (await exists(source)) {
      const target = join(backupDir, relativePath.replace(/[\\/]/g, "__"));
      await copyFile(source, target);
    }
  }
  return backupDir;
}

function isRepairAction(value: unknown): value is MaintenanceRepairAction {
  return typeof value === "string" && (MAINTENANCE_REPAIR_ACTIONS as readonly string[]).includes(value);
}

function projectChild(root: string, ...parts: string[]): string {
  const target = join(root, ...parts);
  const rel = relative(root, target);
  if (rel.startsWith("..") || rel === "" || /^[A-Za-z]:/.test(rel)) {
    throw new Error(`Unsafe project maintenance path: ${parts.join("/")}`);
  }
  return target;
}

async function walkFiles(dir: string): Promise<Array<{ readonly path: string; readonly bytes: number; readonly mtimeMs: number }>> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const files: Array<{ path: string; bytes: number; mtimeMs: number }> = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await walkFiles(path));
      continue;
    }
    if (!entry.isFile()) continue;
    const info = await stat(path).catch(() => null);
    if (!info?.isFile()) continue;
    files.push({ path, bytes: info.size, mtimeMs: info.mtimeMs });
  }
  return files;
}

async function directoryBytes(dir: string): Promise<number> {
  const files = await walkFiles(dir);
  return files.reduce((sum, file) => sum + file.bytes, 0);
}

async function planOldLogs(root: string): Promise<{ readonly files: readonly string[]; readonly bytes: number }> {
  const now = Date.now();
  const logRoot = projectChild(root, "logs");
  const files = await walkFiles(logRoot);
  const candidates = files.filter((file) => {
    const lower = basename(file.path).toLowerCase();
    const logLike = lower.endsWith(".log") || lower.endsWith(".txt") || lower.endsWith(".jsonl");
    return logLike && (file.bytes >= LARGE_LOG_BYTES || now - file.mtimeMs >= OLD_LOG_MAX_AGE_MS);
  });
  return {
    files: candidates.map((file) => file.path),
    bytes: candidates.reduce((sum, file) => sum + file.bytes, 0),
  };
}

async function activePlayWorldIds(root: string): Promise<Set<string>> {
  const playSessions = await listBookSessions(root, null);
  return new Set(playSessions.filter((session) => session.sessionKind === "play").map((session) => session.sessionId));
}

async function planOrphanWorlds(root: string): Promise<{ readonly worldIds: readonly string[]; readonly bytes: number }> {
  const store = new PlayStore(root);
  const activeWorlds = await activePlayWorldIds(root);
  const worlds = await store.listWorlds();
  const worldIds = worlds.map((world) => world.id).filter((id) => !activeWorlds.has(id));
  const bytes = (await Promise.all(worldIds.map((id) => directoryBytes(store.worldDir(id))))).reduce((sum, value) => sum + value, 0);
  return { worldIds, bytes };
}

function parseKnowledgeLibrary(relativePath: string): { readonly scope: "project" | "book" | "world"; readonly ownerId: string } | null {
  const parts = relativePath.replace(/\\/g, "/").split("/").filter(Boolean);
  if (parts[0] !== "knowledge" || parts.length < 3) return null;
  if (parts[1] === "project") return { scope: "project", ownerId: parts.slice(2).join("/") };
  if (parts[1] === "books") return { scope: "book", ownerId: parts.slice(2).join("/") };
  if (parts[1] === "worlds") return { scope: "world", ownerId: parts.slice(2).join("/") };
  return null;
}

function knowledgeLibraryDir(root: string, library: { readonly scope: "project" | "book" | "world"; readonly ownerId: string }): string {
  const scopeDir = library.scope === "project" ? "project" : library.scope === "world" ? "worlds" : "books";
  return projectChild(root, "knowledge", scopeDir, library.ownerId);
}

function termsForMaintenanceIndex(text: string): readonly string[] {
  const terms = new Set<string>();
  const ascii = text.toLowerCase().match(/[a-z][a-z0-9_-]{2,}/g) ?? [];
  for (const term of ascii) terms.add(term);
  const cjk = text.match(/[\p{Script=Han}]{2,8}/gu) ?? [];
  for (const term of cjk) terms.add(term.length > 4 ? term.slice(0, 4) : term);
  return [...terms].slice(0, 80);
}

async function repairKnowledgeLibraryFallback(
  root: string,
  library: { readonly scope: "project" | "book" | "world"; readonly ownerId: string },
): Promise<void> {
  const dir = knowledgeLibraryDir(root, library);
  const [sourcesRaw, chunksRaw] = await Promise.all([
    readFile(join(dir, "sources.json"), "utf-8").catch(() => "[]"),
    readFile(join(dir, "chunks.json"), "utf-8").catch(() => "[]"),
  ]);
  const sources = JSON.parse(sourcesRaw) as unknown[];
  const chunks = JSON.parse(chunksRaw) as unknown[];
  const sourceIds = new Set(sources
    .filter((source): source is Record<string, unknown> => Boolean(source && typeof source === "object"))
    .map((source) => String(source.id)));
  const nextChunks = chunks
    .filter((chunk): chunk is Record<string, unknown> => Boolean(chunk && typeof chunk === "object"))
    .filter((chunk) => sourceIds.has(String(chunk.sourceId)));
  const chunkCounts = new Map<string, number>();
  for (const chunk of nextChunks) {
    const sourceId = String(chunk.sourceId);
    chunkCounts.set(sourceId, (chunkCounts.get(sourceId) ?? 0) + 1);
  }
  const nextSources = sources
    .filter((source): source is Record<string, unknown> => Boolean(source && typeof source === "object"))
    .map((source) => ({ ...source, chunkCount: chunkCounts.get(String(source.id)) ?? 0 }));
  const terms = new Map<string, Set<string>>();
  for (const chunk of nextChunks) {
    const id = String(chunk.id ?? "");
    if (!id) continue;
    const text = [chunk.sourceName, ...(Array.isArray(chunk.keywords) ? chunk.keywords : []), chunk.text].join("\n");
    for (const term of termsForMaintenanceIndex(text)) {
      if (!terms.has(term)) terms.set(term, new Set());
      terms.get(term)?.add(id);
    }
  }
  await mkdir(dir, { recursive: true });
  await Promise.all([
    writeFile(join(dir, "sources.json"), `${JSON.stringify(nextSources, null, 2)}\n`, "utf-8"),
    writeFile(join(dir, "chunks.json"), `${JSON.stringify(nextChunks, null, 2)}\n`, "utf-8"),
    writeFile(join(dir, "search-index.json"), `${JSON.stringify({
      version: 1,
      chunkCount: nextChunks.length,
      terms: Object.fromEntries([...terms.entries()].map(([term, ids]) => [term, [...ids].slice(0, 240)])),
    })}\n`, "utf-8"),
  ]);
}

async function repairKnowledgeLibrary(
  root: string,
  store: KnowledgeStore,
  library: { readonly scope: "project" | "book" | "world"; readonly ownerId: string },
): Promise<void> {
  const rawDir = join(knowledgeLibraryDir(root, library), "raw");
  const rawFiles = await readdir(rawDir).catch(() => [] as string[]);
  if (rawFiles.some((file) => file.endsWith(".txt"))) {
    await store.rebuild(library.scope, library.ownerId);
    return;
  }
  await repairKnowledgeLibraryFallback(root, library);
}

async function planKnowledgeRebuilds(root: string): Promise<{ readonly libraries: readonly { scope: "project" | "book" | "world"; ownerId: string }[] }> {
  const report = await runMaintenanceScan(root);
  const paths = new Set<string>();
  for (const issue of report.issues) {
    if (
      issue.category === "knowledge-search-index-missing"
      || issue.category === "knowledge-chunk-mismatch"
      || issue.category === "knowledge-orphan-chunk-source"
      || issue.category === "knowledge-index-invalid"
    ) {
      paths.add(issue.path);
    }
  }
  const libraries = [...paths]
    .map(parseKnowledgeLibrary)
    .filter((item): item is { scope: "project" | "book" | "world"; ownerId: string } => Boolean(item));
  return {
    libraries: [...new Map(libraries.map((item) => [`${item.scope}:${item.ownerId}`, item])).values()],
  };
}

async function planBackups(root: string): Promise<{ readonly dirs: readonly string[]; readonly bytes: number }> {
  const backupsRoot = projectChild(root, ".inkos", "backups");
  const entries = await readdir(backupsRoot, { withFileTypes: true }).catch(() => []);
  const now = Date.now();
  const dirs: string[] = [];
  let bytes = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = join(backupsRoot, entry.name);
    if (entry.name.endsWith(".gz")) continue;
    const info = await stat(dir).catch(() => null);
    if (!info?.isDirectory() || now - info.mtimeMs < BACKUP_COMPRESS_MIN_AGE_MS) continue;
    dirs.push(dir);
    bytes += await directoryBytes(dir);
  }
  return { dirs, bytes };
}

async function buildMaintenanceRepairPlan(root: string): Promise<MaintenanceRepairPlan> {
  const [logs, worlds, knowledge, backups] = await Promise.all([
    planOldLogs(root),
    planOrphanWorlds(root),
    planKnowledgeRebuilds(root),
    planBackups(root),
  ]);
  return {
    ok: true,
    root,
    actions: [
      {
        action: "cleanup-old-logs",
        title: "清理旧日志",
        detail: logs.files.length
          ? `将删除 logs/ 下 ${logs.files.length} 个旧日志或超大日志。`
          : "没有达到清理条件的旧日志。",
        count: logs.files.length,
        bytes: logs.bytes,
        enabled: logs.files.length > 0,
        severity: "info",
      },
      {
        action: "prune-orphan-worlds",
        title: "清理孤立 Play 世界",
        detail: worlds.worldIds.length
          ? `将删除 ${worlds.worldIds.length} 个没有对应 Play 会话的 world。`
          : "没有发现孤立 Play 世界。",
        count: worlds.worldIds.length,
        bytes: worlds.bytes,
        enabled: worlds.worldIds.length > 0,
        severity: "warning",
      },
      {
        action: "rebuild-knowledge-indexes",
        title: "重建知识库索引",
        detail: knowledge.libraries.length
          ? `将重建 ${knowledge.libraries.length} 个知识库的 sources/chunks/search-index。`
          : "知识库索引当前不需要重建。",
        count: knowledge.libraries.length,
        bytes: 0,
        enabled: knowledge.libraries.length > 0,
        severity: "warning",
      },
      {
        action: "compress-backups",
        title: "压缩历史备份",
        detail: backups.dirs.length
          ? `将把 ${backups.dirs.length} 个 .inkos/backups 历史目录压缩为 gzip JSON 归档。`
          : "没有达到压缩条件的历史备份目录。",
        count: backups.dirs.length,
        bytes: backups.bytes,
        enabled: backups.dirs.length > 0,
        severity: "info",
      },
    ],
  };
}

async function compressBackupDirectory(root: string, dir: string): Promise<{ readonly archivePath: string; readonly sourceBytes: number; readonly archiveBytes: number }> {
  const files = await walkFiles(dir);
  const payload: Record<string, string> = {};
  for (const file of files) {
    payload[relative(dir, file.path).replace(/\\/g, "/")] = await readFile(file.path, "utf-8").catch(async () => {
      const raw = await readFile(file.path);
      return raw.toString("base64");
    });
  }
  const sourceBytes = files.reduce((sum, file) => sum + file.bytes, 0);
  const archivePath = `${dir}.json.gz`;
  const archive = await gzipAsync(Buffer.from(JSON.stringify({
    version: 1,
    archivedAt: new Date().toISOString(),
    source: relative(root, dir).replace(/\\/g, "/"),
    files: payload,
  }), "utf-8"));
  await writeFile(archivePath, archive);
  await rm(dir, { recursive: true, force: true });
  const archiveInfo = await stat(archivePath).catch(() => null);
  return { archivePath, sourceBytes, archiveBytes: archiveInfo?.size ?? archive.length };
}

async function runMaintenanceRepair(root: string, actions: readonly MaintenanceRepairAction[]): Promise<{
  readonly ok: true;
  readonly root: string;
  readonly actions: readonly MaintenanceRepairAction[];
  readonly results: readonly {
    readonly action: MaintenanceRepairAction;
    readonly changed: number;
    readonly bytes: number;
    readonly message: string;
  }[];
}> {
  const selected = new Set(actions);
  const results: Array<{ action: MaintenanceRepairAction; changed: number; bytes: number; message: string }> = [];

  if (selected.has("cleanup-old-logs")) {
    const plan = await planOldLogs(root);
    await Promise.all(plan.files.map((file) => rm(file, { force: true })));
    results.push({ action: "cleanup-old-logs", changed: plan.files.length, bytes: plan.bytes, message: `Removed ${plan.files.length} old log files.` });
  }

  if (selected.has("prune-orphan-worlds")) {
    const activeWorlds = await activePlayWorldIds(root);
    const removedWorldIds = await new PlayStore(root).pruneOrphanWorlds(activeWorlds);
    results.push({ action: "prune-orphan-worlds", changed: removedWorldIds.length, bytes: 0, message: `Removed ${removedWorldIds.length} orphan Play worlds.` });
  }

  if (selected.has("rebuild-knowledge-indexes")) {
    const plan = await planKnowledgeRebuilds(root);
    const store = new KnowledgeStore(root);
    for (const library of plan.libraries) {
      await repairKnowledgeLibrary(root, store, library);
    }
    results.push({ action: "rebuild-knowledge-indexes", changed: plan.libraries.length, bytes: 0, message: `Rebuilt ${plan.libraries.length} knowledge libraries.` });
  }

  if (selected.has("compress-backups")) {
    const plan = await planBackups(root);
    const archives = await Promise.all(plan.dirs.map((dir) => compressBackupDirectory(root, dir)));
    results.push({
      action: "compress-backups",
      changed: archives.length,
      bytes: archives.reduce((sum, item) => sum + Math.max(0, item.sourceBytes - item.archiveBytes), 0),
      message: `Compressed ${archives.length} backup directories.`,
    });
  }

  return { ok: true, root, actions, results };
}

export function registerRuntimeRoutes(app: Hono, deps: RuntimeRoutesDeps): void {
  const { root, state, broadcast, headroom } = deps;
  const android = process.env.INKOS_ANDROID === "1";
  const play = envEnabled("INKOS_PLAY_ENABLED", true);

  app.get("/api/v1/runtime/status", (c) => c.json({
    state: "running",
    message: `Node backend is serving API requests. Project root: ${root}`,
    updatedAt: Date.now(),
  }));

  app.get("/api/v1/runtime/capabilities", (c) => c.json({
    android,
    play,
    selfUpdate: android,
    imageGeneration: true,
    sqlite: true,
    embeddedNode: android,
    minimumAndroidApi: 28,
    abi: process.arch,
  }));

  app.get("/api/v1/runtime/update/check", async (c) => {
    const configuredManifestUrl = String(process.env.INKOS_UPDATE_MANIFEST_URL ?? DEFAULT_UPDATE_MANIFEST_URL).trim();
    const current = { versionCode: readAndroidVersionCode(), versionName: readAndroidVersionName() };
    if (!/^https:\/\//i.test(configuredManifestUrl)) {
      return c.json({ ok: false, manifestUrl: configuredManifestUrl, current, error: "Update manifest URL must use HTTPS." }, 400);
    }
    const manifestCandidates = buildUpdateManifestCandidates(configuredManifestUrl);
    try {
      const { manifestUrl, update } = await fetchUpdateManifest(manifestCandidates);
      const supported = current.versionCode > 0;
      return c.json({
        ok: true,
        manifestUrl,
        manifestCandidates,
        current,
        supported,
        available: supported && update.versionCode > current.versionCode && current.versionCode >= update.minVersionCode,
        update,
      });
    } catch (error) {
      return c.json({
        ok: false,
        manifestUrl: configuredManifestUrl,
        manifestCandidates,
        current,
        error: error instanceof Error ? error.message : String(error),
      }, 502);
    }
  });

  app.post("/api/v1/runtime/repair", async (c) => {
    await ensureProjectStorage(root);
    const backupDir = await backupUpgradeMetadata(root);
    const playSessions = await listBookSessions(root, null);
    const activeWorldIds = new Set(
      playSessions.filter((session) => session.sessionKind === "play").map((session) => session.sessionId),
    );
    const removedWorldIds = await new PlayStore(root).pruneOrphanWorlds(activeWorldIds);
    const bookIds = await state.listBooks();
    for (const bookId of bookIds) {
      await state.ensureControlDocuments(bookId);
      await state.saveChapterIndex(bookId, await state.loadChapterIndex(bookId));
    }
    broadcast("log", { level: "info", tag: "storage-repair", message: `Storage repair completed; metadata backup: ${backupDir}` });
    return c.json({
      ok: true,
      root,
      backupDir,
      booksChecked: bookIds.length,
      worldsRemoved: removedWorldIds.length,
      removedWorldIds,
    });
  });

  app.post("/api/v1/runtime/background-idle", (c) => {
    const gc = (globalThis as typeof globalThis & { gc?: () => void }).gc;
    gc?.();
    return c.json({ ok: true, message: "Released idle runtime references." });
  });

  app.get("/api/v1/runtime/token-savings", (c) => c.json({
    ok: true,
    telemetry: headroom.getStatus().session,
    contextCompression: true,
  }));

  app.get("/api/v1/token-diagnostics", (c) => {
    const headroomStatus = headroom.getStatus();
    return c.json({
      diagnostics: {
        headroom: headroomStatus,
      embedding: { configured: false, endpoint: null, model: "built-in", lastExternalOk: null, lastExternalAt: null, lastFallbackAt: null, lastError: null },
      telemetry: {
        semanticL1Hits: 0,
        semanticL2Hits: 0,
        semanticMisses: 0,
        cacheSkippedCalls: 0,
        ccrBlocksCompressed: headroomStatus.session.compressions,
        originalChars: headroomStatus.session.originalChars,
        optimizedChars: headroomStatus.session.compressedChars,
        estimatedTokensSaved: headroomStatus.session.tokensSaved,
        pipeline: headroomStatus.lastCompressionAt
          ? [{ kind: "headroom-official", label: "Headroom MCP compression", at: Date.parse(headroomStatus.lastCompressionAt) }]
          : [],
      },
      semanticCache: {
        storage: { sqliteAvailable: true, path: join(root, "worlds"), fallbackPath: join(root, ".inkos", "cache") },
        l1Entries: 0,
        l1Limit: 0,
        rowCount: 0,
        dbBytes: 0,
        fallbackRows: 0,
        fallbackBytes: 0,
        l3ArchiveBytes: 0,
        hitRate: 0,
        lastMaintenanceAt: null,
      },
      },
    });
  });

  app.post("/api/v1/token-diagnostics/headroom/check", async (c) => {
    const status = await headroom.check();
    broadcast("log", {
      level: status.state === "online" ? "info" : "warn",
      tag: "headroom",
      message: status.state === "online"
        ? `Headroom MCP online; tools=${status.tools.join(",")}`
        : `Headroom MCP unavailable: ${status.lastError ?? status.state}`,
    });
    return c.json({ ok: status.state === "online", headroom: status }, status.state === "online" ? 200 : 503);
  });

  app.post("/api/v1/token-diagnostics/headroom/self-test", async (c) => {
    const sample = [
      "# InkOS Headroom self test",
      "",
      "## 当前状态",
      "这是一段用于验证手机端内置 Headroom-compatible 压缩是否真实执行的诊断文本。",
      "它不会写入书籍，只会在当前 Node 进程内累计一次压缩统计。",
      "",
      "## 长上下文样本",
      "角色关系、章节摘要、伏笔状态、作者意图、当前聚焦、历史摘要。",
      "需要保留人名、关系、时间点、未兑现承诺和证据链。",
      "",
      "## 重复上下文",
      "林玄需要保护林雨，同时判断苏晚晴是否可信。".repeat(160),
    ].join("\n");
    const result = await headroom.compress(sample);
    const status = headroom.getStatus();
    broadcast("log", {
      level: result ? "info" : "warn",
      tag: "headroom",
      message: result
        ? `Headroom self-test compressed sample; saved=${status.session.tokensSaved}`
        : `Headroom self-test failed: ${status.lastError ?? status.state}`,
    });
    return c.json(
      { ok: Boolean(result), headroom: status, result },
      result ? 200 : 503,
    );
  });

  app.post("/api/v1/token-cache/maintenance", (c) => c.json({
    ok: true,
    removedRows: 0,
    archivedRows: 0,
    message: "Official 1.5 context storage does not require manual cache maintenance.",
  }));

  app.get("/api/v1/runtime/node-info", async (c) => {
    const sqlite = { available: false, databaseSync: false, exports: [] as string[], error: null as string | null };
    try {
      const { createRequire } = await import("node:module");
      const sqliteModule = createRequire(import.meta.url)("node:sqlite") as Record<string, unknown>;
      sqlite.available = true;
      sqlite.databaseSync = typeof sqliteModule.DatabaseSync === "function";
      sqlite.exports = Object.keys(sqliteModule).sort();
    } catch (error) {
      sqlite.error = error instanceof Error ? error.message : String(error);
    }
    return c.json({
      ok: true,
      node: { version: process.version, versions: process.versions, platform: process.platform, arch: process.arch, execPath: process.execPath },
      sqlite,
    });
  });

  app.get("/api/v1/runtime/python", async (c) => {
    const status = await detectPythonRuntime();
    return c.json({ ok: status.available, python: status });
  });

  app.post("/api/v1/runtime/python/self-test", async (c) => {
    const sample = Buffer.from("# Python self test\n\n林玄在旧楼里找到一份档案。\n", "utf-8").toString("base64");
    const extraction = await extractTextWithPython({ name: "self-test.md", base64: sample });
    const status = await detectPythonRuntime(true);
    return c.json(
      { ok: Boolean(extraction?.ok), python: status, extraction },
      extraction?.ok ? 200 : 503,
    );
  });

  app.get("/api/v1/runtime/maintenance/scan", async (c) => {
    const [python, report] = await Promise.all([
      detectPythonRuntime(),
      runMaintenanceScan(root),
    ]);
    broadcast("log", {
      level: report.ok ? "info" : "warn",
      tag: "maintenance",
      message: report.ok
        ? `Project health scan completed; files=${report.summary.totalFiles}, issues=${report.summary.issueCount}`
        : `Project health scan unavailable: ${report.error ?? "unknown error"}`,
    });
    return c.json({ ...report, ok: report.ok, python });
  });

  app.get("/api/v1/runtime/maintenance/repair-plan", async (c) => {
    return c.json(await buildMaintenanceRepairPlan(root));
  });

  app.post("/api/v1/runtime/maintenance/repair", async (c) => {
    const body = parseMaintenanceRepairRequest(await c.req.json<unknown>().catch(() => null));
    if (!body.confirm) {
      return c.json({ ok: false, error: "Maintenance repair requires confirm=true." }, 400);
    }
    if (body.actions.length === 0) {
      return c.json({ ok: false, error: "No supported maintenance repair actions were selected." }, 400);
    }
    const result = await runMaintenanceRepair(root, [...new Set(body.actions)]);
    broadcast("log", {
      level: "info",
      tag: "maintenance",
      message: `Project maintenance repair completed: ${result.results.map((item) => `${item.action}=${item.changed}`).join(", ")}`,
    });
    return c.json(result);
  });

  app.post("/api/v1/runtime/python/quality", async (c) => {
    const body = await c.req.json<{ text?: string }>().catch(() => ({ text: "" }));
    const text = typeof body.text === "string" ? body.text : "";
    if (!text || text.trim().length < 50) {
      return c.json({ ok: false, error: "Text too short for quality analysis (min 50 chars)." }, 400);
    }
    const result = await analyzeTextQuality(text);
    if (!result) {
      return c.json({ ok: false, error: "Python runtime unavailable for quality analysis." }, 503);
    }
    broadcast("log", {
      level: result.ok ? "info" : "warn",
      tag: "quality",
      message: result.ok
        ? `Text quality analysis completed: score=${result.overallScore ?? "?"}, warnings=${result.warnings?.length ?? 0}`
        : `Text quality analysis failed: ${result.error ?? "unknown"}`,
    });
    return c.json(result, result.ok ? 200 : 500);
  });

  app.get("/api/v1/runtime/maintenance/backup-diff", async (c) => {
    const backupsRoot = join(root, ".inkos", "backups");
    const entries = await readdir(backupsRoot, { withFileTypes: true }).catch(() => []);
    const dirs: Array<{ name: string; path: string; mtimeMs: number; bytes: number }> = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.endsWith(".gz")) continue;
      const dir = join(backupsRoot, entry.name);
      const info = await stat(dir).catch(() => null);
      if (!info?.isDirectory()) continue;
      const bytes = await directoryBytes(dir);
      dirs.push({ name: entry.name, path: dir, mtimeMs: info.mtimeMs, bytes });
    }
    dirs.sort((a, b) => b.mtimeMs - a.mtimeMs);
    if (dirs.length < 2) {
      return c.json({ ok: true, backups: dirs.length, message: dirs.length === 0 ? "No backups found." : "Only one backup exists; need at least two to compare." });
    }
    const [newer, older] = [dirs[0], dirs[1]];
    const newerFiles = new Set((await walkFiles(newer.path)).map((f) => relative(newer.path, f.path).replace(/\\/g, "/")));
    const olderFiles = new Set((await walkFiles(older.path)).map((f) => relative(older.path, f.path).replace(/\\/g, "/")));
    const added = [...newerFiles].filter((f) => !olderFiles.has(f));
    const removed = [...olderFiles].filter((f) => !newerFiles.has(f));
    const shared = [...newerFiles].filter((f) => olderFiles.has(f));
    const changed: string[] = [];
    for (const relPath of shared) {
      const newInfo = await stat(join(newer.path, relPath)).catch(() => null);
      const oldInfo = await stat(join(older.path, relPath)).catch(() => null);
      if (newInfo && oldInfo && newInfo.size !== oldInfo.size) {
        changed.push(relPath);
      }
    }
    return c.json({
      ok: true,
      newer: { name: newer.name, bytes: newer.bytes, files: newerFiles.size },
      older: { name: older.name, bytes: older.bytes, files: olderFiles.size },
      diff: { added, removed, changed, unchanged: shared.length - changed.length },
    });
  });

  app.get("/api/v1/tools/capabilities", (c) => c.json({ mode: "embedded-node", capabilities: NODE_TOOL_CAPABILITIES }));

  app.get("/api/v1/local-storage", async (c) => {
    await ensureProjectStorage(root);
    const probePath = join(root, ".inkos-node-write-test");
    await writeFile(probePath, String(Date.now()), "utf8");
    await rm(probePath, { force: true });
    return c.json({ mode: "node", available: true, directory: "NodeProjectRoot", uri: `file://${root}`, path: root });
  });
}
