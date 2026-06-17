import { z } from "zod";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

export const TimelineAnchorSchema = z.object({
  chapter: z.number().int().min(1),
  timeDescription: z.string().min(1),
  parsedDate: z.string().optional(),
  charactersPresent: z.array(z.string()).default([]),
  eventSummary: z.string().min(1),
});
export type TimelineAnchor = z.infer<typeof TimelineAnchorSchema>;

export const TimelineDataSchema = z.object({
  bookId: z.string().min(1),
  anchors: z.array(TimelineAnchorSchema).default([]),
  lastRebuilt: z.string().datetime().optional(),
});
export type TimelineData = z.infer<typeof TimelineDataSchema>;

const TIMELINE_FILE = "timeline.json";

export async function loadTimeline(bookDir: string): Promise<TimelineData> {
  try {
    const raw = await readFile(join(bookDir, TIMELINE_FILE), "utf-8");
    return TimelineDataSchema.parse(JSON.parse(raw));
  } catch {
    return { bookId: "", anchors: [] };
  }
}

export async function saveTimeline(bookDir: string, data: TimelineData): Promise<void> {
  await mkdir(bookDir, { recursive: true });
  await writeFile(join(bookDir, TIMELINE_FILE), JSON.stringify(data, null, 2), "utf-8");
}

const CHINESE_DATE_PATTERNS: ReadonlyArray<{
  re: RegExp;
  extract: (match: RegExpMatchArray) => string;
}> = [
  {
    re: /第([零一二三四五六七八九十百千万\d]+)年/g,
    extract: (m) => `第${m[1]}年`,
  },
  {
    re: /([零一二三四五六七八九十百千万\d]+)月([零一二三四五六七八九十百千万\d]+)日/g,
    extract: (m) => `${m[1]}月${m[2]}日`,
  },
  {
    re: /(\d{4})[年/-](\d{1,2})[月/-](\d{1,2})[日号]?/g,
    extract: (m) => `${m[1]}-${m[2]!.padStart(2, "0")}-${m[3]!.padStart(2, "0")}`,
  },
  {
    re: /三年后|三年之后|三个月后|三月之后/g,
    extract: (m) => m[0],
  },
  {
    re: /翌日|次日|第二天|当晚|那天|今日|昨日|前天/g,
    extract: (m) => m[0],
  },
];

export function extractTimelineAnchors(
  chapterNumber: number,
  content: string,
): ReadonlyArray<Omit<TimelineAnchor, "id">> {
  const anchors: Array<Omit<TimelineAnchor, "id">> = [];

  for (const pattern of CHINESE_DATE_PATTERNS) {
    let match: RegExpExecArray | null;
    while ((match = pattern.re.exec(content)) !== null) {
      const parsedDate = pattern.extract(match);
      // Get surrounding context (30 chars before and after)
      const start = Math.max(0, match.index - 30);
      const end = Math.min(content.length, match.index + match[0].length + 30);
      const context = content.slice(start, end).replace(/\n/g, " ").trim();

      // Avoid duplicate anchors at same position
      const alreadyExists = anchors.some(
        (a) => a.parsedDate === parsedDate && a.eventSummary === context,
      );
      if (!alreadyExists) {
        anchors.push({
          chapter: chapterNumber,
          timeDescription: match[0],
          parsedDate,
          charactersPresent: [],
          eventSummary: context.length > 60 ? `${context.slice(0, 57)}…` : context,
        });
      }
    }
  }

  return anchors;
}

export function validateTimelineConsistency(
  anchors: ReadonlyArray<TimelineAnchor>,
): ReadonlyArray<{ chapter: number; issue: string }> {
  const issues: Array<{ chapter: number; issue: string }> = [];

  for (let i = 1; i < anchors.length; i += 1) {
    const prev = anchors[i - 1]!;
    const curr = anchors[i]!;

    // Simple check: if chapter goes backward but time goes forward
    if (curr.chapter < prev.chapter && curr.parsedDate && prev.parsedDate) {
      // Numeric dates: check ordering
      const prevNum = parseInt(prev.parsedDate.replace(/\D/g, ""), 10);
      const currNum = parseInt(curr.parsedDate.replace(/\D/g, ""), 10);
      if (!Number.isNaN(prevNum) && !Number.isNaN(currNum) && currNum < prevNum) {
        issues.push({
          chapter: curr.chapter,
          issue: `时间倒流：第${curr.chapter}章的时间(${curr.parsedDate})早于第${prev.chapter}章(${prev.parsedDate})`,
        });
      }
    }
  }

  return issues;
}

export type { TimelineAnchor as TimelineAnchorType };
