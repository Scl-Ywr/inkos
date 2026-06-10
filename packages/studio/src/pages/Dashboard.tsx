import { fetchJson, useApi, postApi } from "../hooks/use-api";
import { buildApiUrl } from "../lib/api-url";
import { useEffect, useMemo, useState, useRef } from "react";
import { useServiceStore } from "../store/service";
import type { ActiveOperation, SSEMessage } from "../hooks/use-sse";
import type { Theme } from "../hooks/use-theme";
import type { TFunction } from "../hooks/use-i18n";
import { useColors } from "../hooks/use-colors";
import { deriveActiveBookIds, shouldRefetchBookCollections } from "../hooks/use-book-activity";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { appAlert } from "../lib/app-dialog";
import {
  Plus,
  BookOpen,
  BarChart2,
  Zap,
  Clock,
  CheckCircle2,
  AlertCircle,
  MoreVertical,
  ChevronRight,
  Flame,
  Trash2,
  Settings,
  Download,
  FileInput,
  History,
} from "lucide-react";

interface BookSummary {
  readonly id: string;
  readonly title: string;
  readonly genre: string;
  readonly status: string;
  readonly chaptersWritten: number;
  readonly language?: string;
  readonly fanficMode?: string;
}

interface Nav {
  toBook: (id: string) => void;
  toBookSettings: (id: string) => void;
  toAnalytics: (id: string) => void;
  toBookCreate: () => void;
  toServices: () => void;
}

interface TaskLogEntry {
  readonly message: string;
  readonly tag?: string;
  readonly level?: string;
  readonly timestamp: number;
}

interface CurrentTask {
  readonly bookId: string | null;
  readonly sessionId?: string | null;
  readonly label: string;
  readonly status: "running" | "complete" | "error";
  readonly timestamp: number;
  readonly startedAt?: number;
}

export interface OperationHistoryItem {
  readonly key: string;
  readonly type: string;
  readonly bookId: string;
  readonly status: "completed" | "error" | "cancelled";
  readonly label: string;
  readonly message: string;
  readonly startedAt: number;
  readonly updatedAt: number;
  readonly completedAt: number;
  readonly durationMs: number;
  readonly chapter?: number;
  readonly sessionId?: string;
  readonly error?: string;
}

interface DashboardSseState {
  readonly messages: ReadonlyArray<SSEMessage>;
  readonly activeOperations?: ReadonlyArray<ActiveOperation>;
}

const TASK_LABELS: Record<string, string> = {
  "write:start": "开始写作",
  "write:complete": "写作完成",
  "write:error": "写作失败",
  "draft:start": "开始起草",
  "draft:complete": "起草完成",
  "draft:error": "起草失败",
  "rewrite:start": "开始重写",
  "rewrite:complete": "重写完成",
  "rewrite:error": "重写失败",
  "audit:start": "开始审计",
  "audit:complete": "审计完成",
  "audit:error": "审计失败",
  "revise:start": "开始修订",
  "revise:complete": "修订完成",
  "revise:error": "修订失败",
  "agent:start": "Agent 启动",
  "agent:complete": "Agent 完成",
  "agent:error": "Agent 失败",
};

function getMessageBookId(message: SSEMessage): string | null {
  const data = message.data as { bookId?: unknown } | null;
  return typeof data?.bookId === "string" ? data.bookId : null;
}

function getMessageSessionId(message: SSEMessage): string | null {
  const data = message.data as { sessionId?: unknown } | null;
  return typeof data?.sessionId === "string" ? data.sessionId : null;
}

function normalizeLogEvent(message: SSEMessage): TaskLogEntry | null {
  if (message.event !== "log" || !message.data || typeof message.data !== "object") return null;
  const data = message.data as { message?: unknown; tag?: unknown; level?: unknown; timestamp?: unknown };
  if (typeof data.message !== "string" || data.message.trim().length === 0) return null;
  const parsedTimestamp = typeof data.timestamp === "string" ? Date.parse(data.timestamp) : Number.NaN;
  return {
    message: data.message,
    timestamp: Number.isFinite(parsedTimestamp) ? parsedTimestamp : message.timestamp,
    ...(typeof data.tag === "string" ? { tag: data.tag } : {}),
    ...(typeof data.level === "string" ? { level: data.level } : {}),
  };
}

function normalizeTaskEvent(message: SSEMessage): TaskLogEntry | null {
  if (message.event === "operations:restore") {
    const operations = (message.data as { operations?: Array<{ type?: string }> } | null)?.operations ?? [];
    const operation = operations.at(-1);
    if (!operation) return null;
    return {
      tag: "task",
      level: "info",
      message: `已恢复执行中的任务${operation.type ? `: ${operation.type}` : ""}`,
      timestamp: message.timestamp,
    };
  }

  const label = TASK_LABELS[message.event];
  if (!label) return null;
  const data = message.data as { error?: unknown; agent?: unknown; tool?: unknown } | null;
  const detail = typeof data?.error === "string"
    ? data.error
    : typeof data?.agent === "string"
      ? data.agent
      : typeof data?.tool === "string"
        ? data.tool
        : "";
  return {
    tag: "task",
    level: message.event.endsWith(":error") ? "error" : "info",
    message: detail ? `${label}: ${detail}` : label,
    timestamp: message.timestamp,
  };
}

function getCurrentTask(messages: ReadonlyArray<SSEMessage>): CurrentTask | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    const label = TASK_LABELS[message.event];
    if (!label) continue;
    return {
      bookId: getMessageBookId(message),
      sessionId: getMessageSessionId(message),
      label,
      status: message.event.endsWith(":error")
        ? "error"
        : message.event.endsWith(":complete")
          ? "complete"
          : "running",
      timestamp: message.timestamp,
    };
  }

  let restored: SSEMessage | undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].event === "operations:restore") {
      restored = messages[i];
      break;
    }
  }
  const operations = (restored?.data as { operations?: Array<{ bookId?: string; type?: string }> } | null)?.operations ?? [];
  const operation = operations.at(-1);
  if (!operation) return null;
  return {
    bookId: operation.bookId ?? null,
    sessionId: "sessionId" in operation && typeof operation.sessionId === "string" ? operation.sessionId : null,
    label: operation.type === "agent" ? "Agent 正在执行" : "任务正在执行",
    status: "running",
    timestamp: restored?.timestamp ?? Date.now(),
    startedAt: restored?.timestamp ?? Date.now(),
  };
}

function isWritingOperation(operation: ActiveOperation): boolean {
  return operation.type === "write"
    || operation.type === "draft"
    || operation.type === "rewrite"
    || operation.type === "revise"
    || operation.type === "audit"
    || operation.type === "agent";
}

function deriveBackendActiveBookIds(operations: ReadonlyArray<ActiveOperation> | undefined): ReadonlySet<string> {
  const active = new Set<string>();
  for (const operation of operations ?? []) {
    if (operation.bookId && operation.bookId !== "project" && isWritingOperation(operation)) {
      active.add(operation.bookId);
    }
  }
  return active;
}

function getCurrentTaskFromOperations(operations: ReadonlyArray<ActiveOperation> | undefined): CurrentTask | null {
  const operation = [...(operations ?? [])]
    .filter((item) => item.status !== "complete" && item.status !== "error")
    .sort((a, b) => (b.updatedAt ?? b.startedAt ?? 0) - (a.updatedAt ?? a.startedAt ?? 0))[0];
  if (!operation) return null;
  return {
    bookId: operation.bookId && operation.bookId !== "project" ? operation.bookId : null,
    sessionId: operation.sessionId ?? null,
    label: operation.label ?? (operation.type === "agent" ? "AI 对话正在执行" : "任务正在执行"),
    status: "running",
    timestamp: operation.updatedAt ?? operation.startedAt ?? Date.now(),
    startedAt: operation.startedAt,
  };
}

export function pickCurrentTask(
  operations: ReadonlyArray<ActiveOperation> | undefined,
  messages: ReadonlyArray<SSEMessage>,
): CurrentTask | null {
  const operationTask = getCurrentTaskFromOperations(operations);
  const eventTask = getCurrentTask(messages);
  if (eventTask && eventTask.status !== "running") {
    if (!operationTask || eventTask.timestamp >= operationTask.timestamp) {
      return eventTask;
    }
  }
  return operationTask ?? eventTask;
}

function restoredOperationMatchesBook(message: SSEMessage, bookId: string): boolean {
  if (message.event !== "operations:restore") return false;
  const operations = (message.data as { operations?: Array<{ bookId?: string }> } | null)?.operations ?? [];
  return operations.some((operation) => operation.bookId === bookId);
}

function getRecentTaskLogs(messages: ReadonlyArray<SSEMessage>, bookId?: string): ReadonlyArray<TaskLogEntry> {
  const activeBookIds = deriveActiveBookIds(messages);
  const seen = new Set<string>();
  return messages
    .filter((message) => {
      if (!bookId) return true;
      const messageBookId = getMessageBookId(message);
      if (messageBookId) return messageBookId === bookId;
      if (restoredOperationMatchesBook(message, bookId)) return true;
      return message.event === "log" && activeBookIds.size <= 1;
    })
    .map((message) => normalizeLogEvent(message) ?? normalizeTaskEvent(message))
    .filter((entry): entry is TaskLogEntry => entry !== null)
    .filter((entry) => {
      const key = `${entry.timestamp}\u0000${entry.tag ?? ""}\u0000${entry.message}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(-6);
}

function shouldRefetchOperationHistory(message: SSEMessage): boolean {
  return message.event === "operations:history"
    || message.event.endsWith(":complete")
    || message.event.endsWith(":error");
}

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest > 0 ? `${minutes}m ${rest}s` : `${minutes}m`;
}

function historyStatusView(status: OperationHistoryItem["status"]): {
  readonly label: string;
  readonly icon: typeof CheckCircle2;
  readonly className: string;
} {
  if (status === "completed") {
    return { label: "完成", icon: CheckCircle2, className: "text-emerald-500 bg-emerald-500/10 border-emerald-500/20" };
  }
  if (status === "cancelled") {
    return { label: "已停止", icon: AlertCircle, className: "text-amber-500 bg-amber-500/10 border-amber-500/20" };
  }
  return { label: "失败", icon: AlertCircle, className: "text-destructive bg-destructive/10 border-destructive/20" };
}

export function selectLatestProgressEvent(
  messages: ReadonlyArray<SSEMessage>,
  filter?: { readonly bookId?: string | null; readonly sessionId?: string | null; readonly startedAt?: number },
): SSEMessage | undefined {
  const hasFilter = Boolean(filter?.bookId || filter?.sessionId);
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.event !== "llm:progress" || !message.data || typeof message.data !== "object") continue;
    if (filter?.startedAt && message.timestamp < filter.startedAt) continue;
    if (!hasFilter) return message;

    const data = message.data as { bookId?: unknown; sessionId?: unknown };
    if (filter?.sessionId && data.sessionId === filter.sessionId) return message;
    if (filter?.bookId && data.bookId === filter.bookId) return message;
  }
  return undefined;
}

function useLiveNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [active]);

  return now;
}

function TaskExecutionLog({
  title,
  subtitle,
  entries,
  progressEvent,
  compact = false,
  onClear,
  startedAt,
}: {
  readonly title: string;
  readonly subtitle?: string;
  readonly entries: ReadonlyArray<TaskLogEntry>;
  readonly progressEvent?: SSEMessage;
  readonly compact?: boolean;
  readonly onClear?: () => void;
  readonly startedAt?: number;
}) {
  const progress = progressEvent?.data as { elapsedMs?: number; totalChars?: number; status?: string } | null;
  const isLiveProgress = Boolean(progress && progress.status !== "done");
  const now = useLiveNow(isLiveProgress);
  const elapsedMs = progress
    ? isLiveProgress && startedAt
      ? Math.max(0, now - startedAt)
      : Math.max(0, progress.elapsedMs ?? 0)
    : 0;

  if (entries.length === 0 && !progressEvent) {
    return null;
  }

  return (
    <div className={`rounded-3xl border border-primary/15 bg-primary/[0.035] ${compact ? "p-3" : "p-4 sm:p-6"}`}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-2xl bg-primary text-primary-foreground shadow-lg shadow-primary/20">
            <Flame size={16} className="animate-pulse" />
          </div>
          <div className="min-w-0">
            <div className="truncate text-sm font-bold text-foreground">{title}</div>
            {subtitle && <div className="mt-0.5 truncate text-xs text-muted-foreground">{subtitle}</div>}
          </div>
        </div>
        {progress && (
          <div className="flex w-full items-center gap-2 sm:w-auto">
            <div className="soft-pill flex flex-1 items-center justify-between gap-3 rounded-full px-3 py-2 text-xs font-bold text-primary sm:flex-none">
              <span className="flex items-center gap-1.5">
                <Clock size={12} />
                {Math.floor(elapsedMs / 1000)}s
              </span>
              <span className="h-3 w-px bg-primary/20" />
              <span className="flex items-center gap-1.5">
                <Zap size={12} />
                {(progress.totalChars ?? 0).toLocaleString()} 字
              </span>
            </div>
            {onClear && (
              <button
                type="button"
                onClick={onClear}
                className="rounded-full border border-border/45 bg-background/45 px-3 py-2 text-xs font-bold text-muted-foreground transition-colors hover:border-destructive/35 hover:bg-destructive/10 hover:text-destructive"
              >
                清除
              </button>
            )}
          </div>
        )}
        {!progress && onClear && (
          <button
            type="button"
            onClick={onClear}
            className="rounded-full border border-border/45 bg-background/45 px-3 py-2 text-xs font-bold text-muted-foreground transition-colors hover:border-destructive/35 hover:bg-destructive/10 hover:text-destructive"
          >
            清除
          </button>
        )}
      </div>

      {entries.length > 0 && (
        <div className={`mt-3 space-y-1 overflow-y-auto rounded-2xl border border-border/40 bg-black/5 p-3 font-mono text-[11px] leading-relaxed dark:bg-black/20 ${compact ? "max-h-28" : "max-h-52 sm:text-xs"}`}>
          {entries.map((entry, index) => (
            <div key={`${entry.timestamp}-${index}`} className="flex gap-2">
              <span className="w-16 shrink-0 tabular-nums text-muted-foreground/55">
                {new Date(entry.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
              </span>
              {entry.tag && (
                <span className={`shrink-0 ${entry.level === "error" ? "text-destructive" : "text-primary/70"}`}>
                  [{entry.tag}]
                </span>
              )}
              <span className={entry.level === "error" ? "text-destructive" : "text-foreground/75"}>
                {entry.message}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function RecentTaskHistory({ items }: { readonly items: ReadonlyArray<OperationHistoryItem> }) {
  if (items.length === 0) return null;

  return (
    <section className="glass-panel rounded-[2rem] p-4 sm:p-6">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-2xl bg-secondary text-primary">
            <History size={16} />
          </div>
          <div className="min-w-0">
            <div className="text-sm font-bold text-foreground">最近任务</div>
            <div className="mt-0.5 text-xs text-muted-foreground">完成、失败和停止记录</div>
          </div>
        </div>
      </div>

      <div className="space-y-2">
        {items.map((item) => {
          const statusView = historyStatusView(item.status);
          const StatusIcon = statusView.icon;
          return (
            <div
              key={`${item.key}-${item.completedAt}`}
              className="rounded-2xl border border-border/45 bg-background/35 px-3 py-3"
            >
              <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <span className="truncate text-sm font-semibold text-foreground">{item.label}</span>
                    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-bold ${statusView.className}`}>
                      <StatusIcon size={11} />
                      {statusView.label}
                    </span>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    <span className="truncate">{item.bookId === "project" ? "项目任务" : item.bookId}</span>
                    {typeof item.chapter === "number" && <span>第 {item.chapter} 章</span>}
                    <span>{new Date(item.completedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>
                    <span>{formatDuration(item.durationMs)}</span>
                  </div>
                </div>
                <div className="max-w-full text-xs leading-5 text-muted-foreground sm:max-w-sm sm:text-right">
                  {item.error || item.message}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function BookMenu({ bookId, bookTitle, nav, t, onDelete, onOpenChange }: {
  readonly bookId: string;
  readonly bookTitle: string;
  readonly nav: Nav;
  readonly t: TFunction;
  readonly onDelete: () => void;
  readonly onOpenChange?: (open: boolean) => void;
}) {
  const [open, setOpenRaw] = useState(false);
  const setOpen = (next: boolean | ((prev: boolean) => boolean)) => {
    setOpenRaw((prev) => {
      const value = typeof next === "function" ? next(prev) : next;
      onOpenChange?.(value);
      return value;
    });
  };
  const [confirmDelete, setConfirmDelete] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  const handleDelete = async () => {
    setConfirmDelete(false);
    setOpen(false);
    await fetchJson(`/books/${bookId}`, { method: "DELETE" });
    onDelete();
  };

  return (
    <div ref={menuRef} className="relative">
      <button
        onClick={() => setOpen((prev) => !prev)}
        className="p-3 rounded-xl text-muted-foreground hover:text-primary hover:bg-primary/10 hover:scale-105 active:scale-95 transition-all cursor-pointer"
      >
        <MoreVertical size={18} />
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 w-44 bg-card border border-border rounded-xl shadow-lg shadow-primary/5 py-1 z-50 fade-in">
          <button
            onClick={() => { setOpen(false); nav.toBookSettings(bookId); }}
            className="w-full flex items-center gap-2.5 px-4 py-2.5 text-sm text-foreground hover:bg-secondary/50 transition-colors cursor-pointer"
          >
            <Settings size={14} className="text-muted-foreground" />
            {t("book.settings")}
          </button>
          <a
            href={buildApiUrl(`/books/${bookId}/export?format=txt`) ?? "#"}
            download
            onClick={() => setOpen(false)}
            className="w-full flex items-center gap-2.5 px-4 py-2.5 text-sm text-foreground hover:bg-secondary/50 transition-colors cursor-pointer"
          >
            <Download size={14} className="text-muted-foreground" />
            {t("book.export")}
          </a>
          <div className="border-t border-border/50 my-1" />
          <button
            onClick={() => { setOpen(false); setConfirmDelete(true); }}
            className="w-full flex items-center gap-2.5 px-4 py-2.5 text-sm text-destructive hover:bg-destructive/10 transition-colors cursor-pointer"
          >
            <Trash2 size={14} />
            {t("book.deleteBook")}
          </button>
        </div>
      )}
      <ConfirmDialog
        open={confirmDelete}
        title={t("book.deleteBook")}
        message={`${t("book.confirmDelete")}\n\n"${bookTitle}"`}
        confirmLabel={t("common.delete")}
        cancelLabel={t("common.cancel")}
        variant="danger"
        onConfirm={handleDelete}
        onCancel={() => setConfirmDelete(false)}
      />
    </div>
  );
}

export function Dashboard({ nav, sse, theme, t }: { nav: Nav; sse: DashboardSseState; theme: Theme; t: TFunction }) {
  const c = useColors(theme);
  const [menuOpenBookId, setMenuOpenBookId] = useState<string | null>(null);
  const [dismissedTaskAt, setDismissedTaskAt] = useState<number | null>(null);
  const { data, loading, error, refetch } = useApi<{ books: ReadonlyArray<BookSummary> }>("/books");
  const { data: operationHistoryData, refetch: refetchOperationHistory } = useApi<{
    operations: ReadonlyArray<OperationHistoryItem>;
  }>("/operations/history?limit=6");
  const currentTask = useMemo(
    () => pickCurrentTask(sse.activeOperations, sse.messages),
    [sse.activeOperations, sse.messages],
  );
  const visibleCurrentTask = currentTask && dismissedTaskAt !== currentTask.timestamp ? currentTask : null;
  const writingBooks = useMemo(() => {
    const active = new Set(deriveActiveBookIds(sse.messages));
    for (const bookId of deriveBackendActiveBookIds(sse.activeOperations)) {
      active.add(bookId);
    }
    if (currentTask?.bookId && currentTask.status !== "running") {
      active.delete(currentTask.bookId);
    }
    return active;
  }, [currentTask, sse.activeOperations, sse.messages]);
  const serviceStoreServices = useServiceStore((s) => s.services);
  const fetchServices = useServiceStore((s) => s.fetchServices);
  useEffect(() => { void fetchServices(); }, [fetchServices]);
  const hasServices = serviceStoreServices.some((s) => s.connected);

  const progressEvent = useMemo(
    () => selectLatestProgressEvent(sse.messages, visibleCurrentTask ?? undefined),
    [visibleCurrentTask, sse.messages],
  );
  const currentTaskLogs = useMemo(() => getRecentTaskLogs(sse.messages), [sse.messages]);

  useEffect(() => {
    const recent = sse.messages.at(-1);
    if (!recent) return;
    if (shouldRefetchBookCollections(recent)) {
      refetch();
    }
    if (shouldRefetchOperationHistory(recent)) {
      refetchOperationHistory();
    }
  }, [refetch, refetchOperationHistory, sse.messages]);

  if (loading) return (
    <div className="flex flex-col items-center justify-center py-32 space-y-4">
      <div className="w-8 h-8 border-2 border-primary/20 border-t-primary rounded-full animate-spin" />
      <span className="text-sm text-muted-foreground animate-pulse">Gathering manuscripts...</span>
    </div>
  );

  if (error) return (
    <div className="flex flex-col items-center justify-center py-20 bg-destructive/5 border border-destructive/20 rounded-2xl">
      <AlertCircle className="text-destructive mb-4" size={32} />
      <h2 className="text-lg font-semibold text-destructive">Failed to load library</h2>
      <p className="text-sm text-muted-foreground mt-1">{error}</p>
    </div>
  );

  if (!data?.books.length) {
    return (
      <div className="aurora-hero flex min-h-[54vh] flex-col items-start justify-end rounded-[1.5rem] border border-border/55 p-5 text-left shadow-2xl shadow-primary/10 sm:min-h-[62vh] sm:rounded-[2rem] sm:p-10 fade-in">
        <div className="soft-pill mb-5 inline-flex max-w-full items-center gap-2 rounded-full px-3 py-1.5 text-[11px] font-semibold text-primary sm:mb-6 sm:text-xs">
          <BookOpen size={14} />
          <span className="truncate">{t("dash.noBooks")}</span>
        </div>
        <h2 className="max-w-2xl font-serif text-4xl leading-tight text-foreground sm:text-6xl">
          {t("dash.title")}
        </h2>
        <p className="mt-3 max-w-xl text-sm leading-7 text-muted-foreground sm:mt-4 sm:text-base">
          {t("dash.createFirst")}
        </p>
        <button
          onClick={nav.toBookCreate}
          className="mt-6 group flex min-h-12 w-full items-center justify-center gap-2 rounded-full bg-primary px-7 py-3 text-sm font-bold text-primary-foreground shadow-xl shadow-primary/25 transition-all hover:scale-[1.02] active:scale-95 sm:mt-8 sm:w-auto"
        >
          <Plus size={18} />
          {t("nav.newBook")}
        </button>
      </div>
    );
  }

  const totalChapters = data.books.reduce((sum, book) => sum + book.chaptersWritten, 0);
  const activeBooks = data.books.filter((book) => book.status === "active").length;

  return (
    <div className="space-y-5 sm:space-y-8">
      <section className="aurora-hero rounded-[1.5rem] border border-border/55 p-4 shadow-2xl shadow-primary/10 sm:rounded-[2rem] sm:p-8 lg:p-10">
        <div className="flex flex-col gap-5 sm:gap-8 lg:flex-row lg:items-end lg:justify-between">
          <div className="max-w-3xl">
            <div className="soft-pill mb-4 inline-flex max-w-full items-center gap-2 rounded-full px-3 py-1.5 text-[11px] font-semibold text-primary sm:mb-5 sm:text-xs">
              <CheckCircle2 size={14} />
              <span className="truncate">Autonomous story workbench</span>
            </div>
            <h1 className="font-serif text-[2.55rem] leading-tight text-foreground sm:text-5xl lg:text-6xl">
              {t("dash.title")}
            </h1>
            <p className="mt-3 max-w-2xl text-sm leading-7 text-muted-foreground sm:mt-4 sm:text-base">
              {t("dash.subtitle")}
            </p>
          </div>
          <button
            onClick={nav.toBookCreate}
            className="group flex min-h-12 w-full items-center justify-center gap-2 rounded-full bg-primary px-7 py-3 text-sm font-bold text-primary-foreground shadow-xl shadow-primary/25 transition-all hover:scale-[1.02] active:scale-95 sm:w-auto"
          >
            <Plus size={18} />
            {t("nav.newBook")}
          </button>
        </div>

        <div className="mt-5 grid grid-cols-3 gap-2 sm:mt-9 sm:gap-3">
          <div className="soft-pill rounded-2xl px-3 py-3 sm:rounded-3xl sm:px-5 sm:py-4">
            <div className="text-2xl font-semibold text-foreground sm:text-3xl">{data.books.length}</div>
            <div className="mt-1 text-[11px] uppercase tracking-[0.06em] text-muted-foreground sm:text-xs sm:tracking-[0.18em]">{t("nav.books")}</div>
          </div>
          <div className="soft-pill rounded-2xl px-3 py-3 sm:rounded-3xl sm:px-5 sm:py-4">
            <div className="text-2xl font-semibold text-foreground sm:text-3xl">{activeBooks}</div>
            <div className="mt-1 text-[11px] uppercase tracking-[0.06em] text-muted-foreground sm:text-xs sm:tracking-[0.18em]">{t("book.statusActive")}</div>
          </div>
          <div className="soft-pill rounded-2xl px-3 py-3 sm:rounded-3xl sm:px-5 sm:py-4">
            <div className="text-2xl font-semibold text-foreground sm:text-3xl">{totalChapters}</div>
            <div className="mt-1 text-[11px] uppercase tracking-[0.06em] text-muted-foreground sm:text-xs sm:tracking-[0.18em]">{t("dash.chapters")}</div>
          </div>
        </div>
      </section>

      {!hasServices && (
        <div className="glass-panel rounded-3xl px-4 sm:px-5 py-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <div className="text-sm font-medium">还没有配置 AI 模型</div>
            <div className="text-xs text-muted-foreground mt-0.5">配好一个服务商才能开始创作</div>
          </div>
          <button
            onClick={nav.toServices}
            className="px-4 py-2 text-xs rounded-full bg-primary text-primary-foreground font-medium hover:bg-primary/90 transition-colors shrink-0"
          >
            去配置
          </button>
        </div>
      )}

      <div className="grid gap-4 sm:gap-6">
        {data.books.map((book, index) => {
          const isWriting = writingBooks.has(book.id);
          const bookTaskLogs = isWriting ? getRecentTaskLogs(sse.messages, book.id) : [];
          const bookProgressEvent = isWriting
            ? selectLatestProgressEvent(sse.messages, {
                bookId: book.id,
                sessionId: visibleCurrentTask?.bookId === book.id ? visibleCurrentTask.sessionId : null,
                startedAt: visibleCurrentTask?.bookId === book.id ? visibleCurrentTask.startedAt : undefined,
              })
            : undefined;
          const staggerClass = `stagger-${Math.min(index + 1, 5)}`;
          return (
            <div
              key={book.id}
              className={`paper-sheet group relative rounded-[1.5rem] fade-in sm:rounded-2xl ${staggerClass} ${menuOpenBookId === book.id ? "z-50" : ""}`}
            >
              <div className="p-4 sm:p-7 flex flex-col sm:flex-row sm:items-start justify-between gap-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-3 mb-3">
                    <div className="shrink-0 p-2.5 rounded-2xl bg-primary/10 text-primary shadow-inner">
                      <BookOpen size={20} />
                    </div>
                    <button
                      onClick={() => nav.toBook(book.id)}
                      className="block min-w-0 flex-1 truncate text-left font-serif text-xl font-medium transition-all hover:text-primary hover:underline underline-offset-4 decoration-primary/30 sm:text-2xl"
                    >
                      {book.title}
                    </button>
                  </div>

                  <div className="flex flex-wrap items-center gap-y-2 gap-x-4 text-[13px] text-muted-foreground font-medium">
                    <div className="soft-pill flex items-center gap-1.5 rounded-full px-3 py-1">
                      <span className="uppercase tracking-wider">{book.genre}</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <Clock size={14} />
                      <span>{book.chaptersWritten} {t("dash.chapters")}</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <div className={`w-2 h-2 rounded-full ${
                        book.status === "active" ? "bg-emerald-500" :
                        book.status === "paused" ? "bg-amber-500" :
                        "bg-muted-foreground"
                      }`} />
                      <span>{
                        book.status === "active" ? t("book.statusActive") :
                        book.status === "paused" ? t("book.statusPaused") :
                        book.status === "outlining" ? t("book.statusOutlining") :
                        book.status === "completed" ? t("book.statusCompleted") :
                        book.status === "dropped" ? t("book.statusDropped") :
                        book.status
                      }</span>
                    </div>
                    {book.language === "en" && (
                      <span className="px-2 py-0.5 rounded-full border border-primary/20 text-primary text-[10px] font-bold">EN</span>
                    )}
                    {book.fanficMode && (
                      <span className="flex items-center gap-1 text-purple-500">
                        <Zap size={12} />
                        <span className="italic">{book.fanficMode}</span>
                      </span>
                    )}
                  </div>
                </div>

                <div className="flex w-full shrink-0 items-center gap-2 sm:ml-6 sm:w-auto sm:gap-3">
                  <button
                    onClick={async () => {
                      try { await postApi(`/books/${book.id}/write-next`, { mode: "quick" }); }
                      catch (e) { await appAlert({ title: "写作启动失败", message: e instanceof Error ? e.message : "Write failed", tone: "danger" }); }
                    }}
                    disabled={isWriting}
                    className={`flex min-h-11 min-w-0 flex-1 items-center justify-center gap-2 rounded-full px-4 py-2.5 text-sm font-bold transition-all shadow-sm sm:flex-none sm:px-6 sm:py-3 ${
                      isWriting
                        ? "bg-primary/20 text-primary cursor-wait animate-pulse"
                        : "bg-secondary text-foreground hover:bg-primary hover:text-primary-foreground hover:shadow-lg hover:shadow-primary/20 hover:scale-[1.02] active:scale-95"
                    }`}
                  >
                    {isWriting ? (
                      <>
                        <div className="w-4 h-4 border-2 border-primary/20 border-t-primary rounded-full animate-spin" />
                        {t("dash.writing")}
                      </>
                    ) : (
                      <>
                        <Zap size={16} />
                        {t("dash.writeNext")}
                      </>
                    )}
                  </button>
                  <button
                    onClick={() => nav.toAnalytics(book.id)}
                    className="p-2.5 sm:p-3 rounded-full bg-secondary text-muted-foreground hover:text-primary hover:bg-primary/10 hover:border-primary/30 hover:shadow-md hover:scale-105 active:scale-95 transition-all border border-border/50 shadow-sm"
                    title={t("dash.stats")}
                  >
                    <BarChart2 size={18} />
                  </button>
                  <BookMenu
                    bookId={book.id}
                    bookTitle={book.title}
                    nav={nav}
                    t={t}
                    onDelete={() => refetch()}
                    onOpenChange={(isOpen) => setMenuOpenBookId(isOpen ? book.id : null)}
                  />
                </div>
              </div>

              {isWriting && (
                <div className="px-4 pb-4 sm:px-7 sm:pb-6">
                  <TaskExecutionLog
                    compact
                    title="当前任务执行日志"
                    subtitle={visibleCurrentTask?.bookId === book.id ? visibleCurrentTask.label : "正在执行写作任务"}
                    entries={bookTaskLogs}
                    progressEvent={bookProgressEvent}
                    startedAt={visibleCurrentTask?.bookId === book.id ? visibleCurrentTask.startedAt : undefined}
                  />
                </div>
              )}

              {/* Enhanced progress indicator */}
              {isWriting && (
                <div className="absolute bottom-0 left-0 right-0 h-1 bg-secondary overflow-hidden">
                   <div className="h-full bg-primary w-1/3 animate-[progress_2s_ease-in-out_infinite]" />
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Current task execution log */}
      {visibleCurrentTask && currentTaskLogs.length > 0 && writingBooks.size === 0 && (
        <div className="glass-panel rounded-[2rem] p-4 sm:p-8 border-primary/20 bg-primary/[0.02] shadow-2xl shadow-primary/5 fade-in">
          <TaskExecutionLog
            title="当前任务执行日志"
            subtitle={visibleCurrentTask.label}
            entries={currentTaskLogs}
            progressEvent={progressEvent}
            startedAt={visibleCurrentTask.startedAt}
            onClear={visibleCurrentTask.status !== "running" ? () => setDismissedTaskAt(visibleCurrentTask.timestamp) : undefined}
          />
        </div>
      )}

      <RecentTaskHistory items={operationHistoryData?.operations ?? []} />

      <style>{`
        @keyframes progress {
          0% { transform: translateX(-100%); }
          100% { transform: translateX(300%); }
        }
      `}</style>
    </div>
  );
}
