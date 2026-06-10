import { buildApiUrl, fetchJson, useApi, postApi } from "../hooks/use-api";
import { useEffect, useMemo, useState, useRef } from "react";
import type { Theme } from "../hooks/use-theme";
import type { TFunction } from "../hooks/use-i18n";
import type { SSEMessage } from "../hooks/use-sse";
import { useColors } from "../hooks/use-colors";
import { deriveBookActivity, shouldRefetchBookView } from "../hooks/use-book-activity";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { StudioSelect } from "../components/StudioSelect";
import { mobileTextInputHandlers } from "../lib/mobile-input";
import { appAlert, appPrompt } from "../lib/app-dialog";
import {
  ChevronLeft,
  Zap,
  FileText,
  CheckCheck,
  BarChart2,
  Download,
  Search,
  Wand2,
  Eye,
  Database,
  Check,
  X,
  ShieldCheck,
  RotateCcw,
  RefreshCw,
  Sparkles,
  Trash2,
  Save
} from "lucide-react";

interface ChapterMeta {
  readonly number: number;
  readonly title: string;
  readonly status: string;
  readonly wordCount: number;
}

interface BookData {
  readonly book: {
    readonly id: string;
    readonly title: string;
    readonly genre: string;
    readonly status: string;
    readonly chapterWordCount: number;
    readonly targetChapters?: number;
    readonly language?: string;
    readonly fanficMode?: string;
  };
  readonly chapters: ReadonlyArray<ChapterMeta>;
  readonly nextChapter: number;
}

type ReviseMode = "spot-fix" | "polish" | "rewrite" | "rework" | "anti-detect";
type ExportFormat = "txt" | "md" | "epub";
type BookStatus = "active" | "paused" | "outlining" | "completed" | "dropped";
type WriteMode = "quick" | "full";

interface Nav {
  toDashboard: () => void;
  toChapter: (bookId: string, num: number) => void;
  toAnalytics: (bookId: string) => void;
  toTruth: (bookId: string) => void;
}

function translateChapterStatus(status: string, t: TFunction): string {
  const map: Record<string, () => string> = {
    "ready-for-review": () => t("chapter.readyForReview"),
    "approved": () => t("chapter.approved"),
    "drafted": () => t("chapter.drafted"),
    "needs-revision": () => t("chapter.needsRevision"),
    "imported": () => t("chapter.imported"),
    "audit-failed": () => t("chapter.auditFailed"),
  };
  return map[status]?.() ?? status;
}

const STATUS_CONFIG: Record<string, { color: string; icon: React.ReactNode }> = {
  "ready-for-review": { color: "text-amber-500 bg-amber-500/10", icon: <Eye size={12} /> },
  approved: { color: "text-emerald-500 bg-emerald-500/10", icon: <Check size={12} /> },
  drafted: { color: "text-muted-foreground bg-muted/20", icon: <FileText size={12} /> },
  "needs-revision": { color: "text-destructive bg-destructive/10", icon: <RotateCcw size={12} /> },
  imported: { color: "text-blue-500 bg-blue-500/10", icon: <Download size={12} /> },
};

export function BookDetail({
  bookId,
  nav,
  theme,
  t,
  sse,
}: {
  bookId: string;
  nav: Nav;
  theme: Theme;
  t: TFunction;
  sse: { messages: ReadonlyArray<SSEMessage> };
}) {
  const c = useColors(theme);
  const { data, loading, error, refetch } = useApi<BookData>(`/books/${bookId}`);
  const [writeRequestPending, setWriteRequestPending] = useState(false);
  const [draftRequestPending, setDraftRequestPending] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const [rewritingChapters, setRewritingChapters] = useState<ReadonlyArray<number>>([]);
  const [revisingChapters, setRevisingChapters] = useState<ReadonlyArray<number>>([]);
  const [syncingChapters, setSyncingChapters] = useState<ReadonlyArray<number>>([]);
  const [savingSettings, setSavingSettings] = useState(false);
  const [settingsWordCount, setSettingsWordCount] = useState<number | null>(null);
  const [settingsTargetChapters, setSettingsTargetChapters] = useState<number | null>(null);
  const [settingsStatus, setSettingsStatus] = useState<BookStatus | null>(null);
  const [exportFormat, setExportFormat] = useState<ExportFormat>("txt");
  const [exportApprovedOnly, setExportApprovedOnly] = useState(false);
  const [writeMode, setWriteMode] = useState<WriteMode>("quick");
  const activity = useMemo(() => deriveBookActivity(sse.messages, bookId), [bookId, sse.messages]);
  const writing = writeRequestPending || activity.writing;
  const drafting = draftRequestPending || activity.drafting;
  const latestPersistedChapter = data ? data.nextChapter - 1 : 0;

  const [streamingText, setStreamingText] = useState("");
  const lastProcessedIndexRef = useRef<number>(-1);

  // Clear streamingText when writing/drafting completes and becomes false
  useEffect(() => {
    if (!writing && !drafting) {
      setStreamingText("");
    }
  }, [writing, drafting]);

  useEffect(() => {
    const recent = sse.messages.at(-1);
    if (!recent) return;

    const data = recent.data as { bookId?: string } | null;
    if (data?.bookId !== bookId) return;

    if (recent.event === "write:start") {
      setWriteRequestPending(false);
      return;
    }

    if (recent.event === "draft:start") {
      setDraftRequestPending(false);
      return;
    }

    if (shouldRefetchBookView(recent, bookId)) {
      setWriteRequestPending(false);
      setDraftRequestPending(false);
      refetch();
    }
  }, [bookId, refetch, sse.messages]);

  // Process real-time streaming text deltas
  useEffect(() => {
    if (sse.messages.length === 0) {
      lastProcessedIndexRef.current = -1;
      return;
    }
    if (lastProcessedIndexRef.current === -1) {
      lastProcessedIndexRef.current = sse.messages.length - 1;
      return;
    }

    let nextText = streamingText;
    let textChanged = false;

    for (let i = lastProcessedIndexRef.current + 1; i < sse.messages.length; i++) {
      const msg = sse.messages[i];
      if (!msg) continue;

      // Reset text on any start event for the current book
      if (
        (msg.event === "write:start" ||
         msg.event === "draft:start" ||
         msg.event === "rewrite:start" ||
         msg.event === "revise:start") &&
        (msg.data as { bookId?: string })?.bookId === bookId
      ) {
        nextText = "";
        textChanged = true;
      }

      // Append text on delta event
      if (msg.event === "write:delta") {
        const d = msg.data as { bookId?: string; text?: string } | null;
        if (d?.bookId === bookId && d?.text) {
          nextText += d.text;
          textChanged = true;
        }
      }
    }

    lastProcessedIndexRef.current = sse.messages.length - 1;

    if (textChanged) {
      setStreamingText(nextText);
    }
  }, [sse.messages, bookId, streamingText]);

  const handleWriteNext = async () => {
    setWriteRequestPending(true);
    try {
      await postApi(`/books/${bookId}/write-next`, { mode: writeMode });
    } catch (e) {
      setWriteRequestPending(false);
      await appAlert({ title: "写作启动失败", message: e instanceof Error ? e.message : "Failed", tone: "danger" });
    }
  };

  const handleDraft = async () => {
    setDraftRequestPending(true);
    try {
      await postApi(`/books/${bookId}/draft`);
    } catch (e) {
      setDraftRequestPending(false);
      await appAlert({ title: "草稿生成失败", message: e instanceof Error ? e.message : "Failed", tone: "danger" });
    }
  };

  const handleDeleteBook = async () => {
    setConfirmDeleteOpen(false);
    setDeleting(true);
    try {
      await fetchJson(`/books/${bookId}`, { method: "DELETE" });
      nav.toDashboard();
    } catch (e) {
      await appAlert({ title: "删除失败", message: e instanceof Error ? e.message : "Delete failed", tone: "danger" });
    } finally {
      setDeleting(false);
    }
  };

  const handleRewrite = async (chapterNum: number) => {
    const brief = await appPrompt({
      title: data?.book.language === "en" ? "Rewrite brief" : "重写说明",
      message: data?.book.language === "en"
        ? "Optional rewrite brief for this run only. Leave blank to use existing focus."
        : "可选：输入这次重写要遵循的补充想法。留空则沿用现有 focus。",
      confirmLabel: data?.book.language === "en" ? "Rewrite" : "开始重写",
      placeholder: data?.book.language === "en" ? "Optional brief..." : "可留空",
    });
    if (brief === null) return;
    setRewritingChapters((prev) => [...prev, chapterNum]);
    try {
      await fetchJson(`/books/${bookId}/rewrite/${chapterNum}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ brief: brief.trim() || undefined }),
      });
      refetch();
    } catch (e) {
      await appAlert({ title: "重写失败", message: e instanceof Error ? e.message : "Rewrite failed", tone: "danger" });
    } finally {
      setRewritingChapters((prev) => prev.filter((n) => n !== chapterNum));
    }
  };

  const handleRevise = async (chapterNum: number, mode: ReviseMode) => {
    const brief = await appPrompt({
      title: data?.book.language === "en" ? "Revision brief" : "修订说明",
      message: data?.book.language === "en"
        ? "Optional revise brief for this run only. Leave blank to use existing focus."
        : "可选：输入这次修订要遵循的补充想法。留空则沿用现有 focus。",
      confirmLabel: data?.book.language === "en" ? "Revise" : "开始修订",
      placeholder: data?.book.language === "en" ? "Optional brief..." : "可留空",
    });
    if (brief === null) return;
    setRevisingChapters((prev) => [...prev, chapterNum]);
    try {
      await fetchJson(`/books/${bookId}/revise/${chapterNum}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode, brief: brief.trim() || undefined }),
      });
      refetch();
    } catch (e) {
      await appAlert({ title: "修订失败", message: e instanceof Error ? e.message : "Revision failed", tone: "danger" });
    } finally {
      setRevisingChapters((prev) => prev.filter((n) => n !== chapterNum));
    }
  };

  const handleSync = async (chapterNum: number) => {
    const brief = await appPrompt({
      title: data?.book.language === "en" ? "Sync brief" : "同步说明",
      message: data?.book.language === "en"
        ? "Optional sync brief for interpreting the edited chapter body. Leave blank to sync directly from the text."
        : "可选：输入这次同步时要遵循的补充说明。留空则直接按正文同步。",
      confirmLabel: data?.book.language === "en" ? "Sync" : "开始同步",
      placeholder: data?.book.language === "en" ? "Optional brief..." : "可留空",
    });
    if (brief === null) return;
    setSyncingChapters((prev) => [...prev, chapterNum]);
    try {
      await fetchJson(`/books/${bookId}/resync/${chapterNum}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ brief: brief.trim() || undefined }),
      });
      refetch();
    } catch (e) {
      await appAlert({ title: "同步失败", message: e instanceof Error ? e.message : "Sync failed", tone: "danger" });
    } finally {
      setSyncingChapters((prev) => prev.filter((n) => n !== chapterNum));
    }
  };

  const handleSaveSettings = async () => {
    if (!data) return;
    setSavingSettings(true);
    try {
      const body: Record<string, unknown> = {};
      if (settingsWordCount !== null) body.chapterWordCount = settingsWordCount;
      if (settingsTargetChapters !== null) body.targetChapters = settingsTargetChapters;
      if (settingsStatus !== null) body.status = settingsStatus;
      await fetchJson(`/books/${bookId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      refetch();
    } catch (e) {
      await appAlert({ title: "保存失败", message: e instanceof Error ? e.message : "Save failed", tone: "danger" });
    } finally {
      setSavingSettings(false);
    }
  };

  const handleApproveAll = async () => {
    if (!data) return;
    const reviewable = data.chapters.filter((ch) => ch.status === "ready-for-review");
    let failed = 0;
    for (const chapter of reviewable) {
      try {
        await postApi(`/books/${bookId}/chapters/${chapter.number}/approve`);
      } catch {
        failed += 1;
      }
    }
    if (failed > 0) {
      await appAlert({ title: "批量通过失败", message: `${failed}/${reviewable.length} approve(s) failed`, tone: "danger" });
    }
    refetch();
  };

  if (loading) return (
    <div className="flex flex-col items-center justify-center py-32 space-y-4">
      <div className="w-8 h-8 border-2 border-primary/20 border-t-primary rounded-full animate-spin" />
      <span className="text-sm text-muted-foreground">{t("common.loading")}</span>
    </div>
  );

  if (error) return <div className="text-destructive p-8 bg-destructive/5 rounded-xl border border-destructive/20">Error: {error}</div>;
  if (!data) return null;

  const { book, chapters } = data;
  const totalWords = chapters.reduce((sum, ch) => sum + (ch.wordCount ?? 0), 0);
  const reviewCount = chapters.filter((ch) => ch.status === "ready-for-review").length;

  const currentWordCount = settingsWordCount ?? book.chapterWordCount;
  const currentTargetChapters = settingsTargetChapters ?? book.targetChapters ?? 0;
  const currentStatus = settingsStatus ?? (book.status as BookStatus);

  const exportHref = buildApiUrl(`/books/${bookId}/export?format=${exportFormat}${exportApprovedOnly ? "&approvedOnly=true" : ""}`) ?? "#";
  const exportFormatOptions = [
    { value: "txt" as const, label: "TXT" },
    { value: "md" as const, label: "MD" },
    { value: "epub" as const, label: "EPUB" },
  ];
  const bookStatusOptions = [
    { value: "active" as const, label: t("book.statusActive") },
    { value: "paused" as const, label: t("book.statusPaused") },
    { value: "outlining" as const, label: t("book.statusOutlining") },
    { value: "completed" as const, label: t("book.statusCompleted") },
    { value: "dropped" as const, label: t("book.statusDropped") },
  ];
  const reviseModeOptions = [
    { value: "spot-fix" as const, label: t("book.spotFix") },
    { value: "polish" as const, label: t("book.polish") },
    { value: "rewrite" as const, label: t("book.rewrite") },
    { value: "rework" as const, label: t("book.rework") },
    { value: "anti-detect" as const, label: t("book.antiDetect") },
  ];

  return (
    <div className="space-y-8 fade-in">
      {/* Breadcrumbs */}
      <nav className="flex items-center gap-2 text-[13px] font-medium text-muted-foreground">
        <button
          onClick={nav.toDashboard}
          className="hover:text-primary transition-colors flex items-center gap-1"
        >
          <ChevronLeft size={14} />
          {t("bread.books")}
        </button>
        <span className="text-border">/</span>
        <span className="text-foreground">{book.title}</span>
      </nav>

      {/* Header Section */}
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-6 border-b border-border/40 pb-8">
        <div className="space-y-2">
          <div className="flex items-center gap-3">
            <h1 className="text-2xl sm:text-4xl font-serif font-medium">{book.title}</h1>
            {book.language === "en" && (
              <span className="px-1.5 py-0.5 rounded border border-primary/20 text-primary text-[10px] font-bold">EN</span>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-muted-foreground font-medium">
            <span className="px-2 py-0.5 rounded bg-secondary/50 text-foreground/70 uppercase tracking-wider text-xs">{book.genre}</span>
            <div className="flex items-center gap-1.5">
              <FileText size={14} />
              <span>{chapters.length} {t("dash.chapters")}</span>
            </div>
            <div className="flex items-center gap-1.5">
              <Zap size={14} />
              <span>{totalWords.toLocaleString()} {t("book.words")}</span>
            </div>
            {book.fanficMode && (
              <span className="flex items-center gap-1 text-purple-500">
                <Sparkles size={12} />
                <span className="italic">fanfic:{book.fanficMode}</span>
              </span>
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="relative grid h-10 w-40 grid-cols-2 overflow-hidden rounded-xl border border-border/60 bg-secondary/40 p-1">
            <span
              className={`pointer-events-none absolute bottom-1 top-1 rounded-lg border border-primary/30 bg-background shadow-sm transition-all duration-200 ${
                writeMode === "quick"
                  ? "left-1 w-[calc(50%-0.25rem)]"
                  : "left-1/2 w-[calc(50%-0.25rem)]"
              }`}
            />
            <button
              type="button"
              onClick={() => setWriteMode("quick")}
              disabled={writing || drafting}
              className={`relative z-10 inline-flex h-full items-center justify-center rounded-lg px-3 text-center text-xs font-extrabold leading-none transition-colors disabled:opacity-50 ${
                writeMode === "quick"
                  ? "text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <span className="-translate-y-[2px]">快速</span>
            </button>
            <button
              type="button"
              onClick={() => setWriteMode("full")}
              disabled={writing || drafting}
              className={`relative z-10 inline-flex h-full items-center justify-center rounded-lg px-3 text-center text-xs font-extrabold leading-none transition-colors disabled:opacity-50 ${
                writeMode === "full"
                  ? "text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <span className="-translate-y-[2px]">完整</span>
            </button>
          </div>
          <button
            onClick={handleWriteNext}
            disabled={writing || drafting}
            className="flex items-center gap-2 px-5 py-2.5 text-sm font-bold bg-primary text-primary-foreground rounded-xl hover:scale-105 active:scale-95 transition-all shadow-lg shadow-primary/20 disabled:opacity-50"
          >
            {writing ? <div className="w-4 h-4 border-2 border-primary-foreground/20 border-t-primary-foreground rounded-full animate-spin" /> : <Zap size={16} />}
            {writing ? t("dash.writing") : t("book.writeNext")}
          </button>
          <button
            onClick={handleDraft}
            disabled={writing || drafting}
            className="flex items-center gap-2 px-5 py-2.5 text-sm font-bold bg-secondary text-foreground rounded-xl hover:bg-secondary/80 transition-all border border-border/50 disabled:opacity-50"
          >
            {drafting ? <div className="w-4 h-4 border-2 border-muted-foreground/20 border-t-muted-foreground rounded-full animate-spin" /> : <Wand2 size={16} />}
            {drafting ? t("book.drafting") : t("book.draftOnly")}
          </button>
          <button
            onClick={() => setConfirmDeleteOpen(true)}
            disabled={deleting}
            className="flex items-center gap-2 px-5 py-2.5 text-sm font-bold bg-destructive/10 text-destructive rounded-xl hover:bg-destructive hover:text-white transition-all border border-destructive/20 disabled:opacity-50"
          >
            {deleting ? <div className="w-4 h-4 border-2 border-destructive/20 border-t-destructive rounded-full animate-spin" /> : <Trash2 size={16} />}
            {deleting ? t("common.loading") : t("book.deleteBook")}
          </button>
        </div>
      </div>

      {(writing || drafting || activity.lastError) && (
        <div
          className={`rounded-2xl border px-4 py-3 text-sm ${
            activity.lastError
              ? "border-destructive/30 bg-destructive/5 text-destructive"
              : "border-primary/20 bg-primary/[0.04] text-foreground"
          }`}
        >
          {activity.lastError ? (
            <span>
              {t("book.pipelineFailed")}: {activity.lastError}
            </span>
          ) : writing ? (
            <span>{t("book.pipelineWriting")}</span>
          ) : (
            <span>{t("book.pipelineDrafting")}</span>
          )}
        </div>
      )}

      {/* Live Writing Stream Viewport */}
      {(writing || drafting) && streamingText && (
        <div className="paper-sheet rounded-2xl border border-primary/20 shadow-xl shadow-primary/5 p-6 space-y-4 fade-in">
          <div className="flex items-center justify-between border-b border-border/40 pb-3">
            <div className="flex items-center gap-2">
              <span className="relative flex h-2.5 w-2.5">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-primary"></span>
              </span>
              <span className="text-xs font-bold uppercase tracking-widest text-primary">
                {writing ? t("dash.writing") : t("book.drafting")}...
              </span>
            </div>
            <span className="text-[11px] font-mono text-muted-foreground">
              {t("book.words")}: {streamingText.length}
            </span>
          </div>
          
          <div className="relative max-h-96 overflow-y-auto pr-2 rounded-xl bg-secondary/15 p-4 border border-border/20">
            <div className="font-serif text-lg leading-relaxed text-foreground/90 whitespace-pre-wrap selection:bg-primary/10">
              {streamingText}
              <span className="inline-block w-1.5 h-5 ml-0.5 bg-primary animate-pulse align-middle" />
            </div>
          </div>
        </div>
      )}

      {/* Tool Strip */}
      <div className="flex flex-wrap items-center gap-2 py-1">
          {reviewCount > 0 && (
            <button
              onClick={handleApproveAll}
              className="flex items-center gap-2 px-4 py-2 text-xs font-bold bg-emerald-500/10 text-emerald-600 rounded-lg hover:bg-emerald-500/20 transition-all border border-emerald-500/20"
            >
              <CheckCheck size={14} />
              {t("book.approveAll")} ({reviewCount})
            </button>
          )}
          <button
            onClick={() => nav.toTruth(bookId)}
            className="flex items-center gap-2 px-4 py-2 text-xs font-bold bg-secondary/50 text-muted-foreground rounded-lg hover:text-foreground hover:bg-secondary transition-all border border-border/50"
          >
            <Database size={14} />
            {t("book.truthFiles")}
          </button>
          <button
            onClick={() => nav.toAnalytics(bookId)}
            className="flex items-center gap-2 px-4 py-2 text-xs font-bold bg-secondary/50 text-muted-foreground rounded-lg hover:text-foreground hover:bg-secondary transition-all border border-border/50"
          >
            <BarChart2 size={14} />
            {t("book.analytics")}
          </button>
          <div className="flex items-center gap-2">
            <StudioSelect
              value={exportFormat}
              onValueChange={setExportFormat}
              options={exportFormatOptions}
              triggerClassName="h-9 w-24 rounded-lg bg-secondary/50 text-xs font-bold text-muted-foreground shadow-none"
            />
            <label className="flex items-center gap-1.5 text-xs font-bold text-muted-foreground cursor-pointer select-none">
              <input
                type="checkbox"
                checked={exportApprovedOnly}
                onChange={(e) => setExportApprovedOnly(e.target.checked)}
                className="rounded border-border/50"
              />
              {t("book.approvedOnly")}
            </label>
            <button
              onClick={async () => {
                try {
                  const data = await fetchJson<{ path?: string; chapters?: number }>(`/books/${bookId}/export-save`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ format: exportFormat, approvedOnly: exportApprovedOnly }),
                  });
                  await appAlert({ title: t("common.exportSuccess"), message: `${data.path}\n(${data.chapters} ${t("dash.chapters")})`, tone: "success" });
                } catch (e) {
                  await appAlert({ title: "导出失败", message: e instanceof Error ? e.message : "Export failed", tone: "danger" });
                }
              }}
              className="flex items-center gap-2 px-4 py-2 text-xs font-bold bg-secondary/50 text-muted-foreground rounded-lg hover:text-foreground hover:bg-secondary transition-all border border-border/50"
            >
              <Download size={14} />
              {t("book.export")}
            </button>
          </div>
      </div>

      {/* Book Settings */}
      <div className="paper-sheet rounded-2xl border border-border/40 shadow-sm p-4 sm:p-6">
        <h2 className="text-sm font-bold uppercase tracking-widest text-muted-foreground mb-4">{t("book.settings")}</h2>
        <div className="flex flex-wrap items-end gap-4">
          <div className="flex flex-col gap-1">
            <label className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground">{t("create.wordsPerChapter")}</label>
            <input
              type="number"
              value={currentWordCount}
              {...mobileTextInputHandlers((value) => setSettingsWordCount(Number(value)))}
              className="px-3 py-2 text-sm rounded-lg border border-border/50 bg-secondary/30 outline-none focus:border-primary/50 w-32"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground">{t("create.targetChapters")}</label>
            <input
              type="number"
              value={currentTargetChapters}
              {...mobileTextInputHandlers((value) => setSettingsTargetChapters(Number(value)))}
              className="px-3 py-2 text-sm rounded-lg border border-border/50 bg-secondary/30 outline-none focus:border-primary/50 w-32"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground">{t("book.status")}</label>
            <StudioSelect
              value={currentStatus}
              onValueChange={setSettingsStatus}
              options={bookStatusOptions}
              triggerClassName="h-10 min-w-36 rounded-lg bg-secondary/30 shadow-none"
            />
          </div>
          <button
            onClick={handleSaveSettings}
            disabled={savingSettings}
            className="flex items-center gap-2 px-4 py-2 text-sm font-bold bg-primary text-primary-foreground rounded-lg hover:scale-105 active:scale-95 transition-all disabled:opacity-50"
          >
            {savingSettings ? <div className="w-4 h-4 border-2 border-primary-foreground/20 border-t-primary-foreground rounded-full animate-spin" /> : <Save size={14} />}
            {savingSettings ? t("book.saving") : t("book.save")}
          </button>
        </div>
      </div>

      {/* Chapters List */}
      <div className="paper-sheet rounded-2xl overflow-hidden border border-border/40 shadow-xl shadow-primary/5">
        <div className="divide-y divide-border/30 md:hidden">
          {chapters.map((ch, index) => {
            const staggerClass = `stagger-${Math.min(index + 1, 5)}`;
            const busy = rewritingChapters.includes(ch.number)
              || revisingChapters.includes(ch.number)
              || syncingChapters.includes(ch.number);
            return (
              <div key={ch.number} className={`p-4 fade-in ${staggerClass}`}>
                <div className="flex items-start gap-3">
                  <div className="w-9 shrink-0 pt-1 font-mono text-xs text-muted-foreground/60">
                    {ch.number.toString().padStart(2, "0")}
                  </div>
                  <div className="min-w-0 flex-1">
                    <button
                      onClick={() => nav.toChapter(bookId, ch.number)}
                      className="block w-full text-left font-serif text-lg font-medium leading-snug text-foreground hover:text-primary"
                    >
                      {ch.title || t("chapter.label").replace("{n}", String(ch.number))}
                    </button>
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <span className="text-xs font-medium tabular-nums text-muted-foreground">
                        {(ch.wordCount ?? 0).toLocaleString()} {t("book.words")}
                      </span>
                      <div className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-tight ${STATUS_CONFIG[ch.status]?.color ?? "bg-muted text-muted-foreground"}`}>
                        {STATUS_CONFIG[ch.status]?.icon}
                        {translateChapterStatus(ch.status, t)}
                      </div>
                    </div>
                  </div>
                </div>

                <div className="mt-4 flex flex-wrap items-center gap-2 pl-12">
                  {ch.status === "ready-for-review" && (
                    <>
                      <button
                        onClick={async () => {
                          try { await postApi(`/books/${bookId}/chapters/${ch.number}/approve`); refetch(); }
                          catch (e) { await appAlert({ title: "操作失败", message: e instanceof Error ? e.message : "Approve failed", tone: "danger" }); }
                        }}
                        className="flex h-11 w-11 items-center justify-center rounded-2xl bg-emerald-500 text-white shadow-sm shadow-emerald-500/20"
                        title={t("book.approve")}
                        aria-label={t("book.approve")}
                      >
                        <Check size={18} />
                      </button>
                      <button
                        onClick={async () => {
                          try { await postApi(`/books/${bookId}/chapters/${ch.number}/reject`); refetch(); }
                          catch (e) { await appAlert({ title: "操作失败", message: e instanceof Error ? e.message : "Reject failed", tone: "danger" }); }
                        }}
                        className="flex h-11 w-11 items-center justify-center rounded-2xl bg-destructive/10 text-destructive"
                        title={t("book.reject")}
                        aria-label={t("book.reject")}
                      >
                        <X size={18} />
                      </button>
                    </>
                  )}
                  <button
                    onClick={async () => {
                      try {
                        const auditResult = await fetchJson<{ passed?: boolean; issues?: unknown[] }>(`/books/${bookId}/audit/${ch.number}`, { method: "POST" });
                        await appAlert({
                          title: auditResult.passed ? "Audit passed" : "Audit failed",
                          message: auditResult.passed ? "Audit passed" : `${auditResult.issues?.length ?? 0} issues`,
                          tone: auditResult.passed ? "success" : "danger",
                        });
                        refetch();
                      } catch (e) {
                        await appAlert({ title: "Audit failed", message: e instanceof Error ? e.message : "Audit failed", tone: "danger" });
                      }
                    }}
                    className="flex h-11 w-11 items-center justify-center rounded-2xl bg-secondary text-muted-foreground"
                    title={t("book.audit")}
                    aria-label={t("book.audit")}
                  >
                    <ShieldCheck size={18} />
                  </button>
                  <button
                    onClick={() => handleRewrite(ch.number)}
                    disabled={busy}
                    className="flex h-11 w-11 items-center justify-center rounded-2xl bg-secondary text-muted-foreground disabled:opacity-40"
                    title={t("book.rewrite")}
                    aria-label={t("book.rewrite")}
                  >
                    {rewritingChapters.includes(ch.number)
                      ? <div className="h-4 w-4 rounded-full border-2 border-muted-foreground/20 border-t-muted-foreground animate-spin" />
                      : <RotateCcw size={18} />}
                  </button>
                  <button
                    onClick={() => handleSync(ch.number)}
                    disabled={busy || ch.number !== latestPersistedChapter}
                    className="flex h-11 w-11 items-center justify-center rounded-2xl bg-secondary text-muted-foreground disabled:opacity-40"
                    title={data?.book.language === "en" ? "Sync truth/state from edited chapter" : "根据已编辑章节同步 truth/state"}
                    aria-label={data?.book.language === "en" ? "Sync truth/state from edited chapter" : "根据已编辑章节同步 truth/state"}
                  >
                    {syncingChapters.includes(ch.number)
                      ? <div className="h-4 w-4 rounded-full border-2 border-muted-foreground/20 border-t-muted-foreground animate-spin" />
                      : <RefreshCw size={18} />}
                  </button>
                  <StudioSelect
                    disabled={revisingChapters.includes(ch.number)}
                    value=""
                    onValueChange={(mode) => handleRevise(ch.number, mode)}
                    options={reviseModeOptions}
                    placeholder={revisingChapters.includes(ch.number) ? t("common.loading") : t("book.curate")}
                    triggerClassName="h-11 w-28 rounded-2xl bg-secondary text-sm font-bold text-muted-foreground shadow-none disabled:opacity-40"
                  />
                </div>
              </div>
            );
          })}
        </div>

        <div className="hidden overflow-x-auto md:block">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="bg-muted/30 border-b border-border/50">
                <th className="text-left px-3 sm:px-6 py-3 sm:py-4 font-bold text-[11px] uppercase tracking-widest text-muted-foreground w-16">#</th>
                <th className="text-left px-3 sm:px-6 py-3 sm:py-4 font-bold text-[11px] uppercase tracking-widest text-muted-foreground">{t("book.manuscriptTitle")}</th>
                <th className="text-left px-3 sm:px-6 py-3 sm:py-4 font-bold text-[11px] uppercase tracking-widest text-muted-foreground w-28">{t("book.words")}</th>
                <th className="text-left px-3 sm:px-6 py-3 sm:py-4 font-bold text-[11px] uppercase tracking-widest text-muted-foreground w-36">{t("book.status")}</th>
                <th className="text-right px-3 sm:px-6 py-3 sm:py-4 font-bold text-[11px] uppercase tracking-widest text-muted-foreground">{t("book.curate")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/30">
              {chapters.map((ch, index) => {
                const staggerClass = `stagger-${Math.min(index + 1, 5)}`;
                return (
                <tr key={ch.number} className={`group hover:bg-primary/[0.02] transition-colors fade-in ${staggerClass}`}>
                  <td className="px-3 sm:px-6 py-3 sm:py-4 text-muted-foreground/60 font-mono text-xs">{ch.number.toString().padStart(2, '0')}</td>
                  <td className="px-3 sm:px-6 py-3 sm:py-4">
                    <button
                      onClick={() => nav.toChapter(bookId, ch.number)}
                      className="font-serif text-base sm:text-lg font-medium hover:text-primary transition-colors text-left"
                    >
                      {ch.title || t("chapter.label").replace("{n}", String(ch.number))}
                    </button>
                  </td>
                  <td className="px-3 sm:px-6 py-3 sm:py-4 text-muted-foreground font-medium tabular-nums text-xs">{(ch.wordCount ?? 0).toLocaleString()}</td>
                  <td className="px-3 sm:px-6 py-3 sm:py-4">
                    <div className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-bold uppercase tracking-tight ${STATUS_CONFIG[ch.status]?.color ?? "bg-muted text-muted-foreground"}`}>
                      {STATUS_CONFIG[ch.status]?.icon}
                      {translateChapterStatus(ch.status, t)}
                    </div>
                  </td>
                  <td className="px-3 sm:px-6 py-3 sm:py-4 text-right">
                    <div className="flex gap-1.5 justify-end opacity-100 transition-opacity">
                      {ch.status === "ready-for-review" && (
                        <>
                          <button
                            onClick={async () => {
                              try { await postApi(`/books/${bookId}/chapters/${ch.number}/approve`); refetch(); }
                              catch (e) { await appAlert({ title: "操作失败", message: e instanceof Error ? e.message : "Approve failed", tone: "danger" }); }
                            }}
                            className="p-2 rounded-lg bg-emerald-500/10 text-emerald-600 hover:bg-emerald-500 hover:text-white transition-all shadow-sm"
                            title={t("book.approve")}
                          >
                            <Check size={14} />
                          </button>
                          <button
                            onClick={async () => {
                              try { await postApi(`/books/${bookId}/chapters/${ch.number}/reject`); refetch(); }
                              catch (e) { await appAlert({ title: "操作失败", message: e instanceof Error ? e.message : "Reject failed", tone: "danger" }); }
                            }}
                            className="p-2 rounded-lg bg-destructive/10 text-destructive hover:bg-destructive hover:text-white transition-all shadow-sm"
                            title={t("book.reject")}
                          >
                            <X size={14} />
                          </button>
                        </>
                      )}
                      <button
                        onClick={async () => {
                          try {
                            const auditResult = await fetchJson<{ passed?: boolean; issues?: unknown[] }>(`/books/${bookId}/audit/${ch.number}`, { method: "POST" });
                            await appAlert({
                              title: auditResult.passed ? "Audit passed" : "Audit failed",
                              message: auditResult.passed ? "Audit passed" : `${auditResult.issues?.length ?? 0} issues`,
                              tone: auditResult.passed ? "success" : "danger",
                            });
                            refetch();
                          } catch (e) {
                            await appAlert({ title: "Audit failed", message: e instanceof Error ? e.message : "Audit failed", tone: "danger" });
                          }
                        }}
                        className="p-2 rounded-lg bg-secondary text-muted-foreground hover:text-primary hover:bg-primary/10 transition-all shadow-sm"
                        title={t("book.audit")}
                      >
                        <ShieldCheck size={14} />
                      </button>
                      <button
                        onClick={() => handleRewrite(ch.number)}
                        disabled={rewritingChapters.includes(ch.number)}
                        className="p-2 rounded-lg bg-secondary text-muted-foreground hover:text-primary hover:bg-primary/10 transition-all shadow-sm disabled:opacity-50"
                        title={t("book.rewrite")}
                      >
                        {rewritingChapters.includes(ch.number)
                          ? <div className="w-3.5 h-3.5 border-2 border-muted-foreground/20 border-t-muted-foreground rounded-full animate-spin" />
                          : <RotateCcw size={14} />}
                      </button>
                      <button
                        onClick={() => handleSync(ch.number)}
                        disabled={syncingChapters.includes(ch.number) || ch.number !== latestPersistedChapter}
                        className="p-2 rounded-lg bg-secondary text-muted-foreground hover:text-primary hover:bg-primary/10 transition-all shadow-sm disabled:opacity-50"
                        title={data?.book.language === "en" ? "Sync truth/state from edited chapter" : "根据已编辑章节同步 truth/state"}
                      >
                        {syncingChapters.includes(ch.number)
                          ? <div className="w-3.5 h-3.5 border-2 border-muted-foreground/20 border-t-muted-foreground rounded-full animate-spin" />
                          : <RefreshCw size={14} />}
                      </button>
                      <StudioSelect
                        disabled={revisingChapters.includes(ch.number)}
                        value=""
                        onValueChange={(mode) => handleRevise(ch.number, mode)}
                        options={reviseModeOptions}
                        placeholder={revisingChapters.includes(ch.number) ? t("common.loading") : t("book.curate")}
                        triggerClassName="h-8 w-24 rounded-lg bg-secondary text-[11px] font-bold text-muted-foreground shadow-none hover:text-primary hover:bg-primary/10 disabled:opacity-50"
                      />
                    </div>
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {chapters.length === 0 && (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <div className="w-12 h-12 rounded-full bg-muted/20 flex items-center justify-center mb-4">
               <FileText size={20} className="text-muted-foreground/40" />
            </div>
            <p className="text-sm italic font-serif text-muted-foreground">
              {t("book.noChapters")}
            </p>
          </div>
        )}
      </div>

      <ConfirmDialog
        open={confirmDeleteOpen}
        title={t("book.deleteBook")}
        message={t("book.confirmDelete")}
        confirmLabel={t("common.delete")}
        cancelLabel={t("common.cancel")}
        variant="danger"
        onConfirm={handleDeleteBook}
        onCancel={() => setConfirmDeleteOpen(false)}
      />
    </div>
  );
}
