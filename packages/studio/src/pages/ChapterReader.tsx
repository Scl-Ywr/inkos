import { useEffect, useState, useCallback } from "react";
import { fetchJson, useApi, postApi } from "../hooks/use-api";
import type { Theme } from "../hooks/use-theme";
import type { TFunction } from "../hooks/use-i18n";
import { useColors } from "../hooks/use-colors";
import { appAlert } from "../lib/app-dialog";
import { useSpeech } from "../hooks/use-speech";
import { ClipboardPanel } from "../components/chat/ClipboardPanel";
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
  EyeOff,
  Copy,
  Download,
  Timer,
  Sparkles,
  Zap,
  Volume2,
  Pause,
  Clipboard,
  Play,
  Square,
  MessageSquare,
  ThumbsUp,
  ThumbsDown,
  Minus,
  Languages,
  Globe,
  Headphones,
  FileText,
  ShieldAlert,
  MessageCircle,
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

const READER_FONTS = [
  { id: "song", label: "宋体", stack: '"Noto Serif CJK SC", "Source Han Serif SC", "Songti SC", SimSun, serif', weight: 450, spacing: "0" },
  { id: "hei", label: "黑体", stack: '"Noto Sans SC Variable", "Noto Sans CJK SC", "Microsoft YaHei", "PingFang SC", sans-serif', weight: 400, spacing: "0" },
  { id: "kai", label: "楷体", stack: 'KaiTi, "Kaiti SC", STKaiti, "Noto Serif CJK SC", serif', weight: 500, spacing: "0.025em" },
  { id: "fangsong", label: "仿宋", stack: 'FangSong, STFangsong, "FangSong_GB2312", "Noto Serif CJK SC", serif', weight: 400, spacing: "0.04em" },
  { id: "serif", label: "雅致衬线", stack: 'var(--font-serif)', weight: 550, spacing: "0.012em" },
] as const;

type ReaderFontId = (typeof READER_FONTS)[number]["id"];

interface ReaderPreferences {
  readonly font: ReaderFontId;
  readonly size: number;
  readonly lineHeight: number;
  readonly focusMode: boolean;
}

const READER_PREFERENCES_KEY = "inkos:reader:preferences";
const DEFAULT_READER_PREFERENCES: ReaderPreferences = {
  font: "song",
  size: 20,
  lineHeight: 1.95,
  focusMode: false,
};

function readReaderPreferences(): ReaderPreferences {
  if (typeof window === "undefined") return DEFAULT_READER_PREFERENCES;
  try {
    const stored = JSON.parse(window.localStorage.getItem(READER_PREFERENCES_KEY) ?? "{}") as Partial<ReaderPreferences>;
    const font = READER_FONTS.some((item) => item.id === stored.font)
      ? stored.font as ReaderFontId
      : DEFAULT_READER_PREFERENCES.font;
    const size = typeof stored.size === "number" && Number.isFinite(stored.size)
      ? Math.min(26, Math.max(16, stored.size))
      : DEFAULT_READER_PREFERENCES.size;
    const lineHeight = typeof stored.lineHeight === "number" && Number.isFinite(stored.lineHeight)
      ? Math.min(2.35, Math.max(1.55, stored.lineHeight))
      : DEFAULT_READER_PREFERENCES.lineHeight;
    const focusMode = typeof stored.focusMode === "boolean" ? stored.focusMode : false;
    return { font, size, lineHeight, focusMode };
  } catch {
    return DEFAULT_READER_PREFERENCES;
  }
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
  const [readerPreferences, setReaderPreferences] = useState<ReaderPreferences>(readReaderPreferences);
  const readerFont = readerPreferences.font;
  const readerSize = readerPreferences.size;
  const readerLineHeight = readerPreferences.lineHeight;
  const focusMode = readerPreferences.focusMode;
  const [focusSeconds, setFocusSeconds] = useState(0);
  const [focusStartWordCount, setFocusStartWordCount] = useState(0);
  const [activeBeats, setActiveBeats] = useState<ReadonlyArray<{ type: string; paragraph: number; description: string }>>([]);
  const [showClipboard, setShowClipboard] = useState(false);
  const [simulatedComments, setSimulatedComments] = useState<{
    comments: Array<{ username: string; content: string; sentiment: string; likes: number; timestamp: string }>;
    summary: string;
    highlights: string[];
    concerns: string[];
  } | null>(null);
  const [loadingComments, setLoadingComments] = useState(false);
  const [showComments, setShowComments] = useState(false);
  const [translation, setTranslation] = useState<{
    translatedContent: string;
    targetLanguage: string;
    style: string;
    wordCount: number;
  } | null>(null);
  const [loadingTranslation, setLoadingTranslation] = useState(false);
  const [showTranslation, setShowTranslation] = useState(false);
  const [targetLanguage, setTargetLanguage] = useState("en");
  const [translationStyle, setTranslationStyle] = useState<"literal" | "literary" | "colloquial">("literary");
  const [audiobookAdaptation, setAudiobookAdaptation] = useState<{
    adaptedContent: string;
    wordCount: number;
    estimatedDuration: string;
    voiceStyle: string;
    pacing: string;
  } | null>(null);
  const [loadingAudiobook, setLoadingAudiobook] = useState(false);
  const [showAudiobook, setShowAudiobook] = useState(false);
  const [voiceStyle, setVoiceStyle] = useState("标准朗读");
  const [pacing, setPacing] = useState<"slow" | "normal" | "fast">("normal");

  // P3 features state
  const [summary, setSummary] = useState<{ summary: string; style: string } | null>(null);
  const [loadingSummary, setLoadingSummary] = useState(false);
  const [showSummary, setShowSummary] = useState(false);
  const [sensitiveFindings, setSensitiveFindings] = useState<{ findings: Array<{ category: string; word: string; context: string }>; totalFindings: number } | null>(null);
  const [loadingSensitive, setLoadingSensitive] = useState(false);
  const [showSensitive, setShowSensitive] = useState(false);
  const [dialogueAnalysis, setDialogueAnalysis] = useState<{ characters: Array<{ name: string; dialogueCount: number; style: string; consistency: number }>; overallQuality: number } | null>(null);
  const [loadingDialogue, setLoadingDialogue] = useState(false);
  const [showDialogue, setShowDialogue] = useState(false);
  const [styleConsistency, setStyleConsistency] = useState<{ overallScore: number; issues: Array<{ type: string; description: string; severity: string; suggestion: string }> } | null>(null);
  const [loadingStyle, setLoadingStyle] = useState(false);
  const [showStyle, setShowStyle] = useState(false);
  const [pacingAnalysis, setPacingAnalysis] = useState<{ overallPacing: number; sections: Array<{ paragraph: number; pacing: string; description: string }>; suggestions: string[] } | null>(null);
  const [loadingPacing, setLoadingPacing] = useState(false);
  const [showPacing, setShowPacing] = useState(false);
  const [conflictDetection, setConflictDetection] = useState<{ conflicts: Array<{ type: string; description: string; severity: string; involvedCharacters: string[] }>; totalConflicts: number } | null>(null);
  const [loadingConflict, setLoadingConflict] = useState(false);
  const [showConflict, setShowConflict] = useState(false);

  const speech = useSpeech();

  // Load cached comments on mount
  useEffect(() => {
    if (!data) return;
    fetchJson(`/books/${bookId}/chapters/${chapterNumber}/comments`)
      .then((cached) => {
        if (cached && typeof cached === "object" && "comments" in cached) {
          setSimulatedComments(cached as typeof simulatedComments);
        }
      })
      .catch(() => undefined);
  }, [bookId, chapterNumber, data]);

  const handleSimulateComments = async () => {
    setLoadingComments(true);
    setShowComments(true);
    try {
      const result = await postApi(`/books/${bookId}/chapters/${chapterNumber}/simulate-comments`);
      setSimulatedComments(result as typeof simulatedComments);
    } catch (e) {
      console.error("Failed to simulate comments:", e);
    } finally {
      setLoadingComments(false);
    }
  };

  const handleTranslate = async () => {
    setLoadingTranslation(true);
    setShowTranslation(true);
    try {
      const result = await postApi(`/books/${bookId}/chapters/${chapterNumber}/translate`, {
        targetLanguage,
        style: translationStyle,
      });
      setTranslation(result as typeof translation);
    } catch (e) {
      console.error("Failed to translate:", e);
    } finally {
      setLoadingTranslation(false);
    }
  };

  const handleAudiobookAdapt = async () => {
    setLoadingAudiobook(true);
    setShowAudiobook(true);
    try {
      const result = await postApi(`/books/${bookId}/chapters/${chapterNumber}/audiobook-adapt`, {
        voiceStyle,
        pacing,
      });
      setAudiobookAdaptation(result as typeof audiobookAdaptation);
    } catch (e) {
      console.error("Failed to adapt for audiobook:", e);
    } finally {
      setLoadingAudiobook(false);
    }
  };

  // P3 handlers
  const handleGenerateSummary = async () => {
    setLoadingSummary(true);
    setShowSummary(true);
    try {
      const result = await postApi(`/books/${bookId}/chapters/${chapterNumber}/summary`, { style: "brief" });
      setSummary(result as typeof summary);
    } catch (e) {
      console.error("Failed to generate summary:", e);
    } finally {
      setLoadingSummary(false);
    }
  };

  const handleDetectSensitive = async () => {
    setLoadingSensitive(true);
    setShowSensitive(true);
    try {
      const result = await postApi(`/books/${bookId}/chapters/${chapterNumber}/detect-sensitive`);
      setSensitiveFindings(result as typeof sensitiveFindings);
    } catch (e) {
      console.error("Failed to detect sensitive content:", e);
    } finally {
      setLoadingSensitive(false);
    }
  };

  const handleAnalyzeDialogue = async () => {
    setLoadingDialogue(true);
    setShowDialogue(true);
    try {
      const result = await postApi(`/books/${bookId}/chapters/${chapterNumber}/analyze-dialogue`);
      setDialogueAnalysis(result as typeof dialogueAnalysis);
    } catch (e) {
      console.error("Failed to analyze dialogue:", e);
    } finally {
      setLoadingDialogue(false);
    }
  };

  const handleCheckStyle = async () => {
    setLoadingStyle(true);
    setShowStyle(true);
    try {
      const result = await postApi(`/books/${bookId}/check-style-consistency`, { chapterNumber });
      setStyleConsistency(result as typeof styleConsistency);
    } catch (e) {
      console.error("Failed to check style consistency:", e);
    } finally {
      setLoadingStyle(false);
    }
  };

  const handleAnalyzePacing = async () => {
    setLoadingPacing(true);
    setShowPacing(true);
    try {
      const result = await postApi(`/books/${bookId}/analyze-pacing`, { chapterNumber });
      setPacingAnalysis(result as typeof pacingAnalysis);
    } catch (e) {
      console.error("Failed to analyze pacing:", e);
    } finally {
      setLoadingPacing(false);
    }
  };

  const handleDetectConflicts = async () => {
    setLoadingConflict(true);
    setShowConflict(true);
    try {
      const result = await postApi(`/books/${bookId}/detect-conflicts`, { chapterNumber });
      setConflictDetection(result as typeof conflictDetection);
    } catch (e) {
      console.error("Failed to detect conflicts:", e);
    } finally {
      setLoadingConflict(false);
    }
  };

  useEffect(() => {
    try {
      window.localStorage.setItem(READER_PREFERENCES_KEY, JSON.stringify(readerPreferences));
    } catch {
      // Keep the in-memory choice when WebView storage is unavailable.
    }
  }, [readerPreferences]);

  // Focus mode: Fullscreen + timer
  useEffect(() => {
    if (!focusMode) {
      setFocusSeconds(0);
      return;
    }
    const start = Date.now();
    if (data) {
      const lines = data.content.split("\n");
      const titleLine = lines.find((l) => l.startsWith("# ")) ?? "";
      const body = lines.filter((l) => l !== titleLine).join("\n").trim();
      setFocusStartWordCount(body.length);
    }
    const timer = setInterval(() => setFocusSeconds(Math.floor((Date.now() - start) / 1000)), 1000);
    try { document.documentElement.requestFullscreen(); } catch { /* fullscreen not supported */ }
    return () => {
      clearInterval(timer);
      try { if (document.fullscreenElement) document.exitFullscreen(); } catch { /* */ }
    };
  }, [focusMode, data]);

  useEffect(() => {
    const onFsChange = () => {
      if (!document.fullscreenElement && focusMode) {
        setReaderPreferences((p) => ({ ...p, focusMode: false }));
      }
    };
    document.addEventListener("fullscreenchange", onFsChange);
    return () => document.removeEventListener("fullscreenchange", onFsChange);
  }, [focusMode]);

  const exitFocusMode = () => {
    setReaderPreferences((p) => ({ ...p, focusMode: false }));
  };

  const enterFocusMode = () => {
    setReaderPreferences((p) => ({ ...p, focusMode: true }));
  };

  const formatTimer = (s: number) => {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
  };

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
  const selectedFont = READER_FONTS.find((font) => font.id === readerFont) ?? READER_FONTS[0];

  return (
    <div className={`mx-auto max-w-5xl space-y-8 fade-in ${focusMode ? "bg-background" : ""}`}>
      {!focusMode && (
      <>
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
          <button
            onClick={enterFocusMode}
            className={`${actionClass} border-amber-500/20 bg-amber-500/10 text-amber-600 shadow-sm hover:bg-amber-500 hover:text-white`}
            title="专注写作"
          >
            <EyeOff size={14} />
            专注
          </button>
          {speech.isSupported && (
            <button
              onClick={() => {
                if (speech.isSpeaking && !speech.isPaused) {
                  speech.pause();
                } else if (speech.isPaused) {
                  speech.resume();
                } else {
                  speech.speak(body);
                }
              }}
              className={`${actionClass} border-blue-500/20 bg-blue-500/10 text-blue-600 shadow-sm hover:bg-blue-500 hover:text-white`}
              title={speech.isSpeaking && !speech.isPaused ? "暂停朗读" : "朗读章节"}
            >
              {speech.isSpeaking && !speech.isPaused ? (
                <><Pause size={14} /> 暂停</>
              ) : speech.isPaused ? (
                <><Play size={14} /> 继续</>
              ) : (
                <><Volume2 size={14} /> 朗读</>
              )}
            </button>
          )}
          {speech.isSpeaking && (
            <button
              onClick={() => speech.stop()}
              className={`${actionClass} border-destructive/20 bg-destructive/10 text-destructive shadow-sm hover:bg-destructive hover:text-white`}
              title="停止朗读"
            >
              <Square size={14} />
            </button>
          )}
          <button
            onClick={() => setShowClipboard(true)}
            className={`${actionClass} border-violet-500/20 bg-violet-500/10 text-violet-600 shadow-sm hover:bg-violet-500 hover:text-white`}
            title="素材剪贴板"
          >
            <Clipboard size={14} />
            素材
          </button>
          <button
            onClick={handleSimulateComments}
            disabled={loadingComments}
            className={`${actionClass} border-orange-500/20 bg-orange-500/10 text-orange-600 shadow-sm hover:bg-orange-500 hover:text-white disabled:opacity-50`}
            title="读者评论模拟"
          >
            <MessageSquare size={14} />
            {loadingComments ? "生成中..." : "读者"}
          </button>
          <button
            onClick={handleTranslate}
            disabled={loadingTranslation}
            className={`${actionClass} border-teal-500/20 bg-teal-500/10 text-teal-600 shadow-sm hover:bg-teal-500 hover:text-white disabled:opacity-50`}
            title="翻译章节"
          >
            <Languages size={14} />
            {loadingTranslation ? "翻译中..." : "翻译"}
          </button>
          <button
            onClick={handleAudiobookAdapt}
            disabled={loadingAudiobook}
            className={`${actionClass} border-indigo-500/20 bg-indigo-500/10 text-indigo-600 shadow-sm hover:bg-indigo-500 hover:text-white disabled:opacity-50`}
            title="有声书适配"
          >
            <Headphones size={14} />
            {loadingAudiobook ? "适配中..." : "有声书"}
          </button>
          <button
            onClick={handleGenerateSummary}
            disabled={loadingSummary}
            className={`${actionClass} border-cyan-500/20 bg-cyan-500/10 text-cyan-600 shadow-sm hover:bg-cyan-500 hover:text-white disabled:opacity-50`}
            title="生成摘要"
          >
            <FileText size={14} />
            {loadingSummary ? "生成中..." : "摘要"}
          </button>
          <button
            onClick={handleDetectSensitive}
            disabled={loadingSensitive}
            className={`${actionClass} border-rose-500/20 bg-rose-500/10 text-rose-600 shadow-sm hover:bg-rose-500 hover:text-white disabled:opacity-50`}
            title="敏感内容检测"
          >
            <ShieldAlert size={14} />
            {loadingSensitive ? "检测中..." : "敏感"}
          </button>
          <button
            onClick={handleAnalyzeDialogue}
            disabled={loadingDialogue}
            className={`${actionClass} border-emerald-500/20 bg-emerald-500/10 text-emerald-600 shadow-sm hover:bg-emerald-500 hover:text-white disabled:opacity-50`}
            title="对话风格分析"
          >
            <MessageCircle size={14} />
            {loadingDialogue ? "分析中..." : "对话"}
          </button>
          <button
            onClick={handleCheckStyle}
            disabled={loadingStyle}
            className={`${actionClass} border-amber-500/20 bg-amber-500/10 text-amber-600 shadow-sm hover:bg-amber-500 hover:text-white disabled:opacity-50`}
            title="风格一致性检查"
          >
            <Sparkles size={14} />
            {loadingStyle ? "检查中..." : "风格"}
          </button>
          <button
            onClick={handleAnalyzePacing}
            disabled={loadingPacing}
            className={`${actionClass} border-indigo-500/20 bg-indigo-500/10 text-indigo-600 shadow-sm hover:bg-indigo-500 hover:text-white disabled:opacity-50`}
            title="剧情节奏分析"
          >
            <Timer size={14} />
            {loadingPacing ? "分析中..." : "节奏"}
          </button>
          <button
            onClick={handleDetectConflicts}
            disabled={loadingConflict}
            className={`${actionClass} border-orange-500/20 bg-orange-500/10 text-orange-600 shadow-sm hover:bg-orange-500 hover:text-white disabled:opacity-50`}
            title="剧情冲突检测"
          >
            <Zap size={14} />
            {loadingConflict ? "检测中..." : "冲突"}
          </button>
        </div>
      </div>

      {/* Clipboard Panel */}
      {showClipboard && (
        <ClipboardPanel
          bookId={bookId}
          theme={theme}
          onInsert={(text) => {
            if (editing) {
              setEditContent((prev) => prev + "\n\n" + text);
            }
            setShowClipboard(false);
          }}
          onClose={() => setShowClipboard(false)}
        />
      )}

      {/* Reader Comments Panel */}
      {showComments && simulatedComments && (
        <div className="paper-sheet rounded-2xl border border-border/40 p-4 shadow-lg shadow-primary/5">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <MessageSquare size={18} className="text-orange-500" />
              <h3 className="text-sm font-bold text-foreground">模拟读者评论</h3>
              <span className="text-xs text-muted-foreground">({simulatedComments.comments?.length ?? 0} 条)</span>
            </div>
            <button
              onClick={() => setShowComments(false)}
              className="p-1 rounded hover:bg-secondary transition-colors"
            >
              <X size={16} className="text-muted-foreground" />
            </button>
          </div>

          {/* Summary */}
          {simulatedComments.summary && (
            <div className="mb-4 p-3 rounded-lg bg-secondary/30 border border-border/30">
              <p className="text-sm text-foreground">{simulatedComments.summary}</p>
            </div>
          )}

          {/* Highlights and Concerns */}
          <div className="grid grid-cols-2 gap-4 mb-4">
            {simulatedComments.highlights && simulatedComments.highlights.length > 0 && (
              <div className="p-3 rounded-lg bg-emerald-500/10 border border-emerald-500/20">
                <div className="text-xs font-bold text-emerald-600 mb-2">亮点</div>
                <ul className="text-xs text-foreground space-y-1">
                  {simulatedComments.highlights.map((h, i) => (
                    <li key={i} className="flex items-start gap-1">
                      <ThumbsUp size={12} className="text-emerald-500 mt-0.5 flex-shrink-0" />
                      {h}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {simulatedComments.concerns && simulatedComments.concerns.length > 0 && (
              <div className="p-3 rounded-lg bg-amber-500/10 border border-amber-500/20">
                <div className="text-xs font-bold text-amber-600 mb-2">问题</div>
                <ul className="text-xs text-foreground space-y-1">
                  {simulatedComments.concerns.map((c, i) => (
                    <li key={i} className="flex items-start gap-1">
                      <ThumbsDown size={12} className="text-amber-500 mt-0.5 flex-shrink-0" />
                      {c}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          {/* Comments List */}
          <div className="space-y-3 max-h-96 overflow-y-auto">
            {simulatedComments.comments?.map((comment, i) => (
              <div key={i} className="p-3 rounded-lg border border-border/30 bg-background">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <div className="w-6 h-6 rounded-full bg-primary/20 flex items-center justify-center text-xs font-bold text-primary">
                      {comment.username[0]}
                    </div>
                    <span className="text-sm font-medium text-foreground">{comment.username}</span>
                    <span className={`text-xs px-1.5 py-0.5 rounded ${
                      comment.sentiment === "positive" ? "bg-emerald-500/10 text-emerald-600" :
                      comment.sentiment === "negative" ? "bg-red-500/10 text-red-600" :
                      "bg-secondary text-muted-foreground"
                    }`}>
                      {comment.sentiment === "positive" ? "正面" : comment.sentiment === "negative" ? "负面" : "中性"}
                    </span>
                  </div>
                  <div className="flex items-center gap-1 text-xs text-muted-foreground">
                    <ThumbsUp size={12} />
                    {comment.likes}
                  </div>
                </div>
                <p className="text-sm text-foreground">{comment.content}</p>
                <div className="mt-1 text-xs text-muted-foreground">{comment.timestamp}</div>
              </div>
            ))}
          </div>

          {loadingComments && (
            <div className="text-center py-4 text-sm text-muted-foreground">
              正在生成模拟评论...
            </div>
          )}
        </div>
      )}

      {/* Translation Panel */}
      {showTranslation && (
        <div className="paper-sheet rounded-2xl border border-border/40 p-4 shadow-lg shadow-primary/5">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <Languages size={18} className="text-teal-500" />
              <h3 className="text-sm font-bold text-foreground">章节翻译</h3>
            </div>
            <button
              onClick={() => setShowTranslation(false)}
              className="p-1 rounded hover:bg-secondary transition-colors"
            >
              <X size={16} className="text-muted-foreground" />
            </button>
          </div>

          {/* Translation Options */}
          <div className="flex flex-wrap gap-4 mb-4">
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium text-muted-foreground">目标语言</label>
              <select
                value={targetLanguage}
                onChange={(e) => setTargetLanguage(e.target.value)}
                className="px-3 py-1.5 text-sm rounded-lg border border-border/50 bg-background outline-none focus:border-primary/50"
              >
                <option value="en">英语 (English)</option>
                <option value="ja">日语 (日本語)</option>
                <option value="ko">韩语 (한국어)</option>
                <option value="fr">法语 (Français)</option>
                <option value="de">德语 (Deutsch)</option>
                <option value="es">西班牙语 (Español)</option>
                <option value="ru">俄语 (Русский)</option>
              </select>
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium text-muted-foreground">翻译风格</label>
              <div className="flex gap-2">
                {[
                  { value: "literal", label: "直译" },
                  { value: "literary", label: "文学" },
                  { value: "colloquial", label: "口语" },
                ].map((style) => (
                  <button
                    key={style.value}
                    onClick={() => setTranslationStyle(style.value as typeof translationStyle)}
                    className={`px-3 py-1.5 text-sm rounded-lg border transition-colors ${
                      translationStyle === style.value
                        ? "border-teal-500 bg-teal-500/10 text-teal-600"
                        : "border-border/50 text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {style.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Translation Result */}
          {loadingTranslation ? (
            <div className="text-center py-8 text-sm text-muted-foreground">
              正在翻译...
            </div>
          ) : translation ? (
            <div>
              <div className="flex items-center gap-2 mb-2 text-xs text-muted-foreground">
                <Globe size={12} />
                <span>翻译完成 · {translation.wordCount} 字</span>
              </div>
              <div className="p-4 rounded-lg bg-secondary/30 border border-border/30 max-h-96 overflow-y-auto">
                <pre className="whitespace-pre-wrap text-sm text-foreground font-sans">
                  {translation.translatedContent}
                </pre>
              </div>
              <div className="flex justify-end gap-2 mt-3">
                <button
                  onClick={() => {
                    navigator.clipboard.writeText(translation.translatedContent);
                  }}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-border/50 text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
                >
                  <Copy size={12} />
                  复制
                </button>
              </div>
            </div>
          ) : (
            <div className="text-center py-4 text-sm text-muted-foreground">
              请选择语言和风格，然后点击翻译按钮
            </div>
          )}
        </div>
      )}

      {/* Audiobook Adaptation Panel */}
      {showAudiobook && (
        <div className="paper-sheet rounded-2xl border border-border/40 p-4 shadow-lg shadow-primary/5">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <Headphones size={18} className="text-indigo-500" />
              <h3 className="text-sm font-bold text-foreground">有声书适配</h3>
            </div>
            <button
              onClick={() => setShowAudiobook(false)}
              className="p-1 rounded hover:bg-secondary transition-colors"
            >
              <X size={16} className="text-muted-foreground" />
            </button>
          </div>

          {/* Audiobook Options */}
          <div className="flex flex-wrap gap-4 mb-4">
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium text-muted-foreground">朗读风格</label>
              <select
                value={voiceStyle}
                onChange={(e) => setVoiceStyle(e.target.value)}
                className="px-3 py-1.5 text-sm rounded-lg border border-border/50 bg-background outline-none focus:border-primary/50"
              >
                <option value="标准朗读">标准朗读</option>
                <option value="情感丰富">情感丰富</option>
                <option value="低沉磁性">低沉磁性</option>
                <option value="清新自然">清新自然</option>
                <option value="激情澎湃">激情澎湃</option>
              </select>
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium text-muted-foreground">语速节奏</label>
              <div className="flex gap-2">
                {[
                  { value: "slow", label: "慢速" },
                  { value: "normal", label: "正常" },
                  { value: "fast", label: "快速" },
                ].map((p) => (
                  <button
                    key={p.value}
                    onClick={() => setPacing(p.value as typeof pacing)}
                    className={`px-3 py-1.5 text-sm rounded-lg border transition-colors ${
                      pacing === p.value
                        ? "border-indigo-500 bg-indigo-500/10 text-indigo-600"
                        : "border-border/50 text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Audiobook Result */}
          {loadingAudiobook ? (
            <div className="text-center py-8 text-sm text-muted-foreground">
              正在生成有声书版本...
            </div>
          ) : audiobookAdaptation ? (
            <div>
              <div className="flex items-center gap-4 mb-2 text-xs text-muted-foreground">
                <span>字数: {audiobookAdaptation.wordCount}</span>
                <span>预计时长: {audiobookAdaptation.estimatedDuration}</span>
                <span>风格: {audiobookAdaptation.voiceStyle}</span>
              </div>
              <div className="p-4 rounded-lg bg-secondary/30 border border-border/30 max-h-96 overflow-y-auto">
                <pre className="whitespace-pre-wrap text-sm text-foreground font-sans">
                  {audiobookAdaptation.adaptedContent}
                </pre>
              </div>
              <div className="flex justify-end gap-2 mt-3">
                <button
                  onClick={() => {
                    navigator.clipboard.writeText(audiobookAdaptation.adaptedContent);
                  }}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-border/50 text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
                >
                  <Copy size={12} />
                  复制
                </button>
              </div>
            </div>
          ) : (
            <div className="text-center py-4 text-sm text-muted-foreground">
              选择朗读风格和语速，然后点击适配按钮
            </div>
          )}
        </div>
      )}

      {/* Summary Panel */}
      {showSummary && (
        <div className="paper-sheet rounded-2xl border border-border/40 p-4 shadow-lg shadow-primary/5">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <FileText size={18} className="text-cyan-500" />
              <h3 className="text-sm font-bold text-foreground">章节摘要</h3>
            </div>
            <button
              onClick={() => setShowSummary(false)}
              className="p-1 rounded hover:bg-secondary transition-colors"
            >
              <X size={16} className="text-muted-foreground" />
            </button>
          </div>
          {loadingSummary ? (
            <div className="text-center py-4 text-sm text-muted-foreground">正在生成摘要...</div>
          ) : summary ? (
            <div className="p-4 rounded-lg bg-secondary/30 border border-border/30">
              <p className="text-sm text-foreground whitespace-pre-wrap">{summary.summary}</p>
            </div>
          ) : (
            <div className="text-center py-4 text-sm text-muted-foreground">点击按钮生成摘要</div>
          )}
        </div>
      )}

      {/* Sensitive Content Panel */}
      {showSensitive && (
        <div className="paper-sheet rounded-2xl border border-border/40 p-4 shadow-lg shadow-primary/5">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <ShieldAlert size={18} className="text-rose-500" />
              <h3 className="text-sm font-bold text-foreground">敏感内容检测</h3>
              {sensitiveFindings && (
                <span className="text-xs px-2 py-0.5 rounded-full bg-rose-500/10 text-rose-500">
                  {sensitiveFindings.totalFindings} 处
                </span>
              )}
            </div>
            <button
              onClick={() => setShowSensitive(false)}
              className="p-1 rounded hover:bg-secondary transition-colors"
            >
              <X size={16} className="text-muted-foreground" />
            </button>
          </div>
          {loadingSensitive ? (
            <div className="text-center py-4 text-sm text-muted-foreground">正在检测...</div>
          ) : sensitiveFindings ? (
            <div className="space-y-2 max-h-60 overflow-y-auto">
              {sensitiveFindings.findings.length === 0 ? (
                <div className="text-center py-4 text-sm text-emerald-500">未发现敏感内容</div>
              ) : (
                sensitiveFindings.findings.map((finding, i) => (
                  <div key={i} className="p-3 rounded-lg border border-rose-500/20 bg-rose-500/5">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-xs font-medium text-rose-500">{finding.category}</span>
                      <span className="text-xs px-1.5 py-0.5 rounded bg-rose-500/10 text-rose-500">{finding.word}</span>
                    </div>
                    <p className="text-xs text-muted-foreground">...{finding.context}...</p>
                  </div>
                ))
              )}
            </div>
          ) : (
            <div className="text-center py-4 text-sm text-muted-foreground">点击按钮检测敏感内容</div>
          )}
        </div>
      )}

      {/* Dialogue Analysis Panel */}
      {showDialogue && (
        <div className="paper-sheet rounded-2xl border border-border/40 p-4 shadow-lg shadow-primary/5">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <MessageCircle size={18} className="text-emerald-500" />
              <h3 className="text-sm font-bold text-foreground">对话风格分析</h3>
              {dialogueAnalysis && (
                <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-500">
                  质量: {Math.round(dialogueAnalysis.overallQuality * 100)}%
                </span>
              )}
            </div>
            <button
              onClick={() => setShowDialogue(false)}
              className="p-1 rounded hover:bg-secondary transition-colors"
            >
              <X size={16} className="text-muted-foreground" />
            </button>
          </div>
          {loadingDialogue ? (
            <div className="text-center py-4 text-sm text-muted-foreground">正在分析...</div>
          ) : dialogueAnalysis ? (
            <div className="space-y-3">
              {dialogueAnalysis.characters.map((char, i) => (
                <div key={i} className="p-3 rounded-lg border border-border/30">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-sm font-medium text-foreground">{char.name}</span>
                    <span className="text-xs text-muted-foreground">{char.dialogueCount} 句对话</span>
                  </div>
                  <p className="text-xs text-muted-foreground mb-1">{char.style}</p>
                  <div className="flex items-center gap-1">
                    <span className="text-xs">一致性:</span>
                    <div className="flex-1 h-1.5 rounded-full bg-secondary">
                      <div
                        className="h-full rounded-full bg-emerald-500"
                        style={{ width: `${char.consistency * 100}%` }}
                      />
                    </div>
                    <span className="text-xs">{Math.round(char.consistency * 100)}%</span>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-center py-4 text-sm text-muted-foreground">点击按钮分析对话风格</div>
          )}
        </div>
      )}

      {/* Style Consistency Panel */}
      {showStyle && (
        <div className="paper-sheet rounded-2xl border border-border/40 p-4 shadow-lg shadow-primary/5">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <Sparkles size={18} className="text-amber-500" />
              <h3 className="text-sm font-bold text-foreground">风格一致性检查</h3>
              {styleConsistency && (
                <span className="text-xs px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-500">
                  评分: {Math.round(styleConsistency.overallScore * 100)}%
                </span>
              )}
            </div>
            <button onClick={() => setShowStyle(false)} className="p-1 rounded hover:bg-secondary transition-colors">
              <X size={16} className="text-muted-foreground" />
            </button>
          </div>
          {loadingStyle ? (
            <div className="text-center py-4 text-sm text-muted-foreground">正在检查...</div>
          ) : styleConsistency ? (
            <div className="space-y-3">
              {styleConsistency.issues.length === 0 ? (
                <div className="text-center py-4 text-sm text-emerald-500">风格一致性良好，未发现问题</div>
              ) : (
                styleConsistency.issues.map((issue, i) => (
                  <div key={i} className="p-3 rounded-lg border border-border/30">
                    <div className="flex items-center gap-2 mb-1">
                      <span className={`text-xs px-1.5 py-0.5 rounded ${
                        issue.severity === "high" ? "bg-red-500/10 text-red-500" :
                        issue.severity === "medium" ? "bg-amber-500/10 text-amber-500" :
                        "bg-blue-500/10 text-blue-500"
                      }`}>{issue.type}</span>
                      <span className="text-xs text-muted-foreground">{issue.severity}</span>
                    </div>
                    <p className="text-sm text-foreground mb-1">{issue.description}</p>
                    <p className="text-xs text-muted-foreground">建议: {issue.suggestion}</p>
                  </div>
                ))
              )}
            </div>
          ) : (
            <div className="text-center py-4 text-sm text-muted-foreground">点击按钮检查风格一致性</div>
          )}
        </div>
      )}

      {/* Pacing Analysis Panel */}
      {showPacing && (
        <div className="paper-sheet rounded-2xl border border-border/40 p-4 shadow-lg shadow-primary/5">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <Timer size={18} className="text-indigo-500" />
              <h3 className="text-sm font-bold text-foreground">剧情节奏分析</h3>
              {pacingAnalysis && (
                <span className="text-xs px-2 py-0.5 rounded-full bg-indigo-500/10 text-indigo-500">
                  节奏: {Math.round(pacingAnalysis.overallPacing * 100)}%
                </span>
              )}
            </div>
            <button onClick={() => setShowPacing(false)} className="p-1 rounded hover:bg-secondary transition-colors">
              <X size={16} className="text-muted-foreground" />
            </button>
          </div>
          {loadingPacing ? (
            <div className="text-center py-4 text-sm text-muted-foreground">正在分析...</div>
          ) : pacingAnalysis ? (
            <div className="space-y-3">
              <div className="space-y-2">
                {pacingAnalysis.sections.map((sec, i) => (
                  <div key={i} className="flex items-center gap-3 p-2 rounded-lg border border-border/30">
                    <span className="text-xs text-muted-foreground w-16">段落 {sec.paragraph}</span>
                    <span className={`text-xs px-1.5 py-0.5 rounded ${
                      sec.pacing === "fast" ? "bg-red-500/10 text-red-500" :
                      sec.pacing === "slow" ? "bg-blue-500/10 text-blue-500" :
                      "bg-emerald-500/10 text-emerald-500"
                    }`}>{sec.pacing}</span>
                    <span className="text-sm text-foreground flex-1">{sec.description}</span>
                  </div>
                ))}
              </div>
              {pacingAnalysis.suggestions.length > 0 && (
                <div className="p-3 rounded-lg bg-indigo-500/5 border border-indigo-500/20">
                  <p className="text-xs font-medium text-indigo-500 mb-2">优化建议</p>
                  {pacingAnalysis.suggestions.map((s, i) => (
                    <p key={i} className="text-xs text-muted-foreground mb-1">- {s}</p>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <div className="text-center py-4 text-sm text-muted-foreground">点击按钮分析剧情节奏</div>
          )}
        </div>
      )}

      {/* Conflict Detection Panel */}
      {showConflict && (
        <div className="paper-sheet rounded-2xl border border-border/40 p-4 shadow-lg shadow-primary/5">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <Zap size={18} className="text-orange-500" />
              <h3 className="text-sm font-bold text-foreground">剧情冲突检测</h3>
              {conflictDetection && (
                <span className="text-xs px-2 py-0.5 rounded-full bg-orange-500/10 text-orange-500">
                  {conflictDetection.totalConflicts} 处冲突
                </span>
              )}
            </div>
            <button onClick={() => setShowConflict(false)} className="p-1 rounded hover:bg-secondary transition-colors">
              <X size={16} className="text-muted-foreground" />
            </button>
          </div>
          {loadingConflict ? (
            <div className="text-center py-4 text-sm text-muted-foreground">正在检测...</div>
          ) : conflictDetection ? (
            <div className="space-y-3">
              {conflictDetection.conflicts.length === 0 ? (
                <div className="text-center py-4 text-sm text-emerald-500">未检测到剧情冲突</div>
              ) : (
                conflictDetection.conflicts.map((conflict, i) => (
                  <div key={i} className="p-3 rounded-lg border border-border/30">
                    <div className="flex items-center gap-2 mb-1">
                      <span className={`text-xs px-1.5 py-0.5 rounded ${
                        conflict.severity === "high" ? "bg-red-500/10 text-red-500" :
                        conflict.severity === "medium" ? "bg-amber-500/10 text-amber-500" :
                        "bg-blue-500/10 text-blue-500"
                      }`}>{conflict.type}</span>
                      <span className="text-xs text-muted-foreground">{conflict.severity}</span>
                    </div>
                    <p className="text-sm text-foreground mb-1">{conflict.description}</p>
                    {conflict.involvedCharacters.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-1">
                        <span className="text-xs text-muted-foreground">涉及角色:</span>
                        {conflict.involvedCharacters.map((ch, j) => (
                          <span key={j} className="text-xs px-1.5 py-0.5 rounded bg-secondary">{ch}</span>
                        ))}
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>
          ) : (
            <div className="text-center py-4 text-sm text-muted-foreground">点击按钮检测剧情冲突</div>
          )}
        </div>
      )}

      <div className="paper-sheet rounded-2xl border border-border/40 px-4 py-3 shadow-lg shadow-primary/5">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
          <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <Type size={16} className="text-primary" />
            阅读设置
          </div>
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
            {READER_FONTS.map((font) => (
              <button
                key={font.id}
                type="button"
                onClick={() => setReaderPreferences((current) => ({ ...current, font: font.id }))}
                className={`min-h-9 rounded-xl border px-3 text-sm transition-all ${readerFont === font.id ? "border-primary/45 bg-primary/10 text-primary shadow-sm" : "border-border/45 bg-background/45 text-muted-foreground hover:text-foreground"}`}
                style={{ fontFamily: font.stack, fontWeight: font.weight, letterSpacing: font.spacing }}
              >
                {font.label}
              </button>
            ))}
          </div>
          <label className="flex min-w-[10rem] items-center gap-2 text-xs text-muted-foreground">
            字号
            <input type="range" min="16" max="26" step="1" value={readerSize} onChange={(event) => setReaderPreferences((current) => ({ ...current, size: Number(event.target.value) }))} className="min-w-0 flex-1 accent-primary" />
            <span className="w-8 text-right font-mono">{readerSize}</span>
          </label>
          <label className="flex min-w-[10rem] items-center gap-2 text-xs text-muted-foreground">
            行距
            <input type="range" min="1.55" max="2.35" step="0.05" value={readerLineHeight} onChange={(event) => setReaderPreferences((current) => ({ ...current, lineHeight: Number(event.target.value) }))} className="min-w-0 flex-1 accent-primary" />
            <span className="w-10 text-right font-mono">{readerLineHeight.toFixed(2)}</span>
          </label>
        </div>
      </div>
      </>)}

      {/* Focus mode overlay bar */}
      {focusMode && (
        <div className="fixed top-0 inset-x-0 z-50 flex items-center justify-between px-4 py-2 bg-background/80 backdrop-blur border-b border-border/20 text-sm">
          <div className="flex items-center gap-3 text-muted-foreground">
            <Timer size={14} className="text-amber-500" />
            <span className="font-mono tabular-nums">{formatTimer(focusSeconds)}</span>
            <span className="text-border">|</span>
            <Type size={14} />
            <span className="tabular-nums">{body.length.toLocaleString()} 字</span>
            {focusStartWordCount > 0 && (
              <>
                <span className="text-border">|</span>
                <span className="tabular-nums text-primary">+{Math.max(0, body.length - focusStartWordCount)} 字本次</span>
              </>
            )}
          </div>
          <button
            onClick={exitFocusMode}
            className="flex items-center gap-1.5 rounded-lg border border-border/50 bg-secondary/60 px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
          >
            <Eye size={12} />
            退出专注
          </button>
        </div>
      )}

      {/* Chapter Highlights */}
      <ChapterHighlights bookId={bookId} chapterNumber={chapterNumber} />

      {/* Satisfaction Beats trigger */}
      <ChapterBeats bookId={bookId} chapterNumber={chapterNumber} onBeatsLoaded={setActiveBeats} />

      {/* Manuscript Sheet */}
      <div className={`paper-sheet relative min-h-[80vh] overflow-hidden rounded-2xl p-6 shadow-2xl shadow-primary/5 md:p-14 lg:p-20 ${focusMode ? "mt-12 border-0 shadow-none rounded-none min-h-screen" : ""}`}>
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
                className="block w-full rounded-xl border border-border/40 bg-background/60 px-4 py-3 text-center text-2xl font-medium text-foreground shadow-sm outline-none transition-all focus:border-primary/50 focus:ring-2 focus:ring-primary/10 md:text-4xl"
                style={{ fontFamily: selectedFont.stack, fontWeight: selectedFont.weight, letterSpacing: selectedFont.spacing }}
                autoFocus
              />
            </label>
          ) : (
            <h1 className="block w-full break-words px-1 text-3xl font-medium text-foreground tracking-normal leading-tight md:text-5xl" style={{ fontFamily: selectedFont.stack, fontWeight: selectedFont.weight, letterSpacing: selectedFont.spacing }}>
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
            className="w-full min-h-[78dvh] resize-y rounded-lg border border-border/30 bg-background/35 p-4 text-foreground/90 transition-all focus:border-primary/40 focus:outline-none focus:ring-2 focus:ring-primary/10 sm:min-h-[72vh] sm:p-6"
            style={{ fontFamily: selectedFont.stack, fontWeight: selectedFont.weight, letterSpacing: selectedFont.spacing, fontSize: readerSize, lineHeight: readerLineHeight }}
          />
        ) : (
          <article className="mx-auto max-w-[42rem] text-foreground/90">
            {paragraphs.map((para, i) => {
              const beat = activeBeats.find((b) => b.paragraph === i);
              return (
                <div key={i} className="mb-7">
                  {beat && (
                    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium mb-1 ${BEAT_COLORS[beat.type] ?? "bg-secondary/60 text-muted-foreground"}`}>
                      {beat.type}
                    </span>
                  )}
                  <p
                    className="break-words text-justify indent-[2em] first-letter:text-[1.45em] first-letter:font-semibold first-letter:text-primary/45"
                    style={{ fontFamily: selectedFont.stack, fontWeight: selectedFont.weight, letterSpacing: selectedFont.spacing, fontSize: readerSize, lineHeight: readerLineHeight }}
                  >
                    {para}
                  </p>
                </div>
              );
            })}
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

function ChapterHighlights({ bookId, chapterNumber }: { readonly bookId: string; readonly chapterNumber: number }) {
  const [highlights, setHighlights] = useState<{ highlights: string[]; hookLine: string; chapterSummary: string } | null>(null);
  const [generating, setGenerating] = useState(false);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    void fetchJson<typeof highlights>(`/books/${bookId}/chapters/${chapterNumber}/highlights`)
      .then((data) => { if (data) { setHighlights(data); setVisible(true); } })
      .catch(() => {});
  }, [bookId, chapterNumber]);

  const handleGenerate = async () => {
    setGenerating(true);
    try {
      const result = await postApi<typeof highlights>(`/books/${bookId}/chapters/${chapterNumber}/highlights`);
      if (result) {
        setHighlights(result);
        setVisible(true);
      }
    } catch (e) {
      await appAlert({ title: "生成失败", message: e instanceof Error ? e.message : "Failed", tone: "danger" });
    } finally {
      setGenerating(false);
    }
  };

  if (!visible && !generating) {
    return (
      <button
        onClick={handleGenerate}
        className="inline-flex items-center gap-1.5 rounded-xl border border-border/50 bg-secondary/60 px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-primary transition-colors"
      >
        <Sparkles size={12} />
        生成看点
      </button>
    );
  }

  if (generating) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground animate-pulse">
        <Sparkles size={12} className="text-primary" />
        正在分析看点...
      </div>
    );
  }

  if (!highlights) return null;

  return (
    <div className="rounded-xl border border-primary/15 bg-primary/[0.04] p-3 space-y-2">
      {highlights.hookLine && (
        <p className="text-sm font-medium text-primary">{highlights.hookLine}</p>
      )}
      {highlights.highlights.length > 0 && (
        <ul className="space-y-1">
          {highlights.highlights.map((h, i) => (
            <li key={i} className="text-xs text-muted-foreground flex items-start gap-1.5">
              <span className="text-primary shrink-0 mt-0.5">•</span>
              {h}
            </li>
          ))}
        </ul>
      )}
      {highlights.chapterSummary && (
        <p className="text-[11px] text-muted-foreground/70 border-t border-border/20 pt-1.5">{highlights.chapterSummary}</p>
      )}
      <button onClick={() => setVisible(false)} className="text-[10px] text-muted-foreground hover:text-foreground">收起</button>
    </div>
  );
}

// --- Satisfaction Beats inline tags on paragraphs ---

const BEAT_COLORS: Record<string, string> = {
  "打脸": "bg-rose-500/10 text-rose-600 dark:text-rose-400",
  "face-slap": "bg-rose-500/10 text-rose-600 dark:text-rose-400",
  "升级": "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  "power-up": "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  "反转": "bg-violet-500/10 text-violet-600 dark:text-violet-400",
  "twist": "bg-violet-500/10 text-violet-600 dark:text-violet-400",
  "悬念": "bg-sky-500/10 text-sky-600 dark:text-sky-400",
  "suspense": "bg-sky-500/10 text-sky-600 dark:text-sky-400",
  "拯救": "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  "rescue": "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  "复仇": "bg-red-500/10 text-red-600 dark:text-red-400",
  "revenge": "bg-red-500/10 text-red-600 dark:text-red-400",
  "揭秘": "bg-indigo-500/10 text-indigo-600 dark:text-indigo-400",
  "reveal": "bg-indigo-500/10 text-indigo-600 dark:text-indigo-400",
};

function ChapterBeats({ bookId, chapterNumber, onBeatsLoaded }: {
  readonly bookId: string;
  readonly chapterNumber: number;
  readonly onBeatsLoaded: (beats: ReadonlyArray<{ type: string; paragraph: number; description: string }>) => void;
}) {
  const [beats, setBeats] = useState<ReadonlyArray<{ type: string; paragraph: number; description: string }>>([]);
  const [generating, setGenerating] = useState(false);

  useEffect(() => {
    void fetchJson<typeof beats>(`/books/${bookId}/chapters/${chapterNumber}/beats`)
      .then((data) => { if (data && data.length > 0) { setBeats(data); onBeatsLoaded(data); } })
      .catch(() => {});
  }, [bookId, chapterNumber, onBeatsLoaded]);

  const handleGenerate = async () => {
    setGenerating(true);
    try {
      const result = await postApi<typeof beats>(`/books/${bookId}/chapters/${chapterNumber}/beats`);
      if (result) {
        setBeats(result);
        onBeatsLoaded(result);
      }
    } catch {
      // keep empty
    } finally {
      setGenerating(false);
    }
  };

  if (beats.length > 0) return null;

  return (
    <button
      onClick={handleGenerate}
      disabled={generating}
      className="inline-flex items-center gap-1.5 rounded-xl border border-border/50 bg-secondary/60 px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-primary transition-colors disabled:opacity-40"
    >
      <Zap size={12} />
      {generating ? "分析中..." : "标记爽点"}
    </button>
  );
}
