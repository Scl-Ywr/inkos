import { Type, type Static } from "@mariozechner/pi-ai";
import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from "@mariozechner/pi-agent-core";
import type { PipelineRunner } from "../pipeline/runner.js";
import { ArchitectIncompleteFoundationError } from "../agents/architect.js";
import { type ReviseMode } from "../agents/reviser.js";
import { defaultChapterLength } from "../utils/length-metrics.js";
import { inferLanguage } from "../utils/language.js";
import { readFile, writeFile, readdir, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { StateManager } from "../state/manager.js";
import { assertSafeTruthFileName, createInteractionToolsFromDeps } from "../interaction/project-tools.js";
import { writeExportArtifact } from "../interaction/export-artifact.js";
import { assertSafeBookId, deriveBookIdFromTitle } from "../utils/book-id.js";
import { safeChildPath } from "../utils/path-safety.js";
import { normalizePlatformId, normalizePlatformOrOther } from "../models/book.js";
import { generateShortFictionCover, runShortFictionProduction } from "../pipeline/short-fiction-runner.js";
import { createPlayDB, type PlayGraphDB } from "../play/play-db-factory.js";
import { PlayRunner, type PlayOpeningSeedResult, type PlayReplayResult, type PlayStepResult, type PlayVariantRestoreResult } from "../play/play-runner.js";
import { PlayStore } from "../play/play-store.js";
import type { AgentContext } from "../agents/base.js";
import { ActionPayloadSchema, isUsablePlayInitialScene, type ActionPayload } from "../interaction/action-envelope.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function textResult(text: string): AgentToolResult<undefined>;
function textResult<T>(text: string, details: T): AgentToolResult<T>;
function textResult<T = undefined>(text: string, details?: T): AgentToolResult<T> {
  return { content: [{ type: "text", text }], details: details as T };
}

/**
 * Resolve a user-supplied relative path against the books root and guard
 * against path-traversal (../ etc.).
 */
function safeBooksPath(booksRoot: string, relativePath: string): string {
  return safeChildPath(booksRoot, relativePath);
}

function resolveToolBookId(
  toolName: string,
  paramsBookId: string | undefined,
  activeBookId: string | null,
): string {
  const resolvedBookId = paramsBookId ?? activeBookId ?? undefined;
  if (!resolvedBookId) {
    throw new Error(`${toolName} requires bookId when there is no active book.`);
  }
  const safeBookId = assertSafeBookId(resolvedBookId, `${toolName}.bookId`);
  if (paramsBookId && activeBookId && safeBookId !== activeBookId) {
    throw new Error(`${toolName}.bookId must match the active book.`);
  }
  return safeBookId;
}

function createDeterministicInteractionTools(pipeline: PipelineRunner, projectRoot: string) {
  const state = new StateManager(projectRoot);
  return createInteractionToolsFromDeps(pipeline, state);
}

function closePlayDB(db: PlayGraphDB): void {
  db.close?.();
}

function closePlayRunner(runner: { close?: () => void }): void {
  runner.close?.();
}

function safePlayId(value: string | undefined, fallback: string): string {
  const raw = (value?.trim() || fallback).slice(0, 80);
  if (!raw || raw === "." || raw === ".." || raw.includes("/") || raw.includes("\\") || raw.includes("\0")) {
    throw new Error(`Invalid play id: ${JSON.stringify(value)}`);
  }
  return raw;
}

const SuggestedActionParam = Type.Union([
  Type.String({ description: "A short clickable player action." }),
  Type.Object({
    label: Type.Optional(Type.String({ description: "Short clickable player action." })),
    action: Type.Optional(Type.String({ description: "Concrete action text." })),
    text: Type.Optional(Type.String({ description: "Concrete action text." })),
    title: Type.Optional(Type.String({ description: "Short action title." })),
    description: Type.Optional(Type.String({ description: "Optional action description." })),
  }, { description: "A model may describe an action as an object; InkOS will normalize it to one short action string." }),
], { description: "Suggested action as a string or small action object." });

type SuggestedActionParamType = Static<typeof SuggestedActionParam>;

function normalizeSuggestedActions(value: readonly SuggestedActionParamType[] | undefined): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const raw of value) {
    const text = typeof raw === "string"
      ? raw
      : raw.action ?? raw.label ?? raw.text ?? raw.title ?? raw.description ?? "";
    const normalized = text.replace(/\s+/g, " ").trim();
    if (normalized) out.push(normalized);
    if (out.length >= 4) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 1. Proposed Action Tool (propose_action)
// ---------------------------------------------------------------------------

const ProposeActionParams = Type.Object({
  action: Type.Union([
    Type.Literal("create_book"),
    Type.Literal("short_run"),
    Type.Literal("play_start"),
    Type.Literal("generate_cover"),
    Type.Literal("fanfic_init"),
    Type.Literal("continuation_import"),
    Type.Literal("spinoff_create"),
    Type.Literal("style_imitation"),
  ], {
    description: "The production or assisted Studio workflow the user appears to want, but which needs explicit confirmation from general chat.",
  }),
  instruction: Type.String({
    description: "The exact production instruction to run after the user confirms. It must be self-contained: include title, story direction, active target, output directory, cover visual direction, or any referenced context that would otherwise be lost when switching sessions.",
  }),
  title: Type.Optional(Type.String({
    description: "Short user-facing title for the confirmation card.",
  })),
  summary: Type.Optional(Type.String({
    description: "One or two sentences explaining what will happen if the user confirms.",
  })),
  createBook: Type.Optional(Type.Object({
    title: Type.Optional(Type.String({
      description: "Confirmed long-form book title.",
    })),
    genre: Type.Optional(Type.String({
      description: "Confirmed book genre/category.",
    })),
    platform: Type.Optional(Type.Union([
      Type.Literal("tomato"),
      Type.Literal("qidian"),
      Type.Literal("feilu"),
      Type.Literal("other"),
    ], { description: "Confirmed target platform, e.g. tomato for 番茄." })),
    language: Type.Optional(Type.Union([
      Type.Literal("zh"),
      Type.Literal("en"),
    ], { description: "Confirmed writing language." })),
    targetChapters: Type.Optional(Type.Number({
      description: "Confirmed total chapter count.",
    })),
    chapterWordCount: Type.Optional(Type.Number({
      description: "Confirmed per-chapter length in the book's native unit.",
    })),
  }, { description: "Structured execution args for action=create_book. Put platform/length here; do not leave them only in instruction text." })),
  shortRun: Type.Optional(Type.Object({
    direction: Type.Optional(Type.String({
      description: "Confirmed standalone short direction.",
    })),
    reference: Type.Optional(Type.String({
      description: "Optional confirmed reference notes or constraints.",
    })),
    storyId: Type.Optional(Type.String({
      description: "Optional confirmed output id under shorts/.",
    })),
    chapters: Type.Optional(Type.Number({
      description: "Confirmed complete short chapter count, 12-18.",
    })),
    charsPerChapter: Type.Optional(Type.Number({
      description: "Confirmed Chinese characters per chapter, 900-1200. Do not put total story length here.",
    })),
    cover: Type.Optional(Type.Boolean({
      description: "Whether to attempt cover generation.",
    })),
  }, { description: "Structured execution args for action=short_run." })),
  playStart: Type.Optional(Type.Object({
    title: Type.Optional(Type.String({ description: "Confirmed interactive world title." })),
    premise: Type.Optional(Type.String({ description: "Confirmed playable premise." })),
    worldContract: Type.Optional(Type.String({
      description: "Confirmed durable world contract in natural language: time semantics, role autonomy, object/clue/relationship rules, taboos, or other long-lived rules the user explicitly asked for. Do not invent RPG/level systems.",
    })),
    visualContract: Type.Optional(Type.String({
      description: "Confirmed visual contract for Play illustrations in natural language. Only include user-defined visual semantics; do not invent game frames, colored tiers, UI, or stats.",
    })),
    mode: Type.Optional(Type.Union([
      Type.Literal("open"),
      Type.Literal("guided"),
    ], { description: "Confirmed play mode: open for free actions, guided for suggested choices." })),
    initialScene: Type.Optional(Type.String({
      description: "Confirmed opening scene shown to the player after confirmation. It must be pure narrative prose, not a title/setup/rules summary, not a question prompt, and not an action/options list.",
    })),
    suggestedActions: Type.Optional(Type.Array(SuggestedActionParam, {
      description: "Optional action springboards shown as separate UI chips. Do not include these in initialScene.",
    })),
  }, { description: "Structured execution args for action=play_start." })),
  generateCover: Type.Optional(Type.Object({
    title: Type.Optional(Type.String({ description: "Confirmed cover title." })),
    intro: Type.Optional(Type.String({ description: "Confirmed synopsis/hook for the cover." })),
    sellingPoints: Type.Optional(Type.String({ description: "Confirmed selling points for the cover." })),
    coverPrompt: Type.Optional(Type.String({ description: "Confirmed visual direction." })),
    outputDir: Type.Optional(Type.String({ description: "Confirmed output directory." })),
  }, { description: "Structured execution args for action=generate_cover." })),
});

type ProposeActionParamsType = Static<typeof ProposeActionParams>;
type ProposedActionTargetRoute = "import:fanfic" | "import:chapters" | "import:canon" | "import:spinoff" | "import:imitation" | "style";
type ProposeActionToolOptions = {
  readonly sameSession?: boolean;
};

function proposedActionSessionKind(action: ProposeActionParamsType["action"]): "book-create" | "short" | "play" | "chat" {
  if (action === "create_book") return "book-create";
  if (action === "play_start") return "play";
  if (action === "fanfic_init" || action === "continuation_import" || action === "spinoff_create" || action === "style_imitation") return "chat";
  return "short";
}

function proposedActionTargetRoute(action: ProposeActionParamsType["action"]): ProposedActionTargetRoute | undefined {
  if (action === "fanfic_init") return "import:fanfic";
  if (action === "continuation_import") return "import:chapters";
  if (action === "spinoff_create") return "import:spinoff";
  if (action === "style_imitation") return "import:imitation";
  return undefined;
}

function proposedActionFallbackTitle(action: ProposeActionParamsType["action"], isZh: boolean): string {
  switch (action) {
    case "create_book":
      return isZh ? "创建长篇书籍" : "Create a long-form book";
    case "short_run":
      return isZh ? "生成 InkOS Short" : "Generate InkOS Short";
    case "play_start":
      return isZh ? "启动 InkOS Play" : "Start InkOS Play";
    case "generate_cover":
      return isZh ? "生成封面" : "Generate cover";
    case "fanfic_init":
      return isZh ? "打开同人创作" : "Open fanfiction workflow";
    case "continuation_import":
      return isZh ? "打开续写导入" : "Open continuation import";
    case "spinoff_create":
      return isZh ? "打开番外创作" : "Open side-story workflow";
    case "style_imitation":
      return isZh ? "打开仿写/文风分析" : "Open style imitation";
  }
}

function proposedActionFallbackSummary(action: ProposeActionParamsType["action"], isZh: boolean): string {
  if (proposedActionTargetRoute(action)) {
    return isZh
      ? "确认后只会打开现有 Studio 工具，不会直接生成成品。"
      : "After confirmation, InkOS will only open the existing Studio tool; it will not generate finished content directly.";
  }
  return isZh
    ? "确认后会切换到对应入口并执行这条需求。"
    : "After confirmation, InkOS will switch to the matching surface and run this request.";
}

function compactObject<T extends Record<string, unknown>>(value: T | undefined): T | undefined {
  if (!value || typeof value !== "object") return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw === "string") {
      const text = raw.trim();
      if (text) out[key] = text;
      continue;
    }
    if (Array.isArray(raw)) {
      const items = raw.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
        .map((item) => item.trim());
      if (items.length > 0) out[key] = items;
      continue;
    }
    if (raw !== undefined && raw !== null) {
      out[key] = raw;
    }
  }
  return Object.keys(out).length > 0 ? out as T : undefined;
}

function compactPlayStartPayload(value: ProposeActionParamsType["playStart"]): NonNullable<ActionPayload["playStart"]> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const out: NonNullable<ActionPayload["playStart"]> = {};
  const title = value.title?.trim();
  if (title) out.title = title;
  const premise = value.premise?.trim();
  if (premise) out.premise = premise;
  const worldContract = value.worldContract?.trim();
  if (worldContract) out.worldContract = worldContract;
  const visualContract = value.visualContract?.trim();
  if (visualContract) out.visualContract = visualContract;
  if (value.mode) out.mode = value.mode;
  const initialScene = value.initialScene?.trim();
  if (isUsablePlayInitialScene(initialScene)) out.initialScene = initialScene;
  const suggestedActions = normalizeSuggestedActions(value.suggestedActions);
  if (suggestedActions.length > 0) out.suggestedActions = suggestedActions;
  return Object.keys(out).length > 0 ? out : undefined;
}

function proposedActionPayload(params: ProposeActionParamsType): ActionPayload | undefined {
  const payload: ActionPayload = {};
  if (params.action === "create_book") {
    const createBook = compactObject(params.createBook);
    if (createBook) payload.createBook = createBook;
  }
  if (params.action === "short_run") {
    const shortRun = compactObject(params.shortRun);
    if (shortRun) payload.shortRun = shortRun;
  }
  if (params.action === "play_start") {
    const playStart = compactPlayStartPayload(params.playStart);
    if (playStart) payload.playStart = playStart;
  }
  if (params.action === "generate_cover") {
    const generateCover = compactObject(params.generateCover);
    if (generateCover) payload.generateCover = generateCover;
  }
  return Object.keys(payload).length > 0 ? payload : undefined;
}

function validateProposedActionPayload(payload: ActionPayload | undefined): {
  readonly payload?: ActionPayload;
  readonly error?: string;
} {
  if (!payload) return {};
  const parsed = ActionPayloadSchema.safeParse(payload);
  if (parsed.success) return { payload: parsed.data };
  return { error: parsed.error.issues.map((issue) => issue.message).join("; ") };
}

function requireProposedText(value: string | undefined, label: string): void {
  if (typeof value === "string" && value.trim().length > 0) return;
  throw new Error(`propose_action is missing ${label}; retry with that field in the structured payload, not only in summary or instruction.`);
}

function assertExecutableProposedAction(params: ProposeActionParamsType, payload: ActionPayload | undefined): void {
  if (params.action === "create_book") {
    requireProposedText(payload?.createBook?.title, "createBook.title");
    return;
  }
  if (params.action === "play_start") {
    requireProposedText(payload?.playStart?.title, "playStart.title");
    requireProposedText(payload?.playStart?.premise, "playStart.premise");
    requireProposedText(payload?.playStart?.initialScene, "playStart.initialScene");
    return;
  }
  if (params.action === "generate_cover") {
    requireProposedText(payload?.generateCover?.title, "generateCover.title");
  }
}

export function createProposeActionTool(
  language: "zh" | "en" = "zh",
  options: ProposeActionToolOptions = {},
): AgentTool<typeof ProposeActionParams> {
  return {
    name: "propose_action",
    description:
      "Ask the user to confirm a production action from general chat. " +
      "Use this before creating books, generating shorts/covers, or starting play worlds when the user has not clicked a confirmation.",
    label: "Confirm Action",
    parameters: ProposeActionParams,
    async execute(_toolCallId: string, params: ProposeActionParamsType): Promise<AgentToolResult<unknown>> {
      const targetSessionKind = proposedActionSessionKind(params.action);
      const targetRoute = proposedActionTargetRoute(params.action);
      const isZh = language === "zh";
      const title = params.title?.trim() || proposedActionFallbackTitle(params.action, isZh);
      const summary = params.summary?.trim() || proposedActionFallbackSummary(params.action, isZh);
      const proposedPayload = validateProposedActionPayload(proposedActionPayload(params));
      if (proposedPayload.error) {
        throw new Error(`Invalid proposed action payload: ${proposedPayload.error}`);
      }
      const actionPayload = proposedPayload.payload;
      assertExecutableProposedAction(params, actionPayload);
      return textResult(
        [
          title,
          summary,
          "",
          `Instruction: ${params.instruction}`,
        ].join("\n"),
        {
          kind: "proposed_action",
          action: params.action,
          targetSessionKind,
          ...(targetRoute ? { targetRoute } : {}),
          sameSession: options.sameSession === true,
          title,
          summary,
          instruction: params.instruction,
          ...(actionPayload ? { actionPayload } : {}),
        },
      );
    },
  };
}

// ---------------------------------------------------------------------------
// 2. SubAgentTool (sub_agent)
// ---------------------------------------------------------------------------

const SubAgentParams = Type.Object({
  agent: Type.Union([
    Type.Literal("architect"),
    Type.Literal("writer"),
    Type.Literal("auditor"),
    Type.Literal("reviser"),
    Type.Literal("exporter"),
  ]),
  instruction: Type.Optional(Type.String({ description: "Natural language instruction for the sub-agent" })),
  bookId: Type.Optional(Type.String({
    description: "Optional book ID. In active-book sessions, omit it to use the current active book; if provided, it must match the current active book. For architect creation, this optionally sets the new book ID.",
  })),
  chapterNumber: Type.Optional(Type.Number({ description: "auditor/reviser: target chapter number. Omit to use the latest chapter." })),
  // -- architect params --
  title: Type.Optional(Type.String({ description: "architect only: explicit book title. Required when creating a book." })),
  genre: Type.Optional(Type.String({ description: "architect only: genre (xuanhuan, urban, mystery, romance, scifi, fantasy, wuxia, general, etc.)" })),
  platform: Type.Optional(Type.Union([
    Type.Literal("tomato"),
    Type.Literal("qidian"),
    Type.Literal("feilu"),
    Type.Literal("other"),
  ], { description: "architect only: target platform. Default: other" })),
  language: Type.Optional(Type.Union([
    Type.Literal("zh"),
    Type.Literal("en"),
  ], { description: "architect only: writing language. Default: zh" })),
  targetChapters: Type.Optional(Type.Number({ description: "architect only: total chapter count. Default: 200" })),
  chapterWordCount: Type.Optional(Type.Number({ description: "architect/writer: per-chapter length in the book's native unit (zh characters / en words). Default: 3000 zh, 2000 en" })),
  revise: Type.Optional(Type.Boolean({
    description: "architect only: true 表示在当前 active book 上重新生成架构稿，而不是新建书籍。no-book creation sessions cannot revise an existing book.",
  })),
  feedback: Type.Optional(Type.String({
    description: "architect only: revise 模式下的调整要求。举例：把架构稿从条目式升级成段落式架构稿、某个角色设定需要重新设计、主线冲突表达太弱需要加强等。如果是架构稿评审未通过要求重写的场景，把评审意见的 overallFeedback 原样传入即可",
  })),
  // -- reviser params --
  mode: Type.Optional(Type.Union([
    Type.Literal("spot-fix"),
    Type.Literal("polish"),
    Type.Literal("rewrite"),
    Type.Literal("rework"),
    Type.Literal("anti-detect"),
  ], { description: "reviser only: revision mode. Default: spot-fix" })),
  // -- exporter params --
  format: Type.Optional(Type.Union([
    Type.Literal("txt"),
    Type.Literal("md"),
    Type.Literal("epub"),
  ], { description: "exporter only: export format. Default: txt" })),
  approvedOnly: Type.Optional(Type.Boolean({ description: "exporter only: export only approved chapters. Default: false" })),
});

type SubAgentParamsType = Static<typeof SubAgentParams>;

const ArchitectCreateSubAgentParams = Type.Object({
  agent: Type.Literal("architect"),
  instruction: Type.Optional(Type.String({ description: "Confirmed self-contained book-creation instruction for the architect." })),
  bookId: Type.Optional(Type.String({
    description: "Optional new book ID. Usually omit it and let InkOS derive the ID from title.",
  })),
  title: Type.Optional(Type.String({ description: "Confirmed book title. Required when creating a book." })),
  genre: Type.Optional(Type.String({ description: "Confirmed book genre." })),
  platform: Type.Optional(Type.Union([
    Type.Literal("tomato"),
    Type.Literal("qidian"),
    Type.Literal("feilu"),
    Type.Literal("other"),
  ], { description: "Confirmed target platform. Default: other" })),
  language: Type.Optional(Type.Union([
    Type.Literal("zh"),
    Type.Literal("en"),
  ], { description: "Confirmed writing language. Default: zh" })),
  targetChapters: Type.Optional(Type.Number({ description: "Confirmed total chapter count. Default: 200" })),
  chapterWordCount: Type.Optional(Type.Number({ description: "Confirmed per-chapter length in the book's native unit. Default: 3000 zh, 2000 en" })),
});

function prepareSubAgentArguments(args: unknown): SubAgentParamsType {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return args as SubAgentParamsType;
  }

  const prepared = { ...(args as Record<string, unknown>) };
  if ("platform" in prepared) {
    const platform = normalizePlatformId(prepared.platform);
    if (platform) {
      prepared.platform = platform;
    } else {
      delete prepared.platform;
    }
  }
  return prepared as SubAgentParamsType;
}

export function createSubAgentTool(
  pipeline: PipelineRunner,
  activeBookId: string | null,
  projectRoot?: string,
  options: { readonly actionPayload?: ActionPayload; readonly architectCreateOnly?: boolean } = {},
): AgentTool<any> {
  return {
    name: "sub_agent",
    description: options.architectCreateOnly
      ? "Create a new long-form InkOS book foundation. This confirmation turn can only call agent='architect'; writing chapters happens after the session is bound to the created book."
      : "Delegate a heavy operation to a specialised sub-agent. " +
        "Use agent='architect' to initialise a new book, 'writer' to write the next chapter, " +
        "'auditor' to audit quality, 'reviser' to revise a chapter, 'exporter' to export.",
    label: "Sub-Agent",
    parameters: options.architectCreateOnly ? ArchitectCreateSubAgentParams : SubAgentParams,
    prepareArguments: prepareSubAgentArguments,
    async execute(
      _toolCallId: string,
      params: SubAgentParamsType,
      _signal?: AbortSignal,
      onUpdate?: AgentToolUpdateCallback,
    ): Promise<AgentToolResult<unknown>> {
      const { agent, bookId, title, chapterNumber, genre, platform, language, targetChapters, chapterWordCount, revise, feedback, mode, format, approvedOnly } = params;
      const instruction = params.instruction ?? "";

      const progress = (msg: string) => {
        onUpdate?.(textResult(msg));
      };

      try {
        if (options.architectCreateOnly && agent !== "architect") {
          throw new Error("This confirmed book-creation turn can only run the architect. Open the created book or use the book session to write chapters.");
        }
        if (!activeBookId && agent !== "architect") {
          return textResult("No active book. Only the architect agent can create a book from this session.");
        }
        if (activeBookId && agent === "architect" && !revise) {
          return textResult("当前已有书籍，不需要建书。如果你想创建新书，请先回到首页。");
        }

        switch (agent) {
          case "architect": {
            const createBookPayload = options.actionPayload?.createBook;
            if (revise) {
              if (!activeBookId) {
                return textResult("Open the book first before revising its foundation.");
              }
              const targetBookId = resolveToolBookId("architect", bookId, activeBookId);
              progress(`Revising foundation for "${targetBookId}"...`);
              await pipeline.reviseFoundation(targetBookId, feedback ?? instruction);
              progress(`Foundation revised for "${targetBookId}".`);
              return textResult(
                `Book "${targetBookId}" 架构稿已按要求重写。原书的条目式架构稿已备份到 story/.backup-phase4-<时间戳>/。`,
              );
            }
            const confirmedTitle = createBookPayload?.title?.trim();
            const resolvedTitle = confirmedTitle || title?.trim();
            if (!resolvedTitle) {
              return textResult('Error: title is required for the architect agent.');
            }
            const id = confirmedTitle
              ? deriveBookIdFromTitle(confirmedTitle) || `book-${Date.now().toString(36)}`
              : bookId
                ? assertSafeBookId(bookId, "architect.bookId")
                : deriveBookIdFromTitle(resolvedTitle) || `book-${Date.now().toString(36)}`;
            const now = new Date().toISOString();
            const resolvedLanguage = createBookPayload?.language ?? language ?? inferLanguage(instruction);
            progress(`Starting architect for book "${id}"...`);
            await pipeline.initBook(
              {
                id,
                title: resolvedTitle,
                genre: createBookPayload?.genre ?? genre ?? "general",
                platform: normalizePlatformOrOther(createBookPayload?.platform ?? platform),
                language: resolvedLanguage as any,
                status: "outlining" as any,
                targetChapters: createBookPayload?.targetChapters ?? targetChapters ?? 200,
                chapterWordCount: createBookPayload?.chapterWordCount ?? chapterWordCount ?? defaultChapterLength(resolvedLanguage),
                createdAt: now,
                updatedAt: now,
              },
              { externalContext: instruction },
            );
            progress(`Architect finished — book "${id}" foundation created.`);
            return textResult(
              `Book "${resolvedTitle}" (${id}) initialised successfully. Foundation files are ready.`,
              { kind: "book_created", bookId: id, title: resolvedTitle },
            );
          }

          case "writer": {
            const targetBookId = resolveToolBookId("writer", bookId, activeBookId);
            progress(`Writing next chapter for "${targetBookId}"...`);
            const result = await pipeline.writeNextChapter(targetBookId, chapterWordCount);
            progress(`Writer finished chapter for "${targetBookId}".`);
            const resultStatus = (result as any).status;
            const wordCount = (result as any).wordCount ?? "unknown";
            const chapterNumberResult = (result as any).chapterNumber;
            const titleResult = (result as any).title;
            const message = resultStatus && resultStatus !== "ready-for-review" && resultStatus !== "active"
              ? `Chapter output for "${targetBookId}" ended with status "${resultStatus}" and needs review before it is treated as complete. Word count: ${wordCount}.`
              : `Chapter written for "${targetBookId}". Word count: ${wordCount}.`;
            return textResult(
              message,
              {
                kind: "chapter_written",
                bookId: targetBookId,
                chapterNumber: chapterNumberResult,
                title: titleResult,
                wordCount,
                status: resultStatus,
              },
            );
          }

          case "auditor": {
            const targetBookId = resolveToolBookId("auditor", bookId, activeBookId);
            progress(`Auditing chapter ${chapterNumber ?? "latest"} for "${targetBookId}"...`);
            const audit = await pipeline.auditDraft(targetBookId, chapterNumber);
            progress(`Audit complete for "${targetBookId}".`);
            const issueLines = (audit.issues ?? [])
              .map((i: any) => `[${i.severity}] ${i.description}`)
              .join("\n");
            return textResult(
              `Audit chapter ${audit.chapterNumber}: ${audit.passed ? "PASSED" : "FAILED"}, ${(audit.issues ?? []).length} issue(s).` +
              (issueLines ? `\n${issueLines}` : ""),
            );
          }

          case "reviser": {
            const targetBookId = resolveToolBookId("reviser", bookId, activeBookId);
            const resolvedMode: ReviseMode = (mode as ReviseMode) ?? "spot-fix";
            progress(`Revising "${targetBookId}" chapter ${chapterNumber ?? "latest"} in ${resolvedMode} mode...`);
            const result = await pipeline.reviseDraft(targetBookId, chapterNumber, resolvedMode);
            const applied = result.applied !== false;
            const resultChapter = result.chapterNumber ?? chapterNumber;
            const details = {
              kind: "chapter_revision",
              bookId: targetBookId,
              chapterNumber: resultChapter,
              mode: resolvedMode,
              applied,
              status: result.status,
              wordCount: result.wordCount,
              fixedIssues: result.fixedIssues,
              skippedReason: result.skippedReason,
            };
            if (!applied) {
              progress(`Revision not applied for "${targetBookId}".`);
              return textResult(
                `Revision not applied for "${targetBookId}" chapter ${resultChapter ?? "latest"}: ${result.skippedReason ?? result.status ?? "pipeline kept the original chapter"}.`,
                details,
              );
            }
            progress(`Revision complete for "${targetBookId}".`);
            return textResult(
              `Revision (${resolvedMode}) complete for "${targetBookId}" chapter ${resultChapter ?? "latest"}.`,
              details,
            );
          }

          case "exporter": {
            const targetBookId = resolveToolBookId("exporter", bookId, activeBookId);
            if (!projectRoot) return textResult("Error: exporter requires projectRoot.");
            const inferredFormat = format ?? (/epub/i.test(instruction)
              ? "epub"
              : /markdown|\bmd\b/i.test(instruction)
                ? "md"
                : "txt");
            const exportApprovedOnly = approvedOnly ?? /approved|已通过|通过章节/.test(instruction);
            const state = new StateManager(projectRoot);
            const result = await writeExportArtifact(state, targetBookId, {
              format: inferredFormat,
              approvedOnly: exportApprovedOnly,
            });
            return textResult(
              `Exported "${targetBookId}": ${result.chaptersExported} chapters, ${result.totalWords} words → ${result.outputPath}`,
            );
          }

          default:
            return textResult(`Unknown agent: ${agent}`);
        }
      } catch (err: any) {
        if (agent === "architect" && err instanceof ArchitectIncompleteFoundationError) {
          const missing = err.missing.join(", ");
          return textResult(
            [
              err.message,
              "",
              `缺失 section: ${missing}`,
              "我会把已生成的部分保留下来，并继续补齐缺失 section；不要重新发明一本书。",
            ].join("\n"),
            {
              kind: "architect_incomplete",
              missing: [...err.missing],
              partialContent: err.partialContent,
              retryInstruction: `Continue repairing the architect foundation. Preserve the partial content and fill missing sections: ${missing}.`,
            },
          );
        }
        console.error(`[sub_agent] "${agent}" failed:`, err);
        throw err;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// 2. Standalone Short Fiction Tool
// ---------------------------------------------------------------------------

const ShortFictionRunParams = Type.Object({
  direction: Type.String({
    description: "Required short fiction direction, e.g. 女频短篇 婚姻背叛 证据反杀. Include genre, protagonist pressure, conflict, and desired payoff when known.",
  }),
  reference: Type.Optional(Type.String({
    description: "Optional user-provided reference notes or constraints. Do not paste copyrighted source text unless the user explicitly provided it.",
  })),
  storyId: Type.Optional(Type.String({
    description: "Optional output id under shorts/. Leave empty to derive from the generated title.",
  })),
  chapters: Type.Optional(Type.Number({
    description: "Target complete short chapter count, 12-18. Default 12.",
  })),
  charsPerChapter: Type.Optional(Type.Number({
    description: "Target Chinese characters per chapter, 900-1200. Default 1000. Do not use total story length here.",
  })),
  cover: Type.Optional(Type.Boolean({
    description: "Whether to attempt cover image generation after synopsis and cover prompt. Default true; use false if the user only wants text assets.",
  })),
  coverBaseUrl: Type.Optional(Type.String({
    description: "Optional OpenAI-compatible Responses API base URL for cover generation.",
  })),
  coverEndpoint: Type.Optional(Type.String({
    description: "Optional exact Responses endpoint for cover generation. Overrides coverBaseUrl.",
  })),
  coverModel: Type.Optional(Type.String({
    description: "Optional image-capable Responses model. Default gpt-image-2.",
  })),
  coverSize: Type.Optional(Type.String({
    description: "Optional image size, default 1024x1536.",
  })),
  coverApiKeyEnv: Type.Optional(Type.String({
    description: "Optional env var containing the cover API key. Default INKOS_COVER_API_KEY.",
  })),
});

type ShortFictionRunParamsType = Static<typeof ShortFictionRunParams>;

export function createShortFictionRunTool(
  pipeline: PipelineRunner,
  projectRoot: string,
  options: { readonly actionPayload?: ActionPayload } = {},
): AgentTool<typeof ShortFictionRunParams> {
  return {
    name: "short_fiction_run",
    description:
      "Create a standalone short fiction project from a direction. " +
      "Runs outline -> outline review/revision -> full draft -> draft review/revision -> synopsis/selling points/cover prompt -> optional cover image. " +
      "Uses the user's direction and optional reference notes as input.",
    label: "Short Fiction",
    parameters: ShortFictionRunParams,
    async execute(
      _toolCallId: string,
      params: ShortFictionRunParamsType,
      _signal?: AbortSignal,
      onUpdate?: AgentToolUpdateCallback,
    ): Promise<AgentToolResult<unknown>> {
      const progress = (message: string) => onUpdate?.(textResult(message));
      const shortPayload = options.actionPayload?.shortRun;
      const result = await runShortFictionProduction({
        projectRoot,
        direction: shortPayload?.direction ?? params.direction,
        runtimes: {
          planner: pipeline.createAgentContext("short-outline"),
          outlineReview: pipeline.createAgentContext("short-outline-review"),
          writer: pipeline.createAgentContext("short-writer"),
          draftReview: pipeline.createAgentContext("short-draft-review"),
          revise: pipeline.createAgentContext("short-revise"),
          package: pipeline.createAgentContext("short-package"),
        },
        ...((shortPayload?.reference ?? params.reference) ? { reference: { text: shortPayload?.reference ?? params.reference! } } : {}),
        storyId: shortPayload?.storyId ?? params.storyId,
        chapterCount: shortPayload?.chapters ?? params.chapters,
        charsPerChapter: shortPayload?.charsPerChapter ?? params.charsPerChapter,
        cover: shortPayload?.cover ?? params.cover,
        coverBaseUrl: params.coverBaseUrl,
        coverEndpoint: params.coverEndpoint,
        coverModel: params.coverModel,
        coverSize: params.coverSize,
        coverApiKeyEnv: params.coverApiKeyEnv,
        onProgress: progress,
      });

      return textResult(
        [
          `Short fiction "${result.storyId}" completed.`,
          `Final: ${result.finalMarkdownPath}`,
          `Sales package: ${result.salesPackagePath}`,
          `Cover prompt: ${result.coverPromptPath}`,
          result.coverImagePath
            ? `Cover image: ${result.coverImagePath}`
            : [
                "Cover image: not generated.",
                `Cover image reason: ${summarizeCoverGenerationError(result.coverError)}`,
                "The short fiction draft, synopsis, selling points, and cover prompt were still written successfully.",
              ].join("\n"),
        ].join("\n"),
        { kind: "short_fiction_created", ...result },
      );
    },
  };
}

function summarizeCoverGenerationError(error: string | undefined): string {
  const text = (error ?? "not generated").trim();
  if (text.includes("HTTP 503")) {
    return "cover provider returned HTTP 503; retry later or switch the Studio cover provider/model.";
  }
  if (text.includes("HTTP 502")) {
    return "cover provider returned HTTP 502; retry later or switch the Studio cover provider/model.";
  }
  if (/API key is required|api key/i.test(text)) {
    return "cover API key is missing; configure it in Studio service settings.";
  }
  return text.slice(0, 300);
}

// ---------------------------------------------------------------------------
// 3. Standalone Cover Tool
// ---------------------------------------------------------------------------

const GenerateCoverParams = Type.Object({
  title: Type.String({
    description: "Required book or short-fiction title. Use the real story title when regenerating an existing cover.",
  }),
  intro: Type.Optional(Type.String({
    description: "Optional synopsis or one-paragraph story hook to guide the cover.",
  })),
  sellingPoints: Type.Optional(Type.String({
    description: "Optional selling points separated by semicolons or new lines, e.g. 婚姻背叛；证据反杀；女主冷笑.",
  })),
  coverPrompt: Type.Optional(Type.String({
    description: "Optional concrete or revised visual direction. Use this when the user changes the cover prompt through chat. Keep it short and commercial; do not paste the whole story.",
  })),
  outputDir: Type.Optional(Type.String({
    description: "Optional project-relative directory for cover-prompt.md and cover.png. For an existing short or cover prompt revision, use its existing final/cover directory to overwrite that cover.",
  })),
  coverBaseUrl: Type.Optional(Type.String({
    description: "Optional image API base URL. Usually omit and use Studio cover config.",
  })),
  coverEndpoint: Type.Optional(Type.String({
    description: "Optional exact image endpoint. Overrides coverBaseUrl.",
  })),
  coverModel: Type.Optional(Type.String({
    description: "Optional image model. Usually omit and use Studio cover config.",
  })),
  coverSize: Type.Optional(Type.String({
    description: "Optional image size, default 1024x1536.",
  })),
  coverApiKeyEnv: Type.Optional(Type.String({
    description: "Optional env var containing the cover API key. Usually omit and use Studio cover config.",
  })),
});

type GenerateCoverParamsType = Static<typeof GenerateCoverParams>;

export function createGenerateCoverTool(
  projectRoot: string,
  options: { readonly actionPayload?: ActionPayload } = {},
): AgentTool<typeof GenerateCoverParams> {
  return {
    name: "generate_cover",
    description:
      "Generate only a cover image and cover prompt from a title/synopsis/visual direction. " +
      "Use this when the user asks to create/regenerate a cover or revise the cover prompt through chat, without rerunning story generation.",
    label: "Generate Cover",
    parameters: GenerateCoverParams,
    async execute(
      _toolCallId: string,
      params: GenerateCoverParamsType,
      _signal?: AbortSignal,
      onUpdate?: AgentToolUpdateCallback,
    ): Promise<AgentToolResult<unknown>> {
      onUpdate?.(textResult("Generating cover image..."));
      const coverPayload = options.actionPayload?.generateCover;
      const result = await generateShortFictionCover({
        projectRoot,
        title: coverPayload?.title ?? params.title,
        intro: coverPayload?.intro ?? params.intro,
        sellingPoints: coverPayload?.sellingPoints ?? params.sellingPoints,
        coverPrompt: coverPayload?.coverPrompt ?? params.coverPrompt,
        outputDir: coverPayload?.outputDir ?? params.outputDir,
        coverBaseUrl: params.coverBaseUrl,
        coverEndpoint: params.coverEndpoint,
        coverModel: params.coverModel,
        coverSize: params.coverSize,
        coverApiKeyEnv: params.coverApiKeyEnv,
      });
      return textResult(
        [
          `Cover generated for "${result.title}".`,
          `Cover prompt: ${result.coverPromptPath}`,
          `Cover image: ${result.coverImagePath}`,
        ].join("\n"),
        { kind: "cover_generated", ...result },
      );
    },
  };
}

// ---------------------------------------------------------------------------
// 4. Interactive Play tools
// ---------------------------------------------------------------------------

const PlayStartParams = Type.Object({
  title: Type.String({
    description: "Interactive world title. Use the user's natural direction as a short playable world title.",
  }),
  premise: Type.Optional(Type.String({
    description: "Playable premise: player role, location, pressure, and core conflict. Keep it concise.",
  })),
  worldContract: Type.Optional(Type.String({
    description: "Durable world contract in natural language. Preserve only user-defined long-lived rules: semantic time, role autonomy, object/clue/relationship systems, taboos, or setting laws. Leave empty when the user did not define rules; do not invent RPG/level systems.",
  })),
  visualContract: Type.Optional(Type.String({
    description: "Visual contract for Play illustrations. Preserve only user-defined visual rules; leave empty when unspecified. Do not invent game frames, colored tiers, UI, or stats.",
  })),
  mode: Type.Optional(Type.Union([
    Type.Literal("open"),
    Type.Literal("guided"),
  ], { description: "open = free actions; guided = emphasize suggested actions. Default open." })),
  initialScene: Type.Optional(Type.String({
    description: "Opening scene shown to the player. Write pure narrative prose for the first playable moment, not a config summary, not a question prompt, and not an action/options list.",
  })),
  suggestedActions: Type.Optional(Type.Array(SuggestedActionParam)),
});

type PlayStartParamsType = Static<typeof PlayStartParams>;

export interface PlayStartToolOptions {
  readonly actionPayload?: ActionPayload;
  readonly runnerFactory?: (input: {
    readonly projectRoot: string;
    readonly worldId: string;
    readonly runId: string;
    readonly ctx: AgentContext;
  }) => { seedOpening(input: { sceneText: string; suggestedActions?: readonly string[] }): Promise<PlayOpeningSeedResult | null>; close?: () => void };
}

export function createPlayStartTool(
  pipeline: PipelineRunner | null,
  projectRoot: string,
  sessionId: string,
  playMode?: "open" | "guided",
  options: PlayStartToolOptions = {},
): AgentTool<typeof PlayStartParams> {
  return {
    name: "play_start",
    description:
      "Start an interactive InkOS Play world directly from chat. " +
      "Use when the user asks to play, roleplay, run an open-world interactive story, or start a Tavern-like scene.",
    label: "Start Play",
    parameters: PlayStartParams,
    async execute(
      _toolCallId: string,
      params: PlayStartParamsType,
      _signal?: AbortSignal,
      onUpdate?: AgentToolUpdateCallback,
    ): Promise<AgentToolResult<unknown>> {
      onUpdate?.(textResult("Starting interactive world..."));
      const playPayload = options.actionPayload?.playStart;
      const store = new PlayStore(projectRoot);
      // The play world is bound 1:1 to the chat session: worldId IS the
      // sessionId. This removes any "which world?" ambiguity, so two play
      // sessions never advance each other's world.
      const worldId = safePlayId(sessionId, sessionId);
      const runId = "main";
      const title = playPayload?.title ?? params.title;
      const premise = playPayload?.premise ?? params.premise;
      const worldContract = playPayload?.worldContract ?? params.worldContract;
      const visualContract = playPayload?.visualContract ?? params.visualContract;
      const initialScene = isUsablePlayInitialScene(playPayload?.initialScene)
        ? playPayload?.initialScene
        : params.initialScene;
      const playLanguage = inferLanguage([title, premise, worldContract, visualContract, initialScene].filter(Boolean).join("\n"));
      const world = await store.createWorld({
        id: worldId,
        title: title.trim(),
        premise: premise?.trim() ?? "",
        worldContract: worldContract?.trim() ?? "",
        visualContract: visualContract?.trim() ?? "",
        mode: playMode ?? params.mode ?? "open",
        language: playLanguage,
      });
      await store.ensureRun(world.id, runId);

      const existingTranscript = await store.readTranscript(world.id, runId);
      const sceneText = (initialScene?.trim() || (world.language === "en"
        ? [`You enter "${world.title}".`, world.premise || "The scene is set. Make your first move."].join("\n")
        : [`你进入「${world.title}」。`, world.premise || "场景已经就位，等待你的第一个动作。"].join("\n"))).trim();
      if (existingTranscript.length === 0) {
        await store.writeProjection(world.id, runId, "projections/scene.md", `${sceneText}\n`);
        await store.saveCurrentState(world.id, runId, {
          turn: 0,
          worldId: world.id,
          runId,
          mode: world.mode,
          premise: world.premise,
          worldContract: world.worldContract,
          visualContract: world.visualContract,
        });
        await store.appendTranscriptTurn(world.id, runId, {
          role: "assistant",
          content: sceneText,
          timestamp: Date.now(),
        });
      }

      const suggestedActions = normalizeSuggestedActions(playPayload?.suggestedActions ?? params.suggestedActions);
      let seed: PlayOpeningSeedResult | null = null;
      let graph;
      if (existingTranscript.length === 0 && pipeline) {
        const db = createPlayDB(store.runDir(world.id, runId));
        let runner: ReturnType<NonNullable<PlayStartToolOptions["runnerFactory"]>> | PlayRunner | undefined;
        try {
          const ctx = pipeline.createAgentContext("play");
          runner = options.runnerFactory?.({
            projectRoot,
            worldId: world.id,
            runId,
            ctx,
          }) ?? new PlayRunner({
            projectRoot,
            worldId: world.id,
            runId,
            ctx,
            db,
          });
          seed = await runner.seedOpening({ sceneText, suggestedActions });
          graph = db.snapshot();
        } catch {
          // Opening graph seed is a HUD enhancement, not a launch precondition.
          // Starting the world must stay fail-open when a model drifts.
        } finally {
          if (runner) closePlayRunner(runner);
          closePlayDB(db);
        }
      }

      return textResult(
        sceneText,
        {
          kind: "play_world_started",
          worldId: world.id,
          runId,
          title: world.title,
          mode: world.mode,
          premise: world.premise,
          worldContract: world.worldContract,
          visualContract: world.visualContract,
          sceneText,
          suggestedActions,
          ...(seed ? { seedMutation: seed.mutation } : {}),
          ...(graph ? { graph } : {}),
        },
      );
    },
  };
}

const PlayStepParams = Type.Object({
  input: Type.String({
    description: "The player's next free-form action or chosen option.",
  }),
});

type PlayStepParamsType = Static<typeof PlayStepParams>;

export interface PlayStepToolOptions {
  readonly playMode?: "open" | "guided";
  readonly runnerFactory?: (input: {
    readonly projectRoot: string;
    readonly worldId: string;
    readonly runId: string;
    readonly ctx: AgentContext;
  }) => {
    step(input: string, options?: { readonly mode?: "open" | "guided" }): Promise<PlayStepResult>;
    close?: () => void;
  };
}

const PlayReviseParams = Type.Object({
  action: Type.Union([
    Type.Literal("regenerate_last"),
    Type.Literal("edit_last_input"),
    Type.Literal("restore_variant"),
  ], {
    description: "How to revise the latest play turn: regenerate the same player input, edit the previous player input, or restore a saved variant.",
  }),
  input: Type.Optional(Type.String({
    description: "Replacement player input when action=edit_last_input.",
  })),
  turn: Type.Optional(Type.Number({
    description: "Turn number when restoring a saved variant.",
  })),
  variantId: Type.Optional(Type.String({
    description: "Saved variant id when action=restore_variant.",
  })),
});

type PlayReviseParamsType = Static<typeof PlayReviseParams>;

export interface PlayReviseToolOptions {
  readonly runnerFactory?: (input: {
    readonly projectRoot: string;
    readonly worldId: string;
    readonly runId: string;
    readonly ctx: AgentContext;
  }) => {
    regenerateLastTurn(input?: string): Promise<PlayReplayResult>;
    restoreVariant(input: { readonly turn: number; readonly variantId: string }): Promise<PlayVariantRestoreResult>;
    close?: () => void;
  };
}

const PlayEntityUpdateParam = Type.Object({
  id: Type.Optional(Type.String({
    description: "Existing entity id to update. Use actor_player for the player persona.",
  })),
  label: Type.Optional(Type.String({
    description: "Existing entity label to update when id is unknown.",
  })),
  type: Type.Optional(Type.Union([
    Type.Literal("actor"),
    Type.Literal("location"),
    Type.Literal("item"),
    Type.Literal("evidence"),
    Type.Literal("clue"),
    Type.Literal("claim"),
    Type.Literal("proof_chain"),
    Type.Literal("organization"),
    Type.Literal("rule"),
    Type.Literal("scene"),
    Type.Literal("event"),
  ], { description: "Entity type when creating a missing entity. Usually actor for character/persona edits." })),
  summary: Type.Optional(Type.String({
    description: "Replacement or enriched entity summary, including goals/motives/persona when relevant.",
  })),
  status: Type.Optional(Type.String({
    description: "Natural-language current status. Do not invent numeric meters unless the user asked for them.",
  })),
});

type PlayEntityUpdateParamType = Static<typeof PlayEntityUpdateParam>;

const PlayContractReplacementParam = Type.Object({
  from: Type.String({
    description: "Exact old wording to replace in the existing contract.",
  }),
  to: Type.String({
    description: "New wording that should replace the old wording.",
  }),
});

type PlayContractReplacementParamType = Static<typeof PlayContractReplacementParam>;

const PlayEditParams = Type.Object({
  worldContract: Type.Optional(Type.String({
    description: "Full updated world contract after applying the user's requested rule change. Use when the user edits world rules, time semantics, item semantics, role autonomy, taboos, or costs.",
  })),
  worldContractReplacements: Type.Optional(Type.Array(PlayContractReplacementParam, {
    description: "Exact replacements for existing world-contract wording. Use when the user says to change/replace X into Y; do not append the new rule while leaving the old wording in place.",
  })),
  worldContractAppend: Type.Optional(Type.String({
    description: "A narrow new world-contract addition. Do not use this for replacements such as 'change X to Y'; use worldContractReplacements or full worldContract instead.",
  })),
  visualContract: Type.Optional(Type.String({
    description: "Full updated visual contract after applying the user's requested image/visual-rule change.",
  })),
  visualContractReplacements: Type.Optional(Type.Array(PlayContractReplacementParam, {
    description: "Exact replacements for existing visual-contract wording. Use when the user says to change/replace one visual rule into another.",
  })),
  visualContractAppend: Type.Optional(Type.String({
    description: "A narrow new visual-contract addition. Do not use this for replacements such as 'change X to Y'; use visualContractReplacements or full visualContract instead.",
  })),
  premise: Type.Optional(Type.String({
    description: "Updated world premise only when the user explicitly changes premise/backstory. Do not rewrite premise for ordinary turns.",
  })),
  playerPersona: Type.Optional(Type.String({
    description: "Updated player persona/identity/goals. This updates the reserved actor_player entity.",
  })),
  entityUpdates: Type.Optional(Type.Array(PlayEntityUpdateParam, {
    description: "Character, object, place, or rule-card updates requested by the user. Use for role goals, status, motives, taboos, or known facts.",
  })),
  note: Type.Optional(Type.String({
    description: "Short human-readable note summarizing what changed.",
  })),
});

type PlayEditParamsType = Static<typeof PlayEditParams>;

export function createPlayEditTool(
  projectRoot: string,
  sessionId: string,
): AgentTool<typeof PlayEditParams> {
  return {
    name: "play_edit",
    description:
      "Persistently edit the active InkOS Play world card, visual contract, player persona, or entity/role cards without advancing time or narrating a turn. " +
      "Use when the user says to change world rules, visual rules, character goals/persona/status, or long-lived play contracts.",
    label: "Edit Play World",
    parameters: PlayEditParams,
    async execute(
      _toolCallId: string,
      params: PlayEditParamsType,
    ): Promise<AgentToolResult<unknown>> {
      const store = new PlayStore(projectRoot);
      const worldId = safePlayId(sessionId, sessionId);
      const runId = "main";
      const world = await store.loadWorld(worldId);
      if (!world) {
        return textResult("还没有可编辑的互动世界。先用 play_start 开一局。");
      }

      const patch: Parameters<PlayStore["updateWorld"]>[1] = {};
      const nextWorldContract = mergeContract(
        world.worldContract,
        params.worldContract,
        params.worldContractReplacements,
        params.worldContractAppend,
      );
      const nextVisualContract = mergeContract(
        world.visualContract,
        params.visualContract,
        params.visualContractReplacements,
        params.visualContractAppend,
      );
      if (nextWorldContract !== world.worldContract) patch.worldContract = nextWorldContract;
      if (nextVisualContract !== world.visualContract) patch.visualContract = nextVisualContract;
      const premise = params.premise?.trim();
      if (premise && premise !== world.premise) patch.premise = premise;
      const updatedWorld = Object.keys(patch).length > 0
        ? await store.updateWorld(worldId, patch)
        : world;

      await store.ensureRun(worldId, runId);
      const db = createPlayDB(store.runDir(worldId, runId));
      let updatedEntities = 0;
      try {
        const playerPersona = params.playerPersona?.trim();
        if (playerPersona) {
          const existingPlayer = db.getEntity("actor_player");
          upsertPlayEditEntity(db, {
            id: "actor_player",
            type: "actor",
            label: existingPlayer?.label ?? "玩家",
            summary: playerPersona,
            status: "已更新",
          });
          updatedEntities += 1;
        }
        for (const update of params.entityUpdates ?? []) {
          if (upsertPlayEditEntity(db, update)) updatedEntities += 1;
        }
        const graph = db.snapshot();
        const currentState = await store.loadCurrentState(worldId, runId).catch(() => ({}));
        await store.saveCurrentState(worldId, runId, {
          ...(currentState && typeof currentState === "object" ? currentState as Record<string, unknown> : {}),
          worldContract: updatedWorld.worldContract,
          visualContract: updatedWorld.visualContract,
          premise: updatedWorld.premise,
          graphEditedAt: new Date().toISOString(),
        });
        return textResult(
          params.note?.trim() || "互动世界设定已更新。",
          {
            kind: "play_world_updated",
            worldId,
            runId,
            world: updatedWorld,
            updatedWorldContract: nextWorldContract !== world.worldContract,
            updatedVisualContract: nextVisualContract !== world.visualContract,
            updatedPremise: Boolean(patch.premise),
            updatedEntities,
            graph,
          },
        );
      } finally {
        closePlayDB(db);
      }
    },
  };
}

export function createPlayStepTool(
  pipeline: PipelineRunner,
  projectRoot: string,
  sessionId: string,
  options: PlayStepToolOptions = {},
): AgentTool<typeof PlayStepParams> {
  return {
    name: "play_step",
    description:
      "Advance the current InkOS Play world by one player action. " +
      "Use after play_start when the user keeps acting in the interactive scene.",
    label: "Play Step",
    parameters: PlayStepParams,
    async execute(
      _toolCallId: string,
      params: PlayStepParamsType,
      _signal?: AbortSignal,
      onUpdate?: AgentToolUpdateCallback,
    ): Promise<AgentToolResult<unknown>> {
      const input = params.input.trim();
      if (!input) return textResult("Play input is empty.");
      const store = new PlayStore(projectRoot);
      // The play world is bound to this chat session (worldId === sessionId).
      const worldId = safePlayId(sessionId, sessionId);
      const runId = "main";
      let world = await store.loadWorld(worldId);
      if (!world) {
        return textResult("还没有可推进的互动世界。先用 play_start 开一局。");
      }
      if (options.playMode && world.mode !== options.playMode) {
        world = await store.updateWorld(worldId, { mode: options.playMode });
      }
      const target = { worldId, runId, world };
      onUpdate?.(textResult(`Advancing "${target.worldId}" / "${target.runId}"...`));
      const ctx = pipeline.createAgentContext("play");
      const runner = options.runnerFactory?.({
        projectRoot,
        worldId: target.worldId,
        runId: target.runId,
        ctx,
      }) ?? new PlayRunner({
        projectRoot,
        worldId: target.worldId,
        runId: target.runId,
        ctx,
      });
      let step: Awaited<ReturnType<typeof runner.step>>;
      try {
        step = await runner.step(input, { mode: options.playMode ?? world.mode });
      } catch (err) {
        // Never hand a raw tool error to the outer agent — it improvises a fake
        // "service unavailable / reload your save" message. Return a fixed, graceful
        // structured failure so the turn fails honestly and recoverably instead.
        const isZh = (target.world?.language ?? "zh") !== "en";
        return textResult(
          isZh
            ? "（系统刚才卡了一下，这一步没能展开。把你刚才想做的再说一遍，我就接着推进。）"
            : "(The system hiccuped and this step didn't resolve. Say what you just did again and I'll continue.)",
          {
            kind: "play_step_failed",
            worldId: target.worldId,
            runId: target.runId,
            error: err instanceof Error ? err.message : String(err),
          },
        );
      } finally {
        closePlayRunner(runner);
      }

      const db = createPlayDB(store.runDir(target.worldId, target.runId));
      let graph;
      try {
        graph = db.snapshot();
      } finally {
        closePlayDB(db);
      }
      const currentState = await store.loadCurrentState(target.worldId, target.runId).catch(() => null);

      return textResult(
        step.sceneText,
        {
          kind: "play_turn_advanced",
          worldId: target.worldId,
          runId: target.runId,
          title: target.world?.title,
          mode: options.playMode ?? target.world?.mode,
          sceneText: step.sceneText,
          suggestedActions: step.suggestedActions,
          action: step.action,
          mutation: step.mutation,
          currentState,
          graph,
        },
      );
    },
  };
}

export function createPlayReviseTool(
  pipeline: PipelineRunner,
  projectRoot: string,
  sessionId: string,
  options: PlayReviseToolOptions = {},
): AgentTool<typeof PlayReviseParams> {
  return {
    name: "play_revise",
    description:
      "Regenerate, edit, or restore the latest InkOS Play turn using saved turn checkpoints. " +
      "Use when the user says to redo the previous turn, try another version, swipe, or replace their last player input.",
    label: "Revise Play Turn",
    parameters: PlayReviseParams,
    async execute(
      _toolCallId: string,
      params: PlayReviseParamsType,
      _signal?: AbortSignal,
      onUpdate?: AgentToolUpdateCallback,
    ): Promise<AgentToolResult<unknown>> {
      const store = new PlayStore(projectRoot);
      const worldId = safePlayId(sessionId, sessionId);
      const runId = "main";
      const world = await store.loadWorld(worldId);
      if (!world) {
        return textResult("还没有可重做的互动世界。先用 play_start 开一局。");
      }
      const ctx = pipeline.createAgentContext("play");
      const runner = options.runnerFactory?.({ projectRoot, worldId, runId, ctx }) ?? new PlayRunner({
        projectRoot,
        worldId,
        runId,
        ctx,
      });
      try {
        if (params.action === "restore_variant") {
          const turn = params.turn;
          const variantId = params.variantId?.trim();
          if (typeof turn !== "number" || !Number.isFinite(turn) || !variantId) {
            return textResult("恢复版本需要 turn 和 variantId。");
          }
          onUpdate?.(textResult(`Restoring play variant "${variantId}"...`));
          const restored = await runner.restoreVariant({
            turn: Math.trunc(turn),
            variantId,
          });
          return textResult(
            restored.sceneText || "已切换到指定互动回合版本。",
            {
              kind: "play_variant_restored",
              worldId,
              runId,
              title: world.title,
              turn: restored.turn,
              variantId: restored.variantId,
              sceneText: restored.sceneText,
            },
          );
        }

        const replacement = params.action === "edit_last_input" ? params.input?.trim() : undefined;
        if (params.action === "edit_last_input" && !replacement) {
          return textResult("编辑上一条玩家动作需要提供新的 input。");
        }
        onUpdate?.(textResult(params.action === "edit_last_input" ? "Replaying edited play turn..." : "Regenerating last play turn..."));
        let replay: PlayReplayResult;
        try {
          replay = await runner.regenerateLastTurn(replacement);
        } catch (err) {
          const isZh = (world.language ?? "zh") !== "en";
          return textResult(
            isZh
              ? "（上一回合暂时不能安全重做。继续输入新的动作，我会从当前状态推进。）"
              : "(The previous turn cannot be safely regenerated yet. Enter a new action and I will continue from the current state.)",
            {
              kind: "play_revise_failed",
              worldId,
              runId,
              error: err instanceof Error ? err.message : String(err),
            },
          );
        }

        const db = createPlayDB(store.runDir(worldId, runId));
        let graph;
        try {
          graph = db.snapshot();
        } finally {
          closePlayDB(db);
        }
        const currentState = await store.loadCurrentState(worldId, runId).catch(() => null);

        return textResult(
          replay.sceneText,
          {
            kind: "play_turn_revised",
            worldId,
            runId,
            title: world.title,
            sceneText: replay.sceneText,
            suggestedActions: replay.suggestedActions,
            action: replay.action,
            mutation: replay.mutation,
            replayedInput: replay.replayedInput,
            previousVariantId: replay.previousVariantId,
            variantId: replay.variantId,
            currentState,
            graph,
          },
        );
      } finally {
        closePlayRunner(runner);
      }
    },
  };
}

function mergeContract(
  existing: string,
  replacement: string | undefined,
  replacements: PlayContractReplacementParamType[] | undefined,
  addition: string | undefined,
): string {
  const next = replacement?.trim();
  if (next) return next;
  let current = existing;
  for (const patch of replacements ?? []) {
    const from = patch.from.trim();
    const to = patch.to.trim();
    if (!from || !to || !current.includes(from)) continue;
    current = current.split(from).join(to);
  }
  const add = addition?.trim();
  if (!add) return current;
  if (current.includes(add)) return current;
  return current.trim() ? `${current.trim()}\n- ${add}` : add;
}

function upsertPlayEditEntity(db: PlayGraphDB, update: PlayEntityUpdateParamType): boolean {
  const summary = update.summary?.trim();
  const status = update.status?.trim();
  const label = update.label?.trim();
  const entityId = resolvePlayEditEntityId(db, update);
  if (!entityId && !label) return false;
  const existing = entityId ? db.getEntity(entityId) : null;
  const id = entityId || playEditEntityId(update.type ?? "actor", label!);
  db.upsertEntity({
    id,
    type: update.type ?? existing?.type ?? "actor",
    label: label || existing?.label || id,
    summary: summary ?? existing?.summary ?? "",
    status: status ?? existing?.status ?? "",
    createdEventId: existing?.createdEventId ?? "manual-edit",
    updatedEventId: "manual-edit",
  });
  return true;
}

function resolvePlayEditEntityId(db: PlayGraphDB, update: PlayEntityUpdateParamType): string | undefined {
  const id = update.id?.trim();
  if (id) return id;
  const label = update.label?.trim();
  if (!label) return undefined;
  const snapshot = db.snapshot();
  const match = snapshot.entities.find((entity) => entity.label === label || entity.id === label);
  return match?.id;
}

function playEditEntityId(type: string, label: string): string {
  const ascii = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/gu, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
  return `${type}_${ascii || Date.now().toString(36)}`;
}

// ---------------------------------------------------------------------------
// 5. Deterministic writing tools
// ---------------------------------------------------------------------------

const WriteTruthFileParams = Type.Object({
  bookId: Type.Optional(Type.String({ description: "Book ID. Omit to use the active book." })),
  fileName: Type.String({ description: "Truth file path under story/. Prefer outline/story_frame.md, outline/volume_map.md, roles/major/<name>.md, roles/minor/<name>.md; flat files such as current_focus.md and author_intent.md are also supported." }),
  content: Type.String({ description: "Full replacement content for the truth file." }),
});

export function createWriteTruthFileTool(
  pipeline: PipelineRunner,
  projectRoot: string,
  activeBookId: string | null,
): AgentTool<typeof WriteTruthFileParams> {
  const tools = createDeterministicInteractionTools(pipeline, projectRoot);
  return {
    name: "write_truth_file",
    description: "Replace a truth/control file under story/ using deterministic project tools.",
    label: "Write Truth File",
    parameters: WriteTruthFileParams,
    async execute(_toolCallId, params): Promise<AgentToolResult<undefined>> {
      try {
        const bookId = resolveToolBookId("write_truth_file", params.bookId, activeBookId);
        const fileName = assertSafeTruthFileName(params.fileName);
        await tools.writeTruthFile(bookId, fileName, params.content);
        return textResult(`Updated "${fileName}" for "${bookId}".`);
      } catch (err: any) {
        return textResult(`write_truth_file failed: ${err?.message ?? String(err)}`);
      }
    },
  };
}

const RenameEntityParams = Type.Object({
  bookId: Type.Optional(Type.String({ description: "Book ID. Omit to use the active book." })),
  oldValue: Type.String({ description: "Current entity name." }),
  newValue: Type.String({ description: "New entity name." }),
});

export function createRenameEntityTool(
  pipeline: PipelineRunner,
  projectRoot: string,
  activeBookId: string | null,
): AgentTool<typeof RenameEntityParams> {
  const tools = createDeterministicInteractionTools(pipeline, projectRoot);
  return {
    name: "rename_entity",
    description: "Rename an entity across truth files and chapters using deterministic edit control.",
    label: "Rename Entity",
    parameters: RenameEntityParams,
    async execute(_toolCallId, params): Promise<AgentToolResult<undefined>> {
      const bookId = resolveToolBookId("rename_entity", params.bookId, activeBookId);
      const result = await tools.renameEntity(bookId, params.oldValue, params.newValue) as {
        readonly __interaction?: { readonly responseText?: string };
      };
      const summary = result.__interaction?.responseText ?? `Renamed "${params.oldValue}" to "${params.newValue}" in "${bookId}".`;
      return textResult(summary);
    },
  };
}

const PatchChapterTextParams = Type.Object({
  bookId: Type.Optional(Type.String({ description: "Book ID. Omit to use the active book." })),
  chapterNumber: Type.Number({ description: "Chapter number to patch." }),
  targetText: Type.String({ description: "Exact text to replace." }),
  replacementText: Type.String({ description: "Replacement text." }),
});

export function createPatchChapterTextTool(
  pipeline: PipelineRunner,
  projectRoot: string,
  activeBookId: string | null,
): AgentTool<typeof PatchChapterTextParams> {
  const tools = createDeterministicInteractionTools(pipeline, projectRoot);
  return {
    name: "patch_chapter_text",
    description: "Apply a deterministic local text patch to a chapter and mark it for review.",
    label: "Patch Chapter",
    parameters: PatchChapterTextParams,
    async execute(_toolCallId, params): Promise<AgentToolResult<undefined>> {
      const bookId = resolveToolBookId("patch_chapter_text", params.bookId, activeBookId);
      const result = await tools.patchChapterText(
        bookId,
        params.chapterNumber,
        params.targetText,
        params.replacementText,
      ) as {
        readonly __interaction?: { readonly responseText?: string };
      };
      const summary = result.__interaction?.responseText ?? `Patched chapter ${params.chapterNumber} for "${bookId}".`;
      return textResult(summary);
    },
  };
}

const ReplaceChapterTextParams = Type.Object({
  bookId: Type.Optional(Type.String({ description: "Book ID. Omit to use the active book." })),
  chapterNumber: Type.Number({ description: "Chapter number to replace." }),
  fullText: Type.String({ description: "The complete replacement chapter markdown/text supplied by the user." }),
});

export function createReplaceChapterTextTool(
  pipeline: PipelineRunner,
  projectRoot: string,
  activeBookId: string | null,
): AgentTool<typeof ReplaceChapterTextParams> {
  const tools = createDeterministicInteractionTools(pipeline, projectRoot);
  return {
    name: "replace_chapter_text",
    description:
      "Replace a whole existing chapter with user-supplied full chapter text and mark it for review. " +
      "Use only when the user provides the complete replacement chapter; for model-generated rewrites use sub_agent reviser.",
    label: "Replace Chapter",
    parameters: ReplaceChapterTextParams,
    async execute(_toolCallId, params): Promise<AgentToolResult<undefined>> {
      const bookId = resolveToolBookId("replace_chapter_text", params.bookId, activeBookId);
      const result = await tools.replaceChapterText(
        bookId,
        params.chapterNumber,
        params.fullText,
      ) as {
        readonly __interaction?: { readonly responseText?: string };
      };
      const summary = result.__interaction?.responseText ?? `Replaced chapter ${params.chapterNumber} for "${bookId}".`;
      return textResult(summary);
    },
  };
}

// ---------------------------------------------------------------------------
// 3. Read Tool
// ---------------------------------------------------------------------------

const ReadParams = Type.Object({
  path: Type.String({ description: "File path relative to books/, or an absolute path when system path reading is enabled." }),
});

export interface ReadToolOptions {
  readonly allowSystemPaths?: boolean;
}

function resolveReadPath(booksRoot: string, requestedPath: string, options: ReadToolOptions): string {
  if (options.allowSystemPaths && isAbsolute(requestedPath)) {
    return resolve(requestedPath);
  }
  return safeBooksPath(booksRoot, requestedPath);
}

export function createReadTool(
  projectRoot: string,
  options: ReadToolOptions = {},
): AgentTool<typeof ReadParams> {
  const booksRoot = join(projectRoot, "books");
  const description = options.allowSystemPaths
    ? "Read a file. Relative paths resolve under books/; absolute paths read from the system filesystem."
    : "Read a file from the book directory. Path is relative to books/.";

  return {
    name: "read",
    description,
    label: "Read File",
    parameters: ReadParams,
    async execute(
      _toolCallId: string,
      params: Static<typeof ReadParams>,
    ): Promise<AgentToolResult<undefined>> {
      try {
        const filePath = resolveReadPath(booksRoot, params.path, options);
        const content = await readFile(filePath, "utf-8");
        return textResult(content);
      } catch (err: any) {
        return textResult(`Failed to read "${params.path}": ${err?.message ?? String(err)}`);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// 3. Edit Tool
// ---------------------------------------------------------------------------

const EditParams = Type.Object({
  path: Type.String({ description: "File path relative to books/" }),
  old_string: Type.String({ description: "Exact string to find in the file" }),
  new_string: Type.String({ description: "Replacement string" }),
});

export function createEditTool(projectRoot: string): AgentTool<typeof EditParams> {
  const booksRoot = join(projectRoot, "books");

  return {
    name: "edit",
    description:
      "Edit a file under books/ via exact string replacement. " +
      "old_string must appear exactly once in the file. " +
      "For chapter text use patch_chapter_text; for canonical truth files (outline/story_frame.md, outline/volume_map.md, roles/**/*.md, current_focus.md, author_intent.md) prefer write_truth_file; " +
      "to rewrite or polish a whole chapter call sub_agent with agent=\"reviser\".",
    label: "Edit File",
    parameters: EditParams,
    async execute(
      _toolCallId: string,
      params: Static<typeof EditParams>,
    ): Promise<AgentToolResult<undefined>> {
      try {
        const filePath = safeBooksPath(booksRoot, params.path);
        const content = await readFile(filePath, "utf-8");
        const idx = content.indexOf(params.old_string);
        if (idx === -1) {
          return textResult(`old_string not found in "${params.path}".`);
        }
        if (content.indexOf(params.old_string, idx + 1) !== -1) {
          return textResult(`old_string appears more than once in "${params.path}". Provide a more specific match.`);
        }
        const updated = content.slice(0, idx) + params.new_string + content.slice(idx + params.old_string.length);
        await writeFile(filePath, updated, "utf-8");
        return textResult(`File "${params.path}" updated successfully.`);
      } catch (err: any) {
        return textResult(`Failed to edit "${params.path}": ${err?.message ?? String(err)}`);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// 4. Write Tool
// ---------------------------------------------------------------------------

const WriteFileParams = Type.Object({
  path: Type.String({ description: "File path relative to books/" }),
  content: Type.String({ description: "Full file content to write" }),
});

export function createWriteFileTool(projectRoot: string): AgentTool<typeof WriteFileParams> {
  const booksRoot = join(projectRoot, "books");

  return {
    name: "write",
    description:
      "Create a new file, or fully replace an existing file's content under books/. " +
      "Parent directories are created automatically. Existing content is overwritten silently — " +
      "for canonical truth files prefer write_truth_file; " +
      "for whole-chapter rewrites/polishing call sub_agent with agent=\"reviser\".",
    label: "Write File",
    parameters: WriteFileParams,
    async execute(
      _toolCallId: string,
      params: Static<typeof WriteFileParams>,
    ): Promise<AgentToolResult<undefined>> {
      try {
        const filePath = safeBooksPath(booksRoot, params.path);
        const parentDir = resolve(filePath, "..");
        const { mkdir } = await import("node:fs/promises");
        await mkdir(parentDir, { recursive: true });
        await writeFile(filePath, params.content, "utf-8");
        return textResult(`File "${params.path}" written successfully.`);
      } catch (err: any) {
        return textResult(`Failed to write "${params.path}": ${err?.message ?? String(err)}`);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// 5. Grep Tool
// ---------------------------------------------------------------------------

const GrepParams = Type.Object({
  bookId: Type.String({ description: "Book ID to search within" }),
  pattern: Type.String({ description: "Search pattern (plain text or regex)" }),
});

export function createGrepTool(projectRoot: string): AgentTool<typeof GrepParams> {
  const booksRoot = join(projectRoot, "books");

  return {
    name: "grep",
    description:
      "Search for a text pattern across a book's story/ and chapters/ directories. Returns matching lines.",
    label: "Search",
    parameters: GrepParams,
    async execute(
      _toolCallId: string,
      params: Static<typeof GrepParams>,
    ): Promise<AgentToolResult<undefined>> {
      try {
        const bookDir = safeBooksPath(booksRoot, params.bookId);
        const regex = new RegExp(params.pattern, "gi");
        const results: string[] = [];

        async function searchDir(dir: string, prefix: string) {
          let entries: string[];
          try {
            entries = await readdir(dir);
          } catch {
            return; // directory doesn't exist
          }
          for (const entry of entries) {
            const fullPath = join(dir, entry);
            const entryStat = await stat(fullPath);
            if (entryStat.isDirectory()) {
              await searchDir(fullPath, `${prefix}${entry}/`);
            } else if (entry.endsWith(".md") || entry.endsWith(".txt") || entry.endsWith(".json")) {
              const content = await readFile(fullPath, "utf-8");
              const lines = content.split("\n");
              for (let i = 0; i < lines.length; i++) {
                if (regex.test(lines[i])) {
                  results.push(`${prefix}${entry}:${i + 1}: ${lines[i]}`);
                  regex.lastIndex = 0; // reset for next test
                }
              }
            }
          }
        }

        await Promise.all([
          searchDir(join(bookDir, "story"), "story/"),
          searchDir(join(bookDir, "chapters"), "chapters/"),
        ]);

        if (results.length === 0) {
          return textResult(`No matches for "${params.pattern}" in book "${params.bookId}".`);
        }

        const truncated = results.length > 100
          ? results.slice(0, 100).join("\n") + `\n\n... [${results.length - 100} more matches]`
          : results.join("\n");

        return textResult(truncated);
      } catch (err: any) {
        return textResult(`Grep failed: ${err?.message ?? String(err)}`);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// 5. Ls Tool
// ---------------------------------------------------------------------------

const LsParams = Type.Object({
  bookId: Type.String({ description: "Book ID" }),
  subdir: Type.Optional(
    Type.String({ description: "Subdirectory within the book, e.g. 'story', 'chapters', 'story/runtime'" }),
  ),
});

export function createLsTool(projectRoot: string): AgentTool<typeof LsParams> {
  const booksRoot = join(projectRoot, "books");

  return {
    name: "ls",
    description: "List files in a book directory. Optionally specify a subdirectory like 'story' or 'chapters'.",
    label: "List Files",
    parameters: LsParams,
    async execute(
      _toolCallId: string,
      params: Static<typeof LsParams>,
    ): Promise<AgentToolResult<undefined>> {
      try {
        const base = safeBooksPath(booksRoot, params.bookId);
        const target = params.subdir ? safeBooksPath(base, params.subdir) : base;

        const entries = await readdir(target);
        const details: string[] = [];

        for (const entry of entries) {
          const fullPath = join(target, entry);
          try {
            const entryStat = await stat(fullPath);
            const suffix = entryStat.isDirectory() ? "/" : ` (${entryStat.size} bytes)`;
            details.push(`${entry}${suffix}`);
          } catch {
            details.push(entry);
          }
        }

        if (details.length === 0) {
          return textResult(`Directory is empty: ${params.bookId}/${params.subdir ?? ""}`);
        }

        return textResult(details.join("\n"));
      } catch (err: any) {
        return textResult(`Failed to list "${params.bookId}/${params.subdir ?? ""}": ${err?.message ?? String(err)}`);
      }
    },
  };
}
