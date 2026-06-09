import { useEffect } from "react";
import { LazyStreamdown } from "../ai-elements/lazy-streamdown";
import { useChatStore } from "../../store/chat";
import type { BookSummary } from "../../store/chat";
import { fetchJson } from "../../hooks/use-api";
import { SidebarCard } from "./SidebarCard";

const SIDEBAR_MD_CLASS =
  "text-xs text-muted-foreground leading-relaxed " +
  "[&>*:first-child]:mt-0 [&>*:last-child]:mb-0 " +
  "[&>p+p]:mt-1.5 [&_strong]:text-foreground [&_strong]:font-medium " +
  "[&_ul]:list-disc [&_ul]:pl-4 [&_ol]:list-decimal [&_ol]:pl-4 [&_li]:my-0.5 " +
  "[&_h1]:hidden [&_h2]:text-xs [&_h2]:font-medium [&_h2]:text-foreground [&_h2]:mt-1.5 [&_h2]:mb-0.5 " +
  "[&_h3]:text-xs [&_h3]:font-medium [&_h3]:text-foreground [&_h3]:mt-1.5 [&_h3]:mb-0.5 " +
  "[&_code]:text-[11px] [&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded [&_code]:bg-secondary/60";

const bookSummaryCache = new Map<string, BookSummary | null>();

function parseStoryBible(content: string): BookSummary {
  const normalized = content.replace(/^---[\s\S]*?---\s*/m, "").trim();
  const sections = normalized.split(/^##\s+/m);
  let world = "";
  let protagonist = "";
  let cast = "";

  for (const section of sections) {
    if (/^0?1[_\s]|世界观|world/i.test(section)) {
      world = section.replace(/^[^\n]+\n/, "").trim().split("\n\n")[0] ?? "";
    } else if (/^0?2[_\s]|主角|protagonist/i.test(section)) {
      protagonist = section.replace(/^[^\n]+\n/, "").trim().split("\n\n")[0] ?? "";
    } else if (/^0?3[_\s]|配角|supporting|cast/i.test(section)) {
      cast = section.replace(/^[^\n]+\n/, "").trim().split("\n\n")[0] ?? "";
    }
  }

  if (!world) {
    world = normalized
      .split(/\n{2,}/)
      .map((part) => part.trim())
      .filter((part) => part && !/^#/.test(part))
      .slice(0, 2)
      .join("\n\n");
  }

  return { world, protagonist, cast };
}

interface SummarySectionProps {
  readonly bookId: string;
}

export function SummarySection({ bookId }: SummarySectionProps) {
  const summary = useChatStore((s) => s.bookSummary);
  const setBookSummary = useChatStore((s) => s.setBookSummary);
  const bookDataVersion = useChatStore((s) => s.bookDataVersion);

  useEffect(() => {
    let ignore = false;
    if (bookSummaryCache.has(bookId)) {
      setBookSummary(bookSummaryCache.get(bookId) ?? null);
    } else {
      setBookSummary(null);
    }

    fetchJson<{ content: string | null }>(`/books/${bookId}/truth/outline/story_frame.md`)
      .then((data) => {
        if (ignore) return;
        const nextSummary = data.content ? parseStoryBible(data.content) : null;
        bookSummaryCache.set(bookId, nextSummary);
        setBookSummary(nextSummary);
      })
      .catch(() => {
        fetchJson<{ content: string | null }>(`/books/${bookId}/truth/story_bible.md`)
          .then((data) => {
            if (ignore) return;
            const nextSummary = data.content ? parseStoryBible(data.content) : null;
            bookSummaryCache.set(bookId, nextSummary);
            setBookSummary(nextSummary);
          })
          .catch(() => {});
      });

    return () => {
      ignore = true;
    };
  }, [bookId, bookDataVersion, setBookSummary]);

  if (!summary) return null;

  return (
    <>
      {summary.world && (
        <SidebarCard title="世界观">
          <LazyStreamdown className={SIDEBAR_MD_CLASS}>
            {summary.world}
          </LazyStreamdown>
        </SidebarCard>
      )}
      {(summary.protagonist || summary.cast) && (
        <SidebarCard title="角色">
          {summary.protagonist && (
            <LazyStreamdown className={SIDEBAR_MD_CLASS}>
              {summary.protagonist}
            </LazyStreamdown>
          )}
          {summary.cast && (
            <div className={summary.protagonist ? "mt-2" : undefined}>
              <LazyStreamdown className={SIDEBAR_MD_CLASS}>
                {summary.cast}
              </LazyStreamdown>
            </div>
          )}
        </SidebarCard>
      )}
    </>
  );
}
