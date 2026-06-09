export interface ActiveOperation {
  readonly type: "write" | "draft" | "rewrite" | "agent" | "revise" | "audit" | "resync";
  readonly bookId: string;
  readonly startedAt: number;
  readonly updatedAt: number;
  readonly status: "running";
  readonly label: string;
  readonly message: string;
  readonly sessionId?: string;
  readonly chapter?: number;
  readonly instruction?: string;
}

export type OperationHistoryStatus = "completed" | "error" | "cancelled";

export interface OperationHistoryItem extends Omit<ActiveOperation, "status"> {
  readonly key: string;
  readonly status: OperationHistoryStatus;
  readonly completedAt: number;
  readonly durationMs: number;
  readonly error?: string;
}

export interface OperationFinishInput {
  readonly status: OperationHistoryStatus;
  readonly message?: string;
  readonly error?: string;
}

export type ActiveOperationInput =
  Omit<ActiveOperation, "startedAt" | "updatedAt" | "status" | "label" | "message"> & {
    readonly label?: string;
    readonly message?: string;
  };

export interface ActiveOperationEntry {
  readonly key: string;
  readonly operation: ActiveOperation;
}

export interface CancelOperationResult {
  readonly targets: ReadonlyArray<string>;
  readonly agentSessionId?: string;
  readonly history: ReadonlyArray<OperationHistoryItem>;
}

export const AGENT_CANCEL_SUPPRESSION_MS = 2_500;
export const AGENT_CANCEL_MARK_TTL_MS = 30_000;

export function operationCancelledError(): Error {
  const error = new Error("用户已停止当前生成。");
  error.name = "OperationCancelledError";
  return error;
}

export function operationLabel(type: ActiveOperation["type"]): string {
  switch (type) {
    case "write": return "章节写作";
    case "draft": return "章节草稿";
    case "rewrite": return "章节重写";
    case "agent": return "AI 对话";
    case "revise": return "章节修订";
    case "audit": return "章节审计";
    case "resync": return "状态补算";
  }
}

export function agentSessionIdFromOperationKey(key: string): string | null {
  if (!key.startsWith("agent:")) return null;
  const sessionId = key.slice("agent:".length).split(":")[0]?.trim();
  return sessionId || null;
}

function operationMatchesCancelKey(activeKey: string, cancelKey: string): boolean {
  if (activeKey === cancelKey) return true;
  return cancelKey.startsWith("agent:") && activeKey.startsWith(`${cancelKey}:`);
}

export class ActiveOperationRegistry {
  private readonly activeOperations = new Map<string, ActiveOperation>();
  private readonly cancelledOperations = new Set<string>();
  private readonly cancelledAgentSessions = new Map<string, number>();
  private readonly operationControllers = new Map<string, AbortController>();
  private readonly operationHistory: OperationHistoryItem[] = [];

  constructor(private readonly historyLimit = 50) {}

  get activeCount(): number {
    return this.activeOperations.size;
  }

  get(key: string): ActiveOperation | undefined {
    return this.activeOperations.get(key);
  }

  list(): ActiveOperation[] {
    return [...this.activeOperations.values()];
  }

  history(limit = this.historyLimit): OperationHistoryItem[] {
    const normalizedLimit = Number.isFinite(limit) && limit > 0
      ? Math.min(Math.floor(limit), this.historyLimit)
      : this.historyLimit;
    return this.operationHistory.slice(-normalizedLimit).reverse();
  }

  replaceHistory(items: ReadonlyArray<OperationHistoryItem>): void {
    this.operationHistory.splice(0, this.operationHistory.length, ...items.slice(-this.historyLimit));
  }

  mergeHistory(items: ReadonlyArray<OperationHistoryItem>): void {
    const merged = new Map<string, OperationHistoryItem>();
    for (const item of [...this.operationHistory, ...items]) {
      merged.set(`${item.key}\u0000${item.completedAt}\u0000${item.status}`, item);
    }
    this.replaceHistory(
      [...merged.values()].sort((left, right) => left.completedAt - right.completedAt),
    );
  }

  latest(): ActiveOperation | null {
    return this.latestEntry()?.operation ?? null;
  }

  latestEntry(): ActiveOperationEntry | null {
    const entries = [...this.activeOperations.entries()];
    entries.sort((a, b) => b[1].updatedAt - a[1].updatedAt);
    const latest = entries[0];
    return latest ? { key: latest[0], operation: latest[1] } : null;
  }

  set(key: string, op: ActiveOperationInput): ActiveOperation {
    const now = Date.now();
    this.cancelledOperations.delete(key);
    const label = op.label ?? operationLabel(op.type);
    const operation: ActiveOperation = {
      ...op,
      status: "running",
      label,
      message: op.message ?? `${label}正在进行`,
      startedAt: now,
      updatedAt: now,
    };
    this.activeOperations.set(key, operation);
    return operation;
  }

  clear(key: string): void {
    this.activeOperations.delete(key);
    this.operationControllers.delete(key);
  }

  finish(key: string, input: OperationFinishInput): OperationHistoryItem | null {
    const operation = this.activeOperations.get(key);
    if (!operation) {
      this.operationControllers.delete(key);
      return null;
    }
    const historyItem = this.recordHistory(key, operation, input);
    this.clear(key);
    return historyItem;
  }

  touch(key: string, message: string): ActiveOperation | null {
    const current = this.activeOperations.get(key);
    if (!current) return null;
    const next = { ...current, message, updatedAt: Date.now() };
    this.activeOperations.set(key, next);
    return next;
  }

  isCancelled(key: string): boolean {
    return this.cancelledOperations.has(key);
  }

  createController(key: string): AbortController {
    this.operationControllers.get(key)?.abort(operationCancelledError());
    const controller = new AbortController();
    this.operationControllers.set(key, controller);
    return controller;
  }

  markCancelled(key: string): CancelOperationResult {
    const targets = new Set<string>([key]);
    for (const activeKey of this.activeOperations.keys()) {
      if (operationMatchesCancelKey(activeKey, key)) targets.add(activeKey);
    }
    for (const activeKey of this.operationControllers.keys()) {
      if (operationMatchesCancelKey(activeKey, key)) targets.add(activeKey);
    }

    const agentSessionId = agentSessionIdFromOperationKey(key);
    if (agentSessionId) {
      this.cancelledAgentSessions.set(agentSessionId, Date.now());
    }

    const history: OperationHistoryItem[] = [];
    for (const target of targets) {
      this.cancelledOperations.add(target);
      this.operationControllers.get(target)?.abort(operationCancelledError());
      const operation = this.activeOperations.get(target);
      if (operation) {
        history.push(this.recordHistory(target, operation, {
          status: "cancelled",
          message: "用户已停止当前生成。",
        }));
      }
      this.clear(target);
    }

    return {
      targets: [...targets],
      history,
      ...(agentSessionId ? { agentSessionId } : {}),
    };
  }

  shouldRejectCancelledAgentRequest(sessionId: string, clientStartedAt: number): boolean {
    const cancelledAt = this.cancelledAgentSessions.get(sessionId);
    if (cancelledAt === undefined) return false;
    if (Date.now() - cancelledAt > AGENT_CANCEL_MARK_TTL_MS) {
      this.cancelledAgentSessions.delete(sessionId);
      return false;
    }
    return clientStartedAt <= cancelledAt || clientStartedAt - cancelledAt < AGENT_CANCEL_SUPPRESSION_MS;
  }

  private recordHistory(
    key: string,
    operation: ActiveOperation,
    input: OperationFinishInput,
  ): OperationHistoryItem {
    const completedAt = Date.now();
    const historyItem: OperationHistoryItem = {
      ...operation,
      key,
      status: input.status,
      message: input.message ?? operation.message,
      updatedAt: completedAt,
      completedAt,
      durationMs: Math.max(0, completedAt - operation.startedAt),
      ...(input.error ? { error: input.error } : {}),
    };
    this.operationHistory.push(historyItem);
    if (this.operationHistory.length > this.historyLimit) {
      this.operationHistory.splice(0, this.operationHistory.length - this.historyLimit);
    }
    return historyItem;
  }
}
