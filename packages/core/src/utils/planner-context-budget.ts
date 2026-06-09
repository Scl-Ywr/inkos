export interface PlannerContextBudget {
  readonly brief: number;
  readonly chapterContext: number;
  readonly previousEndingExcerpt: number;
  readonly recentSummaries: number;
  readonly currentArcProse: number;
  readonly protagonistMatrixRow: number;
  readonly opponentRows: number;
  readonly collaboratorRows: number;
  readonly relevantThreads: number;
  readonly recyclableHooks: number;
  readonly bookRulesRelevant: number;
}

export interface PlannerContextCompaction {
  readonly label: string;
  readonly originalChars: number;
  readonly compactedChars: number;
}

export const DEFAULT_PLANNER_CONTEXT_BUDGET: PlannerContextBudget = {
  brief: 2_500,
  chapterContext: 2_000,
  previousEndingExcerpt: 600,
  recentSummaries: 1_800,
  currentArcProse: 1_800,
  protagonistMatrixRow: 1_500,
  opponentRows: 1_200,
  collaboratorRows: 1_200,
  relevantThreads: 1_800,
  recyclableHooks: 1_500,
  bookRulesRelevant: 2_200,
};

export function buildPlannerContextBudget(): PlannerContextBudget {
  return DEFAULT_PLANNER_CONTEXT_BUDGET;
}

export function compactPlanningTextForChapter(
  text: string,
  options: {
    readonly label: string;
    readonly maxChars: number;
    readonly chapterNumber: number;
    readonly goal?: string;
    readonly language?: "zh" | "en";
  },
): { readonly text: string; readonly compaction?: PlannerContextCompaction } {
  const normalized = text.trim();
  if (normalized.length <= options.maxChars) {
    return { text };
  }

  const keywords = buildKeywords(options.chapterNumber, options.goal);
  const segments = splitSegments(normalized);
  const scored = segments
    .map((segment, index) => ({ segment, index, score: scoreSegment(segment, keywords) }))
    .sort((left, right) => right.score - left.score || left.index - right.index);

  const selected = new Set<number>();
  if (segments.length > 0) selected.add(0);
  if (segments.length > 1) selected.add(segments.length - 1);

  let budget = Math.max(200, options.maxChars - 160);
  for (const item of scored) {
    if (selected.has(item.index)) continue;
    const cost = item.segment.length + 2;
    if (cost > budget && selected.size > 2) continue;
    selected.add(item.index);
    budget -= Math.min(cost, budget);
    if (budget <= 0) break;
  }

  const kept = [...selected]
    .sort((left, right) => left - right)
    .map((index) => segments[index])
    .join("\n\n")
    .trim();
  const fallback = `${normalized.slice(0, Math.floor(options.maxChars * 0.65)).trim()}\n\n...\n\n${normalized.slice(-Math.floor(options.maxChars * 0.2)).trim()}`;
  const body = (kept || fallback).slice(0, options.maxChars - 120).trim();
  const marker = options.language === "en"
    ? `[planner context compacted: ${normalized.length} -> ${body.length} chars; original file is unchanged]`
    : `[planner 上下文已压缩：${normalized.length} -> ${body.length} 字符；原文件未改动]`;
  const compacted = `${marker}\n${body}`;

  return {
    text: compacted,
    compaction: {
      label: options.label,
      originalChars: normalized.length,
      compactedChars: compacted.length,
    },
  };
}

function buildKeywords(chapterNumber: number, goal?: string): ReadonlyArray<string> {
  const keywords = new Set<string>([
    String(chapterNumber),
    `第${chapterNumber}`,
    `chapter ${chapterNumber}`,
    "当前",
    "本章",
    "主角",
    "hook",
    "伏笔",
    "禁止",
    "不要",
  ]);
  for (const token of (goal ?? "").split(/[^\p{L}\p{N}]+/u)) {
    const trimmed = token.trim();
    if (trimmed.length >= 2) keywords.add(trimmed);
  }
  return [...keywords];
}

function splitSegments(text: string): ReadonlyArray<string> {
  const headingSections = text
    .split(/(?=^#{1,4}\s+)/m)
    .map((part) => part.trim())
    .filter(Boolean);
  if (headingSections.length > 1) return headingSections;

  return text
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function scoreSegment(segment: string, keywords: ReadonlyArray<string>): number {
  const lower = segment.toLowerCase();
  let score = 0;
  for (const keyword of keywords) {
    if (!keyword) continue;
    if (lower.includes(keyword.toLowerCase())) score += keyword.length >= 4 ? 3 : 1;
  }
  if (/主角|protagonist|当前状态|current state/i.test(segment)) score += 4;
  if (/hook|伏笔|pending|advance|resolve|defer/i.test(segment)) score += 4;
  if (/不要|禁止|prohibit|forbidden|do not/i.test(segment)) score += 3;
  return score;
}
