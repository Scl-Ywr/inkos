import type { LogEntry } from "@actalk/inkos-core";
import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { agentSessionIdFromOperationKey } from "./active-operations.js";
import type { EventHandler, OperationRuntime } from "./operation-runtime.js";
import {
  mergeLogEntries,
  normalizeLogLimit,
  parseJsonLineLogEntries,
} from "./server-logs.js";

interface OperationRuntimeRoutesDeps {
  readonly root: string;
  readonly runtime: OperationRuntime;
}

export function registerOperationRuntimeRoutes(
  app: Hono,
  deps: OperationRuntimeRoutesDeps,
): void {
  const { root, runtime } = deps;

  app.get("/api/v1/active-operations", (c) => {
    return c.json({ operations: runtime.listActiveOperations() });
  });

  app.get("/api/v1/operations/history", async (c) => {
    await runtime.waitForOperationHistoryStorage();
    const limit = Number.parseInt(c.req.query("limit") ?? "", 10);
    return c.json({ operations: runtime.historyOperations(limit) });
  });

  app.post("/api/v1/active-operations/:operationId/cancel", (c) => {
    const operationId = decodeURIComponent(c.req.param("operationId"));
    runtime.markOperationCancelled(operationId);
    runtime.broadcast("agent:error", {
      sessionId: agentSessionIdFromOperationKey(operationId) ?? undefined,
      error: "用户已停止当前生成。",
    });
    return c.json({ ok: true, operationId });
  });

  app.get("/api/v1/agent-results/:sessionId/:requestId", (c) => {
    const sessionId = c.req.param("sessionId");
    const requestId = c.req.param("requestId");
    const result = runtime.getAgentRequestResult(sessionId, requestId);
    if (!result) {
      return c.json({ status: "pending" }, 202);
    }
    return c.json({
      status: "completed",
      completedAt: result.completedAt,
      responseStatus: result.status,
      payload: result.payload,
    });
  });

  app.get("/api/v1/logs", async (c) => {
    const limit = normalizeLogLimit(c.req.query("limit"));
    const memoryEntries = runtime.latestLogs(limit);
    let fileEntries: LogEntry[] = [];
    try {
      fileEntries = parseJsonLineLogEntries(await readFile(join(root, "inkos.log"), "utf-8"), limit);
    } catch {
      fileEntries = [];
    }
    const entries = mergeLogEntries(fileEntries, memoryEntries, limit);
    return c.json({ entries });
  });

  app.delete("/api/v1/logs", async (c) => {
    runtime.clearLogs();
    await writeFile(join(root, "inkos.log"), "", "utf-8").catch(() => undefined);
    runtime.broadcast("logs:clear", { timestamp: new Date().toISOString() });
    return c.json({ status: "cleared" });
  });

  app.get("/api/v1/events", (c) => {
    return streamSSE(c, async (stream) => {
      const handler: EventHandler = (event, data) => {
        stream.writeSSE({ event, data: JSON.stringify(data) });
      };
      const unsubscribe = runtime.subscribe(handler);
      await stream.writeSSE({ event: "ping", data: "" });

      const activeOperations = runtime.listActiveOperations();
      if (activeOperations.length > 0) {
        await stream.writeSSE({
          event: "operations:restore",
          data: JSON.stringify({ operations: activeOperations }),
        });
      }

      const keepAlive = setInterval(() => {
        stream.writeSSE({ event: "ping", data: "" });
      }, 30_000);

      stream.onAbort(() => {
        unsubscribe();
        clearInterval(keepAlive);
      });

      await new Promise(() => {});
    });
  });
}
