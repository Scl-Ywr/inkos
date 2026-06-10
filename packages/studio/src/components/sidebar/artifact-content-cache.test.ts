import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchJson } from "../../hooks/use-api";
import {
  getCachedArtifactContent,
  invalidateBookArtifactContent,
  loadArtifactContent,
} from "./artifact-content-cache";

vi.mock("../../hooks/use-api", () => ({
  fetchJson: vi.fn(),
}));

const fetchJsonMock = vi.mocked(fetchJson);

describe("artifact content cache", () => {
  beforeEach(() => {
    fetchJsonMock.mockReset();
    invalidateBookArtifactContent("demo");
  });

  it("refetches truth content after invalidating a book", async () => {
    fetchJsonMock
      .mockResolvedValueOnce({ content: "old truth" })
      .mockResolvedValueOnce({ content: "new truth" });

    await expect(loadArtifactContent("demo", { type: "truth", file: "current_state.md" }))
      .resolves.toBe("old truth");
    expect(getCachedArtifactContent("demo", { type: "truth", file: "current_state.md" }))
      .toBe("old truth");

    invalidateBookArtifactContent("demo");

    await expect(loadArtifactContent("demo", { type: "truth", file: "current_state.md" }))
      .resolves.toBe("new truth");
    expect(fetchJsonMock).toHaveBeenCalledTimes(2);
  });

  it("does not let an older in-flight request repopulate invalidated content", async () => {
    let resolveOldRequest: ((value: { content: string }) => void) | undefined;
    fetchJsonMock.mockImplementationOnce(() => new Promise((resolve) => {
      resolveOldRequest = resolve;
    }));

    const oldRequest = loadArtifactContent("demo", { type: "truth", file: "current_state.md" });
    invalidateBookArtifactContent("demo");
    resolveOldRequest?.({ content: "stale truth" });

    await expect(oldRequest).resolves.toBe("stale truth");
    expect(getCachedArtifactContent("demo", { type: "truth", file: "current_state.md" }))
      .toBeUndefined();
  });
});
