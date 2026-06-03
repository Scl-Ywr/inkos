import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { UserMessage } from "@mariozechner/pi-ai";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { isNewLayoutBook } from "../utils/outline-paths.js";

/** Files read in this order; anything else in story/ comes after, sorted alphabetically. */
const PRIORITY_FILES = [
  "story_bible.md",
  "volume_outline.md",
  "book_rules.md",
  "current_focus.md",
];

/** Total character budget for the entire truth-file injection block.
 *  Keeps the per-turn context injection from ballooning on long-running books. */
const MAX_CONTEXT_INJECT_CHARS = 30_000;

/** Per-file character cap so a single oversized truth file cannot monopolize the budget. */
const MAX_SINGLE_FILE_CHARS = 8_000;

/** Maximum number of messages to keep in the agent's context window.
 *  When exceeded, oldest messages are compacted into a summary placeholder. */
const MAX_CONTEXT_MESSAGES = 60;

const UPGRADE_HINT =
  "[提示] 当前这本书的架构稿是旧的条目式格式（story_bible.md / volume_outline.md / character_matrix.md）。" +
  "如果作者有意愿升级成段落式架构稿 + 一人一卡的角色目录（outline/story_frame.md + outline/volume_map.md + roles/），" +
  "可以调用 `sub_agent(architect, { revise: true, bookId, feedback: \"把架构稿从条目式升级成段落式架构稿，并把角色矩阵拆成 roles 目录一人一卡\" })`。" +
  "升级只改架构稿，不动已写的章节。在作者没明确同意前不要主动触发。";

export function createBookContextTransform(
  bookId: string | null,
  projectRoot: string,
): (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]> {
  if (bookId === null) {
    return async (messages) => messages;
  }

  const bookDir = join(projectRoot, "books", bookId);
  const storyDir = join(bookDir, "story");

  return async (messages) => {
    // Slide-window: drop oldest messages when history grows too long.
    const compacted = compactSessionMessages(messages, MAX_CONTEXT_MESSAGES);

    const sections = await readTruthFiles(storyDir);
    if (sections.length === 0) return compacted;

    const isNew = await isNewLayoutBook(bookDir);
    const hintBlock = isNew ? "" : `\n\n${UPGRADE_HINT}`;

    // Apply per-file cap first, then total budget cap to avoid token blowout.
    const cappedSections = sections.map((s) => ({
      ...s,
      content: capFileContent(s.content, s.name, MAX_SINGLE_FILE_CHARS),
    }));
    const rawBody =
      "[以下是当前书籍的真相文件，每次对话时自动从磁盘读取注入。请基于这些内容进行创作和判断。]" +
      hintBlock + "\n\n" +
      cappedSections.map((s) => `=== ${s.name} ===\n${s.content}`).join("\n\n");
    const body = capTotalBody(rawBody);

    const injected: UserMessage = {
      role: "user",
      content: body,
      timestamp: Date.now(),
    };

    return [injected, ...compacted];
  };
}

interface TruthFileSection {
  name: string;
  content: string;
}

async function readTruthFiles(storyDir: string): Promise<TruthFileSection[]> {
  let entries: string[];
  try {
    entries = await readdir(storyDir);
  } catch {
    return [];
  }

  const mdFiles = entries.filter((f) => f.endsWith(".md"));
  if (mdFiles.length === 0) return [];

  const prioritySet = new Set(PRIORITY_FILES);
  const prioritized = PRIORITY_FILES.filter((f) => mdFiles.includes(f));
  const rest = mdFiles.filter((f) => !prioritySet.has(f)).sort();
  const ordered = [...prioritized, ...rest];

  const sections: TruthFileSection[] = [];
  for (const fileName of ordered) {
    try {
      const content = await readFile(join(storyDir, fileName), "utf-8");
      sections.push({ name: fileName, content });
    } catch {
      // skip unreadable files
    }
  }
  return sections;
}

/** Head+tail cap for a single truth file section. */
function capFileContent(content: string, fileName: string, maxChars: number): string {
  if (content.length <= maxChars) return content;
  const note = `\n[InkOS context budget: truncated ${fileName} — omitted ${content.length - maxChars} chars, kept head and tail.]\n`;
  const keep = maxChars - note.length;
  if (keep <= 4) return content.slice(0, maxChars);
  const head = Math.max(1, Math.floor(keep * 0.45));
  const tail = Math.max(1, keep - head);
  return `${content.slice(0, head)}${note}${content.slice(-tail)}`;
}

/** Cap the full assembled context-injection body to the total budget. */
function capTotalBody(body: string): string {
  if (body.length <= MAX_CONTEXT_INJECT_CHARS) return body;
  const note = `\n\n[InkOS context budget: total truth-file injection truncated — omitted ${body.length - MAX_CONTEXT_INJECT_CHARS} chars; kept beginning and latest tail.]\n\n`;
  const keep = MAX_CONTEXT_INJECT_CHARS - note.length;
  if (keep <= 4) return body.slice(0, MAX_CONTEXT_INJECT_CHARS);
  const head = Math.max(1, Math.floor(keep * 0.4));
  const tail = Math.max(1, keep - head);
  return `${body.slice(0, head)}${note}${body.slice(-tail)}`;
}

/** Sliding-window compaction for agent session history.
 *  Keeps the most recent `maxMessages` messages and replaces dropped older
 *  messages with a single summary placeholder. Never splits a toolCall /
 *  toolResult pair across the cut boundary. */
function compactSessionMessages(
  messages: AgentMessage[],
  maxMessages: number,
): AgentMessage[] {
  if (messages.length <= maxMessages) return messages;

  // Walk backwards from the cut point to avoid splitting a toolCall/toolResult pair.
  let cutIndex = messages.length - maxMessages + 1; // +1 for the summary msg we'll insert
  while (cutIndex > 0 && cutIndex < messages.length) {
    const msg = messages[cutIndex] as { role?: string; toolCallId?: string };
    // If the message at the cut is a toolResult, move the cut earlier so the
    // matching assistant toolCall is also included in the kept window.
    if (msg.role === "toolResult") {
      cutIndex--;
      continue;
    }
    // If the previous message is an assistant with toolCalls, include it too.
    if (cutIndex > 0) {
      const prev = messages[cutIndex - 1] as { role?: string; content?: unknown[] };
      if (
        prev?.role === "assistant" &&
        Array.isArray(prev.content) &&
        prev.content.some((b: unknown) => typeof b === "object" && b !== null && (b as { type?: string }).type === "toolCall")
      ) {
        cutIndex--;
        continue;
      }
    }
    break;
  }
  cutIndex = Math.max(0, cutIndex);

  const droppedCount = cutIndex;
  const kept = messages.slice(cutIndex);

  const summary: UserMessage = {
    role: "user",
    content: `[InkOS session compaction: ${droppedCount} older messages were dropped to stay within the context window. The conversation continues from the most recent exchanges below.]`,
    timestamp: Date.now(),
  };

  return [summary, ...kept];
}
