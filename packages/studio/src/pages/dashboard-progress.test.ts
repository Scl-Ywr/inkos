import { describe, expect, it } from "vitest";
import { pickCurrentTask, selectLatestProgressEvent } from "./Dashboard";
import type { ActiveOperation, SSEMessage } from "../hooks/use-sse";

function progressMessage(
  timestamp: number,
  data: { readonly bookId?: string; readonly sessionId?: string; readonly elapsedMs: number },
): SSEMessage {
  return {
    event: "llm:progress",
    data: {
      status: "streaming",
      totalChars: 0,
      chineseChars: 0,
      ...data,
    },
    timestamp,
  };
}

describe("selectLatestProgressEvent", () => {
  it("selects the newest progress event for the active book instead of the global newest event", () => {
    const messages = [
      progressMessage(1_000, { bookId: "book-a", elapsedMs: 1_000 }),
      progressMessage(2_000, { bookId: "book-b", elapsedMs: 2_000 }),
    ];

    expect(selectLatestProgressEvent(messages, { bookId: "book-a" })?.data).toMatchObject({
      bookId: "book-a",
      elapsedMs: 1_000,
    });
  });

  it("falls back to session matching when a legacy progress event has no book id", () => {
    const messages = [
      progressMessage(1_000, { sessionId: "session-a", elapsedMs: 1_000 }),
      progressMessage(2_000, { sessionId: "session-b", elapsedMs: 2_000 }),
    ];

    expect(selectLatestProgressEvent(messages, { bookId: "book-a", sessionId: "session-a" })?.data).toMatchObject({
      sessionId: "session-a",
      elapsedMs: 1_000,
    });
  });

  it("ignores stale progress emitted before the current task started", () => {
    const messages = [
      progressMessage(1_000, { bookId: "book-a", elapsedMs: 30_000 }),
      progressMessage(3_000, { bookId: "book-a", elapsedMs: 1_000 }),
    ];

    expect(selectLatestProgressEvent(messages, { bookId: "book-a", startedAt: 2_000 })?.data).toMatchObject({
      bookId: "book-a",
      elapsedMs: 1_000,
    });
  });
});

describe("pickCurrentTask", () => {
  it("prefers a newer failed task event over a stale active operation snapshot", () => {
    const operations: ActiveOperation[] = [{
      type: "write",
      bookId: "book-a",
      status: "running",
      label: "章节写作",
      message: "正在写作",
      startedAt: 1_000,
      updatedAt: 2_000,
    }];
    const messages: SSEMessage[] = [{
      event: "write:error",
      data: { bookId: "book-a", error: "boom" },
      timestamp: 3_000,
    }];

    expect(pickCurrentTask(operations, messages)).toMatchObject({
      bookId: "book-a",
      label: "写作失败",
      status: "error",
      timestamp: 3_000,
    });
  });
});
