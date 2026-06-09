import type {
  Message,
  MessagePart,
  PipelineStage,
  SessionMessage,
  SessionRuntime,
  SessionSummary,
  ToolExecution,
} from "../../types";
import { localizeKnownRuntimeMessage } from "../../../../lib/error-copy";
import {
  extractToolDetails as extractToolDetailsFromResult,
  extractToolError as extractToolErrorFromResult,
  summarizeToolResult,
} from "../../../../lib/tool-result";

const NULL_BOOK_KEY = "__null__";

const AGENT_LABELS: Record<string, string> = {
  architect: "建书",
  writer: "写作",
  auditor: "审计",
  reviser: "修订",
  exporter: "导出",
};

const TOOL_LABELS: Record<string, string> = {
  read: "读取文件",
  edit: "编辑文件",
  grep: "搜索",
  ls: "列目录",
  short_fiction_run: "短篇生产",
  generate_cover: "生成封面",
};

export function bookKey(bookId: string | null | undefined): string {
  return bookId ?? NULL_BOOK_KEY;
}

export function extractErrorMessage(error: string | { code?: string; message?: string }): string {
  if (typeof error === "string") return localizeKnownRuntimeMessage(error);
  return localizeKnownRuntimeMessage(error.message ?? "Unknown error");
}

export function resolveToolLabel(tool: string, agent?: string): string {
  if (tool === "sub_agent" && agent) return AGENT_LABELS[agent] ?? agent;
  return TOOL_LABELS[tool] ?? tool;
}

export function summarizeResult(result: unknown): string {
  return summarizeToolResult(result, { maxLength: 2000 });
}

export function extractToolDetails(result: unknown): unknown {
  return extractToolDetailsFromResult(result);
}

export function extractToolError(result: unknown): string {
  return extractToolErrorFromResult(result, {
    maxLength: 500,
    localize: localizeKnownRuntimeMessage,
  });
}

export function getOrCreateStream(
  messages: ReadonlyArray<Message>,
  streamTs: number,
): [ReadonlyArray<Message>, Message] {
  const last = messages[messages.length - 1];
  if (last?.timestamp === streamTs && last.role === "assistant") {
    return [messages, last];
  }
  const message: Message = { role: "assistant", content: "", timestamp: streamTs, parts: [] };
  return [[...messages, message], message];
}

export function replaceLast(
  messages: ReadonlyArray<Message>,
  updated: Message,
): ReadonlyArray<Message> {
  return [...messages.slice(0, -1), updated];
}

export function findRunningToolPart(
  parts: MessagePart[],
): (MessagePart & { type: "tool" }) | undefined {
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    const part = parts[i];
    if (part.type === "tool" && part.execution.status === "running") {
      return part as MessagePart & { type: "tool" };
    }
  }
  return undefined;
}

export function deriveFlat(
  parts: MessagePart[],
): { content: string; thinking?: string; thinkingStreaming?: boolean; toolExecutions?: ToolExecution[] } {
  let content = "";
  let thinking = "";
  let thinkingStreaming = false;
  const toolExecutions: ToolExecution[] = [];

  for (const part of parts) {
    if (part.type === "thinking") {
      if (thinking) thinking += "\n\n---\n\n";
      thinking += part.content;
      if (part.streaming) thinkingStreaming = true;
      continue;
    }

    if (part.type === "text") {
      content += part.content;
      continue;
    }

    toolExecutions.push(part.execution);
  }

  return {
    content,
    ...(thinking ? { thinking } : {}),
    ...(thinkingStreaming ? { thinkingStreaming: true } : {}),
    ...(toolExecutions.length > 0 ? { toolExecutions } : {}),
  };
}

export function createSessionRuntime(input: {
  sessionId: string;
  bookId: string | null;
  title: string | null;
  messages?: ReadonlyArray<Message>;
  deletedMessageKeys?: ReadonlyArray<string>;
  isDraft?: boolean;
}): SessionRuntime {
  return {
    sessionId: input.sessionId,
    bookId: input.bookId,
    title: input.title,
    messages: input.messages ?? [],
    deletedMessageKeys: input.deletedMessageKeys ?? [],
    stream: null,
    abortController: null,
    isStreaming: false,
    lastError: null,
    isDraft: input.isDraft ?? false,
  };
}

export function messageDeletionKey(message: Pick<Message, "role" | "content" | "timestamp">): string {
  return [
    message.role,
    String(message.timestamp),
    message.content.trim().slice(0, 240),
  ].join("\u001f");
}

export function filterDeletedMessages(
  messages: ReadonlyArray<Message>,
  deletedMessageKeys: ReadonlyArray<string>,
): ReadonlyArray<Message> {
  if (deletedMessageKeys.length === 0) return messages;
  const deleted = new Set(deletedMessageKeys);

  const parsedDeletedKeys = deletedMessageKeys.map(key => {
    const parts = key.split("\u001f");
    return {
      role: parts[0],
      timestamp: Number(parts[1]),
      content: parts[2] || "",
    };
  });

  return messages.filter((message) => {
    const exactKey = messageDeletionKey(message);
    if (deleted.has(exactKey)) return false;

    // Backend timestamps can differ from local frontend timestamps significantly (e.g. streaming time)
    const msgContent = message.content.trim().slice(0, 240);
    for (const dKey of parsedDeletedKeys) {
      if (dKey.role === message.role && dKey.content === msgContent) {
        return false; // Match by role and content only to handle timestamp mismatches
      }
    }
    return true;
  });
}

export function deserializeMessages(
  msgs: ReadonlyArray<SessionMessage>,
): ReadonlyArray<Message> {
  return msgs
    .filter((message) => message.role === "user" || message.role === "assistant")
    .map((message) => {
      const toolExecutions = message.toolExecutions ? [...message.toolExecutions] : undefined;
      const parts: MessagePart[] = [];
      if (message.thinking) parts.push({ type: "thinking", content: message.thinking, streaming: false });
      if (toolExecutions) {
        for (const execution of toolExecutions) {
          parts.push({ type: "tool", execution });
        }
      }
      if (message.content) parts.push({ type: "text", content: message.content });
      return {
        role: message.role as "user" | "assistant",
        content: message.content,
        thinking: message.thinking,
        toolExecutions,
        tokenUsage: message.tokenUsage,
        timestamp: message.timestamp,
        parts: parts.length > 0 ? parts : undefined,
      };
    });
}

export function updateSession(
  sessions: Record<string, SessionRuntime>,
  sessionId: string,
  updater: (session: SessionRuntime) => Partial<SessionRuntime>,
): Record<string, SessionRuntime> {
  const existing = sessions[sessionId];
  if (!existing) return sessions;
  return {
    ...sessions,
    [sessionId]: {
      ...existing,
      ...updater(existing),
    },
  };
}

export function upsertSessionSummary(
  sessions: Record<string, SessionRuntime>,
  summary: Pick<SessionSummary, "sessionId" | "bookId" | "title">,
): Record<string, SessionRuntime> {
  const existing = sessions[summary.sessionId];
  return {
    ...sessions,
    [summary.sessionId]: existing
      ? { ...existing, bookId: summary.bookId, title: summary.title }
      : createSessionRuntime(summary),
  };
}

export function mergeSessionIds(
  existing: ReadonlyArray<string> | undefined,
  incoming: ReadonlyArray<string>,
): ReadonlyArray<string> {
  if (!existing?.length) return [...incoming];
  const seen = new Set(existing);
  const appended = incoming.filter((id) => !seen.has(id));
  if (appended.length === 0) return existing as string[];
  return [...existing, ...appended];
}

export function sessionMatchesEvent(sessionId: string, data: unknown): boolean {
  if (!data || typeof data !== "object") return false;
  return (data as { sessionId?: unknown }).sessionId === sessionId;
}
