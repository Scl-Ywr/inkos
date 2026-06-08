import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LogRingBuffer,
  formatFileAuditMessage,
  formatUnknownError,
  writeConsoleLogEntry,
} from "./server-logs";

describe("server log helpers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps only the latest entries in the ring buffer", () => {
    const buffer = new LogRingBuffer(2);
    buffer.push({ level: "info", tag: "one", message: "1", timestamp: "t1" });
    buffer.push({ level: "warn", tag: "two", message: "2", timestamp: "t2" });
    buffer.push({ level: "error", tag: "three", message: "3", timestamp: "t3" });

    expect(buffer.latest(10).map((entry) => entry.tag)).toEqual(["two", "three"]);
  });

  it("formats file audit entries consistently", () => {
    expect(formatFileAuditMessage({
      action: "write",
      path: "books/demo/story/current_state.md",
      tool: "sub_agent.writer",
      bookId: "demo",
      detail: "更新状态",
    })).toBe("写入文件 [sub_agent.writer]《demo》 books/demo/story/current_state.md：更新状态");
  });

  it("formats unknown errors without exposing stack traces by default", () => {
    expect(formatUnknownError(new Error("boom"))).toBe("boom");
    expect(formatUnknownError("plain")).toBe("plain");
  });

  it("routes console output by severity", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    writeConsoleLogEntry({ level: "info", tag: "studio", message: "ok" });
    writeConsoleLogEntry({ level: "warn", tag: "studio", message: "careful" });
    writeConsoleLogEntry({ level: "error", tag: "studio", message: "bad" });

    expect(info).toHaveBeenCalledWith("[studio]", "ok");
    expect(warn).toHaveBeenCalledWith("[studio]", "careful");
    expect(error).toHaveBeenCalledWith("[studio]", "bad");
  });
});
