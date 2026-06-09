import type { Hono } from "hono";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { BookChapterRoutesDeps } from "./book-route-context.js";
import { findChapterMarkdownFile, parseJsonObjectBody, parsePositiveIntegerParam } from "./book-route-utils.js";

export function registerChapterFileRoutes(app: Hono, deps: BookChapterRoutesDeps): void {
  const { state } = deps;
  // --- Chapters ---

  app.get("/api/v1/books/:id/chapters/:num", async (c) => {
    const id = c.req.param("id");
    const num = parsePositiveIntegerParam(c.req.param("num"));
    if (num === null) {
      return c.json({ error: "Invalid chapter number" }, 400);
    }
    const bookDir = state.bookDir(id);
    const chaptersDir = join(bookDir, "chapters");

    try {
      const match = await findChapterMarkdownFile(chaptersDir, num);
      if (!match) return c.json({ error: "Chapter not found" }, 404);
      const content = await readFile(join(chaptersDir, match), "utf-8");
      return c.json({ chapterNumber: num, filename: match, content });
    } catch {
      return c.json({ error: "Chapter not found" }, 404);
    }
  });

  // --- Chapter Save ---

  app.put("/api/v1/books/:id/chapters/:num", async (c) => {
    const id = c.req.param("id");
    const num = parsePositiveIntegerParam(c.req.param("num"));
    if (num === null) {
      return c.json({ error: "Invalid chapter number" }, 400);
    }
    const bookDir = state.bookDir(id);
    const chaptersDir = join(bookDir, "chapters");
    const body = await parseJsonObjectBody(c);
    if (!body.ok) {
      return c.json({ error: body.error }, 400);
    }
    const { content } = body.value;
    if (typeof content !== "string") {
      return c.json({ error: "content is required" }, 400);
    }

    try {
      const match = await findChapterMarkdownFile(chaptersDir, num);
      if (!match) return c.json({ error: "Chapter not found" }, 404);

      const { writeFile: writeFileFs } = await import("node:fs/promises");
      await writeFileFs(join(chaptersDir, match), content, "utf-8");
      return c.json({ ok: true, chapterNumber: num });
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  app.delete("/api/v1/books/:id/chapters/:num", async (c) => {
    const id = c.req.param("id");
    const num = parsePositiveIntegerParam(c.req.param("num"));
    if (num === null) {
      return c.json({ error: "Invalid chapter number" }, 400);
    }

    const bookDir = state.bookDir(id);
    const chaptersDir = join(bookDir, "chapters");

    try {
      const match = await findChapterMarkdownFile(chaptersDir, num);
      if (!match) return c.json({ error: "Chapter not found" }, 404);

      await rm(join(chaptersDir, match), { force: true });
      const index = await state.loadChapterIndex(id);
      const updated = index.filter((chapter) => chapter.number !== num);
      await state.saveChapterIndex(id, updated);
      return c.json({ ok: true, chapterNumber: num });
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  app.post("/api/v1/books/:id/chapters/:num/approve", async (c) => {
    const id = c.req.param("id");
    const num = parsePositiveIntegerParam(c.req.param("num"));
    if (num === null) {
      return c.json({ error: "Invalid chapter number" }, 400);
    }

    try {
      const index = await state.loadChapterIndex(id);
      const updated = index.map((ch) =>
        ch.number === num ? { ...ch, status: "approved" as const } : ch,
      );
      await state.saveChapterIndex(id, updated);
      return c.json({ ok: true, chapterNumber: num, status: "approved" });
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  app.post("/api/v1/books/:id/chapters/:num/reject", async (c) => {
    const id = c.req.param("id");
    const num = parsePositiveIntegerParam(c.req.param("num"));
    if (num === null) {
      return c.json({ error: "Invalid chapter number" }, 400);
    }

    try {
      const index = await state.loadChapterIndex(id);
      const target = index.find((ch) => ch.number === num);
      if (!target) {
        return c.json({ error: `Chapter ${num} not found` }, 404);
      }

      const rollbackTarget = num - 1;
      const discarded = await state.rollbackToChapter(id, rollbackTarget);
      return c.json({
        ok: true,
        chapterNumber: num,
        status: "rejected",
        rolledBackTo: rollbackTarget,
        discarded,
      });
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });
}
