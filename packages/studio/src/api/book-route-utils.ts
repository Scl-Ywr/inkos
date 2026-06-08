import { readdir } from "node:fs/promises";
import type { Context } from "hono";

export type ExportFormat = "txt" | "md" | "epub";
export type JsonObject = Record<string, unknown>;
export type JsonObjectParseResult =
  | { readonly ok: true; readonly value: JsonObject }
  | { readonly ok: false; readonly error: string };

export function parsePositiveIntegerParam(value: string): number | null {
  if (!/^[1-9]\d*$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export async function findChapterMarkdownFile(
  chaptersDir: string,
  chapterNumber: number,
): Promise<string | null> {
  if (!Number.isSafeInteger(chapterNumber) || chapterNumber < 1) return null;
  const files = await readdir(chaptersDir).catch(() => []);
  const paddedNum = String(chapterNumber).padStart(4, "0");
  return files.find((file) => file.startsWith(paddedNum) && file.endsWith(".md")) ?? null;
}

export function parseExportFormat(value: unknown, fallback: ExportFormat): ExportFormat | null {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return normalized === "txt" || normalized === "md" || normalized === "epub"
    ? normalized
    : null;
}

export function validateRegexPattern(pattern: unknown): string | null {
  if (pattern === undefined || pattern === null || pattern === "") return null;
  if (typeof pattern !== "string") return "splitRegex must be a string";
  try {
    new RegExp(pattern, "m");
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export async function parseJsonObjectBody(c: Context): Promise<JsonObjectParseResult> {
  try {
    const value = await c.req.json<unknown>();
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { ok: false, error: "JSON body must be an object" };
    }
    return { ok: true, value: value as JsonObject };
  } catch {
    return { ok: false, error: "Invalid JSON body" };
  }
}
