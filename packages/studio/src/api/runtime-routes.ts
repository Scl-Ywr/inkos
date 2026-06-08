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
