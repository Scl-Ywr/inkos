import {
  BookConfigSchema,
  PipelineRunner,
  computeAnalytics,
  createInteractionToolsFromDeps,
  processProjectInteractionRequest,
} from "@actalk/inkos-core";
import type { Hono } from "hono";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { buildStudioBookConfig } from "./book-create.js";
import type { BookChapterRoutesDeps } from "./book-route-context.js";
import { parseJsonObjectBody } from "./book-route-utils.js";

export function registerBookCrudRoutes(app: Hono, deps: BookChapterRoutesDeps): void {
  const {
    root,
    state,
    bookCreateStatus,
    buildPipelineConfig,
    syncBookDerivedFoundationFiles,
    loadStudioBookListSummary,
    broadcast,
    serverLog,
    emitStudioFileAudit,
  } = deps;
  // --- Books ---

  app.get("/api/v1/books", async (c) => {
    const bookIds = await state.listBooks();
    const books = await Promise.all(bookIds.map((id) => loadStudioBookListSummary(state, id)));
    return c.json({ books });
  });

  app.get("/api/v1/books/:id", async (c) => {
    const id = c.req.param("id");
    try {
      const book = await state.loadBookConfig(id);
      const chapters = await state.loadChapterIndex(id);
      const nextChapter = await state.getNextChapterNumber(id);
      return c.json({ book, chapters, nextChapter });
    } catch {
      return c.json({ error: `Book "${id}" not found` }, 404);
    }
  });

  // --- Book Create ---

  app.post("/api/v1/books/create", async (c) => {
    const body = await c.req.json<{
      title: string;
      genre: string;
      language?: string;
      platform?: string;
      chapterWordCount?: number;
      targetChapters?: number;
      blurb?: string;
    }>();

    const now = new Date().toISOString();
    const bookConfig = buildStudioBookConfig(body, now);
    const bookId = bookConfig.id;
    const bookDir = state.bookDir(bookId);

    try {
      await access(join(bookDir, "book.json"));
      await access(join(bookDir, "story", "story_bible.md"));
      return c.json({ error: `Book "${bookId}" already exists` }, 409);
    } catch {
      // The target book is not fully initialized yet, so creation can continue.
    }

    broadcast("book:creating", { bookId, title: body.title });
    bookCreateStatus.set(bookId, { status: "creating" });

    const operationKey = `book-create:${bookId}`;
    const { setOperation, touchOperation, clearOperation, createOperationController } = deps;
    setOperation(operationKey, {
      type: "book-create",
      bookId,
      label: "创建书籍",
      message: `正在创建《${body.title}》，生成基础设定和世界观。`,
    });
    const operationController = createOperationController(operationKey);

    const pipeline = new PipelineRunner(await buildPipelineConfig({ bookId, operationKey, signal: operationController.signal }));
    const tools = createInteractionToolsFromDeps(pipeline, state, {
      onFileAudit: (event) => emitStudioFileAudit(event, { bookId }),
    });

    touchOperation(operationKey, `正在为《${body.title}》生成世界观和基础设定。`);
    processProjectInteractionRequest({
      projectRoot: root,
      request: {
        intent: "create_book",
        title: body.title,
        genre: body.genre,
        language: body.language === "en" ? "en" : body.language === "zh" ? "zh" : undefined,
        platform: body.platform,
        chapterWordCount: body.chapterWordCount,
        targetChapters: body.targetChapters,
        blurb: body.blurb,
      },
      tools,
    }).then(
      async (result: {
        readonly session: { readonly activeBookId?: string };
        readonly details?: Readonly<Record<string, unknown>>;
      }) => {
        const createdBookId = (result.details?.bookId as string | undefined) ?? result.session.activeBookId ?? bookId;
        touchOperation(operationKey, `正在同步《${body.title}》的核心文件。`);
        await syncBookDerivedFoundationFiles(createdBookId).catch((error) => {
          serverLog("warn", "foundation", `同步 ${createdBookId} 核心文件失败: ${error instanceof Error ? error.message : String(error)}`);
        });
        const book = await loadStudioBookListSummary(state, createdBookId).catch(() => undefined);
        bookCreateStatus.delete(bookId);
        bookCreateStatus.delete(createdBookId);
        clearOperation(operationKey, { status: "completed", message: `书籍《${body.title}》创建完成。` });
        broadcast("book:created", { bookId: createdBookId, ...(book ? { book } : {}) });
      },
      (e: unknown) => {
        const error = e instanceof Error ? e.message : String(e);
        bookCreateStatus.set(bookId, { status: "error", error });
        clearOperation(operationKey, { status: "error", message: `书籍创建失败：${error}`, error });
        broadcast("book:error", { bookId, error });
      },
    );

    return c.json({ status: "creating", bookId });
  });

  app.get("/api/v1/books/:id/create-status", async (c) => {
    const id = c.req.param("id");
    const status = bookCreateStatus.get(id);
    if (!status) {
      return c.json({ status: "missing" }, 404);
    }
    return c.json(status);
  });

  // --- Analytics ---

  app.get("/api/v1/books/:id/analytics", async (c) => {
    const id = c.req.param("id");
    try {
      const chapters = await state.loadChapterIndex(id);
      return c.json(computeAnalytics(id, chapters));
    } catch {
      return c.json({ error: `Book "${id}" not found` }, 404);
    }
  });

  // =============================================
  // NEW ENDPOINTS — CLI parity
  // =============================================

  // --- Book Delete ---

  app.delete("/api/v1/books/:id", async (c) => {
    const id = c.req.param("id");
    const bookDir = state.bookDir(id);
    try {
      const { rm } = await import("node:fs/promises");
      await rm(bookDir, { recursive: true, force: true });
      broadcast("book:deleted", { bookId: id });
      return c.json({ ok: true, bookId: id });
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  // --- Book Update ---

  app.put("/api/v1/books/:id", async (c) => {
    const id = c.req.param("id");
    const body = await parseJsonObjectBody(c);
    if (!body.ok) {
      return c.json({ error: body.error }, 400);
    }
    const updates = body.value;
    try {
      const book = await state.loadBookConfig(id);
      const updated = {
        ...book,
        ...(updates.chapterWordCount !== undefined ? { chapterWordCount: Number(updates.chapterWordCount) } : {}),
        ...(updates.targetChapters !== undefined ? { targetChapters: Number(updates.targetChapters) } : {}),
        ...(updates.status !== undefined ? { status: updates.status } : {}),
        ...(updates.language !== undefined ? { language: updates.language } : {}),
        updatedAt: new Date().toISOString(),
      };
      const parsed = BookConfigSchema.safeParse(updated);
      if (!parsed.success) {
        const message = parsed.error.issues
          .map((issue) => `${issue.path.join(".") || "book"}: ${issue.message}`)
          .join("; ");
        return c.json({ error: message || "Invalid book update" }, 400);
      }
      await state.saveBookConfig(id, parsed.data);
      return c.json({ ok: true, book: parsed.data });
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });
}
