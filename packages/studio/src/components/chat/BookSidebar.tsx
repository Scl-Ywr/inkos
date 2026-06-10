import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import type { Theme } from "../../hooks/use-theme";
import type { TFunction } from "../../hooks/use-i18n";
import type { SSEMessage } from "../../hooks/use-sse";
import { useChatStore } from "../../store/chat";
import { fetchJson } from "../../hooks/use-api";
import { mobileTextInputHandlers } from "../../lib/mobile-input";
import { PanelRightClose, PanelRightOpen, ArrowLeft, Loader2, Pencil, Save, X } from "lucide-react";
import { LazyStreamdown } from "../ai-elements/lazy-streamdown";
import { ProgressSection } from "../sidebar/ProgressSection";
import { FoundationSection, invalidateFoundationFilesCache } from "../sidebar/FoundationSection";
import { SummarySection } from "../sidebar/SummarySection";
import { ChaptersSection } from "../sidebar/ChaptersSection";
import { CharacterSection, invalidateCharactersCache } from "../sidebar/CharacterSection";
import {
  getCachedArtifactContent,
  invalidateBookArtifactContent,
  loadArtifactContent,
  setCachedArtifactContent,
  type ArtifactContentTarget,
} from "../sidebar/artifact-content-cache";

export interface BookSidebarProps {
  readonly bookId: string;
  readonly theme: Theme;
  readonly t: TFunction;
  readonly sse: { messages: ReadonlyArray<SSEMessage>; connected: boolean };
}

const FOUNDATION_LABELS: Record<string, string> = {
  "story_bible.md": "世界观设定",
  "outline/story_frame.md": "世界观设定",
  "volume_outline.md": "卷纲规划",
  "outline/volume_map.md": "卷纲规划",
  "book_rules.md": "叙事规则",
  "current_state.md": "状态卡",
  "pending_hooks.md": "伏笔池",
  "particle_ledger.md": "资源账本",
  "chapter_summaries.md": "章节摘要",
  "subplot_board.md": "支线进度",
  "emotional_arcs.md": "感情线",
  "character_matrix.md": "角色矩阵",
};

function isCompatPointerContent(content: string): boolean {
  return /兼容指针|兼容入口|已废弃|compat pointer|deprecated|authoritative source/iu.test(content);
}

function presentArtifactContent(file: string | null, content: string | null): string | null {
  if (content === null || !file || !isCompatPointerContent(content)) return content;

  if (file === "book_rules.md") {
    return [
      "# 叙事规则索引",
      "",
      "本书使用新版结构，叙事规则的权威内容已经合并到 `outline/story_frame.md` 文件顶部的 YAML 配置区。",
      "",
      "请在核心文件中打开“世界观设定”查看完整设定与规则。这个入口只用于兼容旧书和外部读取。",
    ].join("\n");
  }

  if (file === "character_matrix.md") {
    const roleLines = content
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => /^-\s+roles\//.test(line));
    return [
      "# 角色矩阵索引",
      "",
      "本书使用新版角色图谱，角色矩阵已经拆分为 `roles/` 下的一人一卡文件。侧栏“角色”会直接读取这些角色卡，并按当前章节相关性显示。",
      "",
      roleLines.length > 0 ? "## 角色文件" : "",
      ...roleLines,
    ].filter(Boolean).join("\n");
  }

  if (file === "story_bible.md") {
    return [
      "# 世界观设定索引",
      "",
      "本书使用新版结构，世界观权威内容位于 `outline/story_frame.md`，卷纲位于 `outline/volume_map.md`，角色档案位于 `roles/`。",
      "",
      "请优先打开核心文件中的“世界观设定”和“卷纲规划”。",
    ].join("\n");
  }

  return content.replace(/已废弃/g, "兼容入口").replace(/deprecated/gi, "compat entry");
}

function ArtifactView({ bookId }: { readonly bookId: string }) {
  const artifactFile = useChatStore((s) => s.artifactFile);
  const artifactChapter = useChatStore((s) => s.artifactChapter);
  const closeArtifact = useChatStore((s) => s.closeArtifact);
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [editContent, setEditContent] = useState("");
  const [saving, setSaving] = useState(false);
  const editRef = useRef<HTMLTextAreaElement>(null);

  const isChapter = artifactChapter !== null;
  const target = useMemo<ArtifactContentTarget | null>(
    () => isChapter
      ? { type: "chapter", chapter: artifactChapter }
      : artifactFile ? { type: "truth", file: artifactFile } : null,
    [artifactFile, artifactChapter, isChapter],
  );
  const label = isChapter
    ? `第 ${artifactChapter} 章`
    : artifactFile ? FOUNDATION_LABELS[artifactFile] ?? artifactFile : "";

  useEffect(() => {
    if (!target) return;
    let ignore = false;
    const cached = getCachedArtifactContent(bookId, target);
    setEditing(false);

    if (cached !== undefined) {
      setContent(cached);
      setLoading(false);
    } else {
      setContent(null);
      setLoading(true);
    }

    loadArtifactContent(bookId, target)
      .then((nextContent) => {
        if (!ignore) {
          setContent(nextContent);
        }
      })
      .finally(() => {
        if (!ignore) {
          setLoading(false);
        }
      });

    return () => {
      ignore = true;
    };
  }, [bookId, artifactFile, artifactChapter, target]);

  const handleEdit = useCallback(() => {
    setEditContent(content ?? "");
    setEditing(true);
  }, [content]);

  const handleSave = useCallback(async () => {
    const nextContent = editRef.current?.value ?? editContent;
    setEditContent(nextContent);
    setSaving(true);
    try {
      if (isChapter) {
        await fetchJson(`/books/${bookId}/chapters/${artifactChapter}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: nextContent }),
        });
      } else if (artifactFile) {
        await fetchJson(`/books/${bookId}/truth/${artifactFile}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: nextContent }),
        });
      }
      if (target) {
        setCachedArtifactContent(bookId, target, nextContent);
      }
      setContent(nextContent);
      setEditing(false);
    } catch {
      // keep editing state on error
    } finally {
      setSaving(false);
    }
  }, [bookId, artifactFile, artifactChapter, isChapter, editContent, target]);

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 px-3 py-2.5 border-b border-border/20 shrink-0">
        <button
          onClick={closeArtifact}
          className="w-6 h-6 rounded-md flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-secondary/50 transition-colors"
        >
          <ArrowLeft size={14} />
        </button>
        <span className="text-sm font-medium truncate flex-1">{label}</span>
        {!loading && content !== null && !editing && !isCompatPointerContent(content) && (
          <button
            onClick={handleEdit}
            className="w-6 h-6 rounded-md flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-secondary/50 transition-colors"
          >
            <Pencil size={12} />
          </button>
        )}
        {editing && (
          <div className="flex items-center gap-1">
            <button
              onClick={handleSave}
              disabled={saving}
              className="w-6 h-6 rounded-md flex items-center justify-center text-emerald-500 hover:bg-emerald-500/10 transition-colors"
            >
              {saving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
            </button>
            <button
              onClick={() => setEditing(false)}
              className="w-6 h-6 rounded-md flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-secondary/50 transition-colors"
            >
              <X size={12} />
            </button>
          </div>
        )}
      </div>
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 size={16} className="text-muted-foreground animate-spin" />
          </div>
        ) : content === null ? (
          <p className="text-xs text-muted-foreground/50 italic px-4 py-3">文件不存在</p>
        ) : editing ? (
          <textarea
            ref={editRef}
            defaultValue={editContent}
            {...mobileTextInputHandlers(setEditContent)}
            className="w-full h-full min-h-[300px] bg-transparent text-sm leading-7 px-4 py-3 resize-none outline-none border-0 font-mono"
          />
        ) : (
          <div className="artifact-markdown px-4 py-3 text-sm leading-7">
            <LazyStreamdown mode="static" pluginSet="cjk">{presentArtifactContent(artifactFile, content) ?? ""}</LazyStreamdown>
          </div>
        )}
      </div>
    </div>
  );
}

function PanelView({ bookId, theme: _theme, t, sse }: BookSidebarProps) {
  const isZh = t("nav.connected") === "\u5DF2\u8FDE\u63A5";

  // Show writing indicator only during pipeline operations (write/audit/revise)
  const [activeOp, setActiveOp] = useState<string | null>(null);
  useEffect(() => {
    const latest = sse.messages;
    if (latest.length === 0) return;
    const last = latest[latest.length - 1];
    if (last.event === "write:start") setActiveOp("write");
    else if (last.event === "tool:start") {
      const data = last.data as { tool?: string; args?: { agent?: string } } | null;
      if (data?.tool === "sub_agent") {
        const agent = data.args?.agent;
        if (agent === "writer") setActiveOp("write");
        else if (agent === "auditor") setActiveOp("audit");
        else if (agent === "reviser") setActiveOp("revise");
      }
    } else if (last.event === "write:complete" || last.event === "tool:end") {
      setActiveOp(null);
    }
  }, [sse.messages]);

  const OP_LABELS: Record<string, string> = {
    write: isZh ? "正在写作中..." : "Writing...",
    audit: isZh ? "正在审计中..." : "Auditing...",
    revise: isZh ? "正在修订中..." : "Revising...",
  };

  return (
    <div className="flex flex-col gap-2 p-3">
      {activeOp && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-primary/5 border border-primary/10">
          <Loader2 size={12} className="text-primary animate-spin shrink-0" />
          <span className="text-xs text-primary font-medium">
            {OP_LABELS[activeOp] ?? activeOp}
          </span>
        </div>
      )}
      <ProgressSection sse={sse} />
      <ChaptersSection bookId={bookId} isZh={isZh} />
      <CharacterSection bookId={bookId} />
      <FoundationSection bookId={bookId} />
      <SummarySection bookId={bookId} />
    </div>
  );
}

const SIDEBAR_RATIO = 0.4;
const SIDEBAR_MIN = 280;
const SIDEBAR_MAX = 700;

function defaultSidebarWidth(): number {
  return Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, Math.round(window.innerWidth * SIDEBAR_RATIO)));
}

export function BookSidebar({ bookId, theme, t, sse }: BookSidebarProps) {
  const sidebarView = useChatStore((s) => s.sidebarView);
  const bumpBookDataVersion = useChatStore((s) => s.bumpBookDataVersion);
  const [width, setWidth] = useState(defaultSidebarWidth);
  const dragging = useRef(false);

  useEffect(() => {
    const latest = sse.messages.at(-1);
    if (!latest || (latest.event !== "resync:complete" && latest.event !== "resync:error")) return;
    const data = latest.data as { bookId?: unknown } | null;
    if (data?.bookId !== bookId) return;
    invalidateBookArtifactContent(bookId);
    invalidateFoundationFilesCache(bookId);
    invalidateCharactersCache(bookId);
    bumpBookDataVersion();
  }, [bookId, bumpBookDataVersion, sse.messages]);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = true;
    const startX = e.clientX;
    const startW = width;
    const onMove = (ev: MouseEvent) => {
      if (!dragging.current) return;
      const delta = startX - ev.clientX;
      setWidth(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, startW + delta)));
    };
    const onUp = () => {
      dragging.current = false;
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, [width]);

  return (
    <aside
      className="hidden lg:flex shrink-0 flex-col bg-background/30 backdrop-blur-sm overflow-y-auto relative"
      style={{ width }}
    >
      {/* Resize handle */}
      <div
        onMouseDown={onMouseDown}
        className="absolute left-0 top-0 h-full w-1 cursor-col-resize hover:bg-primary/20 active:bg-primary/30 transition-colors z-10"
      />
      {sidebarView === "artifact" ? (
        <ArtifactView bookId={bookId} />
      ) : (
        <PanelView bookId={bookId} theme={theme} t={t} sse={sse} />
      )}
    </aside>
  );
}

export function BookSidebarToggle({ bookId, theme, t, sse }: BookSidebarProps) {
  const [open, setOpen] = useState(false);
  const sidebarView = useChatStore((s) => s.sidebarView);

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="fixed right-3 top-[7rem] z-20 flex h-10 w-10 items-center justify-center rounded-2xl border border-border/50 bg-card/90 text-muted-foreground shadow-lg shadow-primary/10 backdrop-blur transition-colors hover:text-foreground lg:hidden"
        aria-label="打开书籍信息"
      >
        <PanelRightOpen size={18} />
      </button>

      <div
        className={`fixed inset-0 z-40 lg:hidden transition-opacity duration-150 ${open ? "opacity-100" : "pointer-events-none opacity-0"}`}
        aria-hidden={!open}
        onClick={() => setOpen(false)}
      >
        <div className="absolute inset-0 bg-black/20 backdrop-blur-sm" />
        <aside
          className={`absolute right-0 top-0 h-full w-[min(28rem,calc(100vw-1rem))] overflow-y-auto border-l border-border/20 bg-background shadow-2xl shadow-primary/10 transition-transform duration-150 ${open ? "translate-x-0" : "translate-x-full"}`}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center justify-between border-b border-border/20 px-3 py-2.5 mobile-safe-top">
            <span className="text-xs font-medium text-muted-foreground">书籍信息</span>
            <button
              onClick={() => setOpen(false)}
              className="flex h-10 w-10 items-center justify-center rounded-xl text-muted-foreground hover:bg-secondary/50 hover:text-foreground"
              aria-label="关闭书籍信息"
            >
              <PanelRightClose size={16} />
            </button>
          </div>
          {sidebarView === "artifact" ? (
            <ArtifactView bookId={bookId} />
          ) : (
            <PanelView bookId={bookId} theme={theme} t={t} sse={sse} />
          )}
        </aside>
      </div>
    </>
  );
}
