import { useEffect, useState } from "react";
import { fetchJson } from "../../hooks/use-api";
import { useChatStore } from "../../store/chat";
import { SidebarCard } from "./SidebarCard";
import { cn } from "../../lib/utils";

interface ChapterMeta {
  number: number;
  title: string;
  status: string;
  wordCount: number;
}

const STATUS_INDICATOR: Record<string, { symbol: string; color: string }> = {
  approved: { symbol: "✓", color: "text-emerald-500" },
  "ready-for-review": { symbol: "◆", color: "text-amber-500" },
  drafted: { symbol: "○", color: "text-muted-foreground" },
  "needs-revision": { symbol: "✕", color: "text-destructive" },
  imported: { symbol: "◇", color: "text-blue-500" },
};

interface ChaptersSectionProps {
  readonly bookId: string;
  readonly isZh: boolean;
}

export function ChaptersSection({ bookId, isZh }: ChaptersSectionProps) {
  const [chapters, setChapters] = useState<ReadonlyArray<ChapterMeta>>([]);
  const [loading, setLoading] = useState(true);
  const bookDataVersion = useChatStore((s) => s.bookDataVersion);

  useEffect(() => {
    setLoading(true);
    fetchJson<{ chapters: ChapterMeta[] }>(`/books/${bookId}`)
      .then((data) => {
        setChapters(data.chapters);
        setLoading(false);
      })
      .catch(() => {
        setChapters([]);
        setLoading(false);
      });
  }, [bookId, bookDataVersion]);

  return (
    <SidebarCard title={isZh ? "章节" : "Chapters"}>
      {loading && chapters.length === 0 ? (
        <div className="flex items-center justify-center py-4">
          <div className="w-4 h-4 border-2 border-primary/20 border-t-primary rounded-full animate-spin" />
        </div>
      ) : chapters.length === 0 ? (
        <p className="text-[15px] leading-6 text-muted-foreground/50 italic px-1">
          {isZh ? "暂无章节" : "No chapters"}
        </p>
      ) : (
        <ul className={cn(
          "space-y-1 max-h-52 overflow-y-auto overflow-x-hidden transition-opacity duration-200",
          loading ? "opacity-50" : "opacity-100"
        )}>
          {chapters.map((ch) => {
            const ind = STATUS_INDICATOR[ch.status] ?? { symbol: "○", color: "text-muted-foreground" };
            return (
              <li
                key={`${ch.number}-${ch.title ?? ""}`}
                onClick={() => useChatStore.getState().openChapterArtifact(ch.number)}
                className="flex items-center gap-2 py-1 text-[15px] leading-6 text-muted-foreground cursor-pointer hover:text-foreground transition-colors rounded px-1 -mx-1 hover:bg-secondary/50">
                <span className={cn("text-[13px] shrink-0", ind.color)}>{ind.symbol}</span>
                <span className="truncate flex-1">
                  {String(ch.number).padStart(2, "0")} {ch.title || (isZh ? `第${ch.number}章` : `Chapter ${ch.number}`)}
                </span>
                <span className="tabular-nums text-[13px] text-muted-foreground/50 shrink-0">
                  {(ch.wordCount ?? 0).toLocaleString()}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </SidebarCard>
  );
}
