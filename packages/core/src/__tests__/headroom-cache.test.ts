import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearAllL1Caches,
  embedTextInt8Async,
  ensureSemanticCacheStorage,
  getHeadroomSavingsTelemetry,
  getSemanticCache,
  getTokenDiagnostics,
  maintainSemanticCache,
  optimizeMessagesForTokenPipelineAsync,
  putSemanticCache,
  diffHeadroomSavingsTelemetry,
  recordTokenCompressionSavings,
  recordTokenOptimizationEvent,
} from "../utils/headroom-cache.js";
import type { LLMMessage, LLMResponse } from "../llm/provider.js";

const roots: string[] = [];

describe("headroom semantic cache", () => {
  afterEach(async () => {
    delete process.env.INKOS_DISABLE_NODE_SQLITE;
    delete process.env.INKOS_EMBEDDING_ENDPOINT;
    delete process.env.INKOS_HEADROOM_OFFICIAL;
    delete process.env.HEADROOM_BASE_URL;
    delete process.env.HEADROOM_API_KEY;
    clearAllL1Caches();
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("falls back to a disk cache when node:sqlite is unavailable", async () => {
    process.env.INKOS_DISABLE_NODE_SQLITE = "1";
    const projectRoot = await mkdtemp(join(tmpdir(), "inkos-headroom-cache-"));
    roots.push(projectRoot);

    const messages: LLMMessage[] = [
      { role: "system", content: "固定世界观：青云宗，灵脉复苏，主角谨慎。" },
      { role: "user", content: "生成一个客栈试探场景，主角不暴露实力。" },
    ];
    const response: LLMResponse = {
      content: "客栈里，掌柜试探主角来历，主角以散修身份含混带过。",
      usage: {
        promptTokens: 32,
        completionTokens: 24,
        totalTokens: 56,
      },
    };

    await putSemanticCache({
      projectRoot,
      bookId: "book-1",
      model: "test-model",
      service: "test-service",
    }, messages, response);

    const raw = await readFile(join(projectRoot, ".inkos", "cache", "semantic-cache.json"), "utf-8");
    expect(raw).toContain("test-model");

    await expect(getSemanticCache({
      projectRoot,
      bookId: "book-1",
      model: "test-model",
      service: "test-service",
    }, messages)).resolves.toEqual(response);
  });

  it("isolates semantic cache entries by book and generation variant", async () => {
    process.env.INKOS_DISABLE_NODE_SQLITE = "1";
    const projectRoot = await mkdtemp(join(tmpdir(), "inkos-headroom-isolation-"));
    roots.push(projectRoot);
    const messages: LLMMessage[] = [
      { role: "system", content: "固定世界观：同一套宗门模板。" },
      { role: "user", content: "续写下一段。" },
    ];
    const response: LLMResponse = {
      content: "仅属于第一本书的结果",
      usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
    };
    await putSemanticCache({
      projectRoot,
      bookId: "book-a",
      model: "test-model",
      service: "test-service",
      variant: "temperature=0.7",
    }, messages, response);

    await expect(getSemanticCache({
      projectRoot,
      bookId: "book-b",
      model: "test-model",
      service: "test-service",
      variant: "temperature=0.7",
    }, messages)).resolves.toBeNull();
    await expect(getSemanticCache({
      projectRoot,
      bookId: "book-a",
      model: "test-model",
      service: "test-service",
      variant: "temperature=1",
    }, messages)).resolves.toBeNull();
  });

  it("isolates L1 entries across different project roots", async () => {
    process.env.INKOS_DISABLE_NODE_SQLITE = "1";
    const firstRoot = await mkdtemp(join(tmpdir(), "inkos-headroom-project-a-"));
    const secondRoot = await mkdtemp(join(tmpdir(), "inkos-headroom-project-b-"));
    roots.push(firstRoot, secondRoot);
    const messages: LLMMessage[] = [
      { role: "system", content: "固定世界观：共享模板。" },
      { role: "user", content: "续写下一段。" },
    ];
    const response: LLMResponse = {
      content: "只属于第一个项目",
      usage: { promptTokens: 12, completionTokens: 8, totalTokens: 20 },
    };
    const context = {
      bookId: "same-book",
      model: "test-model",
      service: "test-service",
    };

    await putSemanticCache({ ...context, projectRoot: firstRoot }, messages, response);

    await expect(getSemanticCache({
      ...context,
      projectRoot: secondRoot,
    }, messages)).resolves.toBeNull();
  });

  it("quarantines a corrupt SQLite cache and recreates a usable database", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "inkos-headroom-corrupt-"));
    roots.push(projectRoot);
    const cacheDir = join(projectRoot, ".inkos", "cache");
    await mkdir(cacheDir, { recursive: true });
    await writeFile(join(cacheDir, "semantic-cache.db"), "not a sqlite database", "utf-8");

    const status = ensureSemanticCacheStorage(projectRoot);
    if (!status.sqliteAvailable) return;

    expect(status.error).toBeUndefined();
    const backups = await readdir(join(projectRoot, ".inkos", "repair-backups"));
    expect(backups.some((name) => name.startsWith("semantic-cache.db.corrupt-"))).toBe(true);
  });

  it("counts compression savings produced by tool-request optimization", () => {
    const before = getHeadroomSavingsTelemetry();
    recordTokenCompressionSavings(1_000, 600);
    const after = getHeadroomSavingsTelemetry();

    expect(after.ccrBlocksCompressed - before.ccrBlocksCompressed).toBe(1);
    expect(after.estimatedTokensSaved - before.estimatedTokensSaved).toBe(200);
  });

  it("diffs pipeline events by snapshot boundary instead of timestamp alone", () => {
    const fixedAt = Date.now();
    recordTokenOptimizationEvent({ kind: "cache-check", label: "语义缓存检查", at: fixedAt });
    const before = getHeadroomSavingsTelemetry();
    recordTokenOptimizationEvent({ kind: "cache-miss", label: "语义缓存未命中", at: fixedAt });

    const diff = diffHeadroomSavingsTelemetry(before);

    expect(diff.pipeline?.map((event) => event.kind)).toEqual(["cache-miss"]);
  });

  it("keeps local compression when official Headroom is not configured", async () => {
    const report = await optimizeMessagesForTokenPipelineAsync([
      { role: "system", content: "固定设定：非常非常重要。\n\n\n" },
      { role: "user", content: "继续写下一章。" },
    ], { model: "test-model", compress: true, minCompressChars: 1 });

    expect(report.messages[0]?.content).not.toContain("\n\n\n");
    expect(report.events.some((event) => event.kind === "headroom-fallback")).toBe(false);
  });

  it("can quantize an external bge-compatible embedding endpoint into int8 vectors", async () => {
    const originalFetch = globalThis.fetch;
    process.env.INKOS_EMBEDDING_ENDPOINT = "https://embedding.example.test/v1/embeddings";
    globalThis.fetch = (async () => new Response(JSON.stringify({
      data: [{ embedding: [0.1, -0.2, 0.4, 0.8] }],
    }), { status: 200, headers: { "Content-Type": "application/json" } })) as typeof fetch;
    try {
      const vector = await embedTextInt8Async("客栈 试探 主角");
      expect(vector).toBeInstanceOf(Int8Array);
      expect(vector.length).toBe(384);
      expect(Math.max(...Array.from(vector))).toBeGreaterThan(0);
      expect(Math.min(...Array.from(vector))).toBeLessThan(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("records embedding fallback diagnostics when an external endpoint fails", async () => {
    const originalFetch = globalThis.fetch;
    const projectRoot = await mkdtemp(join(tmpdir(), "inkos-headroom-embedding-fallback-"));
    roots.push(projectRoot);
    process.env.INKOS_EMBEDDING_ENDPOINT = "https://embedding.example.test/v1/embeddings";
    globalThis.fetch = (async () => new Response("bad gateway", { status: 502 })) as typeof fetch;
    try {
      const vector = await embedTextInt8Async("宗门议事 缓存 回退");
      const diagnostics = getTokenDiagnostics(projectRoot);

      expect(vector).toBeInstanceOf(Int8Array);
      expect(diagnostics.embedding).toMatchObject({
        configured: true,
        lastExternalOk: false,
        lastError: "HTTP 502",
      });
      expect(diagnostics.telemetry.pipeline?.some((event) => event.kind === "embedding-fallback")).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("reports semantic cache stats and runs maintenance without blocking on fallback storage", async () => {
    process.env.INKOS_DISABLE_NODE_SQLITE = "1";
    const projectRoot = await mkdtemp(join(tmpdir(), "inkos-headroom-maintenance-"));
    roots.push(projectRoot);
    const messages: LLMMessage[] = [
      { role: "system", content: "固定世界观：语义缓存维护测试。" },
      { role: "user", content: "生成宗门议事场景。" },
    ];
    await putSemanticCache({
      projectRoot,
      bookId: "book-maint",
      model: "test-model",
      service: "test-service",
    }, messages, {
      content: "宗门长老围绕资源分配争执。",
      usage: { promptTokens: 20, completionTokens: 10, totalTokens: 30 },
    });

    const before = getTokenDiagnostics(projectRoot);
    const result = maintainSemanticCache(projectRoot, { maxRows: 1, vacuum: true });
    const after = getTokenDiagnostics(projectRoot);

    expect(before.semanticCache.storage.sqliteAvailable).toBe(false);
    expect(before.semanticCache.fallbackRows).toBeGreaterThanOrEqual(1);
    expect(result.ok).toBe(true);
    expect(after.semanticCache.lastMaintenanceAt).toBeTypeOf("number");
    expect(after.telemetry.pipeline?.some((event) => event.kind === "cache-maintenance")).toBe(true);
  });
});
