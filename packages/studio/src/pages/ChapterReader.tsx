import { useState } from "react";
import { fetchJson, useApi, postApi } from "../hooks/use-api";
import type { Theme } from "../hooks/use-theme";
import type { TFunction } from "../hooks/use-i18n";
import { useColors } from "../hooks/use-colors";
import { appAlert } from "../lib/app-dialog";
import {
  ChevronLeft,
  Check,
  X,
  List,
  RotateCcw,
  BookOpen,
  CheckCircle2,
  XCircle,
  Hash,
  Type,
  Clock,
  Pencil,
  Save,
  Eye,
  Copy,
  Download,
} from "lucide-react";

interface ChapterData {
  readonly chapterNumber: number;
  readonly filename: string;
  readonly content: string;
}

interface Nav {
  toBookSettings: (id: string) => void;
  toDashboard: () => void;
}

function stripChapterHeadingPrefix(heading: string, chapterNumber: number): string {
  return heading
    .replace(new RegExp(`^第\\s*${chapterNumber}\\s*章[\\s:：、.-]*`), "")
    .replace(new RegExp(`^Chapter\\s+${chapterNumber}\\s*[:：.-]?\\s*`, "i"), "")
    .trim();
}

export function ChapterReader({ bookId, chapterNumber, nav, theme, t }: {
  bookId: string;
  chapterNumber: number;
  nav: Nav;
  theme: Theme;
  t: TFunction;
}) {
  const c = useColors(theme);
  const { data, loading, error, refetch } = useApi<ChapterData>(
    `/books/${bookId}/chapters/${chapterNumber}`,
  );
  const [editing, setEditing] = useState(false);
  const [editTitle, setEditTitle] = useState("");
  const [editContent, setEditContent] = useState("");
  const [saving, setSaving] = useState(false);

  const handleStartEdit = () => {
    if (!data) return;
    const titleLine = data.content.split("\n").find((l) => l.startsWith("# "));
    const heading = titleLine?.replace(/^#\s*/, "") ?? `Chapter ${chapterNumber}`;
    setEditTitle(stripChapterHeadingPrefix(heading, chapterNumber) || heading);
    setEditContent(data.content);
    setEditing(true);
  };

  const handleCancelEdit = () => {
    setEditing(false);
    setEditTitle("");
    setEditContent("");
  };

  const handleSave = async () => {
    const title = editTitle.trim();
    if (!title) {
      await appAlert({ title: "保存失败", message: "章节标题不能为空", tone: "danger" });
      return;
    }
    setSaving(true);
    try {
      await fetchJson(`/books/${bookId}/chapters/${chapterNumber}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: editContent, title }),
      });
      setEditing(false);
      setEditTitle("");
      refetch();
    } catch (e) {
      await appAlert({ title: "保存失败", message: e instanceof Error ? e.message : "Save failed", tone: "danger" });
    } finally {
      setSaving(false);
    }
  };

  if (loading) return (
    <div className="flex flex-col items-center justify-center py-32 space-y-4">
      <div className="w-8 h-8 border-2 border-primary/20 border-t-primary rounded-full animate-spin" />
      <span className="text-sm text-muted-foreground">{t("reader.openingManuscript")}</span>
    </div>
  );

  if (error) return <div className="text-destructive p-8 bg-destructive/5 rounded-xl border border-destructive/20">Error: {error}</div>;
  if (!data) return null;

  // Split markdown content into title and body
  const lines = data.content.split("\n");
  const titleLine = lines.find((l) => l.startsWith("# "));
  const title = titleLine?.replace(/^#\s*/, "") ?? `Chapter ${chapterNumber}`;
  const body = lines
    .filter((l) => l !== titleLine)
    .join("\n")
    .trim();

  const handleApprove = async () => {
    try {
      await postApi(`/books/${bookId}/chapters/${chapterNumber}/approve`);
      nav.toBookSettings(bookId);
    } catch (e) {
      await appAlert({ title: "操作失败", message: e instanceof Error ? e.message : "Approve failed", tone: "danger" });
    }
  };

  const handleReject = async () => {
    try {
      await postApi(`/books/${bookId}/chapters/${chapterNumber}/reject`);
      nav.toBookSettings(bookId);
    } catch (e) {
      await appAlert({ title: "操作失败", message: e instanceof Error ? e.message : "Reject failed", tone: "danger" });
    }
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(data.content);
      await appAlert({ title: "复制成功", message: "章节 Markdown 已复制到剪贴板。", tone: "success" });
    } catch {
      await appAlert({ title: "复制失败", message: "系统未允许访问剪贴板，请稍后重试。", tone: "danger" });
    }
  };

  const handleExport = () => {
    const blob = new Blob([data.content], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `chapter-${chapterNumber.toString().padStart(2, "0")}.md`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const paragraphs = body.split(/\n\n+/).filter(Boolean);
  const actionClass = "flex min-h-16 min-w-0 flex-col items-center justify-center gap-1 rounded-xl border px-2 py-2 text-center text-[11px] font-bold leading-4 transition-all sm:min-h-0 sm:flex-row sm:gap-2 sm:px-4 sm:text-xs";

  return (
    <div className="max-w-4xl mx-auto space-y-10 fade-in">
      {/* Navigation & Actions */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-6">
        <nav className="flex items-center gap-2 text-[13px] font-medium text-muted-foreground">
          <button
            onClick={() => nav.toBookSettings(bookId)}
            className="hover:text-primary transition-colors flex items-center gap-1"
          >
            {t("bread.books")}
          </button>
          <span className="text-border">/</span>
          <button
            onClick={() => nav.toBookSettings(bookId)}
            className="hover:text-primary transition-colors truncate max-w-[120px]"
          >
            {bookId}
          </button>
          <span className="text-border">/</span>
          <span className="text-foreground flex items-center gap-1">
            <Hash size={12} />
            {chapterNumber}
          </span>
        </nav>

        <div className="grid w-full grid-cols-3 gap-2 sm:flex sm:w-auto">
          <button
            onClick={() => nav.toBookSettings(bookId)}
            className={`${actionClass} bg-secondary text-muted-foreground hover:bg-secondary/80 hover:text-foreground border-border/50`}
          >
            <List size={14} />
            {t("reader.backToList")}
          </button>

          {/* Edit / Preview toggle */}
          {editing ? (
            <>
              <button
                onClick={handleSave}
                disabled={saving}
                className={`${actionClass} border-primary/20 bg-primary text-primary-foreground shadow-sm hover:scale-[1.02] active:scale-95 disabled:opacity-50`}
              >
                {saving ? <div className="w-3.5 h-3.5 border-2 border-primary-foreground/20 border-t-primary-foreground rounded-full animate-spin" /> : <Save size={14} />}
                {saving ? t("book.saving") : t("book.save")}
              </button>
              <button
                onClick={handleCancelEdit}
                className={`${actionClass} bg-secondary text-muted-foreground hover:text-foreground border-border/50`}
              >
                <Eye size={14} />
                {t("reader.preview")}
              </button>
            </>
          ) : (
            <button
              onClick={handleStartEdit}
              className={`${actionClass} bg-secondary text-muted-foreground hover:bg-primary/10 hover:text-primary border-border/50`}
            >
              <Pencil size={14} />
              {t("reader.edit")}
            </button>
          )}

          <button
            onClick={handleCopy}
            className={`${actionClass} bg-secondary text-muted-foreground hover:bg-primary/10 hover:text-primary border-border/50`}
          >
            <Copy size={14} />
            复制
          </button>
          <button
            onClick={handleExport}
            className={`${actionClass} bg-secondary text-muted-foreground hover:bg-primary/10 hover:text-primary border-border/50`}
          >
            <Download size={14} />
            导出
          </button>
          <button
            onClick={handleApprove}
            className={`${actionClass} border-emerald-500/20 bg-emerald-500/10 text-emerald-600 shadow-sm hover:bg-emerald-500 hover:text-white`}
          >
            <CheckCircle2 size={14} />
            {t("reader.approve")}
          </button>
          <button
            onClick={handleReject}
            className={`${actionClass} border-destructive/20 bg-destructive/10 text-destructive shadow-sm hover:bg-destructive hover:text-white`}
          >
            <XCircle size={14} />
            {t("reader.reject")}
          </button>
        </div>
      </div>

      {/* Manuscript Sheet */}
      <div className="paper-sheet rounded-2xl p-8 md:p-16 lg:p-24 shadow-2xl shadow-primary/5 min-h-[80vh] relative overflow-hidden">
        {/* Physical Paper Details */}
        <div className="absolute top-0 left-8 w-px h-full bg-primary/5 hidden md:block" />
        <div className="absolute top-0 right-8 w-px h-full bg-primary/5 hidden md:block" />

        <header className="mb-12 flex w-full flex-col items-center text-center md:mb-16">
          <div className="flex items-center justify-center gap-2 text-muted-foreground/30 mb-8 select-none">
            <div className="h-px w-12 bg-border/40" />
            <BookOpen size={20} />
            <div className="h-px w-12 bg-border/40" />
          </div>
          {editing ? (
            <label className="block w-full max-w-2xl text-left">
              <span className="mb-2 block text-xs font-bold uppercase tracking-[0.2em] text-muted-foreground/60">
                {t("reader.chapterTitle")}
              </span>
              <input
                value={editTitle}
                onChange={(e) => setEditTitle(e.target.value)}
                className="block w-full rounded-xl border border-border/40 bg-background/60 px-4 py-3 text-center font-serif text-2xl font-medium text-foreground shadow-sm outline-none transition-all focus:border-primary/50 focus:ring-2 focus:ring-primary/10 md:text-4xl"
                autoFocus
              />
            </label>
          ) : (
            <h1 className="block w-full break-words px-1 text-3xl font-serif font-medium italic text-foreground tracking-normal leading-tight md:text-5xl">
              {title}
            </h1>
          )}
          <div className="mt-8 flex items-center justify-center gap-4 text-[10px] font-bold uppercase tracking-[0.2em] text-muted-foreground/60">
            <span>{t("reader.manuscriptPage")}</span>
            <span className="text-border">·</span>
            <span>{chapterNumber.toString().padStart(2, '0')}</span>
          </div>
        </header>

        {editing ? (
          <textarea
            value={editContent}
            onChange={(e) => setEditContent(e.target.value)}
            className="w-full min-h-[78dvh] bg-transparent font-serif text-base leading-[1.8] text-foreground/90 focus:outline-none resize-y border border-border/30 rounded-lg p-4 focus:border-primary/40 focus:ring-2 focus:ring-primary/10 transition-all sm:min-h-[72vh] sm:p-6 sm:text-lg"
          />
        ) : (
          <article className="prose prose-zinc dark:prose-invert max-w-none">
            {paragraphs.map((para, i) => (
              <p key={i} className="font-serif text-lg md:text-xl leading-[1.8] text-foreground/90 mb-8 first-letter:text-2xl first-letter:font-bold first-letter:text-primary/40">
                {para}
              </p>
            ))}
          </article>
        )}

        <footer className="mt-24 pt-12 border-t border-border/20 flex flex-col items-center gap-6 text-center">
          <div className="flex items-center gap-4 text-xs font-medium text-muted-foreground">
             <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-secondary/50">
               <Type size={14} className="text-primary/60" />
               <span>{body.length.toLocaleString()} {t("reader.characters")}</span>
             </div>
             <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-secondary/50">
               <Clock size={14} className="text-primary/60" />
               <span>{Math.ceil(body.length / 500)} {t("reader.minRead")}</span>
             </div>
          </div>
          <p className="text-[10px] uppercase tracking-widest text-muted-foreground/40 font-bold">{t("reader.endOfChapter")}</p>
        </footer>
      </div>

      {/* Footer Navigation */}
      <div className="flex justify-between items-center py-8">
        {chapterNumber > 1 ? (
          <button
            onClick={() => nav.toBookSettings(bookId)}
            className="flex items-center gap-2 text-sm font-bold text-muted-foreground hover:text-primary transition-all group"
          >
            <RotateCcw size={16} className="group-hover:-rotate-45 transition-transform" />
            {t("reader.chapterList")}
          </button>
        ) : (
          <div />
        )}
      </div>
    </div>
  );
}
