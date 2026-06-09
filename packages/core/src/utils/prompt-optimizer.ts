export const INKOS_PROMPT_CACHE_POLICY = {
  rollingChapterWindow: 4,
  ragTopK: 3,
  semanticSimilarityThreshold: 0.82,
  l1HotEntityLimit: 48,
  l1IdleTtlMs: 15 * 60 * 1000,
  l3ArchiveAfterDays: 30,
} as const;

export type HeadroomLightMode = "setting" | "narrative" | "json";

export function normalizePromptForCache(input: string): string {
  return input
    .replace(/\r\n?/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+$/gm, "")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, "<uuid>")
    .replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/g, "<timestamp>")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function headroomLightCompress(input: string, mode: HeadroomLightMode): string {
  if (!input.trim()) return input;
  if (mode === "json") return compressJsonLike(input);

  const lines = input
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => compressLine(line, mode))
    .filter((line, index, lines) => line.length > 0 || lines[index - 1]?.length !== 0);

  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function optimizePromptBlock(input: string, mode: HeadroomLightMode): string {
  return normalizePromptForCache(headroomLightCompress(input, mode));
}

function compressJsonLike(input: string): string {
  try {
    return JSON.stringify(JSON.parse(input));
  } catch {
    return input.replace(/[ \t]+/g, " ").replace(/\n{2,}/g, "\n").trim();
  }
}

function compressLine(line: string, mode: HeadroomLightMode): string {
  const trimmed = line.trimEnd();
  if (!trimmed) return "";
  if (trimmed.includes("|")) {
    return trimmed.replace(/([，。！？、,.!?])\1{1,}/g, "$1");
  }

  let result = trimmed
    .replace(/[ \t]{2,}/g, " ")
    .replace(/([，。！？、,.!?])\1{1,}/g, "$1")
    .replace(/([\u4e00-\u9fff]{1,3})\1{2,}/g, "$1$1");

  if (mode === "narrative") {
    result = result
      .replace(/(?:他|她|他们|众人)?(?:沉默了片刻|一时无言|空气仿佛凝固了)[，。；;]?\s*/g, "")
      .replace(/(?:夜色|月光|风声|烛火)(?:依旧|仍旧|还是)?(?:静静地|缓缓地)?(?:铺开|摇曳|流淌)[，。；;]?\s*/g, "");
  }

  if (mode === "setting") {
    result = result
      .replace(/(?:非常|极其|十分|格外|略显|有些|似乎|仿佛|隐约)/g, "")
      .replace(/(?:需要注意的是|值得一提的是|总体来说)[：:，,]?\s*/g, "");
  }

  return result.trimEnd();
}
