import { analyzeStyle, PipelineRunner } from "@actalk/inkos-core";
import type { Hono } from "hono";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BuildPipelineConfig } from "./book-route-context.js";

interface CreativeToolRoutesDeps {
  readonly root: string;
  readonly buildPipelineConfig: BuildPipelineConfig;
  readonly broadcast: (event: string, data: unknown) => void;
}

interface FanficInitRequest {
  readonly title: string;
  readonly sourceText: string;
  readonly sourceName?: string;
  readonly mode?: string;
  readonly genre?: string;
  readonly platform?: string;
  readonly targetChapters?: number;
  readonly chapterWordCount?: number;
  readonly language?: string;
}

interface RadarHistoryItem {
  readonly file: string;
  readonly timestamp: string;
  readonly marketSummary: string;
  readonly summaryPreview: string;
  readonly result: unknown;
}

function radarTimestampForFilename(value: string | undefined): string {
  const date = value ? new Date(value) : new Date();
  const safeDate = Number.isNaN(date.getTime()) ? new Date() : date;
  return safeDate.toISOString().replace(/[:.]/g, "-");
}

async function saveRadarScan(root: string, result: unknown): Promise<string> {
  const radarDir = join(root, "radar");
  await mkdir(radarDir, { recursive: true });
  const timestamp = typeof result === "object" && result !== null && "timestamp" in result
    ? String((result as { timestamp?: unknown }).timestamp ?? "")
    : "";
  const fileName = `scan-${radarTimestampForFilename(timestamp)}.json`;
  const filePath = join(radarDir, fileName);
  await writeFile(filePath, JSON.stringify(result, null, 2), "utf-8");
  return filePath;
}

async function loadRadarHistory(root: string): Promise<RadarHistoryItem[]> {
  const radarDir = join(root, "radar");
  let files: string[] = [];
  try {
    files = await readdir(radarDir);
  } catch {
    return [];
  }

  const scans = await Promise.all(
    files
      .filter((file) => /^scan-.+\.json$/.test(file))
      .map(async (file) => {
        try {
          const raw = await readFile(join(radarDir, file), "utf-8");
          const result: unknown = JSON.parse(raw);
          const record = result && typeof result === "object" ? result as { timestamp?: unknown; marketSummary?: unknown } : {};
          const timestamp = typeof record.timestamp === "string"
            ? record.timestamp
            : file.replace(/^scan-/, "").replace(/\.json$/, "");
          const marketSummary = typeof record.marketSummary === "string" ? record.marketSummary : "";
          return {
            file,
            timestamp,
            marketSummary,
            summaryPreview: marketSummary.slice(0, 100),
            result,
          };
        } catch {
          return null;
        }
      }),
  );

  return scans
    .filter((item): item is RadarHistoryItem => item !== null)
    .sort((left, right) => right.file.localeCompare(left.file));
}

export function registerCreativeToolRoutes(app: Hono, deps: CreativeToolRoutesDeps): void {
  const { root, buildPipelineConfig, broadcast } = deps;

  app.post("/api/v1/style/analyze", async (c) => {
    const { text, sourceName } = await c.req.json<{ text: string; sourceName: string }>();
    if (!text?.trim()) return c.json({ error: "text is required" }, 400);

    try {
      const profile = analyzeStyle(text, sourceName ?? "unknown");
      return c.json(profile);
    } catch (error) {
      return c.json({ error: String(error) }, 500);
    }
  });

  app.post("/api/v1/fanfic/init", async (c) => {
    const body = await c.req.json<FanficInitRequest>();
    if (!body.title || !body.sourceText) {
      return c.json({ error: "title and sourceText are required" }, 400);
    }

    const now = new Date().toISOString();
    const bookId = body.title
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fff]/g, "-")
      .replace(/-+/g, "-")
      .slice(0, 30);

    const bookConfig = {
      id: bookId,
      title: body.title,
      platform: (body.platform ?? "other") as "other",
      genre: (body.genre ?? "other") as "xuanhuan",
      status: "outlining" as const,
      targetChapters: body.targetChapters ?? 100,
      chapterWordCount: body.chapterWordCount ?? 3000,
      fanficMode: (body.mode ?? "canon") as "canon",
      ...(body.language ? { language: body.language as "zh" | "en" } : {}),
      createdAt: now,
      updatedAt: now,
    };

    broadcast("fanfic:start", { bookId, title: body.title });
    try {
      const pipeline = new PipelineRunner(await buildPipelineConfig());
      await pipeline.initFanficBook(
        bookConfig,
        body.sourceText,
        body.sourceName ?? "source",
        (body.mode ?? "canon") as "canon",
      );
      broadcast("fanfic:complete", { bookId });
      return c.json({ ok: true, bookId });
    } catch (error) {
      broadcast("fanfic:error", { bookId, error: String(error) });
      return c.json({ error: String(error) }, 500);
    }
  });

  app.post("/api/v1/radar/scan", async (c) => {
    broadcast("radar:start", {});
    try {
      const pipeline = new PipelineRunner(await buildPipelineConfig());
      const result = await pipeline.runRadar();
      await saveRadarScan(root, result);
      broadcast("radar:complete", { result });
      return c.json(result);
    } catch (error) {
      broadcast("radar:error", { error: String(error) });
      return c.json({ error: String(error) }, 500);
    }
  });

  app.get("/api/v1/radar/history", async (c) => {
    try {
      const items = await loadRadarHistory(root);
      return c.json({ items });
    } catch (error) {
      return c.json({ error: String(error) }, 500);
    }
  });
}
