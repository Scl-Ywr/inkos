import { z } from "zod";
import yaml from "js-yaml";

const ProtagonistSchema = z.object({
  name: z.string(),
  personalityLock: z.array(z.string()).default([]),
  behavioralConstraints: z.array(z.string()).default([]),
}).optional();

const GenreLockSchema = z.object({
  primary: z.string(),
  forbidden: z.array(z.string()).default([]),
}).optional();

const NumericalOverridesSchema = z.object({
  hardCap: z.union([z.number(), z.string()]).optional(),
  resourceTypes: z.array(z.string()).default([]),
}).optional();

const EraConstraintsSchema = z.object({
  enabled: z.boolean().default(false),
  period: z.string().optional(),
  region: z.string().optional(),
}).optional();

export const BookRulesSchema = z.object({
  version: z.string().default("1.0"),
  protagonist: ProtagonistSchema,
  genreLock: GenreLockSchema,
  // Narrative person, set ONLY when the user explicitly asked for one. Lenient:
  // a stray/placeholder value degrades to undefined rather than breaking the
  // whole book_rules parse (fail-open).
  narrativePerson: z.enum(["first", "third"]).optional().catch(undefined),
  numericalSystemOverrides: NumericalOverridesSchema,
  eraConstraints: EraConstraintsSchema,
  prohibitions: z.array(z.string()).default([]),
  chapterTypesOverride: z.array(z.string()).default([]),
  fatigueWordsOverride: z.array(z.string()).default([]),
  bannedWords: z.array(z.string()).default([]),
  preferredWords: z.array(z.object({ avoid: z.string(), prefer: z.string() })).default([]),
  domainTerms: z.array(z.object({ term: z.string(), definition: z.string().optional() })).default([]),
  additionalAuditDimensions: z.array(z.union([z.number(), z.string()])).default([]),
  enableFullCastTracking: z.boolean().default(false),
  fanficMode: z.enum(["canon", "au", "ooc", "cp"]).optional(),
  allowedDeviations: z.array(z.string()).default([]),
});

export type BookRules = z.infer<typeof BookRulesSchema>;

export interface ParsedBookRules {
  readonly rules: BookRules;
  readonly body: string;
}

/**
 * Legacy Phase 5 books may still contain a compat pointer instead of real
 * rules. Detect that shim so callers can fall back to old story_frame
 * frontmatter instead of treating the pointer as legitimate empty rules.
 *
 * Markers (must match buildBookRulesShim() in architect.ts):
 *   - 本书规则（兼容指针——已废弃） / Book Rules (compat pointer — deprecated)
 *   - 本文件仅为外部读取保留 / This file is kept for external readers only
 */
export function isBookRulesShim(raw: string): boolean {
  return (
    /本书规则（兼容指针——已废弃）/.test(raw)
    || /Book Rules \(compat pointer — deprecated\)/.test(raw)
    || /本文件仅为外部读取保留/.test(raw)
    || /This file is kept for external readers only/.test(raw)
  );
}

export function parseBookRules(raw: string): ParsedBookRules | null {
  // Strip markdown code block wrappers if present (LLM often wraps output in ```md ... ```)
  const stripped = raw.replace(/^```(?:md|markdown|yaml)?\s*\n/, "").replace(/\n```\s*$/, "");

  // Try to find YAML frontmatter anywhere in the text (not just at the start)
  const fmMatch = stripped.match(/---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (fmMatch) {
    try {
      const frontmatter = yaml.load(fmMatch[1]) as Record<string, unknown>;
      const rules = BookRulesSchema.parse(frontmatter);
      const body = fmMatch[2].trim();
      return { rules, body };
    } catch {
      // YAML parse failed — fall through to shim/default check.
    }
  }

  // Phase hotfix 1: refuse to silently zero out rules when reading a Phase 5
  // compat shim. The shim has no real rules; pretending it parses as
  // "default empty" wipes protagonist / prohibitions / genreLock for any
  // caller that fell back to it after a broken story_frame frontmatter.
  if (isBookRulesShim(stripped)) {
    return null;
  }

  // New layout: book_rules.md is ordinary Markdown. The model no longer has
  // to emit YAML; the host extracts the small structured rule surface it needs
  // and keeps the full Markdown as human-readable body.
  const rules = parseMarkdownBookRules(stripped);
  return { rules, body: stripped.trim() };
}

/**
 * Stricter variant of parseBookRules: returns null if the input has no valid
 * YAML frontmatter OR if the frontmatter fails to parse / validate. Unlike
 * parseBookRules, this never falls back to default rules — callers can use
 * the null return to trigger their own fallback (e.g. legacy book_rules.md).
 *
 * Phase 5 hotfix 3: readBookRules() uses this to detect a broken YAML block
 * on story_frame.md and fall back to legacy book_rules.md instead of
 * silently clearing protagonist / prohibitions / genreLock.
 */
export function tryParseBookRulesFrontmatter(
  raw: string,
  onError?: (error: unknown) => void,
): ParsedBookRules | null {
  const stripped = raw.replace(/^```(?:md|markdown|yaml)?\s*\n/, "").replace(/\n```\s*$/, "");
  const fmMatch = stripped.match(/---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!fmMatch) return null;

  try {
    const frontmatter = yaml.load(fmMatch[1]) as Record<string, unknown>;
    const rules = BookRulesSchema.parse(frontmatter);
    const body = fmMatch[2].trim();
    return { rules, body };
  } catch (err) {
    if (onError) onError(err);
    return null;
  }
}

function parseMarkdownBookRules(raw: string): BookRules {
  const protagonistSection = extractMarkdownSection(raw, ["主角", "Protagonist"]);
  const protagonistName =
    readLabeledValue(protagonistSection, ["名字", "姓名", "name", "protagonist"])
    ?? readLabeledValue(raw, ["主角", "protagonist"]);
  const personalityLock = readLabeledList(protagonistSection, [
    "性格锁",
    "性格关键词",
    "personalityLock",
    "personality lock",
    "core tags",
  ]);
  const behavioralConstraints = readLabeledList(protagonistSection, [
    "行为约束",
    "behavioralConstraints",
    "behavioral constraints",
  ]);

  const genreSection = extractMarkdownSection(raw, ["题材锁", "Genre Lock", "Genre"]);
  const primary = readLabeledValue(genreSection, ["主类型", "题材", "primary", "genre"]);
  const forbidden = [
    ...readLabeledList(genreSection, ["禁止混入", "禁混", "forbidden"]),
    ...readMarkdownList(extractMarkdownSection(raw, ["禁止混入", "Forbidden Style Intrusions", "Forbidden"])),
  ];

  const prohibitions = readMarkdownList(extractMarkdownSection(raw, [
    "禁止事项",
    "禁忌",
    "本书禁忌",
    "Prohibitions",
    "Do Not",
  ]));
  const fanficSection = extractMarkdownSection(raw, ["同人模式", "Fanfic Mode", "Fanfic"]);
  const fanficMode = normalizeFanficMode(readLabeledValue(fanficSection, [
    "模式",
    "同人模式",
    "fanficMode",
    "fanfic mode",
    "mode",
  ]));
  const allowedDeviations = readLabeledList(fanficSection, [
    "允许偏离",
    "允许的偏离",
    "allowedDeviations",
    "allowed deviations",
  ]);

  const numericalSection = extractMarkdownSection(raw, [
    "数值/资源规则",
    "数值规则",
    "资源规则",
    "Numerical / Resource Rules",
    "Numerical Rules",
    "Resource Rules",
  ]);
  const resourceTypes = readLabeledList(numericalSection, [
    "核心资源",
    "资源类型",
    "resourceTypes",
    "core resources",
    "resources",
  ]);
  const hardCap = readLabeledValue(numericalSection, ["硬上限", "hardCap", "hard cap"]);

  const eraSection = extractMarkdownSection(raw, ["年代限制", "时代限制", "Era Constraints"]);
  const period = readLabeledValue(eraSection, ["时期", "年代", "period", "era"]);
  const region = readLabeledValue(eraSection, ["地域", "地区", "region"]);

  return BookRulesSchema.parse({
    protagonist: protagonistName
      ? {
          name: protagonistName,
          personalityLock,
          behavioralConstraints,
        }
      : undefined,
    genreLock: primary || forbidden.length > 0
      ? {
          primary: primary ?? "",
          forbidden,
        }
      : undefined,
    narrativePerson: detectNarrativePerson(raw),
    numericalSystemOverrides: hardCap || resourceTypes.length > 0
      ? {
          hardCap,
          resourceTypes,
        }
      : undefined,
    eraConstraints: eraSection
      ? {
          enabled: true,
          period,
          region,
        }
      : undefined,
    prohibitions,
    fanficMode,
    allowedDeviations,
  });
}

function extractMarkdownSection(raw: string, headings: ReadonlyArray<string>): string {
  const wanted = new Set(headings.map(normalizeHeading));
  const lines = raw.split(/\r?\n/);
  let collecting = false;
  const out: string[] = [];

  for (const line of lines) {
    const heading = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/)?.[1];
    if (heading) {
      if (collecting) break;
      collecting = wanted.has(normalizeHeading(heading));
      continue;
    }
    if (collecting) out.push(line);
  }

  return out.join("\n").trim();
}

function readLabeledValue(raw: string, labels: ReadonlyArray<string>): string | undefined {
  if (!raw.trim()) return undefined;
  const labelPattern = labels.map(escapeRegExp).join("|");
  const match = raw.match(new RegExp(`^\\s*(?:[-*]\\s*)?(?:${labelPattern})\\s*[:：]\\s*(.+?)\\s*$`, "im"));
  const value = cleanScalar(match?.[1] ?? "");
  return value || undefined;
}

function readLabeledList(raw: string, labels: ReadonlyArray<string>): string[] {
  const value = readLabeledValue(raw, labels);
  return value ? splitList(value) : [];
}

function readMarkdownList(raw: string): string[] {
  if (!raw.trim()) return [];
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^[-*]\s+/.test(line))
    .map((line) => cleanScalar(line.replace(/^[-*]\s+/, "")))
    .filter((value) => value.length > 0);
}

function splitList(value: string): string[] {
  const stripped = cleanScalar(value).replace(/^[\[(（【]\s*/, "").replace(/\s*[\])）】]$/, "");
  return stripped
    .split(/[、,，;；|]/)
    .map(cleanScalar)
    .filter((item) => item.length > 0);
}

function detectNarrativePerson(raw: string): "first" | "third" | undefined {
  if (/第一人称|first[-\s]?person|\bfirst\b/i.test(raw)) return "first";
  if (/第三人称|third[-\s]?person|\bthird\b/i.test(raw)) return "third";
  return undefined;
}

function normalizeFanficMode(value: string | undefined): "canon" | "au" | "ooc" | "cp" | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "canon" || /正典|原作空白|原作视角/.test(value)) return "canon";
  if (normalized === "au" || /平行|分歧|if线/i.test(value)) return "au";
  if (normalized === "ooc" || /性格偏离/i.test(value)) return "ooc";
  if (normalized === "cp" || /配对|感情线/i.test(value)) return "cp";
  return undefined;
}

function cleanScalar(value: string): string {
  const trimmed = value
    .trim()
    .replace(/^["'`“”‘’]+|["'`“”‘’]+$/g, "")
    .trim();
  return /^(?:无|none|n\/a|na|\(none\)|（无）|-|—)$/i.test(trimmed) ? "" : trimmed;
}

function normalizeHeading(value: string): string {
  return value.replace(/[：:]\s*$/, "").trim().toLowerCase();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
