import { Scheduler, type PipelineConfig, type ProjectConfig } from "@actalk/inkos-core";
import type { Hono } from "hono";

type BuildPipelineConfig = (
  overrides?: Partial<Pick<PipelineConfig, "externalContext" | "client" | "model" | "signal">> & {
    readonly currentConfig?: ProjectConfig;
    readonly sessionIdForSSE?: string;
    readonly bookId?: string;
  },
) => Promise<PipelineConfig>;

interface DaemonRoutesDeps {
  readonly loadCurrentProjectConfig: (options?: { readonly requireApiKey?: boolean }) => Promise<ProjectConfig>;
  readonly buildPipelineConfig: BuildPipelineConfig;
  readonly broadcast: (event: string, data: unknown) => void;
}

export function registerDaemonRoutes(app: Hono, deps: DaemonRoutesDeps): void {
  const { loadCurrentProjectConfig, buildPipelineConfig, broadcast } = deps;
  let schedulerInstance: Scheduler | null = null;

  app.get("/api/v1/daemon", (c) => {
    return c.json({
      running: schedulerInstance?.isRunning ?? false,
    });
  });

  app.post("/api/v1/daemon/start", async (c) => {
    if (schedulerInstance?.isRunning) {
      return c.json({ error: "Daemon already running" }, 400);
    }
    try {
      const currentConfig = await loadCurrentProjectConfig();
      const scheduler = new Scheduler({
        ...(await buildPipelineConfig({ currentConfig })),
        radarCron: currentConfig.daemon.schedule.radarCron,
        writeCron: currentConfig.daemon.schedule.writeCron,
        maxConcurrentBooks: currentConfig.daemon.maxConcurrentBooks,
        chaptersPerCycle: currentConfig.daemon.chaptersPerCycle,
        retryDelayMs: currentConfig.daemon.retryDelayMs,
        cooldownAfterChapterMs: currentConfig.daemon.cooldownAfterChapterMs,
        maxChaptersPerDay: currentConfig.daemon.maxChaptersPerDay,
        onChapterComplete: (bookId, chapter, status) => {
          broadcast("daemon:chapter", { bookId, chapter, status });
        },
        onError: (bookId, error) => {
          broadcast("daemon:error", { bookId, error: error.message });
        },
      });
      schedulerInstance = scheduler;
      broadcast("daemon:started", {});
      void scheduler.start().catch((e) => {
        const error = e instanceof Error ? e : new Error(String(e));
        if (schedulerInstance === scheduler) {
          scheduler.stop();
          schedulerInstance = null;
          broadcast("daemon:stopped", {});
        }
        broadcast("daemon:error", { bookId: "scheduler", error: error.message });
      });
      return c.json({ ok: true, running: true });
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  app.post("/api/v1/daemon/stop", (c) => {
    if (!schedulerInstance?.isRunning) {
      return c.json({ error: "Daemon not running" }, 400);
    }
    schedulerInstance.stop();
    schedulerInstance = null;
    broadcast("daemon:stopped", {});
    return c.json({ ok: true, running: false });
  });
}
