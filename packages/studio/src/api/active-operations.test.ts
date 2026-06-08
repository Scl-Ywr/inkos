import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_CANCEL_MARK_TTL_MS,
  AGENT_CANCEL_SUPPRESSION_MS,
  ActiveOperationRegistry,
  agentSessionIdFromOperationKey,
  operationCancelledError,
} from "./active-operations";

describe("active operation registry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("sets operations with default labels and latest timestamps", () => {
    const registry = new ActiveOperationRegistry();

    const operation = registry.set("write:demo", {
      type: "write",
      bookId: "demo",
    });

    expect(operation).toMatchObject({
      type: "write",
      bookId: "demo",
      status: "running",
      label: "章节写作",
      message: "章节写作正在进行",
      startedAt: Date.now(),
      updatedAt: Date.now(),
    });
    expect(registry.activeCount).toBe(1);
    expect(registry.list()).toEqual([operation]);
    expect(registry.latest()).toBe(operation);
    expect(registry.latestEntry()).toEqual({ key: "write:demo", operation });
  });

  it("updates operation messages without creating missing operations", () => {
    const registry = new ActiveOperationRegistry();
    registry.set("agent:session-a:req-a", {
      type: "agent",
      bookId: "demo",
      sessionId: "session-a",
      message: "starting",
    });

    vi.setSystemTime(new Date("2026-01-01T00:00:03.000Z"));
    const updated = registry.touch("agent:session-a:req-a", "working");

    expect(updated?.message).toBe("working");
    expect(updated?.updatedAt).toBe(Date.now());
    expect(registry.touch("missing", "ignored")).toBeNull();
    expect(registry.activeCount).toBe(1);
  });

  it("records completed operation history in newest-first order", () => {
    const registry = new ActiveOperationRegistry();
    registry.set("write:demo", {
      type: "write",
      bookId: "demo",
      message: "starting",
    });

    vi.setSystemTime(new Date("2026-01-01T00:00:05.000Z"));
    const finished = registry.finish("write:demo", {
      status: "completed",
      message: "done",
    });

    expect(finished).toMatchObject({
      key: "write:demo",
      type: "write",
      bookId: "demo",
      status: "completed",
      message: "done",
      completedAt: Date.now(),
      durationMs: 5000,
    });
    expect(registry.activeCount).toBe(0);
    expect(registry.history()).toEqual([finished]);
    expect(registry.finish("missing", { status: "completed" })).toBeNull();
  });

  it("keeps operation history bounded", () => {
    const registry = new ActiveOperationRegistry(2);

    for (const bookId of ["a", "b", "c"]) {
      registry.set(`write:${bookId}`, { type: "write", bookId });
      registry.finish(`write:${bookId}`, { status: "completed" });
    }

    expect(registry.history().map((item) => item.key)).toEqual(["write:c", "write:b"]);
  });

  it("restores and merges persisted history without duplicating entries", () => {
    const registry = new ActiveOperationRegistry(3);
    const historyItem = {
      key: "write:old",
      type: "write" as const,
      bookId: "old",
      status: "completed" as const,
      label: "章节写作",
      message: "old done",
      startedAt: 1,
      updatedAt: 2,
      completedAt: 2,
      durationMs: 1,
    };

    registry.replaceHistory([historyItem]);
    registry.mergeHistory([
      historyItem,
      {
        ...historyItem,
        key: "write:new",
        bookId: "new",
        message: "new done",
        completedAt: 3,
        updatedAt: 3,
      },
    ]);

    expect(registry.history().map((item) => item.key)).toEqual(["write:new", "write:old"]);
  });

  it("cancels matching agent operations and aborts their controllers", () => {
    const registry = new ActiveOperationRegistry();
    registry.set("agent:session-a", {
      type: "agent",
      bookId: "demo",
      sessionId: "session-a",
    });
    registry.set("agent:session-a:req-a", {
      type: "agent",
      bookId: "demo",
      sessionId: "session-a",
    });
    registry.set("write:demo", {
      type: "write",
      bookId: "demo",
    });
    const parentController = registry.createController("agent:session-a");
    const childController = registry.createController("agent:session-a:req-a");

    const result = registry.markCancelled("agent:session-a");

    expect(new Set(result.targets)).toEqual(new Set(["agent:session-a", "agent:session-a:req-a"]));
    expect(result.agentSessionId).toBe("session-a");
    expect(parentController.signal.aborted).toBe(true);
    expect(childController.signal.aborted).toBe(true);
    expect(registry.get("agent:session-a")).toBeUndefined();
    expect(registry.get("agent:session-a:req-a")).toBeUndefined();
    expect(result.history.map((item) => item.status)).toEqual(["cancelled", "cancelled"]);
    expect(registry.history().map((item) => item.key)).toEqual(["agent:session-a:req-a", "agent:session-a"]);
    expect(registry.get("write:demo")).toBeDefined();
    expect(registry.isCancelled("agent:session-a")).toBe(true);
    expect(registry.isCancelled("agent:session-a:req-a")).toBe(true);
  });

  it("suppresses late agent requests only within the cancellation window", () => {
    const registry = new ActiveOperationRegistry();
    const cancelledAt = Date.now();
    registry.markCancelled("agent:session-a");

    expect(registry.shouldRejectCancelledAgentRequest("session-a", cancelledAt - 1)).toBe(true);
    expect(
      registry.shouldRejectCancelledAgentRequest(
        "session-a",
        cancelledAt + AGENT_CANCEL_SUPPRESSION_MS - 1,
      ),
    ).toBe(true);
    expect(
      registry.shouldRejectCancelledAgentRequest(
        "session-a",
        cancelledAt + AGENT_CANCEL_SUPPRESSION_MS + 1,
      ),
    ).toBe(false);

    vi.setSystemTime(cancelledAt + AGENT_CANCEL_MARK_TTL_MS + 1);
    expect(registry.shouldRejectCancelledAgentRequest("session-a", cancelledAt - 1)).toBe(false);
  });

  it("parses agent session ids and creates cancellation errors", () => {
    expect(agentSessionIdFromOperationKey("agent:session-a:req-a")).toBe("session-a");
    expect(agentSessionIdFromOperationKey("write:demo")).toBeNull();
    expect(operationCancelledError()).toMatchObject({
      name: "OperationCancelledError",
      message: "用户已停止当前生成。",
    });
  });
});
