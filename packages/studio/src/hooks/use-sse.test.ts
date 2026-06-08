import { describe, expect, it } from "vitest";
import { activeOperationsSignature, STUDIO_SSE_EVENTS } from "./use-sse";

describe("STUDIO_SSE_EVENTS", () => {
  it("covers the server lifecycle events that drive the UI", () => {
    expect(STUDIO_SSE_EVENTS).toEqual(expect.arrayContaining([
      "book:creating",
      "book:created",
      "book:deleted",
      "book:error",
      "write:start",
      "write:complete",
      "write:error",
      "draft:start",
      "draft:complete",
      "draft:error",
      "daemon:started",
      "daemon:stopped",
      "daemon:error",
      "audit:start",
      "audit:complete",
      "audit:error",
      "revise:start",
      "revise:complete",
      "revise:error",
      "rewrite:start",
      "rewrite:complete",
      "rewrite:error",
      "agent:start",
      "agent:complete",
      "agent:error",
      "import:start",
      "import:complete",
      "import:error",
      "fanfic:start",
      "fanfic:complete",
      "fanfic:error",
      "fanfic:refresh:start",
      "fanfic:refresh:complete",
      "fanfic:refresh:error",
      "style:start",
      "style:complete",
      "style:error",
      "radar:start",
      "radar:complete",
      "radar:error",
      "log",
      "llm:progress",
      "operations:restore",
      "operations:update",
      "ping",
    ]));
  });
});

describe("activeOperationsSignature", () => {
  it("is stable for equivalent operation snapshots", () => {
    const first = activeOperationsSignature([
      {
        type: "agent",
        bookId: "book-1",
        label: "章节写作",
        message: "正在写作",
        updatedAt: 1,
      },
    ]);
    const second = activeOperationsSignature([
      {
        type: "agent",
        bookId: "book-1",
        label: "章节写作",
        message: "正在写作",
        updatedAt: 1,
      },
    ]);

    expect(second).toBe(first);
    expect(activeOperationsSignature([
      {
        type: "agent",
        bookId: "book-1",
        label: "章节写作",
        message: "正在校验",
        updatedAt: 2,
      },
    ])).not.toBe(first);
  });
});
