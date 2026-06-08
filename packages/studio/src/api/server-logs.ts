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
