import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createStudioServer } from "./server";

const baseConfig = {
  name: "repair-test",
  version: "0.1.0",
  language: "zh",
  llm: {
    provider: "openai",
    service: "custom:Local",
    baseUrl: "http://127.0.0.1:11434/v1",
    model: "qwen-local",
    defaultModel: "qwen-local",
    services: [
      { service: "custom", name: "Local", baseUrl: "http://127.0.0.1:11434/v1" },
      { service: "moonshot" },
    ],
  },
  daemon: {
    schedule: { radarCron: "0 */6 * * *", writeCron: "*/15 * * * *" },
    maxConcurrentBooks: 1,
    chaptersPerCycle: 1,
    retryDelayMs: 30000,
    cooldownAfterChapterMs: 0,
    maxChaptersPerDay: 50,
  },
  modelOverrides: {},
  notify: [],
};

describe("service config repair", () => {
  let root: string;

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("removes deleted provider from config, secrets, and active model selection", async () => {
    root = await mkdtemp(join(tmpdir(), "inkos-service-delete-"));
    await mkdir(join(root, ".inkos"), { recursive: true });
    await writeFile(join(root, "inkos.json"), JSON.stringify(baseConfig, null, 2), "utf-8");
    await writeFile(join(root, ".inkos", "secrets.json"), JSON.stringify({
      services: {
        "custom:Local": { apiKey: "local-key" },
        moonshot: { apiKey: "moon-key" },
      },
    }, null, 2), "utf-8");

    const app = createStudioServer(baseConfig as never, root);
    const res = await app.request("http://localhost/api/v1/services/custom%3ALocal", {
      method: "DELETE",
    });

    expect(res.status).toBe(200);
    const config = JSON.parse(await readFile(join(root, "inkos.json"), "utf-8"));
    expect(config.llm.services).toEqual([{ service: "moonshot" }]);
    expect(config.llm.service).toBe("moonshot");
    expect(config.llm.model).toBeUndefined();
    expect(config.llm.defaultModel).toBeUndefined();

    const secrets = JSON.parse(await readFile(join(root, ".inkos", "secrets.json"), "utf-8"));
    expect(secrets.services["custom:Local"]).toBeUndefined();
    expect(secrets.services.moonshot).toEqual({ apiKey: "moon-key" });
  });

  it("backs up incompatible local files and restores a bootable project config", async () => {
    root = await mkdtemp(join(tmpdir(), "inkos-startup-repair-"));
    await mkdir(join(root, ".inkos"), { recursive: true });
    await writeFile(join(root, "inkos.json"), "{ broken json", "utf-8");
    await writeFile(join(root, ".inkos", "secrets.json"), "[]", "utf-8");

    const app = createStudioServer(baseConfig as never, root);
    const res = await app.request("http://localhost/api/v1/doctor/repair", { method: "POST" });

    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; repaired: ReadonlyArray<{ action: string }> };
    expect(body.ok).toBe(true);
    expect(body.repaired.some((entry) => entry.action === "backup-incompatible-file")).toBe(true);

    const config = JSON.parse(await readFile(join(root, "inkos.json"), "utf-8"));
    expect(config.name).toBe("InkOS Studio");
    expect(config.llm.configSource).toBe("studio");

    const backups = await readdir(join(root, ".inkos", "repair-backups"));
    expect(backups.some((file) => file.startsWith("inkos.json.invalid-json"))).toBe(true);
    expect(backups.some((file) => file.startsWith("secrets.json.non-object-json"))).toBe(true);
  });
});
