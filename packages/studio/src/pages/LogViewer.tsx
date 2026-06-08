import { useEffect, useMemo, useState } from "react";
import { fetchJson, useApi } from "../hooks/use-api";
import type { Theme } from "../hooks/use-theme";
import type { TFunction } from "../hooks/use-i18n";
import { useColors } from "../hooks/use-colors";
import type { ActiveOperation, SSEMessage } from "../hooks/use-sse";

interface LogEntry {
  readonly level?: string;
  readonly tag?: string;
  readonly message: string;
  readonly timestamp?: string;
}

interface Nav {
  toDashboard: () => void;
}

interface LogViewerSseState {
  readonly messages: ReadonlyArray<SSEMessage>;
  readonly activeOperations?: ReadonlyArray<ActiveOperation>;
}

const LEVEL_COLORS: Record<string, string> = {
  error: "text-destructive",
  warn: "text-amber-500",
  info: "text-primary/70",
  debug: "text-muted-foreground/50",
};

const MAX_VISIBLE_LOGS = 500;

function normalizeSseLog(data: unknown): LogEntry | null {
  if (!data || typeof data !== "object") {
    return null;
  }
  const candidate = data as Partial<LogEntry>;
  if (typeof candidate.message !== "string") {
    return null;
  }
  return {
    message: candidate.message,
    ...(typeof candidate.level === "string" ? { level: candidate.level } : {}),
    ...(typeof candidate.tag === "string" ? { tag: candidate.tag } : {}),
    ...(typeof candidate.timestamp === "string" ? { timestamp: candidate.timestamp } : {}),
  };
}

function logKey(entry: LogEntry): string {
  return `${entry.timestamp ?? ""}\u0000${entry.level ?? ""}\u0000${entry.tag ?? ""}\u0000${entry.message}`;
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

function formatOperationElapsed(operation: ActiveOperation, now = Date.now()): string {
  const startedAt = operation.startedAt ?? operation.updatedAt;
  if (!startedAt) return "刚刚";
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}m ${rest}s`;
}

export function LogViewer({ nav, theme, t, sse }: { nav: Nav; theme: Theme; t: TFunction; sse: LogViewerSseState }) {
  const c = useColors(theme);
  const { data, refetch } = useApi<{ entries: ReadonlyArray<LogEntry> }>("/logs");
  const { messages, activeOperations = [] } = sse;
  const [liveEntries, setLiveEntries] = useState<ReadonlyArray<LogEntry>>([]);
  const [clearing, setClearing] = useState(false);
  const [clearError, setClearError] = useState<string | null>(null);
  const liveNow = useLiveNow(activeOperations.length > 0);

  useEffect(() => {
    setLiveEntries(data?.entries ?? []);
  }, [data?.entries]);

  useEffect(() => {
    const lastMessage = messages[messages.length - 1];
    if (lastMessage?.event === "logs:clear") {
      setLiveEntries([]);
      return;
    }
    if (lastMessage?.event !== "log") {
      return;
    }
    const entry = normalizeSseLog(lastMessage.data);
    if (!entry) {
      return;
    }
    setLiveEntries((current) => {
      const next = [...current, entry];
      const seen = new Set<string>();
      return next
        .filter((item) => {
          const key = logKey(item);
          if (seen.has(key)) {
            return false;
          }
          seen.add(key);
          return true;
        })
        .slice(-MAX_VISIBLE_LOGS);
    });
  }, [messages]);

  const entries = useMemo(() => liveEntries.slice(-MAX_VISIBLE_LOGS), [liveEntries]);

  const handleClear = async () => {
    setClearing(true);
    setClearError(null);
    setLiveEntries([]);
    try {
      await fetchJson<{ status: string }>("/logs", { method: "DELETE" });
    } catch (e) {
      setClearError(e instanceof Error ? e.message : String(e));
      void refetch();
    } finally {
      setClearing(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <button onClick={nav.toDashboard} className={c.link}>{t("bread.home")}</button>
        <span className="text-border">/</span>
        <span className="text-foreground">{t("logs.title")}</span>
      </div>

      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="font-serif text-3xl">{t("logs.title")}</h1>
        <div className="flex items-center gap-2">
          <button
            onClick={handleClear}
            disabled={clearing || entries.length === 0}
            className={`px-4 py-2.5 text-sm rounded-md ${c.btnSecondary} disabled:opacity-45`}
          >
            {clearing ? t("common.loading") : t("common.clear")}
          </button>
          <button
            onClick={() => refetch()}
            className={`px-4 py-2.5 text-sm rounded-md ${c.btnSecondary}`}
          >
            {t("common.refresh")}
          </button>
        </div>
      </div>

      {activeOperations.length > 0 && (
        <section className="rounded-3xl border border-primary/20 bg-primary/[0.045] p-4 shadow-lg shadow-primary/5">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-xs font-semibold text-primary">当前后端任务</div>
              <div className="mt-1 truncate text-base font-bold text-foreground">
                {activeOperations[0]?.label ?? "任务正在执行"}
              </div>
            </div>
            <span className="shrink-0 rounded-full bg-primary/12 px-3 py-1.5 text-xs font-bold text-primary">
              {formatOperationElapsed(activeOperations[0], liveNow)}
            </span>
          </div>
          <p className="mt-3 text-sm leading-6 text-muted-foreground">
            {activeOperations[0]?.message ?? "Node 后端仍在处理任务，切换页面不会中断执行。"}
          </p>
        </section>
      )}

      {clearError && (
        <div className="rounded-lg border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {clearError}
        </div>
      )}

      <div className={`border ${c.cardStatic} rounded-lg overflow-hidden`}>
        <div className="max-h-[600px] overflow-y-auto overflow-x-hidden p-2.5 sm:p-4">
          {entries.length > 0 ? (
            <div className="space-y-1 font-mono text-[11px] leading-5 sm:text-xs sm:leading-5">
              {entries.map((entry, i) => (
                <div
                  key={i}
                  className="grid grid-cols-[4.35rem_2.7rem_minmax(0,1fr)] items-start gap-1.5 rounded-xl px-2 py-1.5 sm:grid-cols-[5.2rem_3.5rem_7.5rem_minmax(0,1fr)] sm:gap-2.5 sm:px-3"
                >
                  <span className="text-muted-foreground tabular-nums">
                    {entry.timestamp ? new Date(entry.timestamp).toLocaleTimeString() : "--:--:--"}
                  </span>
                  <span className={`uppercase ${LEVEL_COLORS[entry.level ?? ""] ?? "text-muted-foreground"}`}>
                    {entry.level ?? "info"}
                  </span>
                  <span className="hidden truncate text-primary/70 sm:block">
                    {entry.tag ? `[${entry.tag}]` : "[app]"}
                  </span>
                  <span className="min-w-0 break-words text-foreground/80">
                    <span className="mr-1 text-primary/70 sm:hidden">
                      {entry.tag ? `[${entry.tag}]` : "[app]"}
                    </span>
                    {entry.message}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-muted-foreground text-sm italic py-12 text-center">
              {t("logs.empty")}
            </div>
          )}
        </div>
      </div>

      <p className="text-sm text-muted-foreground">
        {t("logs.showingRecent")}
      </p>
    </div>
  );
}
