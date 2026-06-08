import { describe, expect, it } from "vitest";
import { selectLatestProgressEvent } from "./Dashboard";
import type { SSEMessage } from "../hooks/use-sse";

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
});
