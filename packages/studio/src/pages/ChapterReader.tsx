import { useRef, useState } from "react";
import { Directory, Encoding, Filesystem } from "@capacitor/filesystem";
import { fetchJson, useApi, postApi } from "../hooks/use-api";
import type { Theme } from "../hooks/use-theme";
import type { TFunction } from "../hooks/use-i18n";
import { useColors } from "../hooks/use-colors";
import { mobileTextInputHandlers } from "../lib/mobile-input";
import { isNativeRuntime } from "../lib/mobile-runtime";
import { appAlert, appConfirm } from "../lib/app-dialog";
import { formatChapterForReading, makeTxtFilename } from "../lib/chapter-text";
import {
  ChevronLeft,
  Copy,
  Download,
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
  Trash2,
} from "lucide-react";

interface ChapterData {
  readonly chapterNumber: number;
  readonly filename: string;
  readonly content: string;
}

interface Nav {
  toBook: (id: string) => void;
  toBookSettings: (id: string) => void;
  toDashboard: () => void;
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
  const [editContent, setEditContent] = useState("");
  const [saving, setSaving] = useState(false);
  const [copyState, setCopyState] = useState<"idle" | "copied">("idle");
  const [exportState, setExportState] = useState<"idle" | "done">("idle");
  const [deleting, setDeleting] = useState(false);
  const editRef = useRef<HTMLTextAreaElement>(null);

  const handleStartEdit = () => {
    if (!data) return;
    setEditContent(data.content);
    setEditing(true);
  };

  const handleCancelEdit = () => {
    setEditing(false);
    setEditContent("");
  };

  const handleSave = async () => {
    const nextContent = editRef.current?.value ?? editContent;
    setEditContent(nextContent);
    setSaving(true);
    try {
      await fetchJson(`/books/${bookId}/chapters/${chapterNumber}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: nextContent }),
      });
      setEditing(false);
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

  const formatted = formatChapterForReading(data.content, chapterNumber);
  const { title, body, paragraphs, plainText } = formatted;

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
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(plainText);
      } else {
        const textarea = document.createElement("textarea");
        textarea.value = plainText;
        textarea.setAttribute("readonly", "true");
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand("copy");
        document.body.removeChild(textarea);
      }
      setCopyState("copied");
      window.setTimeout(() => setCopyState("idle"), 1600);
    } catch (e) {
      await appAlert({ title: "复制失败", message: e instanceof Error ? e.message : "Copy failed", tone: "danger" });
    }
  };

  const handleExportTxt = async () => {
    const filename = makeTxtFilename(bookId, chapterNumber, title);
    try {
      if (isNativeRuntime()) {
        const path = `InkOS Studio/exports/${filename}`;
        await Filesystem.writeFile({
          path,
          data: plainText,
          directory: Directory.Documents,
          encoding: Encoding.UTF8,
          recursive: true,
        });
        setExportState("done");
        window.setTimeout(() => setExportState("idle"), 1800);
        await appAlert({ title: t("reader.exported"), message: `${t("reader.exportedTxt")}\nDocuments/${path}`, tone: "success" });
        return;
      }

      const blob = new Blob([plainText], { type: "text/plain;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      link.rel = "noopener";
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
      setExportState("done");
      window.setTimeout(() => setExportState("idle"), 1800);
    } catch (e) {
      await handleCopy().catch(() => undefined);
      await appAlert({ title: t("reader.exportFailed"), message: e instanceof Error ? e.message : t("reader.exportFailed"), tone: "danger" });
    }
  };

  const handleDeleteChapter = async () => {
    if (!await appConfirm({ title: t("reader.deleteChapter"), message: t("reader.deleteConfirm"), tone: "danger", confirmLabel: t("reader.deleteChapter") })) return;
    setDeleting(true);
    try {
      await fetchJson(`/books/${bookId}/chapters/${chapterNumber}`, { method: "DELETE" });
      nav.toBookSettings(bookId);
    } catch (e) {
      await appAlert({ title: "删除失败", message: e instanceof Error ? e.message : "Delete failed", tone: "danger" });
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="max-w-4xl mx-auto space-y-10 fade-in">
      {/* Navigation & Actions */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 md:gap-6">
        <nav className="flex items-center gap-2 text-[13px] font-medium text-muted-foreground">
          <button
            onClick={nav.toDashboard}
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

        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => nav.toBookSettings(bookId)}
            className="flex items-center gap-2 px-4 py-2 text-xs font-bold bg-secondary text-muted-foreground rounded-xl hover:text-foreground hover:bg-secondary/80 transition-all border border-border/50"
          >
            <ChevronLeft size={14} />
            {t("reader.backToList")}
          </button>

          {/* Edit / Preview toggle */}
          {editing ? (
            <>
              <button
                onClick={handleSave}
                disabled={saving}
                className="flex items-center gap-2 px-4 py-2 text-xs font-bold bg-primary text-primary-foreground rounded-xl hover:scale-105 active:scale-95 transition-all shadow-sm disabled:opacity-50"
              >
                {saving ? <div className="w-3.5 h-3.5 border-2 border-primary-foreground/20 border-t-primary-foreground rounded-full animate-spin" /> : <Save size={14} />}
                {saving ? t("book.saving") : t("book.save")}
              </button>
              <button
                onClick={handleCancelEdit}
                className="flex items-center gap-2 px-4 py-2 text-xs font-bold bg-secondary text-muted-foreground rounded-xl hover:text-foreground transition-all border border-border/50"
              >
                <Eye size={14} />
                {t("reader.preview")}
              </button>
            </>
          ) : (
            <button
              onClick={handleStartEdit}
              className="flex items-center gap-2 px-4 py-2 text-xs font-bold bg-secondary text-muted-foreground rounded-xl hover:text-primary hover:bg-primary/10 transition-all border border-border/50"
            >
              <Pencil size={14} />
              {t("reader.edit")}
            </button>
          )}

          <button
            onClick={handleCopy}
            className="flex items-center gap-2 px-4 py-2 text-xs font-bold bg-secondary text-muted-foreground rounded-xl hover:text-primary hover:bg-primary/10 transition-all border border-border/50"
            aria-label={copyState === "copied" ? t("reader.copied") : t("reader.copy")}
          >
            {copyState === "copied" ? <CheckCircle2 size={14} /> : <Copy size={14} />}
            {copyState === "copied" ? t("reader.copied") : t("reader.copy")}
          </button>

          <button
            onClick={handleExportTxt}
            className="flex items-center gap-2 px-4 py-2 text-xs font-bold bg-secondary text-muted-foreground rounded-xl hover:text-primary hover:bg-primary/10 transition-all border border-border/50"
            aria-label={t("reader.exportTxt")}
          >
            {exportState === "done" ? <CheckCircle2 size={14} /> : <Download size={14} />}
            {exportState === "done" ? t("reader.exported") : t("reader.exportTxt")}
          </button>

          <button
            onClick={handleApprove}
            className="flex items-center gap-2 px-4 py-2 text-xs font-bold bg-emerald-500/10 text-emerald-600 rounded-xl hover:bg-emerald-500 hover:text-white transition-all border border-emerald-500/20 shadow-sm"
          >
            <CheckCircle2 size={14} />
            {t("reader.approve")}
          </button>
          <button
            onClick={handleReject}
            className="flex items-center gap-2 px-4 py-2 text-xs font-bold bg-destructive/10 text-destructive rounded-xl hover:bg-destructive hover:text-white transition-all border border-destructive/20 shadow-sm"
          >
            <XCircle size={14} />
            {t("reader.reject")}
          </button>

          <button
            onClick={handleDeleteChapter}
            disabled={deleting}
            className="flex items-center gap-2 px-4 py-2 text-xs font-bold bg-destructive/10 text-destructive rounded-xl hover:bg-destructive hover:text-white transition-all border border-destructive/20 shadow-sm disabled:opacity-50"
            aria-label={t("reader.deleteChapter")}
          >
            {deleting ? <div className="w-3.5 h-3.5 border-2 border-destructive/20 border-t-current rounded-full animate-spin" /> : <Trash2 size={14} />}
            {deleting ? t("reader.deleting") : t("reader.deleteChapter")}
          </button>
        </div>
      </div>

      {/* Manuscript Sheet */}
      <div className={`paper-sheet rounded-2xl shadow-2xl shadow-primary/5 min-h-[80vh] relative overflow-hidden ${
        editing ? "p-3 sm:p-6 md:p-10" : "p-4 sm:p-8 md:p-16 lg:p-24"
      }`}>
        {/* Physical Paper Details */}
        <div className="absolute top-0 left-8 w-px h-full bg-primary/5 hidden md:block" />
        <div className="absolute top-0 right-8 w-px h-full bg-primary/5 hidden md:block" />

        <header className={`${editing ? "mb-4 sm:mb-6" : "mb-8 sm:mb-16"} text-center`}>
          <div className="flex items-center justify-center gap-2 text-muted-foreground/30 mb-6 sm:mb-8 select-none">
            <div className="h-px w-8 sm:w-12 bg-border/40" />
            <BookOpen size={20} />
            <div className="h-px w-8 sm:w-12 bg-border/40" />
          </div>
          <h1 className="text-2xl sm:text-4xl md:text-5xl font-serif font-medium italic text-foreground tracking-tight leading-tight">
            {title}
          </h1>
          <div className={`${editing ? "mt-4" : "mt-8"} flex items-center justify-center gap-4 text-[10px] font-bold uppercase tracking-[0.2em] text-muted-foreground/60`}>
            <span>{t("reader.manuscriptPage")}</span>
            <span className="text-border">·</span>
            <span>{chapterNumber.toString().padStart(2, '0')}</span>
          </div>
        </header>

        {editing ? (
          <div className="mx-auto w-full max-w-none">
            <textarea
              ref={editRef}
              defaultValue={editContent}
              {...mobileTextInputHandlers(setEditContent)}
              className="block w-full min-h-[72dvh] rounded-2xl border border-primary/45 bg-background/35 p-4 text-base leading-8 text-foreground shadow-inner shadow-primary/5 outline-none transition-all focus:border-primary focus:ring-2 focus:ring-primary/25 sm:min-h-[68vh] sm:p-6 sm:text-lg"
              autoFocus
            />
          </div>
        ) : (
          <article className="prose prose-zinc dark:prose-invert max-w-none">
            {paragraphs.map((para, i) => (
              <p key={i} className="whitespace-pre-wrap font-serif text-lg md:text-xl leading-[1.8] text-foreground/90 mb-8">
                {para}
              </p>
            ))}
          </article>
        )}

        <footer className={`${editing ? "mt-8 pt-8" : "mt-24 pt-12"} border-t border-border/20 flex flex-col items-center gap-6 text-center`}>
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
