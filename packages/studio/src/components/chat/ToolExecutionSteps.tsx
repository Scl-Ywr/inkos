import { useMemo, useState, useEffect } from "react";
import type { ChatActionPayload, ChatRequestedIntent, ChatSessionKind, ToolExecution, PipelineStage } from "../../store/chat/types";
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "../ui/collapsible";
import {
  Loader2,
  CheckCircle2,
  XCircle,
  ChevronDown,
  Wrench,
  Check,
  PenLine,
} from "lucide-react";
import { buildApiUrl } from "../../hooks/use-api";
import { chatSelectors, useChatStore } from "../../store/chat";

// -- Status rendering helpers --

const WRITING_HINTS = [
  "整理世界观与角色关系",
  "推演章节目标与冲突",
  "生成正文段落",
  "检查节奏与伏笔",
  "保存章节与运行记录",
] as const;

function activeWritingHint(startedAt: number): string {
  const elapsed = Math.max(0, Date.now() - startedAt);
  return WRITING_HINTS[Math.floor(elapsed / 9000) % WRITING_HINTS.length];
}

function ExecStatusBadge({ exec }: { exec: ToolExecution }) {
  const doneLabel = exec.agent === "state-repair" ? "恢复完成" : "写作完成";
  const errorLabel = exec.agent === "state-repair" ? "恢复失败" : "写作失败";
  switch (exec.status) {
    case "running":
      return (
        <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-primary">
          <Loader2 size={12} className="animate-spin" />
          <span>{activeWritingHint(exec.startedAt)}</span>
        </span>
      );
    case "processing":
      return (
        <span className="inline-flex items-center gap-1.5 text-[11px] text-primary/70">
          <Loader2 size={12} className="animate-spin" style={{ animationDuration: "2s" }} />
          <span>正在合并结果</span>
        </span>
      );
    case "completed":
      return (
        <span className="inline-flex items-center gap-1.5 text-[11px] text-green-600 dark:text-green-400">
          <CheckCircle2 size={12} />
          <span>{doneLabel}</span>
        </span>
      );
    case "error":
      return (
        <span className="inline-flex items-center gap-1.5 text-[11px] text-destructive">
          <XCircle size={12} />
          <span>{errorLabel}</span>
        </span>
      );
  }
}

function StageIcon({ status }: { status: PipelineStage["status"] }) {
  switch (status) {
    case "pending":
      return <span className="w-4 h-4 rounded-full border border-border/60 flex items-center justify-center shrink-0 text-[8px] text-muted-foreground/40">○</span>;
    case "active":
      return <Loader2 size={14} className="text-primary animate-spin shrink-0" />;
    case "completed":
      return <CheckCircle2 size={14} className="text-green-600 dark:text-green-400 shrink-0" />;
  }
}

function formatProgress(progress: NonNullable<PipelineStage["progress"]>, liveElapsedMs?: number): string {
  const elapsedMs = liveElapsedMs !== undefined
    ? Math.max(progress.elapsedMs, liveElapsedMs)
    : progress.elapsedMs;
  const secs = Math.floor(elapsedMs / 1000);
  const statusLabel = progress.status === "thinking" ? "思考设定" : progress.status === "streaming" ? "生成正文" : progress.status ?? "";
  const chars = progress.totalChars > 0
    ? progress.chineseChars > 0 ? `已写 ${progress.totalChars} 字` : `${progress.totalChars} chars`
    : "";
  const tokens = progress.estimatedTokens && progress.estimatedTokens > 0
    ? `约 ${progress.estimatedTokens.toLocaleString()} tokens`
    : "";
  const parts = [statusLabel, `${secs}秒`, chars, tokens].filter(Boolean);
  return parts.join(" · ");
}

function formatTokenUsage(exec: ToolExecution): string | null {
  const usage = exec.tokenUsage;
  if (!usage || usage.totalTokens <= 0) return null;
  const completion = usage.completionTokens && usage.promptTokens
    ? `输出 ${usage.completionTokens.toLocaleString()}`
    : null;
  const total = `${usage.estimated ? "约 " : ""}${usage.totalTokens.toLocaleString()} tokens`;
  return completion ? `${total} · ${completion}` : total;
}

function formatDuration(startedAt: number, completedAt?: number): string {
  const ms = (completedAt ?? Date.now()) - startedAt;
  const secs = Math.round(ms / 1000);
  return secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`;
}

function encodeProjectPath(path: string): string {
  return path.split("/").map((part) => encodeURIComponent(part)).join("/");
}

function extractResultPath(result: string | undefined, label: string): string | null {
  if (!result) return null;
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = result.match(new RegExp(`^${escaped}:\\s*(.+)$`, "im"));
  const path = match?.[1]?.trim();
  return path || null;
}

export interface GeneratedArtifactDetails {
  readonly kind: "short_fiction_created" | "cover_generated";
  readonly title?: string;
  readonly storyId?: string;
  readonly finalMarkdownPath?: string;
  readonly salesPackagePath?: string;
  readonly coverPromptPath?: string;
  readonly coverImagePath?: string;
  readonly coverError?: string;
}

interface ChapterArtifactDetails {
  readonly bookId: string;
  readonly chapterNumber: number;
  readonly title?: string;
  readonly wordCount?: number;
  readonly status?: string;
}

interface ChapterFileResponse {
  readonly filename: string;
  readonly content: string;
}

export interface PlayToolDetails {
  readonly kind: "play_world_started" | "play_turn_advanced" | "play_turn_revised" | "play_variant_restored";
  readonly title?: string;
  readonly worldId?: string;
  readonly runId?: string;
  readonly turn?: number;
  readonly sceneImageUrl?: string;
  readonly sceneText?: string;
  readonly suggestedActions?: readonly string[];
  readonly variantId?: string;
}

export interface PlayEditDetails {
  readonly kind: "play_world_updated";
  readonly worldId?: string;
  readonly runId?: string;
  readonly updatedWorldContract?: boolean;
  readonly updatedVisualContract?: boolean;
  readonly updatedPremise?: boolean;
  readonly updatedEntities?: number;
}

export interface ProposedActionDetails {
  readonly kind: "proposed_action";
  readonly execId: string;
  readonly action: ChatRequestedIntent;
  readonly targetSessionKind: ChatSessionKind;
  readonly targetRoute?: "import:fanfic" | "import:chapters" | "import:canon" | "import:spinoff" | "import:imitation" | "style";
  readonly sameSession?: boolean;
  readonly title?: string;
  readonly summary?: string;
  readonly instruction?: string;
  readonly actionPayload?: ChatActionPayload;
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function booleanField(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  return typeof value === "boolean" ? value : undefined;
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value.replace(/,/g, ""));
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function nestedNumberField(record: Record<string, unknown>, objectKey: string, key: string): number | undefined {
  const value = record[objectKey];
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return numberField(value as Record<string, unknown>, key);
}

function actionPayloadField(record: Record<string, unknown>): ChatActionPayload | undefined {
  const value = record.actionPayload;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as ChatActionPayload;
}

function proposedTargetRouteField(record: Record<string, unknown>): ProposedActionDetails["targetRoute"] {
  const value = stringField(record, "targetRoute");
  if (
    value === "import:fanfic"
    || value === "import:chapters"
    || value === "import:canon"
    || value === "import:spinoff"
    || value === "import:imitation"
    || value === "style"
  ) {
    return value;
  }
  return undefined;
}

export function getGeneratedArtifactDetails(exec: ToolExecution): GeneratedArtifactDetails | null {
  if (!["short_fiction_run", "generate_cover"].includes(exec.tool)) return null;
  if (!exec.details || typeof exec.details !== "object") return null;
  const record = exec.details as Record<string, unknown>;
  if (record.kind !== "short_fiction_created" && record.kind !== "cover_generated") return null;
  return {
    kind: record.kind,
    title: stringField(record, "title"),
    storyId: stringField(record, "storyId"),
    finalMarkdownPath: stringField(record, "finalMarkdownPath"),
    salesPackagePath: stringField(record, "salesPackagePath"),
    coverPromptPath: stringField(record, "coverPromptPath"),
    coverImagePath: stringField(record, "coverImagePath"),
    coverError: stringField(record, "coverError"),
  };
}

function getChapterArtifactDetails(exec: ToolExecution): ChapterArtifactDetails | null {
  if (exec.tool !== "sub_agent" || exec.agent !== "writer") return null;
  if (!exec.details || typeof exec.details !== "object") return null;
  const record = exec.details as Record<string, unknown>;
  if (record.kind !== "chapter_written") return null;
  const bookId = stringField(record, "bookId");
  const chapterNumber = numberField(record, "chapterNumber");
  if (!bookId || chapterNumber === undefined) return null;
  return {
    bookId,
    chapterNumber,
    title: stringField(record, "title"),
    wordCount: numberField(record, "wordCount"),
    status: stringField(record, "status"),
  };
}

function ChapterArtifactPreview({ exec }: { exec: ToolExecution }) {
  const details = getChapterArtifactDetails(exec);
  const [chapter, setChapter] = useState<ChapterFileResponse | null>(null);

  useEffect(() => {
    if (exec.status !== "completed" || !details) return;
    let cancelled = false;
    const url = buildApiUrl(`/books/${encodeURIComponent(details.bookId)}/chapters/${details.chapterNumber}`);
    if (!url) return;
    void fetch(url, { cache: "no-store" })
      .then(async (response) => response.ok ? response.json() as Promise<ChapterFileResponse> : null)
      .then((payload) => {
        if (!cancelled && payload) setChapter(payload);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [details?.bookId, details?.chapterNumber, exec.status]);

  if (exec.status !== "completed" || !details) return null;
  return (
    <div className="mx-3 mb-3 mt-1 overflow-hidden rounded-xl border border-emerald-500/20 bg-emerald-500/5">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-emerald-500/15 px-3 py-2">
        <div className="text-xs font-semibold text-emerald-700 dark:text-emerald-300">
          最终章节文件 · 第 {details.chapterNumber} 章{details.title ? `《${details.title}》` : ""}
        </div>
        <div className="text-[11px] text-muted-foreground">
          {details.wordCount ? `${details.wordCount.toLocaleString()} 字` : details.status ?? "已落盘"}
        </div>
      </div>
      {chapter ? (
        <>
          <div className="max-h-72 overflow-y-auto whitespace-pre-wrap px-3 py-3 font-serif text-sm leading-7 text-foreground/85">
            {chapter.content}
          </div>
          <div className="border-t border-emerald-500/15 px-3 py-1.5 text-[10px] text-muted-foreground">
            {chapter.filename}
          </div>
        </>
      ) : (
        <div className="flex items-center gap-2 px-3 py-3 text-xs text-muted-foreground">
          <Loader2 size={12} className="animate-spin" />
          正在读取已保存的章节文件...
        </div>
      )}
    </div>
  );
}

function extractStreamingSceneText(value: string): string {
  const marker = /"sceneText"\s*:\s*"/u.exec(value);
  if (!marker || marker.index === undefined) return "";
  const source = value.slice(marker.index + marker[0].length);
  let output = "";
  let escaped = false;
  for (const char of source) {
    if (escaped) {
      output += char === "n" ? "\n" : char === "r" ? "\r" : char === "t" ? "\t" : char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "\"") break;
    output += char;
  }
  return output;
}

function LiveGenerationPreview({ exec, active }: { exec: ToolExecution; active: boolean }) {
  if (!active) return null;
  const isWriter = exec.tool === "sub_agent" && exec.agent === "writer";
  const isStateRepair = exec.tool === "sub_agent" && exec.agent === "state-repair";
  const isPlay = ["play_start", "play_step", "play_revise"].includes(exec.tool);
  if (!isWriter && !isStateRepair && !isPlay) return null;
  const previewText = isPlay
    ? extractStreamingSceneText(exec.streamingText ?? "")
    : exec.streamingText ?? "";
  const label = isPlay
    ? "互动场景 · 实时生成"
    : isStateRepair
      ? "章节状态恢复 · 实时处理"
      : "写作工作流 · 实时正文";
  const placeholder = isPlay
    ? "模型正在推演世界状态，场景正文会在这里实时出现..."
    : isStateRepair
      ? "正在读取章节正文并重新结算 truth/state，处理内容会在这里实时出现..."
      : "模型正在准备章节内容，正文片段会在这里实时出现...";
  return (
    <div className="mt-3 overflow-hidden rounded-xl border border-primary/20 bg-primary/5">
      <div className="flex items-center gap-2 border-b border-primary/15 px-3 py-2 text-xs font-semibold text-primary">
        <span className="relative flex h-2 w-2">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-60" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
        </span>
        {label}
      </div>
      <div className="h-72 max-h-[46dvh] min-h-48 overflow-y-auto overscroll-contain whitespace-pre-wrap px-3 py-3 font-serif text-sm leading-7 text-foreground/85">
        {previewText || placeholder}
        <span className="ml-0.5 inline-block h-4 w-1 animate-pulse bg-primary align-middle" />
      </div>
    </div>
  );
}

function ShortFictionResultPreview({ exec }: { exec: ToolExecution }) {
  if (!["short_fiction_run", "generate_cover"].includes(exec.tool) || exec.status !== "completed") return null;
  const details = getGeneratedArtifactDetails(exec);
  const coverPath = details?.coverImagePath ?? extractResultPath(exec.result, "Cover image");
  const coverError = details?.coverError ?? extractResultPath(exec.result, "Cover image reason");
  if (!coverPath || !/\.(png|jpe?g|webp)$/iu.test(coverPath)) {
    if (!coverError) return null;
    return (
      <div className="mx-3 mb-3 mt-1 rounded-xl border border-destructive/20 bg-destructive/5 px-3 py-2 text-xs text-destructive">
        封面未生成：{coverError}
      </div>
    );
  }

  const coverUrl = buildApiUrl(`/project/files/${encodeProjectPath(coverPath)}`);
  if (!coverUrl) return null;
  const title = details?.title ?? details?.storyId ?? "短篇封面";

  return (
    <div className="mx-3 mb-3 mt-1 overflow-hidden rounded-xl border border-border/40 bg-background/70">
      <img
        src={coverUrl}
        alt={title}
        className="block max-h-[360px] w-full object-contain bg-muted/20"
        loading="lazy"
      />
      <div className="border-t border-border/40 px-3 py-2 text-[11px] text-muted-foreground break-all">
        {coverPath}
      </div>
    </div>
  );
}

export function getPlayToolDetails(exec: ToolExecution): PlayToolDetails | null {
  if (!["play_start", "play_step", "play_revise"].includes(exec.tool)) return null;
  if (!exec.details || typeof exec.details !== "object") return null;
  const record = exec.details as Record<string, unknown>;
  if (
    record.kind !== "play_world_started"
    && record.kind !== "play_turn_advanced"
    && record.kind !== "play_turn_revised"
    && record.kind !== "play_variant_restored"
  ) return null;
  const suggested = Array.isArray(record.suggestedActions)
    ? record.suggestedActions.filter((item): item is string => typeof item === "string")
    : [];
  return {
    kind: record.kind,
    title: stringField(record, "title"),
    worldId: stringField(record, "worldId"),
    runId: stringField(record, "runId"),
    turn: numberField(record, "turn")
      ?? nestedNumberField(record, "currentState", "turn")
      ?? (record.kind === "play_world_started" ? 0 : undefined),
    sceneImageUrl: stringField(record, "sceneImageUrl"),
    sceneText: stringField(record, "sceneText"),
    suggestedActions: suggested,
    variantId: stringField(record, "variantId"),
  };
}

type PlayRunImageIndex = {
  readonly sceneImageUrls?: Record<string, string>;
  readonly sceneImageUrl?: string;
  readonly deletedImageKeys?: ReadonlyArray<string>;
};

function sceneImageKey(details: PlayToolDetails): string | null {
  return details.turn == null ? null : `scene-turn-${Math.trunc(details.turn)}`;
}

export function buildPlaySceneImageUrl(details: PlayToolDetails, run?: PlayRunImageIndex | null): string | null {
  const key = sceneImageKey(details);
  if (key && run?.deletedImageKeys?.includes(key)) return null;
  if (details.sceneImageUrl) {
    return buildApiUrl(details.sceneImageUrl);
  }
  const fromIndex = key ? run?.sceneImageUrls?.[key] : undefined;
  if (fromIndex) return buildApiUrl(fromIndex);
  if (key === "scene-turn-0" && run?.sceneImageUrl) return buildApiUrl(run.sceneImageUrl);
  return null;
}

export function buildPlayRunStatusUrl(details: PlayToolDetails): string | null {
  if (!details.worldId || !details.runId || details.turn == null) return null;
  return buildApiUrl(
    `/play/runs/${encodeURIComponent(details.worldId)}/${encodeURIComponent(details.runId)}`,
  );
}

function PlaySceneImagePreview({ details }: { details: PlayToolDetails }) {
  const turn = details.turn == null ? null : Math.trunc(details.turn);
  const runUrl = useMemo(() => {
    if (!details.worldId || !details.runId || turn == null) return null;
    return buildApiUrl(
      `/play/runs/${encodeURIComponent(details.worldId)}/${encodeURIComponent(details.runId)}`,
    );
  }, [details.worldId, details.runId, turn]);
  const directUrl = useMemo(
    () => buildPlaySceneImageUrl(details),
    [details.sceneImageUrl, turn],
  );
  const [readyUrl, setReadyUrl] = useState<string | null>(null);

  useEffect(() => {
    if (directUrl) {
      setReadyUrl(directUrl);
    } else {
      setReadyUrl(null);
    }
    if (!runUrl) return;
    let cancelled = false;
    let timer: number | undefined;
    let attempt = 0;
    const maxAttempts = 40;

    const probe = async () => {
      try {
        const response = await fetch(runUrl);
        if (response.ok) {
          const data = await response.json() as PlayRunImageIndex;
          const url = buildPlaySceneImageUrl(details, data);
          if (cancelled) return;
          if (url) {
            setReadyUrl(url);
            return;
          }
          setReadyUrl(null);
        }
      } catch {
        // The run may not exist yet, or the image may still be generating.
      }
      if (cancelled) return;
      attempt += 1;
      if (attempt < maxAttempts) {
        timer = window.setTimeout(() => void probe(), 2000);
      }
    };

    void probe();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [details.worldId, details.runId, details.sceneImageUrl, turn, directUrl, runUrl]);

  if (!readyUrl) return null;

  return (
    <div className="mt-3 overflow-hidden rounded-xl border border-border/40 bg-background/80">
      <img
        src={readyUrl}
        alt="本幕配图"
        className="block max-h-[420px] w-full object-contain bg-muted/20"
        loading="lazy"
      />
      {details.turn != null && (
        <div className="border-t border-border/40 px-3 py-2.5 text-[14px] leading-6 text-muted-foreground">
          第 {Math.trunc(details.turn)} 幕配图
        </div>
      )}
    </div>
  );
}

export function getPlayEditDetails(exec: ToolExecution): PlayEditDetails | null {
  if (exec.tool !== "play_edit") return null;
  if (!exec.details || typeof exec.details !== "object") return null;
  const record = exec.details as Record<string, unknown>;
  if (record.kind !== "play_world_updated") return null;
  return {
    kind: "play_world_updated",
    worldId: stringField(record, "worldId"),
    runId: stringField(record, "runId"),
    updatedWorldContract: booleanField(record, "updatedWorldContract"),
    updatedVisualContract: booleanField(record, "updatedVisualContract"),
    updatedPremise: booleanField(record, "updatedPremise"),
    updatedEntities: numberField(record, "updatedEntities"),
  };
}

export function getProposedActionDetails(exec: ToolExecution): ProposedActionDetails | null {
  if (exec.tool !== "propose_action") return null;
  if (!exec.details || typeof exec.details !== "object") return null;
  const record = exec.details as Record<string, unknown>;
  if (record.kind !== "proposed_action") return null;
  const action = stringField(record, "action") as ChatRequestedIntent | undefined;
  const targetSessionKind = stringField(record, "targetSessionKind") as ChatSessionKind | undefined;
  const instruction = stringField(record, "instruction");
  if (!action || !targetSessionKind || !instruction) return null;
  return {
    kind: "proposed_action",
    execId: exec.id,
    action,
    targetSessionKind,
    targetRoute: proposedTargetRouteField(record),
    sameSession: booleanField(record, "sameSession"),
    title: stringField(record, "title"),
    summary: stringField(record, "summary"),
    instruction,
    actionPayload: actionPayloadField(record),
  };
}

export function getProposedActionContractRows(details: ProposedActionDetails): ReadonlyArray<{ label: string; value: string }> {
  const playStart = details.actionPayload?.playStart;
  if (details.action !== "play_start" || !playStart) return [];
  const rows: Array<{ label: string; value: string }> = [];
  const worldContract = playStart.worldContract?.trim();
  if (worldContract) rows.push({ label: "世界契约", value: worldContract });
  const visualContract = playStart.visualContract?.trim();
  if (visualContract) rows.push({ label: "视觉契约", value: visualContract });
  return rows;
}

function ProposedActionPreview({
  exec,
  onProposedAction,
  onRejectProposedAction,
}: {
  exec: ToolExecution;
  onProposedAction?: (details: ProposedActionDetails) => void;
  onRejectProposedAction?: (details: ProposedActionDetails) => void;
}) {
  const resolvedProposals = useChatStore((s) => s.resolvedProposals);
  const isActiveSessionStreaming = useChatStore(chatSelectors.isActiveSessionStreaming);
  if (exec.tool !== "propose_action" || exec.status !== "completed") return null;
  const details = getProposedActionDetails(exec);
  if (!details) return null;
  // A proposed action is one-shot: once confirmed or rejected the card locks so
  // the production action can't be re-fired. While a run is in flight the
  // confirm button reflects "执行中…" instead of silently swallowing the click.
  const resolution = resolvedProposals[details.execId];
  const streaming = isActiveSessionStreaming;
  const locked = resolution !== undefined;
  const contractRows = getProposedActionContractRows(details);
  return (
    <div className="mx-3 mb-3 mt-1 rounded-xl border border-primary/25 bg-primary/5 px-4 py-3.5">
      <div className="text-[17px] leading-6 font-semibold text-foreground">{details.title ?? "确认执行"}</div>
      {details.summary && (
        <div className="mt-1.5 whitespace-pre-wrap break-words text-[15px] leading-7 text-muted-foreground">{details.summary}</div>
      )}
      <div className="mt-2.5 whitespace-pre-wrap break-words rounded-lg bg-background/70 px-3 py-2.5 text-[15px] leading-7 text-muted-foreground">
        {details.instruction}
      </div>
      {contractRows.length > 0 && (
        <div className="mt-2 space-y-1.5">
          {contractRows.map((row) => (
            <div key={row.label} className="rounded-lg border border-border/50 bg-background/60 px-3 py-2.5">
              <div className="text-[13px] leading-5 font-semibold text-foreground">{row.label}</div>
              <div className="mt-1 whitespace-pre-wrap break-words text-[15px] leading-7 text-muted-foreground">{row.value}</div>
            </div>
          ))}
        </div>
      )}
      {resolution === "confirmed" ? (
        <div className="mt-3 flex items-center gap-1.5 text-[15px] leading-6 font-medium text-primary">
          <Check size={15} className="shrink-0" />
          {details.targetRoute ? "已打开" : "已执行"}
        </div>
      ) : resolution === "rejected" ? (
        <div className="mt-3 text-[15px] leading-6 font-medium text-muted-foreground">已取消</div>
      ) : (
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => onProposedAction?.(details)}
            disabled={!onProposedAction || streaming || locked}
            className="rounded-lg bg-primary px-3.5 py-2 text-[15px] leading-6 font-medium text-primary-foreground disabled:opacity-50"
          >
            {streaming ? "执行中…" : details.targetRoute ? "打开入口" : "继续执行"}
          </button>
          <button
            type="button"
            onClick={() => onRejectProposedAction?.(details)}
            disabled={!onRejectProposedAction || streaming || locked}
            className="rounded-lg border border-border/60 bg-background/80 px-3.5 py-2 text-[15px] leading-6 font-medium text-muted-foreground disabled:opacity-50"
          >
            取消
          </button>
        </div>
      )}
    </div>
  );
}

function PlayResultPreview({ exec }: { exec: ToolExecution }) {
  if (!["play_start", "play_step", "play_revise"].includes(exec.tool) || exec.status !== "completed") return null;
  const details = getPlayToolDetails(exec);
  if (!details?.sceneText) return null;
  const label = details.kind === "play_world_started"
    ? "互动世界已启动"
    : details.kind === "play_turn_revised"
      ? "互动回合已重做"
      : details.kind === "play_variant_restored"
        ? "已切换互动回合版本"
        : "互动世界已推进";
  return (
    <div className="mx-3 mb-3 mt-1 rounded-xl border border-primary/20 bg-primary/5 px-3 py-3">
      <div className="mb-2 text-[16px] leading-6 font-semibold text-primary">
        {label}
      </div>
      <div className="whitespace-pre-wrap text-base leading-7 text-foreground">{details.sceneText}</div>
      <PlaySceneImagePreview details={details} />
    </div>
  );
}

function PlayEditPreview({ exec }: { exec: ToolExecution }) {
  if (exec.tool !== "play_edit" || exec.status !== "completed") return null;
  const details = getPlayEditDetails(exec);
  if (!details) return null;
  const changes = [
    details.updatedWorldContract ? "世界契约" : "",
    details.updatedVisualContract ? "视觉契约" : "",
    details.updatedPremise ? "世界前提" : "",
    details.updatedEntities && details.updatedEntities > 0 ? `${details.updatedEntities} 张卡片` : "",
  ].filter(Boolean);
  return (
    <div className="mx-3 mb-3 mt-1 rounded-xl border border-primary/20 bg-primary/5 px-3 py-2.5">
      <div className="text-[16px] leading-6 font-semibold text-primary">互动世界设定已更新</div>
      <div className="mt-1 text-xs leading-5 text-muted-foreground">
        {changes.length > 0 ? changes.join(" · ") : "已写入当前世界。"}
      </div>
    </div>
  );
}

function isPipelineTool(tool: string): boolean {
  return tool === "sub_agent"
    || tool === "context_compression"
    || tool === "propose_action"
    || tool === "short_fiction_run"
    || tool === "generate_cover"
    || tool === "play_edit"
    || tool === "play_start"
    || tool === "play_revise"
    || tool === "play_step"
    || tool === "architect"
    || tool === "truth"
    || tool === "role"
    || tool === "writer"
    || tool === "auditor"
    || tool === "reviser"
    || tool === "exporter"
    || tool === "importer"
    || tool === "market"
    || tool === "cover"
    || tool === "scheduler"
    || tool === "write_truth_file"
    || tool === "rename_entity"
    || tool === "patch_chapter_text";
}

// -- Live elapsed timer hook --

function useElapsedTimer(startedAt: number, active: boolean): number {
  const [elapsed, setElapsed] = useState(() => active ? Date.now() - startedAt : 0);
  useEffect(() => {
    if (!active) return;
    setElapsed(Date.now() - startedAt);
    const id = setInterval(() => setElapsed(Date.now() - startedAt), 1000);
    return () => clearInterval(id);
  }, [startedAt, active]);
  return elapsed;
}

// -- Pipeline operation (sub_agent) --

function PipelineExecution({
  exec,
  onProposedAction,
  onRejectProposedAction,
}: {
  exec: ToolExecution;
  onProposedAction?: (details: ProposedActionDetails) => void;
  onRejectProposedAction?: (details: ProposedActionDetails) => void;
}) {
  const isActive = exec.status === "running" || exec.status === "processing";
  const [open, setOpen] = useState(isActive);
  const elapsedMs = useElapsedTimer(exec.startedAt, isActive);

  useEffect(() => {
    if (exec.status === "running") setOpen(true);
  }, [exec.status]);

  const bookId = exec.args?.bookId as string | undefined;
  const tokenUsageLabel = formatTokenUsage(exec);

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="rounded-2xl border border-border/45 bg-card/70 shadow-sm shadow-primary/5">
      <CollapsibleTrigger className="w-full flex items-center justify-between gap-2 rounded-2xl px-3 py-3 transition-colors hover:bg-card/85 cursor-pointer">
        <div className="flex items-center gap-2 min-w-0">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/12 text-primary">
            <PenLine size={14} />
          </span>
          <span className="truncate text-sm font-semibold text-foreground">
            {exec.label}
            {bookId && <span className="text-muted-foreground font-normal"> · {bookId}</span>}
          </span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {tokenUsageLabel && (
            <span className="hidden rounded-full border border-border/45 bg-background/45 px-2 py-0.5 text-[10px] font-medium text-muted-foreground sm:inline-flex">
              {tokenUsageLabel}
            </span>
          )}
          <span className="text-[10px] text-muted-foreground/60">
            {isActive
              ? formatDuration(exec.startedAt, exec.startedAt + elapsedMs)
              : exec.completedAt ? formatDuration(exec.startedAt, exec.completedAt) : ""}
          </span>
          <ExecStatusBadge exec={exec} />
          <ChevronDown size={14} className={`text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`} />
        </div>
      </CollapsibleTrigger>
      <ProposedActionPreview
        exec={exec}
        onProposedAction={onProposedAction}
        onRejectProposedAction={onRejectProposedAction}
      />
      <ShortFictionResultPreview exec={exec} />
      <PlayResultPreview exec={exec} />
      <PlayEditPreview exec={exec} />
      <ChapterArtifactPreview exec={exec} />
      <CollapsibleContent>
        <div className="px-3 pb-3 pt-1">
          {tokenUsageLabel && (
            <div className="mb-2 inline-flex rounded-full border border-border/45 bg-background/45 px-2.5 py-1 text-[11px] font-medium text-muted-foreground sm:hidden">
              {tokenUsageLabel}
            </div>
          )}
          {exec.stages && exec.stages.length > 0 && (
            <ol className="mb-3 space-y-1.5 rounded-xl border border-border/35 bg-background/25 p-2.5">
              {exec.stages.map((stage) => (
                <li
                  key={stage.label}
                  className="flex items-start gap-2 text-xs text-muted-foreground"
                >
                  <StageIcon status={stage.status} />
                  <div className="min-w-0 flex-1">
                    <div className="font-medium text-foreground/80">{stage.label}</div>
                    {stage.progress && (
                      <div className="mt-0.5 text-[11px] leading-5 text-muted-foreground/80">
                        {formatProgress(stage.progress, stage.status === "active" && isActive ? elapsedMs : undefined)}
                      </div>
                    )}
                  </div>
                </li>
              ))}
            </ol>
          )}
          <LiveGenerationPreview exec={exec} active={isActive} />
          {/* Real-time execution logs */}
          {exec.logs && exec.logs.length > 0 && (
            <ul className="space-y-0.5">
              {exec.logs.map((log, i) => {
                const isError = log.startsWith("[error]") || /error/i.test(log);
                const isWarn = log.startsWith("[warning]") || /warning|警告/i.test(log);
                return (
                  <li key={i} className={`rounded-lg px-2 py-1 text-[11px] font-mono leading-5 break-words ${isError ? "bg-destructive/5 text-destructive" : isWarn ? "bg-amber-500/10 text-yellow-700 dark:text-yellow-300" : "bg-background/35 text-muted-foreground"}`}>
                    {log}
                  </li>
                );
              })}
            </ul>
          )}
          {exec.status === "error" && exec.error && (
            <div className="mt-2 text-xs text-destructive bg-destructive/5 rounded-lg px-2.5 py-2">
              {exec.error}
            </div>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

// -- Utility tools (read/edit/grep/ls) grouped --

function UtilityToolsGroup({ execs }: { execs: ToolExecution[] }) {
  const [open, setOpen] = useState(false);
  const allDone = execs.every(e => e.status === "completed" || e.status === "error");
  const hasError = execs.some(e => e.status === "error");

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex items-center gap-2 px-2 py-1 rounded-lg hover:bg-muted/50 transition-colors cursor-pointer text-xs text-muted-foreground">
        <Wrench size={12} />
        <span>{execs.length} 个文件操作</span>
        {allDone && !hasError && <CheckCircle2 size={10} className="text-green-600 dark:text-green-400" />}
        {hasError && <XCircle size={10} className="text-destructive" />}
        {!allDone && <Loader2 size={10} className="animate-spin text-primary" />}
        <ChevronDown size={10} className={`transition-transform ${open ? "rotate-180" : ""}`} />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ul className="pl-6 space-y-0.5 py-1">
          {execs.map((exec) => (
            <li key={exec.id} className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className="font-mono truncate">{exec.tool} {String(exec.args?.path ?? exec.args?.pattern ?? "")}</span>
              {exec.status === "completed" && <CheckCircle2 size={10} className="text-green-600 dark:text-green-400 shrink-0" />}
              {exec.status === "error" && <XCircle size={10} className="text-destructive shrink-0" />}
              {(exec.status === "running" || exec.status === "processing") && <Loader2 size={10} className="animate-spin text-primary shrink-0" />}
            </li>
          ))}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  );
}

// -- Main component --

export interface ToolExecutionStepsProps {
  executions: ToolExecution[];
  onProposedAction?: (details: ProposedActionDetails) => void;
  onRejectProposedAction?: (details: ProposedActionDetails) => void;
}

/**
 * Group executions chronologically: pipeline ops render individually,
 * consecutive utility tools are merged into a single collapsed group.
 */
type RenderGroup =
  | { type: "pipeline"; exec: ToolExecution }
  | { type: "utilities"; execs: ToolExecution[] };

export function groupToolExecutionsChronologically(executions: ToolExecution[]): RenderGroup[] {
  const groups: RenderGroup[] = [];
  let utilBuf: ToolExecution[] = [];

  const flushUtils = () => {
    if (utilBuf.length > 0) {
      groups.push({ type: "utilities", execs: utilBuf });
      utilBuf = [];
    }
  };

  for (const exec of executions) {
    if (isPipelineTool(exec.tool)) {
      flushUtils();
      groups.push({ type: "pipeline", exec });
    } else {
      utilBuf.push(exec);
    }
  }
  flushUtils();
  return groups;
}

export function ToolExecutionSteps({ executions, onProposedAction, onRejectProposedAction }: ToolExecutionStepsProps) {
  const visibleExecutions = useMemo(
    () => executions.filter((execution) =>
      execution.tool !== "context_compression"
      || execution.status === "running"
      || execution.status === "processing"
      || execution.status === "error"
    ),
    [executions],
  );
  const groups = useMemo(() => groupToolExecutionsChronologically(visibleExecutions), [visibleExecutions]);

  if (groups.length === 0) return null;

  return (
    <div className="space-y-2 mt-2">
      {groups.map((g, i) =>
        g.type === "pipeline"
          ? (
              <PipelineExecution
                key={g.exec.id}
                exec={g.exec}
                onProposedAction={onProposedAction}
                onRejectProposedAction={onRejectProposedAction}
              />
            )
          : <UtilityToolsGroup key={`utils-${i}`} execs={g.execs} />
      )}
    </div>
  );
}
