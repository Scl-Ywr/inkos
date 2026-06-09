import { GLOBAL_ENV_PATH, type ProjectConfig, type StateManager } from "@actalk/inkos-core";
import type { Hono } from "hono";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { StorageRepairEntry } from "./storage-repair.js";

interface DoctorProbeServiceCapabilitiesInput {
  readonly root: string;
  readonly service: string;
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly preferredApiFormat?: "chat" | "responses";
  readonly preferredStream?: boolean;
  readonly preferredModel?: string;
  readonly proxyUrl?: string;
}

interface DoctorRoutesDeps {
  readonly root: string;
  readonly state: StateManager;
  readonly loadCurrentProjectConfig: (options?: { readonly requireApiKey?: boolean }) => Promise<ProjectConfig>;
  readonly probeServiceCapabilities: (args: DoctorProbeServiceCapabilitiesInput) => Promise<{ readonly ok: boolean }>;
  readonly repairStudioStartupCompatibility: (root: string) => Promise<ReadonlyArray<StorageRepairEntry>>;
  readonly ensureProjectStorageSkeleton: (root: string) => Promise<void>;
}

export function registerDoctorRoutes(app: Hono, deps: DoctorRoutesDeps): void {
  const {
    root,
    state,
    loadCurrentProjectConfig,
    probeServiceCapabilities,
    repairStudioStartupCompatibility,
    ensureProjectStorageSkeleton,
  } = deps;

  app.get("/api/v1/doctor", async (c) => {
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
    } catch {
      // Diagnostics should stay best-effort.
    }

    try {
      const currentConfig = await loadCurrentProjectConfig({ requireApiKey: false });
      const service = currentConfig.llm.service ?? currentConfig.llm.provider;
      const probe = await probeServiceCapabilities({
        root,
        service,
        apiKey: currentConfig.llm.apiKey,
        baseUrl: currentConfig.llm.baseUrl,
        preferredApiFormat: currentConfig.llm.apiFormat,
        preferredStream: currentConfig.llm.stream,
        preferredModel: currentConfig.llm.model,
        proxyUrl: currentConfig.llm.proxyUrl,
      });
      checks.llmConnected = probe.ok;
    } catch {
      // Diagnostics should stay best-effort.
    }

    return c.json(checks);
  });

  app.post("/api/v1/doctor/repair", async (c) => {
    const repaired = await repairStudioStartupCompatibility(root);
    await ensureProjectStorageSkeleton(root);
    return c.json({ ok: true, repaired });
  });
}
