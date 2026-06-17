import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildUpdateManifestCandidates,
  initializeStudioProject,
  PROJECT_DIRS,
  registerRuntimeRoutes,
} from "./runtime-routes";

const OFFICIAL_MANIFEST = "https://github.com/example/inkos/releases/latest/download/update.json";

function createApp(root = "D:/inkos-test") {
  const app = new Hono();
  let headroomStatus: {
    enabled: boolean;
    configured: boolean;
    state: string;
    mode: string;
    command: string;
    args: string[];
    tools: string[];
    lastCheckedAt: string | null;
    lastCompressionAt: string | null;
    lastCompressionOk: boolean | null;
    lastError: string | null;
    stats: null;
    session: {
      compressions: number;
      originalTokens: number;
      compressedTokens: number;
      tokensSaved: number;
      originalChars: number;
      compressedChars: number;
    };
  } = {
    enabled: true,
    configured: true,
    state: "offline",
    mode: "external-mcp",
    command: "headroom",
    args: ["mcp", "serve"],
    tools: [],
    lastCheckedAt: null,
    lastCompressionAt: null,
    lastCompressionOk: null,
    lastError: "not installed",
    stats: null,
    session: {
      compressions: 0,
      originalTokens: 0,
      compressedTokens: 0,
      tokensSaved: 0,
      originalChars: 0,
      compressedChars: 0,
    },
  };
  registerRuntimeRoutes(app, {
    root,
    state: {} as never,
    broadcast: vi.fn(),
    headroom: {
      getStatus: () => headroomStatus,
      check: async () => headroomStatus,
      compress: async () => {
        headroomStatus = {
          ...headroomStatus,
          state: "online",
          tools: ["headroom_compress", "headroom_retrieve", "headroom_stats"],
          lastCompressionAt: "2026-06-15T00:00:00.000Z",
          lastCompressionOk: true,
          lastError: null,
          session: {
            compressions: 1,
            originalTokens: 1000,
            compressedTokens: 300,
            tokensSaved: 700,
            originalChars: 4000,
            compressedChars: 1200,
          },
        };
        return { compressed: "compressed sample", originalTokens: 1000, compressedTokens: 300, transforms: [] };
      },
    } as never,
  });
  return app;
}

function updateManifest() {
  return {
    channel: "stable",
    versionName: "1.5.0-2",
    versionCode: 152,
    minVersionCode: 1,
    apkUrl: "https://github.com/example/inkos/releases/download/apk-v1.5.0-2/inkos.apk",
    apkMirrorUrls: [
      "https://ghproxy.net/https://github.com/example/inkos/releases/download/apk-v1.5.0-2/inkos.apk",
    ],
    apkSha256: "a".repeat(64),
    size: 1024,
    notes: ["mirror update"],
    publishedAt: "2026-06-12T00:00:00.000Z",
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.INKOS_UPDATE_MANIFEST_URL;
  delete process.env.INKOS_UPDATE_MANIFEST_URLS;
  delete process.env.INKOS_ANDROID_VERSION_CODE;
  delete process.env.INKOS_ANDROID_VERSION_NAME;
});

describe("Android update manifest fallback", () => {
  it("builds GitHub mirror candidates and keeps configured sources", () => {
    process.env.INKOS_UPDATE_MANIFEST_URLS = "https://updates.example.com/update.json";
    const candidates = buildUpdateManifestCandidates(OFFICIAL_MANIFEST);

    expect(candidates[0]).toBe(OFFICIAL_MANIFEST);
    expect(candidates).toContain("https://updates.example.com/update.json");
    expect(candidates).toContain(`https://ghproxy.net/${OFFICIAL_MANIFEST}`);
  });

  it("detects an update through a mirror when GitHub is unreachable", async () => {
    process.env.INKOS_UPDATE_MANIFEST_URL = OFFICIAL_MANIFEST;
    process.env.INKOS_ANDROID_VERSION_CODE = "151";
    process.env.INKOS_ANDROID_VERSION_NAME = "1.5.0-1";
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === `https://ghproxy.net/${OFFICIAL_MANIFEST}`) {
        return new Response(JSON.stringify(updateManifest()), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error("direct GitHub connection failed");
    }));

    const response = await createApp().request("http://localhost/api/v1/runtime/update/check");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      available: true,
      manifestUrl: `https://ghproxy.net/${OFFICIAL_MANIFEST}`,
      update: {
        versionCode: 152,
        apkMirrorUrls: [
          "https://ghproxy.net/https://github.com/example/inkos/releases/download/apk-v1.5.0-2/inkos.apk",
        ],
      },
    });
  });

  it("reports unreachable sources instead of pretending there is no update", async () => {
    process.env.INKOS_UPDATE_MANIFEST_URL = OFFICIAL_MANIFEST;
    process.env.INKOS_ANDROID_VERSION_CODE = "151";
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("network blocked");
    }));

    const response = await createApp().request("http://localhost/api/v1/runtime/update/check");
    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("无法连接在线更新源"),
    });
  });
});

describe("Headroom diagnostics", () => {
  it("reports the real offline MCP state instead of a fixed enabled status", async () => {
    const response = await createApp().request("http://localhost/api/v1/token-diagnostics");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      diagnostics: {
        headroom: {
          state: "offline",
          lastError: "not installed",
        },
        telemetry: {
          ccrBlocksCompressed: 0,
          estimatedTokensSaved: 0,
        },
      },
    });
  });

  it("returns a failing health response while Headroom MCP is offline", async () => {
    const response = await createApp().request("http://localhost/api/v1/token-diagnostics/headroom/check", {
      method: "POST",
    });
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      headroom: { state: "offline" },
    });
  });

  it("runs a real Headroom compression self-test and reports updated savings", async () => {
    const app = createApp();
    const response = await app.request("http://localhost/api/v1/token-diagnostics/headroom/self-test", {
      method: "POST",
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      headroom: {
        state: "online",
        session: {
          compressions: 1,
          tokensSaved: 700,
        },
      },
      result: {
        compressed: "compressed sample",
      },
    });
  });
});

describe("Project maintenance diagnostics", () => {
  it("returns a structured maintenance scan response without mutating files", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-maintenance-route-"));
    try {
      await writeFile(join(root, "runtime-status.json"), "{\"state\":\"test\"}\n", "utf-8");
      const app = createApp(root);
      const response = await app.request("http://localhost/api/v1/runtime/maintenance/scan");
      expect(response.status).toBe(200);
      const payload = await response.json() as {
        ok: boolean;
        summary: { root: string; issueCount: number };
        sections: Record<string, unknown>;
        issues: unknown[];
        recommendations: unknown[];
      };
      expect(typeof payload.ok).toBe("boolean");
      expect(payload.summary.root).toBe(root);
      expect(payload.sections.books).toBeTruthy();
      expect(payload.sections.worlds).toBeTruthy();
      expect(payload.sections.knowledge).toBeTruthy();
      expect(Array.isArray(payload.issues)).toBe(true);
      expect(Array.isArray(payload.recommendations)).toBe(true);
      await expect(readFile(join(root, "runtime-status.json"), "utf-8")).resolves.toContain("\"state\":\"test\"");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("requires explicit confirmation before running project maintenance repairs", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-maintenance-confirm-"));
    try {
      await mkdir(join(root, "logs"), { recursive: true });
      await writeFile(join(root, "logs", "old.log"), "old log", "utf-8");
      const oldDate = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000);
      await utimes(join(root, "logs", "old.log"), oldDate, oldDate);

      const app = createApp(root);
      const response = await app.request("http://localhost/api/v1/runtime/maintenance/repair", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ actions: ["cleanup-old-logs"] }),
      });

      expect(response.status).toBe(400);
      await expect(readFile(join(root, "logs", "old.log"), "utf-8")).resolves.toBe("old log");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("runs confirmed maintenance repairs for logs, worlds, knowledge indexes, and backups", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-maintenance-repair-"));
    try {
      await mkdir(join(root, "logs"), { recursive: true });
      await mkdir(join(root, "worlds", "orphan-world"), { recursive: true });
      await mkdir(join(root, "worlds", "active-play"), { recursive: true });
      await mkdir(join(root, ".inkos", "sessions"), { recursive: true });
      await mkdir(join(root, "knowledge", "books", "demo"), { recursive: true });
      await mkdir(join(root, ".inkos", "backups", "upgrade-old"), { recursive: true });

      await writeFile(join(root, "logs", "old.log"), "old log", "utf-8");
      await writeFile(join(root, "worlds", "orphan-world", "world.json"), JSON.stringify({
        id: "orphan-world",
        title: "Orphan",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }), "utf-8");
      await writeFile(join(root, "worlds", "active-play", "world.json"), JSON.stringify({
        id: "active-play",
        title: "Active",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }), "utf-8");
      await writeFile(join(root, ".inkos", "sessions", "active-play.json"), JSON.stringify({
        sessionId: "active-play",
        bookId: null,
        title: "Active",
        updatedAt: "2026-01-01T00:00:00.000Z",
        sessionKind: "play",
      }), "utf-8");
      await writeFile(join(root, "knowledge", "books", "demo", "sources.json"), JSON.stringify([
        { id: "source-1", name: "Source", chunkCount: 2 },
      ]), "utf-8");
      await writeFile(join(root, "knowledge", "books", "demo", "chunks.json"), JSON.stringify([
        { id: "chunk-1", sourceId: "source-1", sourceName: "Source", text: "alpha beta", keywords: ["alpha"] },
        { id: "chunk-2", sourceId: "missing", sourceName: "Missing", text: "orphan", keywords: [] },
      ]), "utf-8");
      await writeFile(join(root, ".inkos", "backups", "upgrade-old", "inkos.json"), "{\"name\":\"backup\"}", "utf-8");

      const oldDate = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000);
      await Promise.all([
        utimes(join(root, "logs", "old.log"), oldDate, oldDate),
        utimes(join(root, ".inkos", "backups", "upgrade-old"), oldDate, oldDate),
      ]);

      const app = createApp(root);
      const planResponse = await app.request("http://localhost/api/v1/runtime/maintenance/repair-plan");
      expect(planResponse.status).toBe(200);
      const plan = await planResponse.json() as { actions: Array<{ action: string; enabled: boolean; count: number }> };
      expect(plan.actions.find((item) => item.action === "cleanup-old-logs")).toMatchObject({ enabled: true, count: 1 });
      expect(plan.actions.find((item) => item.action === "prune-orphan-worlds")).toMatchObject({ enabled: true, count: 1 });
      expect(plan.actions.find((item) => item.action === "rebuild-knowledge-indexes")).toMatchObject({ enabled: true, count: 1 });
      expect(plan.actions.find((item) => item.action === "compress-backups")).toMatchObject({ enabled: true, count: 1 });

      const repairResponse = await app.request("http://localhost/api/v1/runtime/maintenance/repair", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          confirm: true,
          actions: ["cleanup-old-logs", "prune-orphan-worlds", "rebuild-knowledge-indexes", "compress-backups"],
        }),
      });
      expect(repairResponse.status).toBe(200);
      await expect(readFile(join(root, "logs", "old.log"), "utf-8")).rejects.toThrow();
      await expect(stat(join(root, "worlds", "orphan-world"))).rejects.toThrow();
      await expect(stat(join(root, "worlds", "active-play"))).resolves.toBeTruthy();
      await expect(readFile(join(root, "knowledge", "books", "demo", "search-index.json"), "utf-8")).resolves.toContain("\"chunkCount\":1");
      await expect(readFile(join(root, "knowledge", "books", "demo", "chunks.json"), "utf-8")).resolves.not.toContain("missing");
      await expect(stat(join(root, ".inkos", "backups", "upgrade-old"))).rejects.toThrow();
      await expect(stat(join(root, ".inkos", "backups", "upgrade-old.json.gz"))).resolves.toBeTruthy();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("Studio first-run project initialization", () => {
  it("creates the project layout and a loadable default config in an empty directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-studio-first-run-"));
    try {
      await initializeStudioProject(root);

      for (const directory of PROJECT_DIRS) {
        expect((await stat(join(root, directory))).isDirectory()).toBe(true);
      }
      await expect(readFile(join(root, "inkos.json"), "utf-8")).resolves.toContain('"configSource": "studio"');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves an existing project config", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-studio-existing-"));
    const configPath = join(root, "inkos.json");
    const existing = '{"name":"existing"}\n';
    try {
      await writeFile(configPath, existing, "utf-8");
      await initializeStudioProject(root);
      await expect(readFile(configPath, "utf-8")).resolves.toBe(existing);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
