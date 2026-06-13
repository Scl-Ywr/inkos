import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readWriterSettleContext,
  readWriterTruthContext,
  WRITER_CONTEXT_MISSING,
} from "../agents/writer-context.js";
import { TruthContextCache } from "../agents/truth-context-cache.js";
import { estimateTextTokens } from "../llm/provider.js";

const tempRoots: string[] = [];

async function createBookDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "inkos-writer-context-"));
  tempRoots.push(root);
  const bookDir = join(root, "book");
  await mkdir(join(bookDir, "story", "outline"), { recursive: true });
  return bookDir;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("writer context reader", () => {
  it("returns the shared missing placeholder for absent truth files", async () => {
    const bookDir = await createBookDir();

    const context = await readWriterTruthContext(bookDir);

    expect(context.storyBibleRaw).toBe(WRITER_CONTEXT_MISSING);
    expect(context.volumeOutline).toBe(WRITER_CONTEXT_MISSING);
    expect(context.styleGuide).toBe(WRITER_CONTEXT_MISSING);
    expect(context.currentState).toBe(WRITER_CONTEXT_MISSING);
    expect(context.hooks).toBe(WRITER_CONTEXT_MISSING);
    expect(context.characterMatrix).toBe(WRITER_CONTEXT_MISSING);
  });

  it("reads Phase 5 outline, direct truth files, and role card context", async () => {
    const bookDir = await createBookDir();
    const storyDir = join(bookDir, "story");
    const majorRoleDir = join(storyDir, "roles", "主要角色");
    await mkdir(majorRoleDir, { recursive: true });

    await Promise.all([
      writeFile(join(storyDir, "outline", "story_frame.md"), "# Story Frame\n\ncore bible", "utf-8"),
      writeFile(join(storyDir, "outline", "volume_map.md"), "# Volume Map\n\nvolume arc", "utf-8"),
      writeFile(join(storyDir, "style_guide.md"), "# Style\n\nplain", "utf-8"),
      writeFile(join(storyDir, "current_state.md"), "# Current State\n\nstable", "utf-8"),
      writeFile(join(storyDir, "particle_ledger.md"), "# Ledger\n\ncount", "utf-8"),
      writeFile(join(storyDir, "pending_hooks.md"), "# Hooks\n\nopen", "utf-8"),
      writeFile(join(storyDir, "chapter_summaries.md"), "# Summaries\n\nchapter 1", "utf-8"),
      writeFile(join(storyDir, "subplot_board.md"), "# Subplots\n\nsubplot", "utf-8"),
      writeFile(join(storyDir, "emotional_arcs.md"), "# Emotional Arcs\n\narc", "utf-8"),
      writeFile(join(storyDir, "style_profile.json"), "{\"tone\":\"quiet\"}", "utf-8"),
      writeFile(join(storyDir, "parent_canon.md"), "# Parent Canon", "utf-8"),
      writeFile(join(storyDir, "fanfic_canon.md"), "# Fanfic Canon", "utf-8"),
      writeFile(join(majorRoleDir, "林玄.md"), "## 当前现状\n\ninside DR-07", "utf-8"),
    ]);

    const context = await readWriterTruthContext(bookDir);

    expect(context.storyBibleRaw).toContain("core bible");
    expect(context.volumeOutline).toContain("volume arc");
    expect(context.styleGuide).toContain("plain");
    expect(context.currentState).toContain("stable");
    expect(context.ledger).toContain("count");
    expect(context.hooks).toContain("open");
    expect(context.chapterSummaries).toContain("chapter 1");
    expect(context.subplotBoard).toContain("subplot");
    expect(context.emotionalArcs).toContain("arc");
    expect(context.characterMatrix).toContain("### 林玄");
    expect(context.characterMatrix).toContain("inside DR-07");
    expect(context.styleProfileRaw).toContain("quiet");
    expect(context.parentCanon).toContain("Parent Canon");
    expect(context.fanficCanonRaw).toContain("Fanfic Canon");
  });

  it("reads the smaller settlement context without requiring writing-only files", async () => {
    const bookDir = await createBookDir();
    const storyDir = join(bookDir, "story");
    await Promise.all([
      writeFile(join(storyDir, "outline", "volume_map.md"), "# Volume Map\n\nsettle volume", "utf-8"),
      writeFile(join(storyDir, "current_state.md"), "# Current State\n\nsettle state", "utf-8"),
      writeFile(join(storyDir, "pending_hooks.md"), "# Hooks\n\nsettle hook", "utf-8"),
      writeFile(join(storyDir, "character_matrix.md"), "# Characters\n\nsettle character", "utf-8"),
    ]);

    const context = await readWriterSettleContext(bookDir);

    expect(context.currentState).toContain("settle state");
    expect(context.hooks).toContain("settle hook");
    expect(context.characterMatrix).toContain("settle character");
    expect(context.volumeOutline).toContain("settle volume");
    expect(context.ledger).toBe(WRITER_CONTEXT_MISSING);
  });

  it("derives settlement context from cached writer truth context", async () => {
    const bookDir = await createBookDir();
    const storyDir = join(bookDir, "story");
    const cache = new TruthContextCache();
    await Promise.all([
      writeFile(join(storyDir, "outline", "volume_map.md"), "# Volume Map\n\nfirst volume", "utf-8"),
      writeFile(join(storyDir, "current_state.md"), "# Current State\n\nfirst state", "utf-8"),
      writeFile(join(storyDir, "pending_hooks.md"), "# Hooks\n\nfirst hook", "utf-8"),
      writeFile(join(storyDir, "character_matrix.md"), "# Characters\n\nfirst character", "utf-8"),
    ]);

    await readWriterTruthContext(bookDir, undefined, { cache });
    await Promise.all([
      writeFile(join(storyDir, "current_state.md"), "# Current State\n\nchanged state", "utf-8"),
      writeFile(join(storyDir, "pending_hooks.md"), "# Hooks\n\nchanged hook", "utf-8"),
      writeFile(join(storyDir, "character_matrix.md"), "# Characters\n\nchanged character", "utf-8"),
    ]);
    const settle = await readWriterSettleContext(bookDir, undefined, { cache });

    expect(settle.currentState).toContain("first state");
    expect(settle.hooks).toContain("first hook");
    expect(settle.characterMatrix).toContain("first character");
    expect(settle.volumeOutline).toContain("first volume");
    expect(settle.currentState).not.toContain("changed state");
    expect(cache.metrics().hits).toBeGreaterThan(0);
  });

  it("uses token budgets, records per-field metrics, and caches only the aggregate snapshot", async () => {
    const bookDir = await createBookDir();
    const storyDir = join(bookDir, "story");
    const cache = new TruthContextCache();
    await Promise.all([
      writeFile(join(storyDir, "current_state.md"), `# State\n\n${"状态推进。".repeat(300)}`, "utf-8"),
      writeFile(join(storyDir, "pending_hooks.md"), `# Hooks\n\n${"hook detail ".repeat(400)}`, "utf-8"),
      writeFile(join(storyDir, "chapter_summaries.md"), `| chapter | summary |\n| --- | --- |\n${"| 1 | complete row |".repeat(200)}`, "utf-8"),
    ]);

    const context = await readWriterTruthContext(bookDir, undefined, { cache, maxTokens: 500 });
    const metrics = cache.metrics();
    const returnedTokens = Object.values(context).reduce((sum, value) => sum + estimateTextTokens(value), 0);

    expect(returnedTokens).toBeLessThanOrEqual(500);
    expect(metrics.entries).toBe(1);
    expect(metrics.fields.currentState?.tokensBefore).toBeGreaterThan(metrics.fields.currentState?.tokensAfter ?? 0);
    expect(metrics.fields.hooks?.tokensBefore).toBeGreaterThan(metrics.fields.hooks?.tokensAfter ?? 0);
    expect(cache.summary()).toContain("context compression: applied");
    expect(cache.summary()).toContain(`saved ${metrics.tokensBeforeTrim - metrics.tokensAfterTrim}`);
  });

  it("keeps JSON parseable and Markdown table rows structurally complete after trimming", async () => {
    const bookDir = await createBookDir();
    const storyDir = join(bookDir, "story");
    await Promise.all([
      writeFile(join(storyDir, "style_profile.json"), JSON.stringify({ tone: "quiet ".repeat(500) }), "utf-8"),
      writeFile(
        join(storyDir, "pending_hooks.md"),
        ["| hook_id | status |", "| --- | --- |", ...Array.from({ length: 100 }, (_, i) => `| H${i} | open |`)].join("\n"),
        "utf-8",
      ),
    ]);

    const context = await readWriterTruthContext(bookDir, undefined, { maxTokens: 180 });

    expect(() => JSON.parse(context.styleProfileRaw)).not.toThrow();
    for (const line of context.hooks.split("\n").filter((value) => value.startsWith("|"))) {
      expect(line.endsWith("|")).toBe(true);
    }
  });
});
