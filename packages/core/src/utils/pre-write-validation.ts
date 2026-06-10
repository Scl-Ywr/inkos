import type { BookConfig } from "../models/book.js";
import type { LLMClient } from "../llm/provider.js";

export interface ValidationWarning {
  readonly severity: "warning" | "error";
  readonly message: string;
  readonly suggestion?: string;
}

export interface PreWriteValidationResult {
  readonly valid: boolean;
  readonly warnings: ReadonlyArray<ValidationWarning>;
}

export function validateWriteRequest(
  book: BookConfig,
  chapterNumber: number,
  client: LLMClient,
  wordCountOverride?: number,
): PreWriteValidationResult {
  const warnings: ValidationWarning[] = [];
  const targetWordCount = wordCountOverride ?? book.chapterWordCount;
  const modelMaxTokens = client.defaults.maxTokens;

  // 检查字数是否超出模型能力（宽松模式：允许2倍buffer）
  const estimatedOutputTokens = targetWordCount * 2;
  if (estimatedOutputTokens > modelMaxTokens * 2) {
    warnings.push({
      severity: "error",
      message: `目标字数 ${targetWordCount} 字需要约 ${estimatedOutputTokens.toLocaleString()} tokens，远超模型输出限制 ${modelMaxTokens.toLocaleString()} tokens。`,
      suggestion: `建议将单章字数降低到 ${Math.floor(modelMaxTokens / 4)} 字以内，或切换支持更大输出的模型。`,
    });
  } else if (estimatedOutputTokens > modelMaxTokens) {
    warnings.push({
      severity: "warning",
      message: `目标字数 ${targetWordCount} 字接近模型输出限制（估算 ${estimatedOutputTokens.toLocaleString()} tokens vs ${modelMaxTokens.toLocaleString()} tokens）。`,
      suggestion: "生成可能会被截断，建议适当降低字数或使用更大输出能力的模型。",
    });
  }

  // 检查超大章节
  if (targetWordCount > 15000) {
    warnings.push({
      severity: "warning",
      message: `单章 ${targetWordCount} 字属于超大章节，可能导致生成质量下降或超时。`,
      suggestion: "建议将章节拆分为多个部分，或降低到 12000 字以内以获得更好的质量。",
    });
  }

  // 检查章节号合理性
  if (chapterNumber > 500) {
    warnings.push({
      severity: "warning",
      message: `当前是第 ${chapterNumber} 章，章节数较多可能影响上下文效率。`,
      suggestion: "考虑定期清理或压缩历史章节摘要。",
    });
  }

  // 检查目标章数和实际进度
  if (book.targetChapters && chapterNumber > book.targetChapters * 1.2) {
    warnings.push({
      severity: "warning",
      message: `当前章节 ${chapterNumber} 已超出目标章数 ${book.targetChapters} 的 20%。`,
      suggestion: "确认是否需要调整目标章数配置。",
    });
  }

  const hasErrors = warnings.some(w => w.severity === "error");
  return {
    valid: !hasErrors,
    warnings,
  };
}

export function validateBookCreateRequest(
  title: string,
  targetChapters: number,
  chapterWordCount: number,
): PreWriteValidationResult {
  const warnings: ValidationWarning[] = [];

  // 检查总字数规模
  const totalWords = targetChapters * chapterWordCount;
  if (totalWords > 10_000_000) {
    warnings.push({
      severity: "error",
      message: `总字数 ${(totalWords / 10000).toFixed(0)} 万字过大（目标 ${targetChapters} 章 × ${chapterWordCount} 字/章）。`,
      suggestion: "建议将目标章数降低到 500 章以内，或降低单章字数。",
    });
  } else if (totalWords > 5_000_000) {
    warnings.push({
      severity: "warning",
      message: `总字数 ${(totalWords / 10000).toFixed(0)} 万字较大，建书和写作将需要较长时间。`,
      suggestion: "建议分卷创建，或确保有足够的时间和资源完成。",
    });
  }

  // 检查单章字数
  if (chapterWordCount > 15000) {
    warnings.push({
      severity: "warning",
      message: `单章 ${chapterWordCount} 字较大，可能影响生成速度和质量。`,
      suggestion: "建议将单章字数降低到 5000-10000 字范围以获得最佳效果。",
    });
  }

  // 检查目标章数
  if (targetChapters > 1000) {
    warnings.push({
      severity: "warning",
      message: `目标 ${targetChapters} 章属于超长篇，需要持续投入。`,
      suggestion: "建议先设定阶段性目标（如 200-300 章），完成后再扩展。",
    });
  }

  const hasErrors = warnings.some(w => w.severity === "error");
  return {
    valid: !hasErrors,
    warnings,
  };
}
