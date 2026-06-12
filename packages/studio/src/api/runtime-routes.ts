import type { StateManager } from "@actalk/inkos-core";
import type { Hono } from "hono";
import { copyFile, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

const DEFAULT_UPDATE_MANIFEST_URL = "https://github.com/Scl-Ywr/inkos/releases/latest/download/update.json";
const UPDATE_SOURCE_TIMEOUT_MS = 8_000;
const GITHUB_UPDATE_MIRROR_PREFIXES = [
  "https://ghproxy.net/",
  "https://ghfast.top/",
  "https://gh-proxy.com/",
  "https://githubproxy.cc/",
] as const;
const PROJECT_DIRS = [".inkos", ".inkos/sessions", ".inkos/backups", "books", "genres", "radar", "covers", "shorts", "exports", "logs"];

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
}

function envEnabled(name: string, fallback: boolean): boolean {
  const raw = String(process.env[name] ?? "").trim().toLowerCase();
  if (!raw) return fallback;
  return !["0", "false", "no", "off"].includes(raw);
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

async function ensureProjectStorage(root: string): Promise<void> {
  await Promise.all(PROJECT_DIRS.map((dir) => mkdir(join(root, dir), { recursive: true })));
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

export function registerRuntimeRoutes(app: Hono, deps: RuntimeRoutesDeps): void {
  const { root, state, broadcast } = deps;
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
    const bookIds = await state.listBooks();
    for (const bookId of bookIds) {
      await state.ensureControlDocuments(bookId);
      await state.saveChapterIndex(bookId, await state.loadChapterIndex(bookId));
    }
    broadcast("log", { level: "info", tag: "storage-repair", message: `Storage repair completed; metadata backup: ${backupDir}` });
    return c.json({ ok: true, root, backupDir, booksChecked: bookIds.length });
  });

  app.post("/api/v1/runtime/background-idle", (c) => {
    const gc = (globalThis as typeof globalThis & { gc?: () => void }).gc;
    gc?.();
    return c.json({ ok: true, message: "Released idle runtime references." });
  });

  app.get("/api/v1/runtime/token-savings", (c) => c.json({
    ok: true,
    telemetry: null,
    contextCompression: true,
  }));

  app.get("/api/v1/token-diagnostics", (c) => c.json({
    diagnostics: {
      headroom: { enabled: true, configured: false, lastCompressionOk: null, lastCompressionAt: null, lastError: null },
      embedding: { configured: false, endpoint: null, model: "built-in", lastExternalOk: null, lastExternalAt: null, lastFallbackAt: null, lastError: null },
      telemetry: {
        semanticL1Hits: 0,
        semanticL2Hits: 0,
        semanticMisses: 0,
        cacheSkippedCalls: 0,
        ccrBlocksCompressed: 0,
        originalChars: 0,
        optimizedChars: 0,
        estimatedTokensSaved: 0,
        pipeline: [],
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
  }));

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

  app.get("/api/v1/tools/capabilities", (c) => c.json({ mode: "embedded-node", capabilities: NODE_TOOL_CAPABILITIES }));

  app.get("/api/v1/local-storage", async (c) => {
    await ensureProjectStorage(root);
    const probePath = join(root, ".inkos-node-write-test");
    await writeFile(probePath, String(Date.now()), "utf8");
    await rm(probePath, { force: true });
    return c.json({ mode: "node", available: true, directory: "NodeProjectRoot", uri: `file://${root}`, path: root });
  });
}
