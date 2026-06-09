export interface AgentRequestResult {
  readonly sessionId: string;
  readonly requestId: string;
  readonly status: number;
  readonly payload: Record<string, unknown>;
  readonly completedAt: number;
}

export const DEFAULT_AGENT_REQUEST_RESULT_TTL_MS = 2 * 60 * 60_000;

export function agentRequestResultKey(sessionId: string, requestId: string): string {
  return `${sessionId}:${requestId}`;
}

export class AgentRequestResultCache {
  private readonly ttlMs: number;
  private readonly results = new Map<string, AgentRequestResult>();

  constructor(ttlMs = DEFAULT_AGENT_REQUEST_RESULT_TTL_MS) {
    this.ttlMs = ttlMs;
  }

  get size(): number {
    return this.results.size;
  }

  remember(
    sessionId: string,
    requestId: string | undefined,
    payload: Record<string, unknown>,
    status: number,
  ): AgentRequestResult | null {
    if (!requestId) return null;
    const now = Date.now();
    const result: AgentRequestResult = {
      sessionId,
      requestId,
      status,
      payload,
      completedAt: now,
    };
    this.results.set(agentRequestResultKey(sessionId, requestId), result);
    this.prune(now);
    return result;
  }

  get(sessionId: string, requestId: string): AgentRequestResult | undefined {
    this.prune(Date.now());
    return this.results.get(agentRequestResultKey(sessionId, requestId));
  }

  private prune(now: number): void {
    for (const [key, result] of this.results) {
      if (now - result.completedAt > this.ttlMs) {
        this.results.delete(key);
      }
    }
  }
}
