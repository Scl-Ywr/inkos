import type { Theme } from "../../hooks/use-theme";
import type { SyntheticEvent } from "react";
import { useRef } from "react";
import type { TokenUsageSnapshot } from "../../store/chat/types";
import {
  Message,
  MessageContent,
  MessageResponse,
} from "../ai-elements/message";
import { CheckCircle2, CircleDot, Database, RefreshCw, Scissors, Trash2, XCircle, Zap } from "lucide-react";

export interface ChatMessageProps {
  readonly role: "user" | "assistant";
  readonly content: string;
  readonly timestamp: number;
  readonly theme: Theme;
  readonly tokenUsage?: TokenUsageSnapshot;
  readonly isStreaming?: boolean;
  readonly onDelete?: () => void;
}

export function ChatMessage({
  role,
  content,
  tokenUsage,
  isStreaming = false,
  onDelete,
}: ChatMessageProps) {
  const isUser = role === "user";
  const lastDeleteTriggerAt = useRef(0);
  const isError = content.startsWith("\u2717");
  const tokenLabel = tokenUsage && !isUser && tokenUsage.totalTokens > 0
    ? `本次${tokenUsage.estimated ? "约 " : " "}${tokenUsage.totalTokens.toLocaleString()} tokens`
    : null;
  const savings = tokenUsage?.tokenSavings;
  const savedTokens = savings?.estimatedTokensSaved ?? 0;
  const hasTokenSavings = Boolean(savings && (savedTokens > 0 || savings.cacheSkippedCalls > 0));
  const compressionPercent = savings && savings.originalChars > 0
    ? Math.max(0, Math.min(100, Math.round(((savings.originalChars - savings.optimizedChars) / savings.originalChars) * 100)))
    : 0;
  const savingsLabel = !isUser && savings && hasTokenSavings
    ? savings.cacheSkippedCalls > 0
      ? `Token 缓存已生效，估算节省 ${savedTokens.toLocaleString()} tokens`
      : savings.ccrBlocksCompressed > 0
        ? `Headroom 压缩已生效，压缩 ${compressionPercent}% · 估算节省 ${savedTokens.toLocaleString()} tokens`
        : null
    : null;
  const savingsActive = hasTokenSavings;
  const pipeline = !isUser ? compactPipeline(savings?.pipeline ?? []) : [];
  const handleDelete = () => {
    void onDelete?.();
  };
  const triggerDelete = (event: SyntheticEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const now = Date.now();
    if (now - lastDeleteTriggerAt.current < 350) return;
    lastDeleteTriggerAt.current = now;
    handleDelete();
  };

  return (
    <Message from={role}>
      {isUser ? (
        <div className="flex max-w-full items-end justify-end gap-1.5">
          <MessageContent className="max-w-[min(78vw,34rem)]">
            <div className="text-sm leading-relaxed">{content}</div>
          </MessageContent>
          {onDelete && (
            <button
              type="button"
              aria-label="删除消息"
              title="删除这条用户消息"
              onPointerDown={triggerDelete}
              onTouchStart={triggerDelete}
              onClick={triggerDelete}
              className="mb-0.5 flex h-7 w-7 shrink-0 touch-manipulation items-center justify-center rounded-full text-muted-foreground/75 opacity-90 transition-colors hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100 focus-visible:opacity-100"
            >
              <Trash2 size={12} />
            </button>
          )}
        </div>
      ) : (
        <MessageContent>
          {isError ? (
          <div className="flex items-center gap-2 text-sm text-destructive">
            <XCircle size={14} className="shrink-0" />
            <span>{content.replace(/^\u2717\s*/, "")}</span>
          </div>
        ) : isStreaming ? (
          <div className="whitespace-pre-wrap break-words text-sm leading-7 text-foreground">{content}</div>
        ) : (
          <MessageResponse>{content}</MessageResponse>
        )}
        {(tokenLabel || savingsLabel) && (
          <div className="mt-2 inline-flex flex-wrap items-center gap-1.5 rounded-full border border-border/45 bg-background/35 px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
            {tokenLabel && <span>{tokenLabel}</span>}
            {savingsLabel && (
              <span className={savingsActive ? "text-emerald-600 dark:text-emerald-400" : ""}>
                {tokenLabel ? "· " : ""}{savingsLabel}
              </span>
            )}
          </div>
        )}
        {pipeline.length > 0 && (
          <div className="mt-2 flex max-w-full flex-wrap gap-1.5 text-[10px] text-muted-foreground">
            {pipeline.map((event, index) => {
              const Icon = pipelineIcon(event.kind);
              const detail = event.estimatedTokensSaved && event.estimatedTokensSaved > 0
                ? ` · 估算省 ${event.estimatedTokensSaved.toLocaleString()}`
                : event.similarity
                  ? ` · ${(event.similarity * 100).toFixed(0)}%`
                  : "";
              return (
                <span
                  key={`${event.kind}-${event.at}-${index}`}
                  className="inline-flex items-center gap-1 rounded-full border border-border/35 bg-background/30 px-2 py-0.5"
                >
                  <Icon size={11} />
                  {event.label}{detail}
                </span>
              );
            })}
          </div>
        )}
        {onDelete && (
          <div className="mt-1 flex justify-start">
            <button
              type="button"
              aria-label="删除这条 AI 回复"
              title="删除这条 AI 回复"
              onPointerDown={triggerDelete}
              onTouchStart={triggerDelete}
              onClick={triggerDelete}
              className="inline-flex min-h-9 shrink-0 touch-manipulation items-center gap-1.5 rounded-full border border-border/35 bg-background/30 px-3 text-xs font-medium text-muted-foreground/85 opacity-95 transition-colors hover:border-destructive/35 hover:bg-destructive/10 hover:text-destructive focus-visible:opacity-100"
            >
              <Trash2 size={13} />
              删除
            </button>
          </div>
        )}
      </MessageContent>
      )}
    </Message>
  );
}

function compactPipeline(
  events: ReadonlyArray<{ readonly kind: string; readonly label: string; readonly at: number; readonly estimatedTokensSaved?: number; readonly similarity?: number }>,
) {
  const preferred = ["standardized", "headroom-official", "headroom-fallback", "compressed", "embedding-external", "embedding-fallback", "cache-check", "cache-hit", "cache-miss", "llm-call", "cache-write", "cache-maintenance", "cache-skip"];
  const result: Array<(typeof events)[number]> = [];
  for (const kind of preferred) {
    const event = [...events].reverse().find((item) => item.kind === kind);
    if (event) result.push(event);
  }
  return result.slice(0, 7);
}

function pipelineIcon(kind: string) {
  if (kind === "compressed" || kind === "headroom-official") return Scissors;
  if (kind === "cache-hit" || kind === "cache-write" || kind === "embedding-external" || kind === "cache-maintenance") return Database;
  if (kind === "cache-check") return RefreshCw;
  if (kind === "llm-call") return Zap;
  if (kind === "cache-miss" || kind === "cache-skip") return CircleDot;
  return CheckCircle2;
}
