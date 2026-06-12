import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { buildUpdateManifestCandidates, registerRuntimeRoutes } from "./runtime-routes";

const OFFICIAL_MANIFEST = "https://github.com/example/inkos/releases/latest/download/update.json";

function createApp() {
  const app = new Hono();
  registerRuntimeRoutes(app, {
    root: "D:/inkos-test",
    state: {} as never,
    broadcast: vi.fn(),
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
