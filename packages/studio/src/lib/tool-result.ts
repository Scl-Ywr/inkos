type TextLocalizer = (message: string) => string;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function firstTextContentPart(content: ReadonlyArray<unknown>): string | undefined {
  for (const part of content) {
    if (!isRecord(part) || part.type !== "text") continue;
    if (typeof part.text === "string") return part.text;
    if (typeof part.content === "string") return part.content;
  }
  return undefined;
}

function collectTextContentParts(content: ReadonlyArray<unknown>): string {
  return content
    .map((part) => {
      if (!isRecord(part) || part.type !== "text") return "";
      if (typeof part.text === "string") return part.text;
      if (typeof part.content === "string") return part.content;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

export function summarizeToolResult(
  result: unknown,
  options: { readonly maxLength?: number } = {},
): string {
  const maxLength = options.maxLength ?? 2000;
  if (typeof result === "string") return result.slice(0, maxLength);

  if (isRecord(result)) {
    if (typeof result.content === "string") return result.content.slice(0, maxLength);
    if (typeof result.text === "string") return result.text.slice(0, maxLength);
    if (Array.isArray(result.content)) {
      const text = collectTextContentParts(result.content);
      if (text.trim()) return text.slice(0, maxLength);
    }
  }

  return String(result).slice(0, maxLength);
}

export function extractToolDetails(result: unknown): unknown {
  return isRecord(result) ? result.details : undefined;
}

export function extractToolError(
  result: unknown,
  options: {
    readonly maxLength?: number;
    readonly localize?: TextLocalizer;
  } = {},
): string {
  const maxLength = options.maxLength ?? 500;
  const localize = options.localize ?? ((message) => message);

  if (typeof result === "string") {
    return localize(result).slice(0, maxLength);
  }

  if (isRecord(result)) {
    if (typeof result.content === "string") {
      return localize(result.content).slice(0, maxLength);
    }
    if (Array.isArray(result.content)) {
      const text = firstTextContentPart(result.content);
      if (text !== undefined) return localize(text).slice(0, maxLength);
    }
  }

  return localize(String(result)).slice(0, maxLength);
}
