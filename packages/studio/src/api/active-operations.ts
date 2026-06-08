export interface ActiveOperation {
  readonly type: "write" | "rewrite" | "agent" | "revise";
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
    case "rewrite": return "章节重写";
    case "agent": return "AI 对话";
    case "revise": return "章节修订";
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

  get activeCount(): number {
    return this.activeOperations.size;
  }

  get(key: string): ActiveOperation | undefined {
    return this.activeOperations.get(key);
  }

  list(): ActiveOperation[] {
    return [...this.activeOperations.values()];
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

    for (const target of targets) {
      this.cancelledOperations.add(target);
      this.operationControllers.get(target)?.abort(operationCancelledError());
      this.clear(target);
    }

    return {
      targets: [...targets],
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
}
