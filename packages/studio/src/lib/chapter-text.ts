export interface ChapterDisplayText {
  readonly title: string;
  readonly body: string;
  readonly paragraphs: ReadonlyArray<string>;
  readonly plainText: string;
}

const DEFAULT_MAX_PARAGRAPH_CHARS = 120;
const MIN_SPLIT_CHARS = 48;
const CHINESE_PARAGRAPH_INDENT = "\u3000\u3000";

export function parseChapterMarkdown(content: string, chapterNumber: number): {
  readonly title: string;
  readonly body: string;
} {
  const lines = content.split("\n");
  const titleLine = lines.find((line) => line.startsWith("# "));
  const title = titleLine?.replace(/^#\s*/, "").trim() || `Chapter ${chapterNumber}`;
  const body = lines
    .filter((line) => line !== titleLine)
    .join("\n")
    .trim();
  return { title, body };
}

export function formatChapterForReading(
  content: string,
  chapterNumber: number,
  options: { readonly maxParagraphChars?: number } = {},
): ChapterDisplayText {
  const { title, body } = parseChapterMarkdown(content, chapterNumber);
  const paragraphs = splitLongParagraphs(body, options.maxParagraphChars ?? DEFAULT_MAX_PARAGRAPH_CHARS)
    .map(formatReadingParagraph);
  return {
    title,
    body,
    paragraphs,
    plainText: [title, "", ...paragraphs].join("\n\n").trimEnd() + "\n",
  };
}

function formatReadingParagraph(paragraph: string): string {
  const trimmed = paragraph.trim();
  if (!trimmed) return "";
  return `${CHINESE_PARAGRAPH_INDENT}${trimmed.replace(/^\u3000{1,2}/u, "")}`;
}

export function splitLongParagraphs(
  body: string,
  maxChars: number = DEFAULT_MAX_PARAGRAPH_CHARS,
): string[] {
  return body
    .split(/\n\s*\n+/)
    .flatMap((paragraph) => splitParagraph(paragraph.trim(), maxChars))
    .filter(Boolean);
}

function splitParagraph(paragraph: string, maxChars: number): string[] {
  if (!paragraph || paragraph.length <= maxChars) return paragraph ? [paragraph] : [];
  const sentences = paragraph
    .replace(/\s+/g, "")
    .match(/[^。！？!?；;……]+(?:……|[。！？!?；;]|$)/g)
    ?.map((sentence) => sentence.trim())
    .filter(Boolean) ?? [paragraph];

  const chunks: string[] = [];
  let current = "";
  for (const sentence of sentences) {
    if (!current) {
      current = sentence;
      continue;
    }
    if (current.length + sentence.length <= maxChars || current.length < MIN_SPLIT_CHARS) {
      current += sentence;
      continue;
    }
    chunks.push(current);
    current = sentence;
  }
  if (current) chunks.push(current);

  return chunks.flatMap((chunk) => chunk.length > maxChars * 1.45
    ? hardSplitLongSentence(chunk, maxChars)
    : [chunk]);
}

function hardSplitLongSentence(text: string, maxChars: number): string[] {
  const chunks: string[] = [];
  for (let start = 0; start < text.length; start += maxChars) {
    chunks.push(text.slice(start, start + maxChars));
  }
  return chunks;
}

export function makeTxtFilename(bookId: string, chapterNumber: number, title: string): string {
  const safeBook = sanitizeFilenamePart(bookId) || "book";
  const safeTitle = sanitizeFilenamePart(title.replace(/^第?\s*\d+\s*章\s*/u, "")) || `chapter-${chapterNumber}`;
  return `${safeBook}-chapter-${String(chapterNumber).padStart(4, "0")}-${safeTitle}.txt`;
}

function sanitizeFilenamePart(value: string): string {
  return value
    .trim()
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 48)
    .replace(/^-|-$/g, "");
}
