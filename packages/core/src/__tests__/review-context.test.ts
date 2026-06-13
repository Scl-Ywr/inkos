import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readAuditTruthContext,
  readRevisionTruthContext,
  REVIEW_CONTEXT_MISSING,
} from "../agents/review-context.js";
import { TruthContextCache } from "../agents/truth-context-cache.js";
import { estimateTextTokens } from "../llm/provider.js";

const tempRoots: string[] = [];

async function createBookDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "inkos-review-context-"));
  tempRoots.push(root);
  const bookDir = join(root, "book");
  await mkdir(join(bookDir, "story", "outline"), { recursive: true });
  return bookDir;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("review context reader", () => {
  it("returns the review missing placeholder for absent truth files", async () => {
    const bookDir = await createBookDir();

    const context = await readRevisionTruthContext(bookDir);

    expect(context.currentState).toBe(REVIEW_CONTEXT_MISSING);
    expect(context.ledger).toBe(REVIEW_CONTEXT_MISSING);
    expect(context.hooks).toBe(REVIEW_CONTEXT_MISSING);
    expect(context.styleGuideRaw).toBe(REVIEW_CONTEXT_MISSING);
    expect(context.volumeOutline).toBe(REVIEW_CONTEXT_MISSING);
    expect(context.storyBible).toBe(REVIEW_CONTEXT_MISSING);
    expect(context.characterMatrix).toBe(REVIEW_CONTEXT_MISSING);
  });

  it("reads revision context from Phase 5 outline files and role cards", async () => {
    const bookDir = await createBookDir();
    const storyDir = join(bookDir, "story");
    const majorRoleDir = join(storyDir, "roles", "主要角色");
    await mkdir(majorRoleDir, { recursive: true });

    await Promise.all([
      writeFile(join(storyDir, "outline", "story_frame.md"), "# Story Frame\n\nreview bible", "utf-8"),
      writeFile(join(storyDir, "outline", "volume_map.md"), "# Volume Map\n\nreview volume", "utf-8"),
      writeFile(join(storyDir, "current_state.md"), "# Current State\n\nreview state", "utf-8"),
      writeFile(join(storyDir, "particle_ledger.md"), "# Ledger\n\nreview ledger", "utf-8"),
      writeFile(join(storyDir, "pending_hooks.md"), "# Hooks\n\nreview hook", "utf-8"),
      writeFile(join(storyDir, "style_guide.md"), "# Style\n\nreview style", "utf-8"),
      writeFile(join(storyDir, "chapter_summaries.md"), "# Summaries\n\nreview summary", "utf-8"),
      writeFile(join(storyDir, "parent_canon.md"), "# Parent Canon\n\nreview parent", "utf-8"),
      writeFile(join(storyDir, "fanfic_canon.md"), "# Fanfic Canon\n\nreview fanfic", "utf-8"),
      writeFile(join(majorRoleDir, "林玄.md"), "## 当前现状\n\nreview character", "utf-8"),
    ]);

    const context = await readRevisionTruthContext(bookDir);

    expect(context.storyBible).toContain("review bible");
    expect(context.volumeOutline).toContain("review volume");
    expect(context.currentState).toContain("review state");
    expect(context.ledger).toContain("review ledger");
    expect(context.hooks).toContain("review hook");
    expect(context.styleGuideRaw).toContain("review style");
    expect(context.chapterSummaries).toContain("review summary");
    expect(context.parentCanon).toContain("review parent");
    expect(context.fanficCanon).toContain("review fanfic");
    expect(context.characterMatrix).toContain("### 林玄");
    expect(context.characterMatrix).toContain("review character");
  });

  it("reads audit-only truth files alongside shared review context", async () => {
    const bookDir = await createBookDir();
    const storyDir = join(bookDir, "story");
    await Promise.all([
      writeFile(join(storyDir, "outline", "volume_map.md"), "# Volume Map\n\naudit volume", "utf-8"),
      writeFile(join(storyDir, "current_state.md"), "# Current State\n\naudit state", "utf-8"),
      writeFile(join(storyDir, "subplot_board.md"), "# Subplots\n\naudit subplot", "utf-8"),
      writeFile(join(storyDir, "emotional_arcs.md"), "# Emotional Arcs\n\naudit emotion", "utf-8"),
      writeFile(join(storyDir, "character_matrix.md"), "# Characters\n\naudit character", "utf-8"),
    ]);

    const context = await readAuditTruthContext(bookDir);

    expect(context.currentState).toContain("audit state");
    expect(context.volumeOutline).toContain("audit volume");
    expect(context.subplotBoard).toContain("audit subplot");
    expect(context.emotionalArcs).toContain("audit emotion");
    expect(context.characterMatrix).toContain("audit character");
    expect(context.hooks).toBe(REVIEW_CONTEXT_MISSING);
  });

  it("reuses the audit truth snapshot when revision context is read with the same cache", async () => {
    const bookDir = await createBookDir();
    const storyDir = join(bookDir, "story");
    const cache = new TruthContextCache();
    await Promise.all([
      writeFile(join(storyDir, "outline", "story_frame.md"), "# Story Frame\n\ncached bible", "utf-8"),
      writeFile(join(storyDir, "outline", "volume_map.md"), "# Volume Map\n\ncached volume", "utf-8"),
      writeFile(join(storyDir, "current_state.md"), "# Current State\n\nfirst state", "utf-8"),
      writeFile(join(storyDir, "pending_hooks.md"), "# Hooks\n\nfirst hook", "utf-8"),
      writeFile(join(storyDir, "character_matrix.md"), "# Characters\n\nfirst character", "utf-8"),
    ]);

    const audit = await readAuditTruthContext(bookDir, undefined, { cache });
    await Promise.all([
      writeFile(join(storyDir, "current_state.md"), "# Current State\n\nchanged state", "utf-8"),
      writeFile(join(storyDir, "pending_hooks.md"), "# Hooks\n\nchanged hook", "utf-8"),
      writeFile(join(storyDir, "character_matrix.md"), "# Characters\n\nchanged character", "utf-8"),
    ]);
    const revision = await readRevisionTruthContext(bookDir, undefined, { cache });

    expect(audit.currentState).toContain("first state");
    expect(revision.currentState).toContain("first state");
    expect(revision.hooks).toContain("first hook");
    expect(revision.characterMatrix).toContain("first character");
    expect(revision.storyBible).toContain("cached bible");
    expect(revision.currentState).not.toContain("changed state");
    expect(cache.metrics().hits).toBeGreaterThan(0);
  });

  it("trims the shared review snapshot to the requested context budget and records character counts", async () => {
    const bookDir = await createBookDir();
    const storyDir = join(bookDir, "story");
    const cache = new TruthContextCache();
    await Promise.all([
      writeFile(join(storyDir, "current_state.md"), `# State\n\n${"state ".repeat(300)}`, "utf-8"),
      writeFile(join(storyDir, "pending_hooks.md"), `# Hooks\n\n${"hook ".repeat(300)}`, "utf-8"),
      writeFile(join(storyDir, "chapter_summaries.md"), `# Summaries\n\n${"summary ".repeat(300)}`, "utf-8"),
      writeFile(join(storyDir, "parent_canon.md"), `# Canon\n\n${"canon ".repeat(300)}`, "utf-8"),
    ]);

    const context = await readAuditTruthContext(bookDir, undefined, { cache, maxChars: 1_200 });
    const returnedChars = Object.values(context).reduce((sum, value) => sum + value.length, 0);
    const metrics = cache.metrics();

    expect(returnedChars).toBeLessThanOrEqual(1_200);
    expect(context.currentState).toContain("InkOS context budget");
    expect(context.fanficCanon).toBe(REVIEW_CONTEXT_MISSING);
    expect(metrics.budgetReads).toBe(1);
    expect(metrics.trimmedReads).toBe(1);
    expect(metrics.charsBeforeTrim).toBeGreaterThan(metrics.charsAfterTrim);
    expect(metrics.charsAfterTrim).toBe(returnedChars);
    expect(cache.summary()).toContain("context compression: applied");
    expect(cache.summary()).toContain(`-> ${metrics.tokensAfterTrim} tokens`);
  });

  it("keeps differently budgeted review snapshots separate in the shared cache", async () => {
    const bookDir = await createBookDir();
    const storyDir = join(bookDir, "story");
    const cache = new TruthContextCache();
    await writeFile(join(storyDir, "current_state.md"), `# State\n\n${"state ".repeat(400)}`, "utf-8");

    const small = await readAuditTruthContext(bookDir, undefined, { cache, maxTokens: 100 });
    const large = await readAuditTruthContext(bookDir, undefined, { cache, maxTokens: 500 });
    const smallTokens = Object.values(small).reduce((sum, value) => sum + estimateTextTokens(value), 0);
    const largeTokens = Object.values(large).reduce((sum, value) => sum + estimateTextTokens(value), 0);

    expect(smallTokens).toBeLessThanOrEqual(100);
    expect(largeTokens).toBeLessThanOrEqual(500);
    expect(largeTokens).toBeGreaterThanOrEqual(smallTokens);
    expect(cache.metrics().budgetReads).toBe(2);
    expect(cache.metrics().misses).toBe(2);
    expect(cache.metrics().entries).toBe(2);
    expect(cache.metrics().fields.currentState?.reads).toBe(2);
  });
});
