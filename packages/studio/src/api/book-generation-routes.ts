import { PipelineRunner, createLLMClient } from "@actalk/inkos-core";
import type { Hono } from "hono";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { BookChapterRoutesDeps } from "./book-route-context.js";
import { findChapterMarkdownFile, parsePositiveIntegerParam } from "./book-route-utils.js";

export function registerBookGenerationRoutes(app: Hono, deps: BookChapterRoutesDeps): void {
  const {
    root,
    state,
    buildPipelineConfig,
    loadCurrentProjectConfig,
    syncBookDerivedFoundationFiles,
    broadcast,
    serverLog,
    setOperation,
    createOperationController,
    isOperationCancelled,
    clearOperation,
    isOperationAbortError,
    rememberRuntimeNotice,
    readRuntimeTokenUsage,
    appendRuntimeTokenSummary,
  } = deps;
  // --- Actions ---

  app.post("/api/v1/books/:id/write-next", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json<{ wordCount?: number }>().catch(() => ({ wordCount: undefined }));

    broadcast("write:start", { bookId: id });
    serverLog("info", "write", `开始写作书籍 ${id}`);

    // Track active operation for session recovery
    const operationKey = `write:${id}`;
    setOperation(operationKey, {
      type: "write",
      bookId: id,
      label: "章节写作",
      message: `正在为《${id}》生成下一章，AI 正在整理剧情、人物状态和章节文本。`,
    });
    const operationController = createOperationController(operationKey);

    // Fire and forget — progress/completion/errors pushed via SSE
    const pipeline = new PipelineRunner(await buildPipelineConfig({ bookId: id, signal: operationController.signal }));
    pipeline.writeNextChapter(id, body.wordCount).then(
      (result) => {
        if (isOperationCancelled(operationKey) || operationController.signal.aborted) {
          serverLog("warn", "write", `书籍 ${id} 写作结果已丢弃：任务已停止`);
          clearOperation(operationKey);
          return;
        }
        serverLog("info", "write", `书籍 ${id} 第 ${result.chapterNumber} 章写作完成: ${result.title} (${result.wordCount} 字)`);
        void syncBookDerivedFoundationFiles(id).catch((error) => {
          serverLog("warn", "foundation", `同步 ${id} 核心文件失败: ${error instanceof Error ? error.message : String(error)}`);
        });
        const runtimeTokenUsage = readRuntimeTokenUsage(result.tokenUsage);
        rememberRuntimeNotice({
          kind: "completed",
          title: "章节生成完成",
          message: appendRuntimeTokenSummary(
            `《${id}》第 ${result.chapterNumber} 章《${result.title}》已完成，${result.wordCount} 字，状态 ${result.status}。`,
            runtimeTokenUsage,
          ),
          ...(runtimeTokenUsage ? { tokenUsage: runtimeTokenUsage } : {}),
        });
        clearOperation(operationKey);
        broadcast("write:complete", { bookId: id, chapterNumber: result.chapterNumber, status: result.status, title: result.title, wordCount: result.wordCount });
      },
      (e) => {
        const msg = e instanceof Error ? e.message : String(e);
        clearOperation(operationKey);
        if (isOperationAbortError(e)) {
          serverLog("warn", "write", `书籍 ${id} 写作已停止`);
          broadcast("write:error", { bookId: id, error: "用户已停止当前生成。" });
          return;
        }
        serverLog("error", "write", `书籍 ${id} 写作失败: ${msg}`);
        rememberRuntimeNotice({
          kind: "error",
          title: "章节生成失败",
          message: `《${id}》写作失败：${msg.slice(0, 160)}`,
        });
        broadcast("write:error", { bookId: id, error: msg });
      },
    );

    return c.json({ status: "writing", bookId: id });
  });

  app.post("/api/v1/books/:id/draft", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json<{ wordCount?: number; context?: string }>().catch(() => ({ wordCount: undefined, context: undefined }));

    broadcast("draft:start", { bookId: id });
    serverLog("info", "draft", `开始草稿书籍 ${id}`);

    // Track active operation for session recovery
    const operationKey = `draft:${id}`;
    setOperation(operationKey, {
      type: "write",
      bookId: id,
      label: "章节草稿",
      message: `正在为《${id}》生成草稿，会先铺剧情骨架再扩写正文。`,
    });
    const operationController = createOperationController(operationKey);

    const pipeline = new PipelineRunner(await buildPipelineConfig({ bookId: id, signal: operationController.signal }));
    pipeline.writeDraft(id, body.context, body.wordCount).then(
      (result) => {
        if (isOperationCancelled(operationKey) || operationController.signal.aborted) {
          serverLog("warn", "draft", `书籍 ${id} 草稿结果已丢弃：任务已停止`);
          clearOperation(operationKey);
          return;
        }
        serverLog("info", "draft", `书籍 ${id} 草稿完成: ${result.title} (${result.wordCount} 字)`);
        void syncBookDerivedFoundationFiles(id).catch((error) => {
          serverLog("warn", "foundation", `同步 ${id} 核心文件失败: ${error instanceof Error ? error.message : String(error)}`);
        });
        const runtimeTokenUsage = readRuntimeTokenUsage(result.tokenUsage);
        rememberRuntimeNotice({
          kind: "completed",
          title: "章节草稿完成",
          message: appendRuntimeTokenSummary(
            `《${id}》第 ${result.chapterNumber} 章草稿《${result.title}》已完成，${result.wordCount} 字。`,
            runtimeTokenUsage,
          ),
          ...(runtimeTokenUsage ? { tokenUsage: runtimeTokenUsage } : {}),
        });
        clearOperation(operationKey);
        broadcast("draft:complete", { bookId: id, chapterNumber: result.chapterNumber, title: result.title, wordCount: result.wordCount });
      },
      (e) => {
        const msg = e instanceof Error ? e.message : String(e);
        clearOperation(operationKey);
        if (isOperationAbortError(e)) {
          serverLog("warn", "draft", `书籍 ${id} 草稿已停止`);
          broadcast("draft:error", { bookId: id, error: "用户已停止当前生成。" });
          return;
        }
        serverLog("error", "draft", `书籍 ${id} 草稿失败: ${msg}`);
        rememberRuntimeNotice({
          kind: "error",
          title: "章节草稿失败",
          message: `《${id}》草稿生成失败：${msg.slice(0, 160)}`,
        });
        broadcast("draft:error", { bookId: id, error: msg });
      },
    );

    return c.json({ status: "drafting", bookId: id });
  });

  // --- Audit ---

  app.post("/api/v1/books/:id/audit/:chapter", async (c) => {
    const id = c.req.param("id");
    const chapterNum = parsePositiveIntegerParam(c.req.param("chapter"));
    if (chapterNum === null) {
      return c.json({ error: "Invalid chapter number" }, 400);
    }
    const bookDir = state.bookDir(id);

    broadcast("audit:start", { bookId: id, chapter: chapterNum });
    try {
      const book = await state.loadBookConfig(id);
      const chaptersDir = join(bookDir, "chapters");
      const match = await findChapterMarkdownFile(chaptersDir, chapterNum);
      if (!match) return c.json({ error: "Chapter not found" }, 404);

      const content = await readFile(join(chaptersDir, match), "utf-8");
      const currentConfig = await loadCurrentProjectConfig();
      const { ContinuityAuditor } = await import("@actalk/inkos-core");
      const auditor = new ContinuityAuditor({
        client: createLLMClient(currentConfig.llm),
        model: currentConfig.llm.model,
        projectRoot: root,
        bookId: id,
      });
      const result = await auditor.auditChapter(bookDir, content, chapterNum, book.genre);
      broadcast("audit:complete", { bookId: id, chapter: chapterNum, passed: result.passed });
      return c.json(result);
    } catch (e) {
      broadcast("audit:error", { bookId: id, error: String(e) });
      return c.json({ error: String(e) }, 500);
    }
  });

  // --- Revise ---

  app.post("/api/v1/books/:id/revise/:chapter", async (c) => {
    const id = c.req.param("id");
    const chapterNum = parsePositiveIntegerParam(c.req.param("chapter"));
    if (chapterNum === null) {
      return c.json({ error: "Invalid chapter number" }, 400);
    }
    const bookDir = state.bookDir(id);
    const body = await c.req
      .json<{ mode?: string; brief?: string }>()
      .catch(() => ({ mode: "spot-fix", brief: undefined }));

    broadcast("revise:start", { bookId: id, chapter: chapterNum });
    serverLog("info", "revise", `开始修订书籍 ${id} 第 ${chapterNum} 章`);
    const operationKey = `revise:${id}:${chapterNum}`;
    setOperation(operationKey, {
      type: "revise",
      bookId: id,
      chapter: chapterNum,
      label: "章节修订",
      message: `正在修订《${id}》第 ${chapterNum} 章，保留原剧情并优化表达。`,
    });
    const operationController = createOperationController(operationKey);
    try {
      const book = await state.loadBookConfig(id);
      const chaptersDir = join(bookDir, "chapters");
      const match = await findChapterMarkdownFile(chaptersDir, chapterNum);
      if (!match) {
        clearOperation(operationKey);
        return c.json({ error: "Chapter not found" }, 404);
      }

      const pipeline = new PipelineRunner(await buildPipelineConfig({
        externalContext: body.brief,
        bookId: id,
        signal: operationController.signal,
      }));
      const normalizedMode = body.mode ?? "spot-fix";
      const result = await pipeline.reviseDraft(
        id,
        chapterNum,
        normalizedMode as "polish" | "rewrite" | "rework" | "spot-fix" | "anti-detect",
      );
      serverLog("info", "revise", `书籍 ${id} 第 ${chapterNum} 章修订完成`);
      void syncBookDerivedFoundationFiles(id).catch((error) => {
        serverLog("warn", "foundation", `同步 ${id} 的核心文件聚合失败: ${String(error)}`);
      });
      clearOperation(operationKey);
      broadcast("revise:complete", { bookId: id, chapter: chapterNum });
      return c.json(result);
    } catch (e) {
      clearOperation(operationKey);
      if (isOperationAbortError(e)) {
        serverLog("warn", "revise", `书籍 ${id} 第 ${chapterNum} 章修订已停止`);
        broadcast("revise:error", { bookId: id, error: "用户已停止当前生成。" });
        return c.json({ error: "用户已停止当前生成。" }, 400);
      }
      serverLog("error", "revise", `书籍 ${id} 第 ${chapterNum} 章修订失败: ${String(e)}`);
      broadcast("revise:error", { bookId: id, error: String(e) });
      return c.json({ error: String(e) }, 500);
    }
  });

  // --- AIGC Detection ---

  app.post("/api/v1/books/:id/detect/:chapter", async (c) => {
    const id = c.req.param("id");
    const chapterNum = parsePositiveIntegerParam(c.req.param("chapter"));
    if (chapterNum === null) {
      return c.json({ error: "Invalid chapter number" }, 400);
    }
    const bookDir = state.bookDir(id);

    try {
      const chaptersDir = join(bookDir, "chapters");
      const match = await findChapterMarkdownFile(chaptersDir, chapterNum);
      if (!match) return c.json({ error: "Chapter not found" }, 404);

      const content = await readFile(join(chaptersDir, match), "utf-8");
      const { analyzeAITells } = await import("@actalk/inkos-core");
      const result = analyzeAITells(content);
      return c.json({ chapterNumber: chapterNum, ...result });
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  // --- Write Rewrite (specific chapter) ---

  app.post("/api/v1/books/:id/rewrite/:chapter", async (c) => {
    const id = c.req.param("id");
    const chapterNum = parsePositiveIntegerParam(c.req.param("chapter"));
    if (chapterNum === null) {
      return c.json({ error: "Invalid chapter number" }, 400);
    }
    const body: { brief?: string } = await c.req
      .json<{ brief?: string }>()
      .catch(() => ({}));

    broadcast("rewrite:start", { bookId: id, chapter: chapterNum });
    serverLog("info", "rewrite", `开始重写书籍 ${id} 第 ${chapterNum} 章`);

    // Track active operation for session recovery
    const operationKey = `rewrite:${id}`;
    setOperation(operationKey, {
      type: "rewrite",
      bookId: id,
      chapter: chapterNum,
      label: "章节重写",
      message: `正在回退并重写《${id}》第 ${chapterNum} 章后的内容。`,
    });
    const operationController = createOperationController(operationKey);

    try {
      const rollbackTarget = chapterNum - 1;
      const discarded = await state.rollbackToChapter(id, rollbackTarget);
      const pipeline = new PipelineRunner(await buildPipelineConfig({
        externalContext: body.brief,
        bookId: id,
        signal: operationController.signal,
      }));
      pipeline.writeNextChapter(id).then(
        (result) => {
          if (isOperationCancelled(operationKey) || operationController.signal.aborted) {
            serverLog("warn", "rewrite", `书籍 ${id} 重写结果已丢弃：任务已停止`);
            clearOperation(operationKey);
            return;
          }
          serverLog("info", "rewrite", `书籍 ${id} 第 ${result.chapterNumber} 章重写完成: ${result.title} (${result.wordCount} 字)`);
          void syncBookDerivedFoundationFiles(id).catch((error) => {
            serverLog("warn", "foundation", `同步 ${id} 的核心文件聚合失败: ${String(error)}`);
          });
          clearOperation(operationKey);
          broadcast("rewrite:complete", { bookId: id, chapterNumber: result.chapterNumber, title: result.title, wordCount: result.wordCount });
        },
        (e) => {
          clearOperation(operationKey);
          if (isOperationAbortError(e)) {
            serverLog("warn", "rewrite", `书籍 ${id} 重写已停止`);
            broadcast("rewrite:error", { bookId: id, error: "用户已停止当前生成。" });
            return;
          }
          serverLog("error", "rewrite", `书籍 ${id} 重写失败: ${e instanceof Error ? e.message : String(e)}`);
          broadcast("rewrite:error", { bookId: id, error: e instanceof Error ? e.message : String(e) });
        },
      );
      return c.json({ status: "rewriting", bookId: id, chapter: chapterNum, rolledBackTo: rollbackTarget, discarded });
    } catch (e) {
      serverLog("error", "rewrite", `书籍 ${id} 重写失败: ${String(e)}`);
      clearOperation(operationKey);
      broadcast("rewrite:error", { bookId: id, error: String(e) });
      return c.json({ error: String(e) }, 500);
    }
  });

  app.post("/api/v1/books/:id/resync/:chapter", async (c) => {
    const id = c.req.param("id");
    const chapterNum = parsePositiveIntegerParam(c.req.param("chapter"));
    if (chapterNum === null) {
      return c.json({ error: "Invalid chapter number" }, 400);
    }
    const body: { brief?: string } = await c.req
      .json<{ brief?: string }>()
      .catch(() => ({}));

    try {
      const pipeline = new PipelineRunner(await buildPipelineConfig({
        externalContext: body.brief,
      }));
      const result = await pipeline.resyncChapterArtifacts(id, chapterNum);
      void syncBookDerivedFoundationFiles(id).catch((error) => {
        serverLog("warn", "foundation", `同步 ${id} 的核心文件聚合失败: ${String(error)}`);
      });
      return c.json(result);
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  // --- Detect All chapters ---

  app.post("/api/v1/books/:id/detect-all", async (c) => {
    const id = c.req.param("id");
    const bookDir = state.bookDir(id);

    try {
      const chaptersDir = join(bookDir, "chapters");
      const files = await readdir(chaptersDir);
      const mdFiles = files.filter((f) => f.endsWith(".md") && /^\d{4}/.test(f)).sort();
      const { analyzeAITells } = await import("@actalk/inkos-core");

      const results = await Promise.all(
        mdFiles.map(async (f) => {
          const num = parseInt(f.slice(0, 4), 10);
          const content = await readFile(join(chaptersDir, f), "utf-8");
          const result = analyzeAITells(content);
          return { chapterNumber: num, filename: f, ...result };
        }),
      );
      return c.json({ bookId: id, results });
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  // --- Detect Stats ---

  app.get("/api/v1/books/:id/detect/stats", async (c) => {
    const id = c.req.param("id");
    try {
      const { loadDetectionHistory, analyzeDetectionInsights } = await import("@actalk/inkos-core");
      const bookDir = state.bookDir(id);
      const history = await loadDetectionHistory(bookDir);
      const insights = analyzeDetectionInsights(history);
      return c.json(insights);
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });
}
