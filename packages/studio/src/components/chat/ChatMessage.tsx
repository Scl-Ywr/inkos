import { useEffect, useState } from "react";
import type { Theme } from "../../hooks/use-theme";
import type { TokenUsageSnapshot } from "../../store/chat/types";
import {
  Message,
  MessageAction,
  MessageActions,
  MessageContent,
  MessageResponse,
} from "../ai-elements/message";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { Check, CheckCircle2, CircleDot, Copy, Database, MoreHorizontal, RefreshCw, Scissors, Trash2, XCircle, Zap } from "lucide-react";

export interface ChatMessageProps {
  readonly role: "user" | "assistant";
  readonly content: string;
  readonly timestamp: number;
  readonly theme: Theme;
  readonly tokenUsage?: TokenUsageSnapshot;
  readonly isStreaming?: boolean;
  readonly onDelete?: () => void;
  readonly copyContent?: string;
  readonly showCopyAction?: boolean;
}

export function ChatMessage({
  role,
  content,
  tokenUsage,
  isStreaming = false,
  onDelete,
  copyContent,
  showCopyAction = role === "assistant",
}: ChatMessageProps) {
  const [copied, setCopied] = useState(false);
  const isUser = role === "user";
  const isError = content.startsWith("\u2717");
  const textToCopy = copyContent ?? content;
  const canCopy = !isUser && showCopyAction && !isStreaming && textToCopy.trim().length > 0;
  const tokenLabel = tokenUsage && !isUser && tokenUsage.totalTokens > 0
    ? `本次${tokenUsage.estimated ? "约 " : " "}${tokenUsage.totalTokens.toLocaleString()} tokens`
    : null;
  const savings = tokenUsage?.tokenSavings;
  const savedTokens = savings?.estimatedTokensSaved ?? 0;
  const hasTokenSavings = Boolean(savings && (savedTokens > 0 || (savings.cacheSkippedCalls ?? 0) > 0));
  const compressionPercent = savings && (savings.originalChars ?? 0) > 0
    ? Math.max(0, Math.min(100, Math.round((((savings.originalChars ?? 0) - (savings.optimizedChars ?? 0)) / (savings.originalChars ?? 1)) * 100)))
    : 0;
  const savingsLabel = !isUser && savings && hasTokenSavings
    ? (savings.cacheSkippedCalls ?? 0) > 0
      ? `Token 缓存已生效，估算节省 ${savedTokens.toLocaleString()} tokens`
      : (savings.ccrBlocksCompressed ?? 0) > 0
        ? `Headroom 压缩已生效，压缩 ${compressionPercent}% · 估算节省 ${savedTokens.toLocaleString()} tokens`
        : null
    : null;
  const pipeline = !isUser ? compactPipeline(savings?.pipeline ?? []) : [];
  const triggerDelete = () => {
    window.setTimeout(() => onDelete?.(), 0);
  };
  const copyMessage = async () => {
    try {
      await writeClipboardText(textToCopy);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  useEffect(() => {
    if (!copied) return;
    const timeout = window.setTimeout(() => setCopied(false), 1_800);
    return () => window.clearTimeout(timeout);
  }, [copied]);

  return (
    <Message from={role}>
      <div className={`flex flex-col w-full group ${isUser ? "items-end" : "items-start"}`}>
        <MessageContent
          className={isUser
            ? "rounded-[1.15rem] bg-primary text-primary-foreground shadow-sm sm:rounded-2xl"
            : "max-w-[min(100%,74ch)]"}
        >
        {isUser ? (
          <div className="text-[17px] leading-[1.72]">{content}</div>
        ) : isError ? (
          <div className="flex items-center gap-2 text-[17px] leading-[1.72] text-destructive">
            <XCircle size={14} className="shrink-0" />
            <span>{content.replace(/^\u2717\s*/, "")}</span>
          </div>
        ) : (
          <MessageResponse>{content}</MessageResponse>
        )}
        {(tokenLabel || savingsLabel) ? (
          <div className="mt-2 inline-flex flex-wrap items-center gap-1.5 rounded-full border border-border/45 bg-background/35 px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
            {tokenLabel && <span>{tokenLabel}</span>}
            {savingsLabel && (
              <span className="text-emerald-600 dark:text-emerald-400">
                {tokenLabel ? "· " : ""}{savingsLabel}
              </span>
            )}
          </div>
        ) : null}
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
        </MessageContent>
        {canCopy ? (
          <MessageActions className="mt-1">
            <MessageAction
              onClick={() => void copyMessage()}
              label={copied ? "已复制" : "复制消息"}
              title={copied ? "已复制" : "复制消息"}
              className="h-8 gap-1.5 rounded-full px-2.5 text-xs text-muted-foreground/75 transition-colors hover:bg-muted/70 hover:text-foreground"
              size="sm"
            >
              {copied ? <Check size={14} /> : <Copy size={14} />}
              <span aria-hidden="true">{copied ? "已复制" : "复制"}</span>
            </MessageAction>
          </MessageActions>
        ) : null}
        {onDelete && !isStreaming ? (
          <DropdownMenu>
            <DropdownMenuTrigger
              className="mt-1 inline-flex h-10 w-10 touch-manipulation items-center justify-center rounded-full text-muted-foreground/65 transition-colors hover:bg-muted/70 hover:text-foreground sm:h-8 sm:w-8 sm:opacity-0 sm:group-hover:opacity-100"
              aria-label={isUser ? "用户消息操作" : "AI 回复操作"}
              title="消息操作"
            >
              <MoreHorizontal size={16} />
            </DropdownMenuTrigger>
            <DropdownMenuContent
              side={isUser ? "left" : "right"}
              align="start"
              className="w-36 rounded-2xl border-border/60 bg-popover/95 p-1.5 shadow-xl shadow-primary/10 backdrop-blur"
            >
              <DropdownMenuItem
                variant="destructive"
                onClick={triggerDelete}
                className="min-h-10 rounded-xl px-3"
              >
                <Trash2 size={14} />
                <span>删除消息</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>
    </Message>
  );
}

function compactPipeline(
  events: ReadonlyArray<{ readonly kind: string; readonly label: string; readonly at: number; readonly estimatedTokensSaved?: number; readonly similarity?: number }>,
) {
  const preferred = ["standardized", "headroom-official", "headroom-fallback", "compressed", "embedding-external", "embedding-fallback", "cache-check", "cache-hit", "cache-miss", "llm-call", "cache-write", "cache-maintenance", "cache-skip"];
  const preferredKinds = new Set(preferred);
  const latestByKind = new Map<string, (typeof events)[number]>();
  for (let index = events.length - 1; index >= 0 && latestByKind.size < preferred.length; index--) {
    const event = events[index];
    if (preferredKinds.has(event.kind) && !latestByKind.has(event.kind)) {
      latestByKind.set(event.kind, event);
    }
  }
  const result: Array<(typeof events)[number]> = [];
  for (const kind of preferred) {
    const event = latestByKind.get(kind);
    if (event) result.push(event);
  }
  return result.slice(0, 7);
}

async function writeClipboardText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) throw new Error("Copy command failed");
}

function pipelineIcon(kind: string) {
  if (kind === "compressed" || kind === "headroom-official") return Scissors;
  if (kind === "cache-hit" || kind === "cache-write" || kind === "embedding-external" || kind === "cache-maintenance") return Database;
  if (kind === "cache-check") return RefreshCw;
  if (kind === "llm-call") return Zap;
  if (kind === "cache-miss" || kind === "cache-skip") return CircleDot;
  return CheckCircle2;
}
