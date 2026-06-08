import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadOperationHistory,
  normalizeOperationHistoryItems,
  operationHistoryPath,
  saveOperationHistory,
} from "./operation-history-store";

describe("operation history store", () => {
  it("normalizes persisted operation history and ignores invalid entries", () => {
    const items = normalizeOperationHistoryItems({
      operations: [
        { key: "bad" },
        {
          key: "write:demo",
          type: "write",
          bookId: "demo",
          status: "completed",
          label: "章节写作",
          message: "done",
          startedAt: 1,
          updatedAt: 2,
          completedAt: 2,
          durationMs: 1,
          chapter: 3,
        },
      ],
    });

    expect(items).toEqual([
      expect.objectContaining({
        key: "write:demo",
        type: "write",
        bookId: "demo",
        status: "completed",
        chapter: 3,
      }),
    ]);
  });

  it("saves and loads task history from runtime/task-history.json", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-operation-history-"));
    const item = {
      key: "audit:demo:3",
      type: "audit" as const,
      bookId: "demo",
      status: "error" as const,
      label: "章节审计",
      message: "审计失败",
      startedAt: 1,
      updatedAt: 5,
      completedAt: 5,
      durationMs: 4,
      error: "API 400",
    };

    await saveOperationHistory(root, [item]);

    await expect(readFile(operationHistoryPath(root), "utf-8")).resolves.toContain("audit:demo:3");
    await expect(loadOperationHistory(root)).resolves.toEqual([item]);
  });

  it("returns an empty list when the history file is missing or invalid", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-operation-history-invalid-"));

    await expect(loadOperationHistory(root)).resolves.toEqual([]);
    await writeFile(operationHistoryPath(root), "{ broken", "utf-8").catch(async () => {
      await saveOperationHistory(root, []);
      await writeFile(operationHistoryPath(root), "{ broken", "utf-8");
    });

    await expect(loadOperationHistory(root)).resolves.toEqual([]);
  });
});
