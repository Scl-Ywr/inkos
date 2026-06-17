/**
 * Text formatting utilities for web novel authors.
 * Provides auto-paragraphing, dialogue line-breaking, punctuation normalization.
 */

export type FormatPreset = "web-novel" | "publish" | "screenplay" | "short-story";

interface FormatOptions {
  readonly preset?: FormatPreset;
  readonly normalizePunctuation?: boolean;
  readonly breakDialogue?: boolean;
  readonly removeExtraBlankLines?: boolean;
  readonly indentParagraphs?: boolean;
}

const PRESET_DEFAULTS: Record<FormatPreset, FormatOptions> = {
  "web-novel": {
    normalizePunctuation: true,
    breakDialogue: true,
    removeExtraBlankLines: true,
    indentParagraphs: false,
  },
  publish: {
    normalizePunctuation: true,
    breakDialogue: true,
    removeExtraBlankLines: true,
    indentParagraphs: true,
  },
  screenplay: {
    normalizePunctuation: true,
    breakDialogue: true,
    removeExtraBlankLines: true,
    indentParagraphs: false,
  },
  "short-story": {
    normalizePunctuation: true,
    breakDialogue: true,
    removeExtraBlankLines: true,
    indentParagraphs: true,
  },
};

/**
 * Normalize Chinese/English punctuation in text.
 * - Converts mixed/fullwidth/halfwidth punctuation to standard forms
 * - Fixes common punctuation errors
 */
function normalizePunctuation(text: string): string {
  let result = text;

  // Fix ellipsis: normalize various forms to Chinese standard "……"
  result = result.replace(/\.{3,}/g, "……");
  result = result.replace(/…{1,}/g, "……");
  result = result.replace(/。{2,}/g, "……");

  // Fix dashes: normalize to Chinese em-dash "——"
  result = result.replace(/-{2,}/g, "——");
  result = result.replace(/─{2,}/g, "——");
  result = result.replace(/━{2,}/g, "——");

  // Fix quotes: ensure proper pairing for Chinese text
  // Convert straight quotes to curly for Chinese context
  result = result.replace(/"([^"]*?)"/g, "“$1”");
  result = result.replace(/'([^']*?)'/g, "‘$1’");

  // Fix exclamation/question marks: normalize repeated punctuation
  result = result.replace(/！{2,}/g, "！！");
  result = result.replace(/？{2,}/g, "？？");
  result = result.replace(/!{2,}/g, "！！");
  result = result.replace(/\?{2,}/g, "？？");

  // Fix comma/period spacing around quotes
  result = result.replace(/，"/g, "，“");
  result = result.replace(/"，/g, "”，");
  result = result.replace(/。"/g, "。“");
  result = result.replace(/"。/g, "”。");

  return result;
}

/**
 * Break dialogue lines: add line breaks before and after dialogue markers.
 * Improves readability for web novel format.
 */
function breakDialogueLines(text: string): string {
  const lines = text.split("\n");
  const result: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      result.push("");
      continue;
    }

    // Check if line starts with dialogue marker
    if (/^["“]/.test(trimmed)) {
      // Ensure blank line before dialogue (if previous line wasn't dialogue)
      const prevLine = result[result.length - 1];
      if (prevLine && !/^["“]/.test(prevLine.trim())) {
        result.push("");
      }
    }

    result.push(line);
  }

  return result.join("\n");
}

/**
 * Remove excessive blank lines (3+ consecutive → 2).
 */
function removeExtraBlankLines(text: string): string {
  return text.replace(/\n{3,}/g, "\n\n");
}

/**
 * Add indent to paragraphs (2 full-width spaces for Chinese text).
 */
function indentParagraphs(text: string): string {
  const lines = text.split("\n");
  const result: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      result.push("");
      continue;
    }

    // Skip dialogue lines, headings, and separators
    if (/^["“]/.test(trimmed) || /^#/.test(trimmed) || /^[-*_]{3,}$/.test(trimmed)) {
      result.push(line);
    } else {
      result.push(`　　${trimmed}`);
    }
  }

  return result.join("\n");
}

/**
 * Format text according to preset options.
 */
export function formatText(
  content: string,
  options?: FormatOptions,
): string {
  const preset = options?.preset ?? "web-novel";
  const opts = { ...PRESET_DEFAULTS[preset], ...options };

  let result = content;

  if (opts.normalizePunctuation) {
    result = normalizePunctuation(result);
  }

  if (opts.breakDialogue) {
    result = breakDialogueLines(result);
  }

  if (opts.removeExtraBlankLines) {
    result = removeExtraBlankLines(result);
  }

  if (opts.indentParagraphs) {
    result = indentParagraphs(result);
  }

  return result;
}

/**
 * Quick format for web novel (most common use case).
 */
export function quickFormatWebNovel(content: string): string {
  return formatText(content, { preset: "web-novel" });
}

/**
 * Detect formatting issues in text.
 * Returns array of issue descriptions.
 */
export function detectFormattingIssues(content: string): ReadonlyArray<string> {
  const issues: string[] = [];

  // Check for inconsistent quotes
  const straightQuotes = (content.match(/"/g) ?? []).length;
  const curlyQuotes = (content.match(/[“”]/g) ?? []).length;
  if (straightQuotes > 0 && curlyQuotes > 0) {
    issues.push("引号格式不统一：混合使用了直引号和弯引号");
  }

  // Check for excessive punctuation
  if (/[！？]{3,}/.test(content) || /[!?]{3,}/.test(content)) {
    issues.push("标点符号过多：连续3个以上感叹号或问号");
  }

  // Check for inconsistent dashes
  if (/-{2,}/.test(content) && /——/.test(content)) {
    issues.push("破折号格式不统一：混合使用了连字符和中文破折号");
  }

  // Check for inconsistent ellipsis
  if (/\.{3,}/.test(content) && /……/.test(content)) {
    issues.push("省略号格式不统一：混合使用了英文点和中文省略号");
  }

  return issues;
}
