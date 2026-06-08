import { describe, expect, it, vi } from "vitest";
import type { ArchitectOutput } from "../agents/architect.js";
import type { FoundationReviewResult } from "../agents/foundation-reviewer.js";
import {
  buildFoundationReviewFeedback,
  generateAndReviewFoundation,
  type FoundationReviewerLike,
} from "../pipeline/foundation-review.js";

function foundation(label: string): ArchitectOutput {
  return {
    storyBible: `bible ${label}`,
    volumeOutline: `outline ${label}`,
    bookRules: `rules ${label}`,
    currentState: `state ${label}`,
    pendingHooks: `hooks ${label}`,
  };
}

function review(passed: boolean, totalScore: number): FoundationReviewResult {
  return {
    passed,
    totalScore,
    dimensions: [
      { name: "Core", score: totalScore, feedback: "needs sharper conflict" },
    ],
    overallFeedback: "overall note",
  };
}

describe("foundation review helper", () => {
  it("formats localized review feedback", () => {
    expect(buildFoundationReviewFeedback(review(false, 70), "zh")).toContain("- Core（70分）：needs sharper conflict");
    expect(buildFoundationReviewFeedback(review(false, 70), "en")).toContain("- Core [70]: needs sharper conflict");
  });

  it("returns the first foundation when review passes", async () => {
    const first = foundation("first");
    const generate = vi.fn(async () => first);
    const reviewer: FoundationReviewerLike = {
      review: vi.fn(async () => review(true, 92)),
    };

    await expect(generateAndReviewFoundation({
      generate,
      reviewer,
      mode: "original",
      language: "zh",
      stageLanguage: "zh",
      maxRetries: 2,
      logStage: vi.fn(),
      logWarn: vi.fn(),
      logInfo: vi.fn(),
    })).resolves.toBe(first);

    expect(generate).toHaveBeenCalledTimes(1);
    expect(reviewer.review).toHaveBeenCalledTimes(1);
  });

  it("regenerates with reviewer feedback before returning a passing foundation", async () => {
    const first = foundation("first");
    const second = foundation("second");
    const generate = vi
      .fn<(_: string | undefined) => Promise<ArchitectOutput>>()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);
    const reviewer: FoundationReviewerLike = {
      review: vi
        .fn<FoundationReviewerLike["review"]>()
        .mockResolvedValueOnce(review(false, 67))
        .mockResolvedValueOnce(review(true, 86)),
    };

    await expect(generateAndReviewFoundation({
      generate,
      reviewer,
      mode: "fanfic",
      sourceCanon: "canon",
      styleGuide: "style",
      language: "en",
      stageLanguage: "en",
      maxRetries: 2,
      logStage: vi.fn(),
      logWarn: vi.fn(),
      logInfo: vi.fn(),
    })).resolves.toBe(second);

    expect(generate).toHaveBeenNthCalledWith(2, expect.stringContaining("## Overall Feedback"));
    expect(reviewer.review).toHaveBeenNthCalledWith(1, expect.objectContaining({
      foundation: first,
      mode: "fanfic",
      sourceCanon: "canon",
      styleGuide: "style",
      language: "en",
    }));
  });

  it("accepts the final regenerated foundation after max retries", async () => {
    const first = foundation("first");
    const second = foundation("second");
    const generate = vi
      .fn<(_: string | undefined) => Promise<ArchitectOutput>>()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);
    const reviewer: FoundationReviewerLike = {
      review: vi.fn(async () => review(false, 55)),
    };

    await expect(generateAndReviewFoundation({
      generate,
      reviewer,
      mode: "original",
      language: "zh",
      stageLanguage: "zh",
      maxRetries: 1,
      logStage: vi.fn(),
      logWarn: vi.fn(),
      logInfo: vi.fn(),
    })).resolves.toBe(second);

    expect(generate).toHaveBeenCalledTimes(2);
    expect(reviewer.review).toHaveBeenCalledTimes(2);
  });
});
