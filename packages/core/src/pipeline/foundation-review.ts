import type { ArchitectOutput } from "../agents/architect.js";
import type { FoundationReviewResult } from "../agents/foundation-reviewer.js";
import type { LengthLanguage } from "../utils/length-metrics.js";

export interface FoundationReviewerLike {
  readonly review: (params: {
    readonly foundation: ArchitectOutput;
    readonly mode: "original" | "fanfic" | "series";
    readonly sourceCanon?: string;
    readonly styleGuide?: string;
    readonly language: "zh" | "en";
  }) => Promise<FoundationReviewResult>;
}

export function buildFoundationReviewFeedback(
  review: Pick<FoundationReviewResult, "dimensions" | "overallFeedback">,
  language: "zh" | "en",
): string {
  const dimensionLines = review.dimensions
    .map((dimension) => (
      language === "en"
        ? `- ${dimension.name} [${dimension.score}]: ${dimension.feedback}`
        : `- ${dimension.name}（${dimension.score}分）：${dimension.feedback}`
    ))
    .join("\n");

  return language === "en"
    ? [
        "## Overall Feedback",
        review.overallFeedback,
        "",
        "## Dimension Notes",
        dimensionLines || "- none",
      ].join("\n")
    : [
        "## 总评",
        review.overallFeedback,
        "",
        "## 分项问题",
        dimensionLines || "- 无",
      ].join("\n");
}

export async function generateAndReviewFoundation(params: {
  readonly generate: (reviewFeedback?: string) => Promise<ArchitectOutput>;
  readonly reviewer: FoundationReviewerLike;
  readonly mode: "original" | "fanfic" | "series";
  readonly sourceCanon?: string;
  readonly styleGuide?: string;
  readonly language: "zh" | "en";
  readonly stageLanguage: LengthLanguage;
  readonly maxRetries: number;
  readonly logStage: (language: LengthLanguage, message: { zh: string; en: string }) => void;
  readonly logWarn: (language: LengthLanguage, message: { zh: string; en: string }) => void;
  readonly logInfo?: (message: string) => void;
}): Promise<ArchitectOutput> {
  let foundation = await params.generate();

  for (let attempt = 0; attempt < params.maxRetries; attempt++) {
    params.logStage(params.stageLanguage, {
      zh: `审核基础设定（第${attempt + 1}轮）`,
      en: `reviewing foundation (round ${attempt + 1})`,
    });

    const review = await params.reviewer.review({
      foundation,
      mode: params.mode,
      sourceCanon: params.sourceCanon,
      styleGuide: params.styleGuide,
      language: params.language,
    });

    params.logInfo?.(`Foundation review: ${review.totalScore}/100 ${review.passed ? "PASSED" : "REJECTED"}`);
    for (const dimension of review.dimensions) {
      params.logInfo?.(`  [${dimension.score}] ${dimension.name.slice(0, 40)}`);
    }

    if (review.passed) {
      return foundation;
    }

    params.logWarn(params.stageLanguage, {
      zh: `基础设定未通过审核（${review.totalScore}分），正在重新生成...`,
      en: `Foundation rejected (${review.totalScore}/100), regenerating...`,
    });

    foundation = await params.generate(buildFoundationReviewFeedback(review, params.language));
  }

  const finalReview = await params.reviewer.review({
    foundation,
    mode: params.mode,
    sourceCanon: params.sourceCanon,
    styleGuide: params.styleGuide,
    language: params.language,
  });
  params.logInfo?.(
    `Foundation final review: ${finalReview.totalScore}/100 ${finalReview.passed ? "PASSED" : "ACCEPTED (max retries)"}`,
  );

  return foundation;
}
