import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { KnowledgeStore, buildBookKnowledgeContext } from "../knowledge/knowledge-store.js";

describe("KnowledgeStore", () => {
  it("indexes uploaded text into searchable chunks", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-knowledge-"));
    try {
      const store = new KnowledgeStore(root);
      const library = await store.addSource("book", "demo", {
        name: "sample.md",
        content: [
          "# 参考样章",
          "",
          "林玄在雨夜里推开旧楼的门，楼梯间有潮湿铁锈味。",
          "苏青递给他一份档案，提醒他不要相信灵管局局长。",
          "这一段节奏偏慢，使用细节和动作制造悬疑。",
        ].join("\n"),
      });

      expect(library.stats.sourceCount).toBe(1);
      expect(library.stats.chunkCount).toBeGreaterThan(0);

      const result = await store.search("book", "demo", "灵管局局长 悬疑", 3);
      expect(result.chunks.length).toBeGreaterThan(0);
      expect(result.context).toContain("知识库参考");
      expect(result.context).toContain("灵管局局长");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("builds book context without copying unrelated libraries", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-knowledge-"));
    try {
      const store = new KnowledgeStore(root);
      await store.addSource("book", "book-a", {
        name: "a.txt",
        content: "沈砚和陆白是旧友，核心冲突围绕失踪账册展开。",
      });
      await store.addSource("book", "book-b", {
        name: "b.txt",
        content: "完全不同的太空舰队资料。",
      });

      const context = await buildBookKnowledgeContext({
        projectRoot: root,
        bookId: "book-a",
        query: "沈砚 账册",
      });
      expect(context).toContain("沈砚");
      expect(context).not.toContain("太空舰队");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("splits long sources into vectorized chunks and serves lightweight overviews", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-knowledge-"));
    try {
      const store = new KnowledgeStore(root);
      const longSource = Array.from({ length: 260 }, (_, index) => (
        `Chapter ${index + 1}: The archive contains a recurring silver compass clue and a winter harbor witness.`
      )).join(" ");
      const library = await store.addSource("book", "large-book", {
        name: "whole-book.txt",
        content: longSource,
      });

      expect(library.stats.chunkCount).toBeGreaterThan(10);
      expect(library.chunks.every((chunk) => chunk.charCount < 1_600)).toBe(true);
      expect(library.chunks.some((chunk) => (chunk.vector?.length ?? 0) > 0)).toBe(true);

      const overview = await store.loadOverview("book", "large-book");
      expect(overview.stats.chunkCount).toBe(library.stats.chunkCount);
      expect(overview.chunks.every((chunk) => chunk.text === "")).toBe(true);
      expect(overview.chunks.every((chunk) => chunk.vector === undefined)).toBe(true);

      const result = await store.search("book", "large-book", "silver compass harbor witness", 4);
      expect(result.chunks.length).toBeGreaterThan(0);
      expect(result.chunks[0]?.text).toContain("silver compass");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
