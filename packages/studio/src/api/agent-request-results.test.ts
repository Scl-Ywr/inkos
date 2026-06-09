import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AgentRequestResultCache,
  agentRequestResultKey,
} from "./agent-request-results";

describe("agent request result cache", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("builds stable result keys", () => {
    expect(agentRequestResultKey("session-a", "request-a")).toBe("session-a:request-a");
  });

  it("stores completed request payloads with completion metadata", () => {
    const cache = new AgentRequestResultCache();
    const payload = { response: "done" };

    const result = cache.remember("session-a", "request-a", payload, 202);

    expect(result).toEqual({
      sessionId: "session-a",
      requestId: "request-a",
      status: 202,
      payload,
      completedAt: Date.now(),
    });
    expect(cache.get("session-a", "request-a")).toBe(result);
  });

  it("ignores missing request ids", () => {
    const cache = new AgentRequestResultCache();

    expect(cache.remember("session-a", undefined, { response: "done" }, 200)).toBeNull();
    expect(cache.size).toBe(0);
  });

  it("prunes expired results on writes and reads", () => {
    const cache = new AgentRequestResultCache(1_000);
    cache.remember("session-a", "old", { response: "old" }, 200);

    vi.setSystemTime(new Date("2026-01-01T00:00:00.500Z"));
    cache.remember("session-a", "fresh", { response: "fresh" }, 200);
    expect(cache.size).toBe(2);

    vi.setSystemTime(new Date("2026-01-01T00:00:01.001Z"));
    expect(cache.get("session-a", "old")).toBeUndefined();
    expect(cache.get("session-a", "fresh")?.payload).toEqual({ response: "fresh" });
    expect(cache.size).toBe(1);
  });
});
