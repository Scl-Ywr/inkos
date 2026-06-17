import { readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import type { PlanChapterOutput } from "../agents/planner.js";
import {
  ChapterIntentSchema,
  type ChapterIntent,
} from "../models/input-governance.js";
import { parseMemo, PlannerParseError } from "../utils/chapter-memo-parser.js";

/**
 * Persisted governed plans are stored as a human-readable markdown file.
 * The model-facing memo protocol is also Markdown; we do not require LLMs to
 * emit YAML frontmatter. If an old YAML-frontmatter cache is encountered, this
 * loader returns null and the runner re-plans.
 *
 * File path: `story/runtime/chapter-NNNN.plan.md`
 *
 * The sibling `chapter-NNNN.intent.md` file stays as a human-readable
 * render — it is not parsed back. We keep it in sync by regenerating
 * downstream, but only this `.plan.md` is authoritative for restore.
 *
 * If parse fails for any reason we return null and let the runner re-invoke
 * the planner. We never try to partially reconstruct — silent degradation
 * is worse than re-planning.
 */

function planPath(bookDir: string, chapterNumber: number): string {
  const runtimeDir = join(bookDir, "story", "runtime");
  const padded = String(chapterNumber).padStart(4, "0");
  return join(runtimeDir, `chapter-${padded}.plan.md`);
}

function intentPath(bookDir: string, chapterNumber: number): string {
  const runtimeDir = join(bookDir, "story", "runtime");
  const padded = String(chapterNumber).padStart(4, "0");
  return join(runtimeDir, `chapter-${padded}.intent.md`);
}

export async function savePersistedPlan(
  bookDir: string,
  plan: PlanChapterOutput,
): Promise<void> {
  const { intent, memo, plannerInputs } = plan;
  const content = renderPersistedPlanMarkdown(intent, memo, plannerInputs);
  await writeFile(planPath(bookDir, memo.chapter), content, "utf-8");
}

export async function loadPersistedPlan(
  bookDir: string,
  chapterNumber: number,
): Promise<PlanChapterOutput | null> {
  let raw: string;
  try {
    raw = await readFile(planPath(bookDir, chapterNumber), "utf-8");
  } catch {
    return loadLegacyIntentPlan(bookDir, chapterNumber);
  }

  if (raw.trimStart().startsWith("---")) return null;

  // Reconstruct memo via the same strict parser planner uses. This guarantees
  // the 7 required section headings are still present — any drift triggers
  // re-planning (null return).
  let memo;
  try {
    const memoBlock = extractMarkedBlock(raw, "MEMO");
    if (!memoBlock) return null;
    memo = parseMemo(memoBlock, chapterNumber, readBooleanField(raw, "Golden Opening") ?? false);
  } catch (error) {
    if (error instanceof PlannerParseError) return null;
    throw error;
  }

  let intent: ChapterIntent;
  try {
    intent = ChapterIntentSchema.parse({
      chapter: chapterNumber,
      goal: readField(raw, "Intent Goal") ?? memo.goal,
      outlineNode: readOptionalField(raw, "Outline Node"),
      arcContext: readOptionalField(raw, "Arc Context"),
      mustKeep: readListSection(raw, "Must Keep"),
      mustAvoid: readListSection(raw, "Must Avoid"),
      styleEmphasis: readListSection(raw, "Style Emphasis"),
    });
  } catch {
    return null;
  }

  const plannerInputs = readListSection(raw, "Planner Inputs");

  // intentMarkdown is a display artifact — read the sibling .intent.md so we
  // surface the same content downstream consumers expect. If it's missing we
  // fall back to the memo body, which is usable but less rich.
  let intentMarkdown = memo.body;
  try {
    intentMarkdown = await readFile(intentPath(bookDir, chapterNumber), "utf-8");
  } catch {
    // fall through — memo body is a safe default.
  }

  return {
    intent,
    memo,
    intentMarkdown,
    plannerInputs,
    runtimePath: intentPath(bookDir, chapterNumber),
  };
}

function renderPersistedPlanMarkdown(
  intent: ChapterIntent,
  memo: PlanChapterOutput["memo"],
  plannerInputs: ReadonlyArray<string>,
): string {
  return [
    `# Chapter ${memo.chapter} Plan`,
    "",
    "## Metadata",
    `Chapter: ${memo.chapter}`,
    `Golden Opening: ${memo.isGoldenOpening ? "yes" : "no"}`,
    "",
    "<!-- INKOS_PLAN_MEMO_START -->",
    renderMemoMarkdown(memo),
    "<!-- INKOS_PLAN_MEMO_END -->",
    "",
    "## Intent",
    `Intent Goal: ${intent.goal}`,
    `Outline Node: ${intent.outlineNode ?? "(none)"}`,
    `Arc Context: ${intent.arcContext ?? "(none)"}`,
    "",
    "### Must Keep",
    renderList(intent.mustKeep),
    "",
    "### Must Avoid",
    renderList(intent.mustAvoid),
    "",
    "### Style Emphasis",
    renderList(intent.styleEmphasis),
    "",
    "## Planner Inputs",
    renderList(plannerInputs),
    "",
  ].join("\n");
}

function renderMemoMarkdown(memo: PlanChapterOutput["memo"]): string {
  return [
    `# 第 ${memo.chapter} 章 memo`,
    "",
    "## 本章目标",
    memo.goal,
    "",
    "## 关联线索",
    renderList(memo.threadRefs),
    "",
    memo.body.trim(),
  ].join("\n");
}

function renderList(items: ReadonlyArray<string>): string {
  return items.length > 0 ? items.map((item) => `- ${item}`).join("\n") : "- none";
}

function extractMarkedBlock(markdown: string, name: string): string | undefined {
  const match = markdown.match(new RegExp(`<!--\\s*INKOS_PLAN_${name}_START\\s*-->\\s*([\\s\\S]*?)\\s*<!--\\s*INKOS_PLAN_${name}_END\\s*-->`, "m"));
  return match?.[1]?.trim();
}

function readField(markdown: string, label: string): string | undefined {
  const match = markdown.match(new RegExp(`^${escapeRegExp(label)}:\\s*(.*)$`, "m"));
  const value = match?.[1]?.trim();
  return value && value !== "(none)" ? value : undefined;
}

function readOptionalField(markdown: string, label: string): string | undefined {
  const value = readField(markdown, label);
  return value && isMeaningfulLegacyValue(value) ? value : undefined;
}

function readBooleanField(markdown: string, label: string): boolean | undefined {
  const value = readField(markdown, label);
  if (!value) return undefined;
  if (/^(yes|true|是)$/i.test(value)) return true;
  if (/^(no|false|否)$/i.test(value)) return false;
  return undefined;
}

function readListSection(markdown: string, heading: string): string[] {
  const section = markdown.match(new RegExp(`^#{2,3}\\s+${escapeRegExp(heading)}\\s*\\n([\\s\\S]*?)(?=\\n#{2,3}\\s+|(?![\\s\\S]))`, "m"))?.[1]?.trim();
  if (!section) return [];
  return section
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("-"))
    .map((line) => line.replace(/^-\s*/, "").trim())
    .filter((line) => line.length > 0 && line.toLowerCase() !== "none");
}

async function loadLegacyIntentPlan(
  bookDir: string,
  chapterNumber: number,
): Promise<PlanChapterOutput | null> {
  let intentMarkdown: string;
  const runtimePath = intentPath(bookDir, chapterNumber);
  try {
    intentMarkdown = await readFile(runtimePath, "utf-8");
  } catch {
    return null;
  }

  const rawGoal = extractSection(intentMarkdown, "Goal");
  if (!rawGoal || !isMeaningfulLegacyValue(rawGoal)) return null;
  const goal = rawGoal;
  const outlineNodeRaw = extractSection(intentMarkdown, "Outline Node");
  const outlineNode = outlineNodeRaw && isMeaningfulLegacyValue(outlineNodeRaw)
    ? outlineNodeRaw
    : undefined;

  const intent: ChapterIntent = ChapterIntentSchema.parse({
    chapter: chapterNumber,
    goal,
    outlineNode,
    mustKeep: extractListSection(intentMarkdown, "Must Keep"),
    mustAvoid: extractListSection(intentMarkdown, "Must Avoid"),
    styleEmphasis: extractListSection(intentMarkdown, "Style Emphasis"),
  });

  return {
    intent,
    memo: {
      chapter: chapterNumber,
      goal: goal.slice(0, 50),
      isGoldenOpening: false,
      body: intentMarkdown,
      threadRefs: [],
      satisfactionBeats: [],
    },
    intentMarkdown,
    plannerInputs: [relativeToBookDir(bookDir, runtimePath)],
    runtimePath,
  };
}

function extractSection(markdown: string, heading: string): string | undefined {
  const match = markdown.match(new RegExp(`^## ${escapeRegExp(heading)}\\s*\\n([\\s\\S]*?)(?=\\n## |\\n### |$)`, "m"));
  const value = match?.[1]?.trim();
  return value && value !== "- none" ? value : undefined;
}

function extractListSection(markdown: string, heading: string): string[] {
  const section = extractSection(markdown, heading);
  if (!section) return [];
  return section
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("-"))
    .map((line) => line.replace(/^-\s*/, "").trim())
    .filter((line) => line.length > 0 && line.toLowerCase() !== "none");
}

function isMeaningfulLegacyValue(value: string): boolean {
  const normalized = value.trim();
  if (!normalized) return false;
  if (/^\(?not found\)?$/i.test(normalized)) return false;
  if (/^(?:none|null|undefined|n\/a)$/i.test(normalized)) return false;
  if (/^[*_`\-\s]+$/.test(normalized)) return false;
  return true;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function relativeToBookDir(bookDir: string, absolutePath: string): string {
  return relative(bookDir, absolutePath).replaceAll("\\", "/");
}
