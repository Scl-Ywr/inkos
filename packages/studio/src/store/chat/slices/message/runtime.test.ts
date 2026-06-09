import { describe, expect, it } from "vitest";
import { extractErrorMessage, extractToolDetails, extractToolError, summarizeResult } from "./runtime";

describe("chat runtime error copy", () => {
  it("localizes known assistant errors", () => {
    expect(extractErrorMessage({
      message: "Latest chapter 1 is state-degraded. Repair state or rewrite that chapter before continuing.",
    })).toBe("最新第 1 章处于状态降级（state-degraded）。继续写下一章前，请先修复状态，或重写这一章。");
  });

  it("localizes known tool errors", () => {
    expect(extractToolError({
      content: [
        {
          type: "text",
          text: "Latest chapter 2 is state-degraded. Repair state or rewrite that chapter before continuing.",
        },
      ],
    })).toBe("最新第 2 章处于状态降级（state-degraded）。继续写下一章前，请先修复状态，或重写这一章。");
  });

  it("summarizes structured text content without unsafe casts", () => {
    expect(summarizeResult({
      content: [
        { type: "text", text: "first" },
        { type: "image", url: "ignored" },
        { type: "text", content: "second" },
      ],
    })).toBe("first\nsecond");
  });

  it("extracts structured tool details", () => {
    const details = { changed: ["story/current_state.md"] };
    expect(extractToolDetails({ details })).toBe(details);
  });
});
