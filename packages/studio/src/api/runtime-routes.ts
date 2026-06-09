import {
  clearIdleL1Caches,
  ensureSemanticCacheStorage,
  getHeadroomSavingsTelemetry,
  getTokenDiagnostics,
  maintainSemanticCache,
  type StateManager,
} from "@actalk/inkos-core";
import type { Hono } from "hono";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const NODE_TOOL_CAPABILITIES = [
  "PipelineRunner.sub_agent.architect",
  "PipelineRunner.sub_agent.writer",
  "PipelineRunner.sub_agent.auditor",
  "PipelineRunner.sub_agent.reviser",
  "PipelineRunner.sub_agent.exporter",
  "createInteractionToolsFromDeps.writeTruthFile",
  "createInteractionToolsFromDeps.renameEntity",
  "createInteractionToolsFromDeps.patchChapterText",
  "short_fiction_run",
  "generate_cover",
  "Scheduler",
].map((id) => ({
  id,
  desktopSource: id,
  apkStatus: "implemented",
  apkTool: "node-backend",
  notes: "由 APK 内置 Node.js 后端直接运行，不使用 WebView JS fallback。",
}));

const DEFAULT_UPDATE_MANIFEST_URL = "https://github.com/Scl-Ywr/inkos/releases/latest/download/update.json";

interface AndroidUpdateManifest {
  readonly channel: string;
  readonly versionName: string;
  readonly versionCode: number;
  readonly minVersionCode: number;
  readonly apkUrl: string;
  readonly apkSha256: string;
  readonly size: number;
  readonly notes: string[];
  readonly publishedAt: string;
}

interface StorageRepairEntry {
  readonly action: string;
  readonly path: string;
  readonly detail?: string;
}

interface RuntimeRoutesDeps {
  readonly root: string;
  readonly state: StateManager;
  readonly ensureProjectStorageSkeleton: (root: string) => Promise<void>;
  readonly repairProjectResourceIndex: (root: string) => Promise<ReadonlyArray<StorageRepairEntry>>;
  readonly broadcast: (event: string, data: unknown) => void;
}

function readAndroidVersionCode(): number {
  const raw = Number(process.env.INKOS_ANDROID_VERSION_CODE ?? 0);
  return Number.isInteger(raw) && raw > 0 ? raw : 0;
}

function readAndroidVersionName(): string {
  return String(process.env.INKOS_ANDROID_VERSION_NAME ?? "").trim();
}

function parseUpdateManifest(value: unknown): AndroidUpdateManifest {
  if (!value || typeof value !== "object") {
    throw new Error("Update manifest is not a JSON object.");
  }
  const record = value as Record<string, unknown>;
  const versionCode = Number(record.versionCode);
  const minVersionCode = Number(record.minVersionCode ?? 1);
  const size = Number(record.size ?? 0);
  const versionName = String(record.versionName ?? "").trim();
  const channel = String(record.channel ?? "stable").trim() || "stable";
  const apkUrl = String(record.apkUrl ?? "").trim();
  const apkSha256 = String(record.apkSha256 ?? "").trim().toLowerCase();
  const publishedAt = String(record.publishedAt ?? "").trim();
  const notes = Array.isArray(record.notes)
    ? record.notes.map((note) => String(note).trim()).filter(Boolean)
    : [];

  if (!Number.isInteger(versionCode) || versionCode <= 0) {
    throw new Error("Update manifest versionCode must be a positive integer.");
  }
  if (!Number.isInteger(minVersionCode) || minVersionCode <= 0) {
    throw new Error("Update manifest minVersionCode must be a positive integer.");
  }
  if (!versionName) throw new Error("Update manifest versionName is required.");
  if (!/^https:\/\//i.test(apkUrl)) throw new Error("Update manifest apkUrl must be an HTTPS URL.");
  if (!/^[a-f0-9]{64}$/i.test(apkSha256)) throw new Error("Update manifest apkSha256 must be a SHA-256 hex digest.");
  if (!Number.isFinite(size) || size <= 0) throw new Error("Update manifest size must be positive.");

  return {
    channel,
    versionName,
    versionCode,
    minVersionCode,
    apkUrl,
    apkSha256,
    size: Math.floor(size),
    notes,
    publishedAt,
  };
}

export function registerRuntimeRoutes(app: Hono, deps: RuntimeRoutesDeps): void {
  const { root, state, ensureProjectStorageSkeleton, repairProjectResourceIndex, broadcast } = deps;
  let semanticCacheStorage = ensureSemanticCacheStorage(root);

  app.get("/api/v1/runtime/status", (c) => {
    return c.json({
      state: "running",
      message: `Node backend is serving API requests on this device. Project root: ${root}`,
      updatedAt: Date.now(),
    });
  });

  app.get("/api/v1/runtime/update/check", async (c) => {
    const manifestUrl = String(process.env.INKOS_UPDATE_MANIFEST_URL ?? DEFAULT_UPDATE_MANIFEST_URL).trim();
    const currentVersionCode = readAndroidVersionCode();
    const currentVersionName = readAndroidVersionName();
    try {
      const response = await fetch(manifestUrl, {
        headers: { Accept: "application/json", "User-Agent": "InkOS-Studio-Update-Check" },
      });
      if (!response.ok) {
        return c.json({
          ok: false,
          manifestUrl,
          current: {
            versionCode: currentVersionCode,
            versionName: currentVersionName,
          },
          error: `Update manifest returned HTTP ${response.status}.`,
        }, 502);
      }
      const update = parseUpdateManifest(await response.json());
      const supported = currentVersionCode > 0;
      const available = supported
        && update.versionCode > currentVersionCode
        && currentVersionCode >= update.minVersionCode;
      return c.json({
        ok: true,
        manifestUrl,
        current: {
          versionCode: currentVersionCode,
          versionName: currentVersionName,
        },
        supported,
        available,
        update,
      });
    } catch (error) {
      return c.json({
        ok: false,
        manifestUrl,
        current: {
          versionCode: currentVersionCode,
          versionName: currentVersionName,
        },
        error: error instanceof Error ? error.message : String(error),
      }, 502);
    }
  });

  app.post("/api/v1/runtime/repair", async (c) => {
    const repaired = await ensureProjectStorageSkeleton(root)
      .then(() => repairProjectResourceIndex(root));
    broadcast("log", {
      level: "info",
      tag: "storage-repair",
      message: `资源自检修复完成：${repaired.length} 项`,
      timestamp: new Date().toISOString(),
    });
    return c.json({
      ok: true,
      root,
      repaired,
      message: "资源自检修复完成。已保证书籍索引、核心文件、角色目录和占位文件与当前版本兼容。",
    });
  });

  app.post("/api/v1/runtime/background-idle", async (c) => {
    const removed = await clearIdleL1Caches();
    return c.json({
      ok: true,
      removed,
      message: `Released ${removed} idle L1 cache entr${removed === 1 ? "y" : "ies"}.`,
    });
  });

  app.get("/api/v1/runtime/token-savings", (c) => c.json({
    ok: true,
    telemetry: getHeadroomSavingsTelemetry(),
    storage: semanticCacheStorage,
  }));

  app.get("/api/v1/token-diagnostics", (c) => {
    semanticCacheStorage = ensureSemanticCacheStorage(root);
    return c.json({
      ok: true,
      projectRoot: root,
      diagnostics: getTokenDiagnostics(root),
    });
  });

  app.post("/api/v1/token-cache/maintenance", async (c) => {
    const body = await c.req
      .json<{ maxRows?: number; vacuum?: boolean }>()
      .catch((): { maxRows?: number; vacuum?: boolean } => ({}));
    const result = maintainSemanticCache(root, {
      ...(typeof body.maxRows === "number" ? { maxRows: body.maxRows } : {}),
      ...(typeof body.vacuum === "boolean" ? { vacuum: body.vacuum } : {}),
    });
    semanticCacheStorage = result.storage;
    return c.json(result, result.ok ? 200 : 500);
  });

  app.get("/api/v1/runtime/node-info", async (c) => {
    const sqlite: {
      available: boolean;
      databaseSync: boolean;
      exports: string[];
      error: string | null;
    } = {
      available: false,
      databaseSync: false,
      exports: [],
      error: null,
    };

    try {
      const { createRequire } = await import("node:module");
      const nodeRequire = createRequire(import.meta.url);
      const sqliteModule = nodeRequire("node:sqlite") as Record<string, unknown>;
      sqlite.available = true;
      sqlite.databaseSync = typeof sqliteModule.DatabaseSync === "function";
      sqlite.exports = Object.keys(sqliteModule).sort();
    } catch (error) {
      sqlite.error = error instanceof Error ? error.message : String(error);
    }

    semanticCacheStorage = ensureSemanticCacheStorage(root);

    return c.json({
      ok: true,
      node: {
        version: process.version,
        versions: process.versions,
        platform: process.platform,
        arch: process.arch,
        abi: process.versions.modules,
        execPath: process.execPath,
      },
      sqlite,
      semanticCacheStorage,
    });
  });

  app.get("/api/v1/tools/capabilities", (c) => {
    return c.json({
      mode: "embedded-node",
      capabilities: NODE_TOOL_CAPABILITIES,
    });
  });

  app.get("/api/v1/local-storage", async (c) => {
    await ensureProjectStorageSkeleton(root);
    const bookIds = await state.listBooks();
    for (const bookId of bookIds) {
      await state.ensureControlDocuments(bookId);
      await state.saveChapterIndex(bookId, await state.loadChapterIndex(bookId));
    }
    const probePath = join(root, ".inkos-node-write-test");
    await writeFile(probePath, String(Date.now()), "utf-8");
    await rm(probePath, { force: true });
    return c.json({
      mode: "node",
      available: true,
      directory: "NodeProjectRoot",
      uri: `file://${root}`,
      path: root,
      permission: "APK 内置 Node 后端已在 Documents/InkOS Studio 中创建并验证项目目录，可读写书籍、章节、题材、日志和雷达数据。",
    });
  });
}
