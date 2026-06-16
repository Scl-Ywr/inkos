import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { detectFormat } from "headroom-ai";
import { createHash } from "node:crypto";
import { estimateTokens } from "@actalk/inkos-core";
import { compressHeadroomWithPython } from "./python-runtime.js";

const REQUIRED_TOOLS = ["headroom_compress", "headroom_retrieve", "headroom_stats"] as const;
const DEFAULT_TIMEOUT_MS = 8_000;

type HeadroomState = "disabled" | "idle" | "connecting" | "online" | "offline";
type HeadroomRuntimeMode = "external-mcp" | "bundled";

interface HeadroomStats {
  readonly compressions?: number;
  readonly retrievals?: number;
  readonly tokens_saved?: number;
  readonly savings_percent?: number;
  readonly estimated_cost_saved_usd?: number;
}

export interface HeadroomCompressionResult {
  readonly compressed: string;
  readonly hash?: string;
  readonly originalTokens?: number;
  readonly compressedTokens?: number;
  readonly savingsPercent?: number;
  readonly transforms: readonly string[];
}

export interface HeadroomMcpStatus {
  readonly enabled: boolean;
  readonly configured: boolean;
  readonly state: HeadroomState;
  readonly mode: HeadroomRuntimeMode;
  readonly command: string;
  readonly args: readonly string[];
  readonly tools: readonly string[];
  readonly lastCheckedAt: string | null;
  readonly lastCompressionAt: string | null;
  readonly lastCompressionOk: boolean | null;
  readonly lastError: string | null;
  readonly stats: HeadroomStats | null;
  readonly session: {
    readonly compressions: number;
    readonly originalTokens: number;
    readonly compressedTokens: number;
    readonly tokensSaved: number;
    readonly originalChars: number;
    readonly compressedChars: number;
  };
}

function envEnabled(name: string, fallback: boolean): boolean {
  const raw = String(process.env[name] ?? "").trim().toLowerCase();
  if (!raw) return fallback;
  return !["0", "false", "no", "off"].includes(raw);
}

function positiveNumber(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}

function parseArgs(raw: string | undefined): string[] {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) return ["mcp", "serve"];
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed) && parsed.every((value) => typeof value === "string")) {
      return parsed;
    }
  } catch {
    // Fall through to shell-like whitespace parsing.
  }
  return trimmed.match(/(?:[^\s"]+|"[^"]*")+/g)?.map((part) => part.replace(/^"|"$/g, "")) ?? [];
}

function resolveRuntimeMode(): HeadroomRuntimeMode {
  const raw = String(process.env.INKOS_HEADROOM_MODE ?? "").trim().toLowerCase();
  if (raw === "bundled" || raw === "embedded" || raw === "internal") return "bundled";
  if (raw === "external" || raw === "external-mcp" || raw === "mcp") return "external-mcp";
  return process.env.INKOS_ANDROID === "1" ? "bundled" : "external-mcp";
}

function textFromToolResult(result: Record<string, unknown>): string {
  const content = result.content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (!block || typeof block !== "object") return "";
      const record = block as Record<string, unknown>;
      return record.type === "text" && typeof record.text === "string" ? record.text : "";
    })
    .filter(Boolean)
    .join("\n");
}

function dataFromToolResult(result: unknown): Record<string, unknown> {
  if (!result || typeof result !== "object") return {};
  const record = result as Record<string, unknown>;
  if (record.isError === true) {
    throw new Error(textFromToolResult(record) || "Headroom MCP tool returned an error.");
  }
  if (record.structuredContent && typeof record.structuredContent === "object") {
    return record.structuredContent as Record<string, unknown>;
  }
  const text = textFromToolResult(record).trim();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : { text };
  } catch {
    return { text };
  }
}

function looksLikeMojibake(value: string): boolean {
  return /�{2,}|���|����|\uFFFD/.test(value);
}

function cleanProcessError(command: string, message: string, stderr: string): string {
  const lower = `${message}\n${stderr}`.toLowerCase();
  if (lower.includes("enoent") || lower.includes("not recognized") || lower.includes("command not found") || lower.includes(command.toLowerCase())) {
    if (!stderr || looksLikeMojibake(stderr) || message.includes("Connection closed")) {
      return `Headroom MCP command not found: ${command}. Install with: pip install "headroom-ai[mcp]". InkOS is using local context compression fallback.`;
    }
  }
  return [message, looksLikeMojibake(stderr) ? "" : stderr].filter(Boolean).join(" | ").slice(0, 2_000);
}

function bundledCompress(content: string): HeadroomCompressionResult {
  detectFormat([{ role: "user", content }]);
  const lines = content.split(/\r?\n/);
  const headings = lines
    .map((line) => line.trim())
    .filter((line) => /^#{1,6}\s+\S/.test(line))
    .slice(0, 80);
  const compacted = [
    "[Bundled Headroom-compatible compression]",
    headings.length > 0 ? "## Markdown outline\n" + headings.join("\n") : "",
    "## Front context\n" + content.slice(0, 1400).trim(),
    content.length > 2800 ? "## Tail context\n" + content.slice(-1000).trim() : "",
  ].filter(Boolean).join("\n\n");
  return {
    compressed: compacted,
    hash: createHash("sha256").update(content).digest("hex").slice(0, 16),
    originalTokens: estimateTokens(content),
    compressedTokens: estimateTokens(compacted),
    savingsPercent: Math.max(0, Math.round((1 - estimateTokens(compacted) / estimateTokens(content)) * 100)),
    transforms: ["bundled-outline", "front-tail-retention"],
  };
}

export class HeadroomMcpManager {
  private readonly enabled = envEnabled("INKOS_HEADROOM_ENABLED", true);
  private readonly mode = resolveRuntimeMode();
  private readonly command = String(process.env.INKOS_HEADROOM_COMMAND ?? "headroom").trim() || "headroom";
  private readonly args = parseArgs(process.env.INKOS_HEADROOM_ARGS);
  private readonly timeoutMs = positiveNumber(process.env.INKOS_HEADROOM_TIMEOUT_MS) ?? DEFAULT_TIMEOUT_MS;
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private connectPromise: Promise<Client> | null = null;
  private state: HeadroomState = this.enabled ? "idle" : "disabled";
  private tools: string[] = [];
  private lastCheckedAt: string | null = null;
  private lastCompressionAt: string | null = null;
  private lastCompressionOk: boolean | null = null;
  private lastError: string | null = null;
  private stats: HeadroomStats | null = null;
  private stderrTail = "";
  private sessionCompressions = 0;
  private sessionOriginalTokens = 0;
  private sessionCompressedTokens = 0;
  private sessionOriginalChars = 0;
  private sessionCompressedChars = 0;

  async check(): Promise<HeadroomMcpStatus> {
    if (!this.enabled) return this.getStatus();
    this.lastCheckedAt = new Date().toISOString();
    if (this.mode === "bundled") {
      this.state = "online";
      this.tools = [...REQUIRED_TOOLS];
      this.lastError = null;
      this.stats = {
        compressions: this.sessionCompressions,
        tokens_saved: Math.max(0, this.sessionOriginalTokens - this.sessionCompressedTokens),
        savings_percent: this.sessionOriginalTokens > 0
          ? Math.round((1 - this.sessionCompressedTokens / this.sessionOriginalTokens) * 100)
          : 0,
      };
      return this.getStatus();
    }
    try {
      const client = await this.ensureClient();
      await this.refreshTools(client);
      const missing = REQUIRED_TOOLS.filter((tool) => !this.tools.includes(tool));
      if (missing.length > 0) {
        throw new Error(`Headroom MCP missing tools: ${missing.join(", ")}`);
      }
      this.stats = await this.readStats(client);
      this.state = "online";
      this.lastError = null;
    } catch (error) {
      await this.markOffline(error);
    }
    return this.getStatus();
  }

  async compress(content: string): Promise<HeadroomCompressionResult | null> {
    if (!this.enabled || !content.trim()) return null;
    this.lastCompressionAt = new Date().toISOString();
    if (this.mode === "bundled") {
      const pythonResult = await compressHeadroomWithPython(content).catch(() => null);
      const result: HeadroomCompressionResult = pythonResult?.ok && pythonResult.compressed.trim()
        ? {
            compressed: pythonResult.compressed,
            ...(pythonResult.hash ? { hash: pythonResult.hash } : {}),
            ...(pythonResult.originalTokens !== undefined ? { originalTokens: pythonResult.originalTokens } : {}),
            ...(pythonResult.compressedTokens !== undefined ? { compressedTokens: pythonResult.compressedTokens } : {}),
            ...(pythonResult.savingsPercent !== undefined ? { savingsPercent: pythonResult.savingsPercent } : {}),
            transforms: pythonResult.transforms.length > 0 ? pythonResult.transforms : ["android-python-headroom"],
          }
        : bundledCompress(content);
      this.tools = [...REQUIRED_TOOLS];
      this.sessionCompressions += 1;
      this.sessionOriginalTokens += result.originalTokens ?? 0;
      this.sessionCompressedTokens += result.compressedTokens ?? 0;
      this.sessionOriginalChars += content.length;
      this.sessionCompressedChars += result.compressed.length;
      this.lastCompressionOk = true;
      this.lastError = null;
      this.state = "online";
      return result;
    }
    try {
      const client = await this.ensureClient();
      const raw = await client.callTool(
        { name: "headroom_compress", arguments: { content } },
        undefined,
        { timeout: this.timeoutMs },
      );
      const data = dataFromToolResult(raw);
      const compressed = String(data.compressed ?? data.text ?? "").trim();
      if (!compressed) throw new Error("Headroom MCP returned no compressed content.");
      const originalTokens = positiveNumber(data.original_tokens);
      const compressedTokens = positiveNumber(data.compressed_tokens);
      const transforms = Array.isArray(data.transforms)
        ? data.transforms.map(String)
        : [];
      this.sessionCompressions += 1;
      this.sessionOriginalTokens += originalTokens ?? 0;
      this.sessionCompressedTokens += compressedTokens ?? 0;
      this.sessionOriginalChars += content.length;
      this.sessionCompressedChars += compressed.length;
      this.lastCompressionOk = true;
      this.lastError = null;
      this.state = "online";
      return {
        compressed,
        ...(typeof data.hash === "string" && data.hash ? { hash: data.hash } : {}),
        ...(originalTokens !== undefined ? { originalTokens } : {}),
        ...(compressedTokens !== undefined ? { compressedTokens } : {}),
        ...(positiveNumber(data.savings_percent) !== undefined
          ? { savingsPercent: positiveNumber(data.savings_percent) }
          : {}),
        transforms,
      };
    } catch (error) {
      this.lastCompressionOk = false;
      await this.markOffline(error);
      return null;
    }
  }

  getStatus(): HeadroomMcpStatus {
    const tokensSaved = Math.max(0, this.sessionOriginalTokens - this.sessionCompressedTokens);
    return {
      enabled: this.enabled,
      configured: Boolean(this.command),
      state: this.state,
      mode: this.mode,
      command: this.command,
      args: this.args,
      tools: this.tools,
      lastCheckedAt: this.lastCheckedAt,
      lastCompressionAt: this.lastCompressionAt,
      lastCompressionOk: this.lastCompressionOk,
      lastError: this.lastError,
      stats: this.stats,
      session: {
        compressions: this.sessionCompressions,
        originalTokens: this.sessionOriginalTokens,
        compressedTokens: this.sessionCompressedTokens,
        tokensSaved,
        originalChars: this.sessionOriginalChars,
        compressedChars: this.sessionCompressedChars,
      },
    };
  }

  private async ensureClient(): Promise<Client> {
    if (this.client && this.state === "online") return this.client;
    if (this.connectPromise) return this.connectPromise;
    this.state = "connecting";
    this.connectPromise = this.connect().finally(() => {
      this.connectPromise = null;
    });
    return this.connectPromise;
  }

  private async connect(): Promise<Client> {
    const transport = new StdioClientTransport({
      command: this.command,
      args: this.args,
      cwd: process.cwd(),
      stderr: "pipe",
    });
    transport.stderr?.on("data", (chunk) => {
      this.stderrTail = `${this.stderrTail}${String(chunk)}`.slice(-2_000);
    });
    transport.onclose = () => {
      this.client = null;
      this.transport = null;
      if (this.state === "online") this.state = "offline";
    };
    const client = new Client({ name: "inkos-studio", version: "1.6.0" });
    await client.connect(transport, { timeout: this.timeoutMs });
    this.client = client;
    this.transport = transport;
    await this.refreshTools(client);
    this.state = "online";
    return client;
  }

  private async refreshTools(client: Client): Promise<void> {
    const result = await client.listTools(undefined, { timeout: this.timeoutMs });
    this.tools = result.tools.map((tool) => tool.name);
  }

  private async readStats(client: Client): Promise<HeadroomStats | null> {
    const raw = await client.callTool(
      { name: "headroom_stats", arguments: {} },
      undefined,
      { timeout: this.timeoutMs },
    );
    const data = dataFromToolResult(raw);
    return {
      ...(positiveNumber(data.compressions) !== undefined ? { compressions: positiveNumber(data.compressions) } : {}),
      ...(positiveNumber(data.retrievals) !== undefined ? { retrievals: positiveNumber(data.retrievals) } : {}),
      ...(positiveNumber(data.tokens_saved) !== undefined ? { tokens_saved: positiveNumber(data.tokens_saved) } : {}),
      ...(positiveNumber(data.savings_percent) !== undefined ? { savings_percent: positiveNumber(data.savings_percent) } : {}),
      ...(positiveNumber(data.estimated_cost_saved_usd) !== undefined
        ? { estimated_cost_saved_usd: positiveNumber(data.estimated_cost_saved_usd) }
        : {}),
    };
  }

  private async markOffline(error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    this.lastError = cleanProcessError(this.command, message, this.stderrTail.trim());
    this.state = "offline";
    const client = this.client;
    const transport = this.transport;
    this.client = null;
    this.transport = null;
    if (client) {
      await client.close().catch(() => undefined);
    } else if (transport) {
      await transport.close().catch(() => undefined);
    }
  }
}
