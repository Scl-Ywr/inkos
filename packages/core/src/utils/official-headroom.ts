import type { LLMMessage } from "../llm/provider.js";
import type { HeadroomLightMode } from "./prompt-optimizer.js";

export interface OfficialHeadroomCompressionResult {
  readonly messages: LLMMessage[];
  readonly tokensBefore: number;
  readonly tokensAfter: number;
  readonly tokensSaved: number;
  readonly compressionRatio: number;
  readonly transformsApplied: readonly string[];
  readonly ccrHashes: readonly string[];
}

export interface OfficialHeadroomRetrieveResult {
  readonly originalContent: string;
  readonly originalTokens?: number;
  readonly toolName?: string;
}

const DEFAULT_HEADROOM_TIMEOUT_MS = 2_500;

export interface OfficialHeadroomStatus {
  readonly enabled: boolean;
  readonly configured: boolean;
  readonly lastCompressionOk: boolean | null;
  readonly lastCompressionAt: number | null;
  readonly lastError: string | null;
}

const officialHeadroomStatus: {
  lastCompressionOk: boolean | null;
  lastCompressionAt: number | null;
  lastError: string | null;
} = {
  lastCompressionOk: null,
  lastCompressionAt: null,
  lastError: null,
};

export function isOfficialHeadroomEnabled(): boolean {
  return Boolean(
    process.env.HEADROOM_BASE_URL
      || process.env.HEADROOM_API_KEY
      || process.env.INKOS_HEADROOM_OFFICIAL === "1",
  );
}

export function getOfficialHeadroomStatus(): OfficialHeadroomStatus {
  const configured = Boolean(process.env.HEADROOM_BASE_URL || process.env.HEADROOM_API_KEY);
  return {
    enabled: isOfficialHeadroomEnabled(),
    configured,
    lastCompressionOk: officialHeadroomStatus.lastCompressionOk,
    lastCompressionAt: officialHeadroomStatus.lastCompressionAt,
    lastError: officialHeadroomStatus.lastError,
  };
}

export async function compressWithOfficialHeadroom(
  messages: ReadonlyArray<LLMMessage>,
  options: {
    readonly model: string;
    readonly mode?: HeadroomLightMode;
    readonly tokenBudget?: number;
  },
): Promise<OfficialHeadroomCompressionResult | null> {
  if (!isOfficialHeadroomEnabled()) return null;

  try {
    officialHeadroomStatus.lastCompressionAt = Date.now();
    const { compress } = await import("headroom-ai");
    const result = await compress(
      messages.map((message) => ({ role: message.role, content: message.content })),
      {
        model: options.model,
        baseUrl: process.env.HEADROOM_BASE_URL,
        apiKey: process.env.HEADROOM_API_KEY,
        timeout: Number(process.env.INKOS_HEADROOM_TIMEOUT_MS ?? DEFAULT_HEADROOM_TIMEOUT_MS),
        fallback: true,
        retries: 0,
        tokenBudget: options.tokenBudget,
        stack: `inkos-${options.mode ?? "generic"}`,
        config: {
          cacheAligner: {
            enabled: true,
            normalizeWhitespace: true,
            collapseBlankLines: true,
          },
          ccr: {
            enabled: true,
            injectRetrievalMarker: true,
            injectTool: true,
            injectSystemInstructions: true,
          },
          smartCrusher: {
            enabled: true,
          },
          cacheOptimizer: {
            enabled: true,
            enableSemanticCache: true,
            semanticCacheSimilarity: 0.82,
          },
          rollingWindow: {
            enabled: true,
            keepSystem: true,
            keepLastTurns: 4,
          },
        },
      } as any,
    ) as {
      messages?: Array<{ role?: string; content?: string }>;
      tokensBefore?: number;
      tokensAfter?: number;
      tokensSaved?: number;
      compressionRatio?: number;
      transformsApplied?: string[];
      ccrHashes?: string[];
      compressed?: boolean;
    };

    if (!result.compressed || !Array.isArray(result.messages)) {
      officialHeadroomStatus.lastCompressionOk = false;
      officialHeadroomStatus.lastError = "Headroom returned no compressed messages.";
      return null;
    }
    const compressedMessages = result.messages
      .filter((message): message is { role: LLMMessage["role"]; content: string } =>
        (message.role === "system" || message.role === "user" || message.role === "assistant")
        && typeof message.content === "string",
      )
      .map((message) => ({ role: message.role, content: message.content }));
    if (compressedMessages.length !== messages.length) {
      officialHeadroomStatus.lastCompressionOk = false;
      officialHeadroomStatus.lastError = "Headroom returned a different message count.";
      return null;
    }

    officialHeadroomStatus.lastCompressionOk = true;
    officialHeadroomStatus.lastError = null;
    return {
      messages: compressedMessages,
      tokensBefore: result.tokensBefore ?? 0,
      tokensAfter: result.tokensAfter ?? 0,
      tokensSaved: result.tokensSaved ?? 0,
      compressionRatio: result.compressionRatio ?? 1,
      transformsApplied: result.transformsApplied ?? [],
      ccrHashes: result.ccrHashes ?? [],
    };
  } catch (error) {
    officialHeadroomStatus.lastCompressionOk = false;
    officialHeadroomStatus.lastCompressionAt = Date.now();
    officialHeadroomStatus.lastError = error instanceof Error ? error.message : String(error);
    return null;
  }
}

export async function retrieveFromOfficialHeadroom(hash: string): Promise<OfficialHeadroomRetrieveResult | null> {
  if (!isOfficialHeadroomEnabled()) return null;

  try {
    const { HeadroomClient } = await import("headroom-ai");
    const client = new HeadroomClient({
      baseUrl: process.env.HEADROOM_BASE_URL,
      apiKey: process.env.HEADROOM_API_KEY,
      timeout: Number(process.env.INKOS_HEADROOM_TIMEOUT_MS ?? DEFAULT_HEADROOM_TIMEOUT_MS),
      fallback: true,
      retries: 0,
      stack: "inkos-ccr-retrieve",
    } as any);
    const result = await client.retrieve(hash) as unknown;
    if (!result || typeof result !== "object" || !("originalContent" in result)) return null;
    const retrieved = result as {
      originalContent?: unknown;
      originalTokens?: unknown;
      toolName?: unknown;
    };
    if (typeof retrieved.originalContent !== "string") return null;
    return {
      originalContent: retrieved.originalContent,
      originalTokens: typeof retrieved.originalTokens === "number" ? retrieved.originalTokens : undefined,
      toolName: typeof retrieved.toolName === "string" ? retrieved.toolName : undefined,
    };
  } catch {
    return null;
  }
}
