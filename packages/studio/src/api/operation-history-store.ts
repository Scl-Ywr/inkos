import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { OperationHistoryItem, OperationHistoryStatus } from "./active-operations.js";

export const OPERATION_HISTORY_LIMIT = 50;

const OPERATION_TYPES = new Set<OperationHistoryItem["type"]>([
  "write",
  "draft",
  "rewrite",
  "agent",
  "revise",
  "audit",
]);

const OPERATION_HISTORY_STATUSES = new Set<OperationHistoryStatus>([
  "completed",
  "error",
  "cancelled",
]);

export function operationHistoryPath(root: string): string {
  return join(root, "runtime", "task-history.json");
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function normalizeOperationHistoryItem(value: unknown): OperationHistoryItem | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const key = optionalString(record.key);
  const type = optionalString(record.type);
  const bookId = optionalString(record.bookId);
  const status = optionalString(record.status);
  const label = optionalString(record.label);
  const message = optionalString(record.message);
  const startedAt = finiteNumber(record.startedAt);
  const updatedAt = finiteNumber(record.updatedAt);
  const completedAt = finiteNumber(record.completedAt);
  const durationMs = finiteNumber(record.durationMs);

  if (
    !key
    || !type
    || !OPERATION_TYPES.has(type as OperationHistoryItem["type"])
    || !bookId
    || !status
    || !OPERATION_HISTORY_STATUSES.has(status as OperationHistoryStatus)
    || !label
    || !message
    || startedAt === null
    || updatedAt === null
    || completedAt === null
    || durationMs === null
  ) {
    return null;
  }

  const chapter = finiteNumber(record.chapter);
  return {
    key,
    type: type as OperationHistoryItem["type"],
    bookId,
    status: status as OperationHistoryStatus,
    label,
    message,
    startedAt,
    updatedAt,
    completedAt,
    durationMs,
    ...(chapter !== null ? { chapter } : {}),
    ...(optionalString(record.sessionId) ? { sessionId: optionalString(record.sessionId) } : {}),
    ...(optionalString(record.instruction) ? { instruction: optionalString(record.instruction) } : {}),
    ...(optionalString(record.error) ? { error: optionalString(record.error) } : {}),
  };
}

export function normalizeOperationHistoryItems(
  value: unknown,
  limit = OPERATION_HISTORY_LIMIT,
): OperationHistoryItem[] {
  const source = Array.isArray(value)
    ? value
    : value && typeof value === "object" && Array.isArray((value as { operations?: unknown }).operations)
      ? (value as { operations: unknown[] }).operations
      : [];
  const normalizedLimit = Number.isFinite(limit) && limit > 0
    ? Math.floor(limit)
    : OPERATION_HISTORY_LIMIT;
  return source
    .map(normalizeOperationHistoryItem)
    .filter((item): item is OperationHistoryItem => item !== null)
    .sort((left, right) => left.completedAt - right.completedAt)
    .slice(-normalizedLimit);
}

export async function loadOperationHistory(root: string): Promise<OperationHistoryItem[]> {
  try {
    const raw = await readFile(operationHistoryPath(root), "utf-8");
    return normalizeOperationHistoryItems(JSON.parse(raw));
  } catch {
    return [];
  }
}

export async function saveOperationHistory(
  root: string,
  operations: ReadonlyArray<OperationHistoryItem>,
): Promise<void> {
  const runtimeDir = join(root, "runtime");
  await mkdir(runtimeDir, { recursive: true });
  await writeFile(
    operationHistoryPath(root),
    JSON.stringify({
      version: 1,
      operations: operations.slice(0, OPERATION_HISTORY_LIMIT),
    }, null, 2),
    "utf-8",
  );
}
