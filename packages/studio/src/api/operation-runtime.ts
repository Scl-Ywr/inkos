import { writeFile } from "node:fs/promises";
import type { FileAuditEvent, LogEntry } from "@actalk/inkos-core";
import {
  ActiveOperationRegistry,
  type ActiveOperation,
  type ActiveOperationInput,
  type OperationFinishInput,
  type OperationHistoryItem,
} from "./active-operations.js";
import { AgentRequestResultCache, type AgentRequestResult } from "./agent-request-results.js";
import {
  OPERATION_HISTORY_LIMIT,
  loadOperationHistory,
  saveOperationHistory,
} from "./operation-history-store.js";
import {
  DEFAULT_LOG_BUFFER_SIZE,
  LogRingBuffer,
  formatFileAuditMessage,
  writeConsoleLogEntry,
} from "./server-logs.js";

export type EventHandler = (event: string, data: unknown) => void;

interface RuntimeTokenUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
}

interface RuntimeTokenSavings {
  readonly estimatedTokensSaved: number;
}

interface RuntimeNotice {
  readonly id: string;
  readonly kind: "completed" | "error";
  readonly title: string;
  readonly message: string;
  readonly createdAt: number;
  readonly tokenUsage?: RuntimeTokenUsage;
  readonly tokenSavings?: RuntimeTokenSavings;
}

interface RuntimeProgressPayload {
  readonly state: "busy" | "idle";
  readonly label: string;
  readonly message: string;
  readonly updatedAt: number;
  readonly activeCount: number;
  readonly notice: RuntimeNotice | null;
  readonly type?: ActiveOperation["type"];
  readonly bookId?: string;
  readonly chapter?: number | null;
  readonly sessionId?: string | null;
  readonly startedAt?: number;
}

function hasErrorCode(error: unknown, code: string): boolean {
  return Boolean(
    error
      && typeof error === "object"
      && "code" in error
      && (error as { readonly code?: unknown }).code === code,
  );
}

function readRuntimeTokenUsage(value: unknown): RuntimeTokenUsage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const promptTokens = typeof record.promptTokens === "number" && Number.isFinite(record.promptTokens)
    ? Math.max(0, Math.floor(record.promptTokens))
    : 0;
  const completionTokens = typeof record.completionTokens === "number" && Number.isFinite(record.completionTokens)
    ? Math.max(0, Math.floor(record.completionTokens))
    : 0;
  const totalTokens = typeof record.totalTokens === "number" && Number.isFinite(record.totalTokens)
    ? Math.max(0, Math.floor(record.totalTokens))
    : promptTokens + completionTokens;
  if (totalTokens <= 0) return undefined;
  return { promptTokens, completionTokens, totalTokens };
}

function readRuntimeTokenSavings(value: unknown): RuntimeTokenSavings | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const estimatedTokensSaved = typeof record.estimatedTokensSaved === "number" && Number.isFinite(record.estimatedTokensSaved)
    ? Math.max(0, Math.floor(record.estimatedTokensSaved))
    : 0;
  return estimatedTokensSaved > 0 ? { estimatedTokensSaved } : undefined;
}

export function createOperationRuntime() {
  const subscribers = new Set<EventHandler>();
  const operationRegistry = new ActiveOperationRegistry();
  const agentRequestResults = new AgentRequestResultCache();
  const logBuffer = new LogRingBuffer(DEFAULT_LOG_BUFFER_SIZE);
  let operationHistoryRoot: string | null = null;
  let operationHistoryReady: Promise<void> = Promise.resolve();
  let operationHistoryPersist: Promise<void> = Promise.resolve();
  let lastRuntimeNotice: RuntimeNotice | null = null;

  function broadcast(event: string, data: unknown): void {
    for (const handler of subscribers) {
      handler(event, data);
    }
  }

  function persistRuntimeProgress(extra?: { readonly message?: string }): void {
    const progressPath = process.env.INKOS_NODE_PROGRESS;
    if (!progressPath) return;
    const active = operationRegistry.latest();
    const payload: RuntimeProgressPayload = active
      ? {
          state: "busy",
          label: active.label,
          message: extra?.message ?? active.message,
          type: active.type,
          bookId: active.bookId,
          chapter: active.chapter ?? null,
          sessionId: active.sessionId ?? null,
          startedAt: active.startedAt,
          updatedAt: Date.now(),
          activeCount: operationRegistry.activeCount,
          notice: lastRuntimeNotice,
        }
      : {
          state: "idle",
          label: "待命",
          message: "本地 Node 后端正在运行，暂无写作任务。",
          updatedAt: Date.now(),
          activeCount: 0,
          notice: lastRuntimeNotice,
        };
    writeFile(progressPath, JSON.stringify(payload, null, 2), "utf-8").catch(() => undefined);
  }

  function broadcastOperationsUpdate(): void {
    broadcast("operations:update", { operations: operationRegistry.list() });
  }

  function broadcastOperationHistoryUpdate(latest?: OperationHistoryItem): void {
    broadcast("operations:history", {
      operations: operationRegistry.history(20),
      ...(latest ? { latest } : {}),
    });
  }

  function scheduleOperationHistoryPersist(): void {
    const root = operationHistoryRoot;
    const ready = operationHistoryReady;
    if (!root) return;
    operationHistoryPersist = operationHistoryPersist
      .catch(() => undefined)
      .then(() => ready)
      .then(() => saveOperationHistory(root, operationRegistry.history(OPERATION_HISTORY_LIMIT)))
      .catch(() => undefined);
  }

  function touchOperation(key: string, message: string): void {
    const current = operationRegistry.touch(key, message);
    if (!current) {
      persistRuntimeProgress({ message });
      return;
    }
    persistRuntimeProgress({ message });
    broadcastOperationsUpdate();
  }

  function pushLog(entry: LogEntry): void {
    logBuffer.push(entry);
  }

  function serverLog(level: LogEntry["level"], tag: string, message: string): void {
    const entry: LogEntry = { level, tag, message, timestamp: new Date().toISOString() };
    pushLog(entry);
    if (operationRegistry.activeCount > 0) {
      const latest = operationRegistry.latestEntry();
      if (latest) {
        touchOperation(latest.key, message);
      } else {
        persistRuntimeProgress({ message });
      }
    }
    broadcast("log", { level: entry.level, tag: entry.tag, message: entry.message, timestamp: entry.timestamp });
    writeConsoleLogEntry(entry);
  }

  function clearOperation(key: string, outcome?: OperationFinishInput): void {
    const historyItem = outcome ? operationRegistry.finish(key, outcome) : null;
    if (!outcome || !historyItem) {
      operationRegistry.clear(key);
    }
    persistRuntimeProgress();
    broadcastOperationsUpdate();
    if (historyItem) {
      broadcastOperationHistoryUpdate(historyItem);
      scheduleOperationHistoryPersist();
    }
  }

  return {
    appendRuntimeTokenSummary(
      message: string,
      tokenUsage?: RuntimeTokenUsage,
      tokenSavings?: RuntimeTokenSavings,
    ): string {
      const parts = [message.trim()];
      if (tokenUsage && tokenUsage.totalTokens > 0) {
        parts.push(`消耗 ${tokenUsage.totalTokens.toLocaleString()} tokens（输入 ${tokenUsage.promptTokens.toLocaleString()} / 输出 ${tokenUsage.completionTokens.toLocaleString()}）`);
      }
      if (tokenSavings && tokenSavings.estimatedTokensSaved > 0) {
        parts.push(`估算节省 ${tokenSavings.estimatedTokensSaved.toLocaleString()} tokens`);
      }
      return parts.filter(Boolean).join(" · ");
    },

    broadcast,

    clearLogs(): void {
      logBuffer.clear();
    },

    clearOperation,

    configureOperationHistoryPersistence(root: string): void {
      if (operationHistoryRoot === root) return;
      operationHistoryRoot = root;
      operationRegistry.replaceHistory([]);
      operationHistoryReady = loadOperationHistory(root)
        .then((items) => {
          operationRegistry.mergeHistory(items);
          if (items.length > 0) {
            broadcastOperationHistoryUpdate(items.at(-1));
          }
        })
        .catch(() => undefined);
      operationHistoryPersist = operationHistoryReady;
    },

    createOperationController(key: string): AbortController {
      return operationRegistry.createController(key);
    },

    emitStudioFileAudit(
      event: FileAuditEvent,
      context?: {
        readonly sessionId?: string;
        readonly bookId?: string;
      },
    ): void {
      const message = formatFileAuditMessage(event);
      const entry: LogEntry = {
        level: "info",
        tag: "file-audit",
        message,
        timestamp: new Date().toISOString(),
      };
      pushLog(entry);
      if (operationRegistry.activeCount > 0) {
        persistRuntimeProgress({ message });
      }
      broadcast("log", {
        sessionId: context?.sessionId,
        bookId: event.bookId ?? context?.bookId,
        level: entry.level,
        tag: entry.tag,
        message: entry.message,
        timestamp: entry.timestamp,
        audit: event,
      });
      writeConsoleLogEntry(entry);
    },

    getActiveOperation(key: string): ActiveOperation | undefined {
      return operationRegistry.get(key);
    },

    getAgentRequestResult(sessionId: string, requestId: string): AgentRequestResult | undefined {
      return agentRequestResults.get(sessionId, requestId);
    },

    historyOperations(limit?: number): OperationHistoryItem[] {
      return operationRegistry.history(limit);
    },

    isCancellationResult(data: Record<string, unknown>, status: number): boolean {
      if (status === 499) return true;
      const error = data.error;
      const response = data.response;
      const text = typeof response === "string"
        ? response
        : error && typeof error === "object"
          ? JSON.stringify(error)
          : typeof error === "string"
            ? error
            : "";
      return /用户已停止当前生成|operation_cancelled|cancelled/i.test(text);
    },

    isOperationAbortError(error: unknown): boolean {
      if (hasErrorCode(error, "OPERATION_CANCELLED")) return true;
      if (error instanceof Error && error.name === "OperationCancelledError") return true;
      const message = error instanceof Error ? error.message : String(error);
      return /用户已停止当前生成|operation_cancelled|aborted|aborterror|cancelled/i.test(message);
    },

    isOperationCancelled(key: string): boolean {
      return operationRegistry.isCancelled(key);
    },

    latestLogs(limit: number): LogEntry[] {
      return logBuffer.latest(limit);
    },

    listActiveOperations(): ActiveOperation[] {
      return operationRegistry.list();
    },

    markOperationCancelled(key: string): void {
      const result = operationRegistry.markCancelled(key);
      persistRuntimeProgress();
      broadcastOperationsUpdate();
      if (result.history.length > 0) {
        broadcastOperationHistoryUpdate(result.history.at(-1));
        scheduleOperationHistoryPersist();
      }
      serverLog("warn", "operation-cancel", `已停止运行任务：${key}`);
    },

    pushLog,

    readRuntimeTokenSavings,

    readRuntimeTokenUsage,

    rememberAgentRequestResult(
      sessionId: string,
      requestId: string | undefined,
      payload: Record<string, unknown>,
      status: number,
    ): void {
      agentRequestResults.remember(sessionId, requestId, payload, status);
    },

    rememberRuntimeNotice(input: {
      readonly kind: "completed" | "error";
      readonly title: string;
      readonly message: string;
      readonly tokenUsage?: unknown;
      readonly tokenSavings?: unknown;
    }): void {
      lastRuntimeNotice = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        createdAt: Date.now(),
        ...input,
        tokenUsage: readRuntimeTokenUsage(input.tokenUsage),
        tokenSavings: readRuntimeTokenSavings(input.tokenSavings),
      };
      persistRuntimeProgress();
    },

    serverLog,

    setOperation(key: string, op: ActiveOperationInput): void {
      operationRegistry.set(key, op);
      persistRuntimeProgress();
      broadcastOperationsUpdate();
    },

    shouldRejectCancelledAgentRequest(sessionId: string, clientStartedAt: number): boolean {
      return operationRegistry.shouldRejectCancelledAgentRequest(sessionId, clientStartedAt);
    },

    subscribe(handler: EventHandler): () => void {
      subscribers.add(handler);
      return () => subscribers.delete(handler);
    },

    touchOperation,

    async waitForOperationHistoryStorage(): Promise<void> {
      await operationHistoryReady.catch(() => undefined);
      await operationHistoryPersist.catch(() => undefined);
    },
  };
}

export type OperationRuntime = ReturnType<typeof createOperationRuntime>;
