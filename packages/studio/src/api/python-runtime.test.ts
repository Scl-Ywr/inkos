import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectPythonRuntime, extractTextWithPython, runMaintenanceScan } from "./python-runtime";

afterEach(async () => {
  delete process.env.INKOS_ANDROID_PYTHON_BRIDGE_URL;
  await detectPythonRuntime(true);
});

describe("python runtime bridge", () => {
  it("reports Python availability without throwing", async () => {
    const status = await detectPythonRuntime(true);
    expect(typeof status.available).toBe("boolean");
    expect(status.platform).toBe(process.platform);
  });

  it("extracts text when Python is available and falls back cleanly otherwise", async () => {
    const status = await detectPythonRuntime();
    const result = await extractTextWithPython({
      name: "sample.md",
      base64: Buffer.from("# 标题\n\n林玄找到了档案。", "utf-8").toString("base64"),
    });
    if (!status.available) {
      expect(result).toBeNull();
      return;
    }
    expect(result?.ok).toBe(true);
    expect(result?.text).toContain("林玄");
  });

  it("runs a read-only maintenance scan or reports Python unavailability", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-maintenance-"));
    try {
      await mkdir(join(root, "books", "demo"), { recursive: true });
      await mkdir(join(root, "knowledge", "books", "demo"), { recursive: true });
      await writeFile(join(root, "books", "demo", "book.json"), "{\"title\":\"demo\"}\n", "utf-8");
      await writeFile(join(root, "books", "demo", "broken.json"), "{broken", "utf-8");
      await writeFile(join(root, "knowledge", "books", "demo", "sources.json"), "[]\n", "utf-8");
      await writeFile(join(root, "knowledge", "books", "demo", "chunks.json"), "[]\n", "utf-8");

      const result = await runMaintenanceScan(root);
      expect(typeof result.ok).toBe("boolean");
      expect(result.summary.root).toBe(root);
      expect(result.sections.books).toBeTruthy();
      if (result.ok) {
        expect(result.summary.totalFiles).toBeGreaterThan(0);
        expect(result.issues.some((issue) => issue.category === "invalid-json")).toBe(true);
        expect(result.issues.some((issue) => issue.category === "knowledge-search-index-missing")).toBe(true);
      } else {
        expect(result.issues.some((issue) => issue.category === "python-unavailable")).toBe(true);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports damaged JSONL, duplicate files, and knowledge consistency issues", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-maintenance-details-"));
    try {
      await mkdir(join(root, "books", "demo"), { recursive: true });
      await mkdir(join(root, "worlds"), { recursive: true });
      await mkdir(join(root, "knowledge", "library-a"), { recursive: true });
      await writeFile(join(root, "books", "demo", "events.jsonl"), "{\"ok\":true}\n{bad\n", "utf-8");
      await writeFile(join(root, "books", "demo", "copy-a.txt"), "same material", "utf-8");
      await writeFile(join(root, "worlds", "copy-b.txt"), "same material", "utf-8");
      await writeFile(join(root, "knowledge", "library-a", "sources.json"), JSON.stringify([
        { id: "source-1", chunkCount: 2 },
      ]), "utf-8");
      await writeFile(join(root, "knowledge", "library-a", "chunks.json"), JSON.stringify([
        { id: "chunk-1", sourceId: "source-1", text: "one" },
        { id: "chunk-2", sourceId: "missing-source", text: "orphan" },
      ]), "utf-8");

      const result = await runMaintenanceScan(root);
      if (!result.ok) {
        expect(result.issues.some((issue) => issue.category === "python-unavailable")).toBe(true);
        return;
      }

      expect(result.issues.some((issue) => issue.category === "invalid-jsonl")).toBe(true);
      expect(result.issues.some((issue) => issue.category === "duplicate-file")).toBe(true);
      expect(result.issues.some((issue) => issue.category === "knowledge-search-index-missing")).toBe(true);
      expect(result.issues.some((issue) => issue.category === "knowledge-chunk-mismatch")).toBe(true);
      expect(result.issues.some((issue) => issue.category === "knowledge-orphan-chunk-source")).toBe(true);
      expect(result.duplicates.length).toBeGreaterThan(0);
      expect(result.sections.knowledge.knowledge?.orphanChunkSources.length).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns a structured maintenance error when Android Python bridge is unavailable", async () => {
    process.env.INKOS_ANDROID_PYTHON_BRIDGE_URL = "http://127.0.0.1:9";
    await detectPythonRuntime(true);

    const result = await runMaintenanceScan("D:/inkos-unavailable-test");
    expect(result.ok).toBe(false);
    expect(result.summary.issueCount).toBeGreaterThan(0);
    expect(result.sections.books).toBeTruthy();
    expect(result.issues.some((issue) => issue.category === "python-unavailable")).toBe(true);
  });
});
