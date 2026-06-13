import type { AuditIssue, AuditResult } from "../agents/continuity.js";
import type { ChapterMeta } from "../models/chapter.js";
import type { LengthTelemetry } from "../models/length-governance.js";
import { readFile, rm } from "node:fs/promises";
import { atomicWriteFile } from "../utils/atomic-file.js";
import { buildStateDegradedReviewNote } from "./chapter-state-recovery.js";

export interface ChapterPersistenceUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
}

export type ChapterPersistenceStatus = "ready-for-review" | "audit-failed" | "state-degraded";

export type ChapterPersistenceStage =
  | "prepared"
  | "chapter-saved"
  | "truth-saved"
  | "index-saved"
  | "snapshot-saved";

export interface ChapterPersistenceJournal {
  readonly version: 1;
  readonly chapterNumber: number;
  readonly chapterTitle: string;
  readonly status: ChapterPersistenceStatus;
  readonly finalWordCount: number;
  readonly startedAt: string;
  readonly stage: ChapterPersistenceStage;
}

export async function loadChapterPersistenceJournal(
  path: string,
): Promise<ChapterPersistenceJournal | null> {
  try {
    const value = JSON.parse(await readFile(path, "utf-8")) as Partial<ChapterPersistenceJournal>;
    if (
      value.version !== 1 ||
      !Number.isInteger(value.chapterNumber) ||
      (value.chapterNumber ?? 0) < 1 ||
      typeof value.chapterTitle !== "string" ||
      !["ready-for-review", "audit-failed", "state-degraded"].includes(value.status ?? "") ||
      !Number.isInteger(value.finalWordCount) ||
      typeof value.startedAt !== "string" ||
      !["prepared", "chapter-saved", "truth-saved", "index-saved", "snapshot-saved"].includes(value.stage ?? "")
    ) {
      throw new Error(`Invalid chapter persistence journal: ${path}`);
    }
    return value as ChapterPersistenceJournal;
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return null;
    throw error;
  }
}

export async function clearChapterPersistenceJournal(path: string): Promise<void> {
  await rm(path, { force: true });
}

export async function persistChapterArtifacts(params: {
  readonly chapterNumber: number;
  readonly chapterTitle: string;
  readonly status: ChapterPersistenceStatus;
  readonly auditResult: AuditResult;
  readonly finalWordCount: number;
  readonly lengthWarnings: ReadonlyArray<string>;
  readonly lengthTelemetry?: LengthTelemetry;
  readonly degradedIssues: ReadonlyArray<AuditIssue>;
  readonly tokenUsage?: ChapterPersistenceUsage;
  readonly loadChapterIndex: () => Promise<ReadonlyArray<ChapterMeta>>;
  readonly saveChapter: () => Promise<void>;
  readonly saveTruthFiles: () => Promise<void>;
  readonly saveChapterIndex: (index: ReadonlyArray<ChapterMeta>) => Promise<void>;
  readonly markBookActiveIfNeeded: () => Promise<void>;
  readonly persistAuditDriftGuidance: (issues: ReadonlyArray<AuditIssue>) => Promise<void>;
  readonly snapshotState: () => Promise<void>;
  readonly syncCurrentStateFactHistory: () => Promise<void>;
  readonly logSnapshotStage: () => void;
  readonly journalPath?: string;
  readonly now?: () => string;
}): Promise<{ readonly entry: ChapterMeta }> {
  const now = params.now?.() ?? new Date().toISOString();
  const journal: ChapterPersistenceJournal = {
    version: 1,
    chapterNumber: params.chapterNumber,
    chapterTitle: params.chapterTitle,
    status: params.status,
    finalWordCount: params.finalWordCount,
    startedAt: now,
    stage: "prepared",
  };
  const recordStage = async (stage: ChapterPersistenceStage): Promise<void> => {
    if (!params.journalPath) return;
    await atomicWriteFile(
      params.journalPath,
      `${JSON.stringify({ ...journal, stage }, null, 2)}\n`,
      "utf-8",
      false,
    );
  };

  await recordStage("prepared");
  await params.saveChapter();
  await recordStage("chapter-saved");
  if (params.status !== "state-degraded") {
    await params.saveTruthFiles();
    await recordStage("truth-saved");
  }

  const existingIndex = await params.loadChapterIndex();
  const entry: ChapterMeta = {
    number: params.chapterNumber,
    title: params.chapterTitle,
    status: params.status,
    wordCount: params.finalWordCount,
    createdAt: now,
    updatedAt: now,
    auditIssues: params.auditResult.issues.map((issue) => `[${issue.severity}] ${issue.description}`),
    lengthWarnings: [...params.lengthWarnings],
    reviewNote: params.status === "state-degraded"
      ? buildStateDegradedReviewNote(
          params.auditResult.passed ? "ready-for-review" : "audit-failed",
          params.degradedIssues,
        )
      : undefined,
    lengthTelemetry: params.lengthTelemetry,
    tokenUsage: params.tokenUsage,
  };
  const existingIdx = existingIndex.findIndex((e) => e.number === params.chapterNumber);
  const updatedIndex = existingIdx >= 0
    ? existingIndex.map((e, i) => i === existingIdx ? { ...entry, createdAt: e.createdAt } : e)
    : [...existingIndex, entry];
  await params.saveChapterIndex(updatedIndex);
  await recordStage("index-saved");
  await params.markBookActiveIfNeeded();

  const driftIssues = params.auditResult.issues.filter(
    (issue) => issue.severity === "critical" || issue.severity === "warning",
  );
  await params.persistAuditDriftGuidance(params.status === "state-degraded" ? [] : driftIssues);

  if (params.status !== "state-degraded") {
    params.logSnapshotStage();
    await params.snapshotState();
    await params.syncCurrentStateFactHistory();
  }
  await recordStage("snapshot-saved");
  if (params.journalPath) {
    await clearChapterPersistenceJournal(params.journalPath);
  }

  return { entry };
}
