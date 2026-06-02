import { useEffect, useMemo, useState } from "react";
import { useApi } from "../hooks/use-api";
import type { Theme } from "../hooks/use-theme";
import type { TFunction } from "../hooks/use-i18n";
import { useColors } from "../hooks/use-colors";
import { useSSE } from "../hooks/use-sse";

interface LogEntry {
  readonly level?: string;
  readonly tag?: string;
  readonly message: string;
  readonly timestamp?: string;
}

interface Nav {
  toDashboard: () => void;
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

export function LogViewer({ nav, theme, t }: { nav: Nav; theme: Theme; t: TFunction }) {
  const c = useColors(theme);
  const { data, refetch } = useApi<{ entries: ReadonlyArray<LogEntry> }>("/logs");
  const { messages } = useSSE();
  const [liveEntries, setLiveEntries] = useState<ReadonlyArray<LogEntry>>([]);

  useEffect(() => {
    setLiveEntries(data?.entries ?? []);
  }, [data?.entries]);

  useEffect(() => {
    const lastMessage = messages[messages.length - 1];
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

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <button onClick={nav.toDashboard} className={c.link}>{t("bread.home")}</button>
        <span className="text-border">/</span>
        <span className="text-foreground">{t("logs.title")}</span>
      </div>

      <div className="flex items-baseline justify-between">
        <h1 className="font-serif text-3xl">{t("logs.title")}</h1>
        <button
          onClick={() => refetch()}
          className={`px-4 py-2.5 text-sm rounded-md ${c.btnSecondary}`}
        >
          {t("common.refresh")}
        </button>
      </div>

      <div className={`border ${c.cardStatic} rounded-lg overflow-hidden`}>
        <div className="p-4 max-h-[600px] overflow-y-auto">
          {entries.length > 0 ? (
            <div className="space-y-1 font-mono text-sm leading-relaxed">
              {entries.map((entry, i) => (
                <div key={i} className="flex gap-2">
                  {entry.timestamp && (
                    <span className="text-muted-foreground shrink-0 w-20 tabular-nums">
                      {new Date(entry.timestamp).toLocaleTimeString()}
                    </span>
                  )}
                  {entry.level && (
                    <span className={`shrink-0 w-12 uppercase ${LEVEL_COLORS[entry.level] ?? "text-muted-foreground"}`}>
                      {entry.level}
                    </span>
                  )}
                  {entry.tag && (
                    <span className="text-primary/70 shrink-0">[{entry.tag}]</span>
                  )}
                  <span className="text-foreground/80">{entry.message}</span>
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
