import type { FileAuditEvent, LogEntry } from "@actalk/inkos-core";

export const DEFAULT_LOG_BUFFER_SIZE = 500;

export class LogRingBuffer {
  private readonly maxSize: number;
  private readonly entries: LogEntry[] = [];

  constructor(maxSize = DEFAULT_LOG_BUFFER_SIZE) {
    this.maxSize = maxSize;
  }

  push(entry: LogEntry): void {
    this.entries.push(entry);
    if (this.entries.length > this.maxSize) {
      this.entries.splice(0, this.entries.length - this.maxSize);
    }
  }

  latest(limit: number): LogEntry[] {
    return this.entries.slice(-Math.min(limit, this.maxSize));
  }

  clear(): void {
    this.entries.length = 0;
  }
}

export function normalizeLogLimit(value: unknown, fallback = 200): number {
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string"
      ? Number.parseInt(value, 10)
      : NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.round(parsed), DEFAULT_LOG_BUFFER_SIZE);
}

function normalizeParsedLogEntry(value: unknown): LogEntry | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const message = typeof record.message === "string" ? record.message : "";
  if (!message.trim()) return null;
  return {
    level: typeof record.level === "string" ? record.level as LogEntry["level"] : "info",
    tag: typeof record.tag === "string" ? record.tag : "app",
    message,
    timestamp: typeof record.timestamp === "string" ? record.timestamp : new Date().toISOString(),
  };
}

export function parseJsonLineLogEntries(content: string, limit: number): LogEntry[] {
  return content
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .slice(-normalizeLogLimit(limit))
    .map((line) => {
      try {
        return normalizeParsedLogEntry(JSON.parse(line));
      } catch {
        return {
          level: "info" as const,
          tag: "log",
          message: line,
          timestamp: new Date().toISOString(),
        };
      }
    })
    .filter((entry): entry is LogEntry => Boolean(entry));
}

function logEntryKey(entry: LogEntry): string {
  return `${entry.timestamp}\u0000${entry.level}\u0000${entry.tag}\u0000${entry.message}`;
}

export function mergeLogEntries(
  fileEntries: ReadonlyArray<LogEntry>,
  memoryEntries: ReadonlyArray<LogEntry>,
  limit: number,
): LogEntry[] {
  const merged = new Map<string, { entry: LogEntry; index: number }>();
  [...fileEntries, ...memoryEntries].forEach((entry, index) => {
    merged.set(logEntryKey(entry), { entry, index });
  });

  return [...merged.values()]
    .sort((left, right) => {
      const leftTime = Date.parse(left.entry.timestamp);
      const rightTime = Date.parse(right.entry.timestamp);
      if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
        return leftTime - rightTime;
      }
      return left.index - right.index;
    })
    .map((item) => item.entry)
    .slice(-normalizeLogLimit(limit));
}

export function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function writeConsoleLogEntry(entry: Pick<LogEntry, "level" | "tag" | "message">): void {
  const prefix = `[${entry.tag}]`;
  if (entry.level === "error") {
    console.error(prefix, entry.message);
  } else if (entry.level === "warn") {
    console.warn(prefix, entry.message);
  } else {
    console.info(prefix, entry.message);
  }
}

function fileAuditActionLabel(action: FileAuditEvent["action"]): string {
  switch (action) {
    case "read": return "读取";
    case "write": return "写入";
    case "modify": return "修改";
    case "create": return "创建";
    case "list": return "列出";
    case "ensure": return "确认";
  }
}

export function formatFileAuditMessage(event: FileAuditEvent): string {
  const label = fileAuditActionLabel(event.action);
  const tool = event.tool ? ` [${event.tool}]` : "";
  const book = event.bookId ? `《${event.bookId}》` : "";
  const detail = event.detail ? `：${event.detail}` : "";
  return `${label}文件${tool}${book} ${event.path}${detail}`;
}
