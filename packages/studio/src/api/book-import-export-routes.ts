import {
  PipelineRunner,
  buildExportArtifact,
  createInteractionToolsFromDeps,
  processProjectInteractionRequest,
} from "@actalk/inkos-core";
import type { Hono } from "hono";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { BookChapterRoutesDeps } from "./book-route-context.js";
import { parseExportFormat, parseJsonObjectBody, validateRegexPattern } from "./book-route-utils.js";

export function registerBookImportExportRoutes(app: Hono, deps: BookChapterRoutesDeps): void {
  const {
    root,
    state,
    buildPipelineConfig,
    broadcast,
    emitStudioFileAudit,
  } = deps;
  // --- Export ---

  app.get("/api/v1/books/:id/export", async (c) => {
    const id = c.req.param("id");
    const format = parseExportFormat(c.req.query("format"), "txt");
    if (!format) {
      return c.json({ error: "Invalid export format" }, 400);
    }
    const approvedOnly = c.req.query("approvedOnly") === "true";

    try {
      const artifact = await buildExportArtifact(state, id, {
        format,
        approvedOnly,
      });
      const responseBody = typeof artifact.payload === "string"
        ? artifact.payload
        : new Uint8Array(artifact.payload);
      return new Response(responseBody, {
        headers: {
          "Content-Type": artifact.contentType,
          "Content-Disposition": `attachment; filename="${artifact.fileName}"`,
        },
      });
    } catch {
      return c.json({ error: "Export failed" }, 500);
    }
  });

  // --- Export to file (save to project dir) ---

  app.post("/api/v1/books/:id/export-save", async (c) => {
    const id = c.req.param("id");
    const body = await parseJsonObjectBody(c);
    if (!body.ok) {
      return c.json({ error: body.error }, 400);
    }
    const { format, approvedOnly } = body.value;
    const fmt = parseExportFormat(format, "txt");
    if (!fmt) {
      return c.json({ error: "Invalid export format" }, 400);
    }

    try {
      const pipeline = new PipelineRunner(await buildPipelineConfig());
      const tools = createInteractionToolsFromDeps(pipeline, state, {
        onFileAudit: (event) => emitStudioFileAudit(event, { bookId: id }),
      });
      const bookDir = state.bookDir(id);
      const outputPath = join(bookDir, `${id}.${fmt === "epub" ? "epub" : fmt}`);
      const result = await processProjectInteractionRequest({
        projectRoot: root,
        request: {
          intent: "export_book",
          bookId: id,
          format: fmt,
          approvedOnly: approvedOnly === true,
          outputPath,
        },
        tools,
        activeBookId: id,
      });
      return c.json({
        ok: true,
        path: (result.details?.outputPath as string | undefined) ?? outputPath,
        format: fmt,
        chapters: (result.details?.chaptersExported as number | undefined) ?? 0,
      });
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  // --- Style Import to Book ---

  app.post("/api/v1/books/:id/style/import", async (c) => {
    const id = c.req.param("id");
    const body = await parseJsonObjectBody(c);
    if (!body.ok) {
      return c.json({ error: body.error }, 400);
    }
    const { text, sourceName } = body.value;
    if (typeof text !== "string" || !text.trim()) return c.json({ error: "text is required" }, 400);

    broadcast("style:start", { bookId: id });
    try {
      const pipeline = new PipelineRunner(await buildPipelineConfig());
      const result = await pipeline.generateStyleGuide(id, text, typeof sourceName === "string" ? sourceName : "unknown");
      broadcast("style:complete", { bookId: id });
      return c.json({ ok: true, result });
    } catch (e) {
      broadcast("style:error", { bookId: id, error: String(e) });
      return c.json({ error: String(e) }, 500);
    }
  });

  // --- Import Chapters ---

  app.post("/api/v1/books/:id/import/chapters", async (c) => {
    const id = c.req.param("id");
    const body = await parseJsonObjectBody(c);
    if (!body.ok) {
      return c.json({ error: body.error }, 400);
    }
    const { text, splitRegex } = body.value;
    if (typeof text !== "string" || !text.trim()) return c.json({ error: "text is required" }, 400);
    const splitRegexError = validateRegexPattern(splitRegex);
    if (splitRegexError) {
      return c.json({ error: `Invalid splitRegex: ${splitRegexError}` }, 400);
    }

    broadcast("import:start", { bookId: id, type: "chapters" });
    try {
      const { splitChapters } = await import("@actalk/inkos-core");
      const chapters = [...splitChapters(text, typeof splitRegex === "string" ? splitRegex : undefined)];

      const pipeline = new PipelineRunner(await buildPipelineConfig());
      const result = await pipeline.importChapters({ bookId: id, chapters });
      broadcast("import:complete", { bookId: id, type: "chapters", count: result.importedCount });
      return c.json(result);
    } catch (e) {
      broadcast("import:error", { bookId: id, error: String(e) });
      return c.json({ error: String(e) }, 500);
    }
  });

  // --- Import Canon ---

  app.post("/api/v1/books/:id/import/canon", async (c) => {
    const id = c.req.param("id");
    const body = await parseJsonObjectBody(c);
    if (!body.ok) {
      return c.json({ error: body.error }, 400);
    }
    const { fromBookId } = body.value;
    if (typeof fromBookId !== "string" || !fromBookId.trim()) return c.json({ error: "fromBookId is required" }, 400);

    broadcast("import:start", { bookId: id, type: "canon" });
    try {
      const pipeline = new PipelineRunner(await buildPipelineConfig());
      await pipeline.importCanon(id, fromBookId);
      broadcast("import:complete", { bookId: id, type: "canon" });
      return c.json({ ok: true });
    } catch (e) {
      broadcast("import:error", { bookId: id, error: String(e) });
      return c.json({ error: String(e) }, 500);
    }
  });

  // --- Fanfic Show (read canon) ---

  app.get("/api/v1/books/:id/fanfic", async (c) => {
    const id = c.req.param("id");
    const bookDir = state.bookDir(id);
    try {
      const content = await readFile(join(bookDir, "story", "fanfic_canon.md"), "utf-8");
      return c.json({ bookId: id, content });
    } catch {
      return c.json({ bookId: id, content: null });
    }
  });

  // --- Fanfic Refresh ---

  app.post("/api/v1/books/:id/fanfic/refresh", async (c) => {
    const id = c.req.param("id");
    const body = await parseJsonObjectBody(c);
    if (!body.ok) {
      return c.json({ error: body.error }, 400);
    }
    const { sourceText, sourceName } = body.value;
    if (typeof sourceText !== "string" || !sourceText.trim()) return c.json({ error: "sourceText is required" }, 400);

    broadcast("fanfic:refresh:start", { bookId: id });
    try {
      const book = await state.loadBookConfig(id);
      const pipeline = new PipelineRunner(await buildPipelineConfig());
      await pipeline.importFanficCanon(
        id,
        sourceText,
        typeof sourceName === "string" ? sourceName : "source",
        (book.fanficMode ?? "canon") as "canon",
      );
      broadcast("fanfic:refresh:complete", { bookId: id });
      return c.json({ ok: true });
    } catch (e) {
      broadcast("fanfic:refresh:error", { bookId: id, error: String(e) });
      return c.json({ error: String(e) }, 500);
    }
  });
}
