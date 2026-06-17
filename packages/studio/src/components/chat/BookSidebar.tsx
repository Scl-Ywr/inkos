import { useState, useEffect, useCallback, useRef } from "react";
import type { Theme } from "../../hooks/use-theme";
import { useI18n, type TFunction } from "../../hooks/use-i18n";
import type { SSEMessage } from "../../hooks/use-sse";
import { useChatStore } from "../../store/chat";
import { fetchJson } from "../../hooks/use-api";
import { PanelRightClose, PanelRightOpen, ArrowLeft, Loader2, Pencil, Save, X, Network, Database } from "lucide-react";
import { MarkdownView } from "../ai-elements/markdown-view";
import { ProgressSection } from "../sidebar/ProgressSection";
import { FoundationSection } from "../sidebar/FoundationSection";
import { SummarySection } from "../sidebar/SummarySection";
import { ChaptersSection } from "../sidebar/ChaptersSection";
import { CharacterSection } from "../sidebar/CharacterSection";
import { RelationshipGraph } from "../sidebar/RelationshipGraph";
import { SidebarCard } from "../sidebar/SidebarCard";
import { FrontmatterCards } from "../sidebar/FrontmatterCards";
import { PendingHooksView } from "../sidebar/PendingHooksView";
import {
  FOUNDATION_FILE_LABELS,
  frontmatterToCards,
  hasTableRows,
  normalizeRoleCardForDisplay,
  presentCurrentState,
  relabelOkrJargon,
  roleFromPath,
  stripStructuralMarkers,
  type TruthFrontmatter,
} from "../../lib/truth-display";

export interface BookSidebarProps {
  readonly bookId: string;
  readonly theme: Theme;
  readonly t: TFunction;
  readonly sse: { messages: ReadonlyArray<SSEMessage>; connected: boolean };
  readonly onOpenKnowledge?: (bookId: string) => void;
}

// Friendly header label for an opened truth file: character files show the
// character's name, foundation files their friendly label, everything else its
// path as a last resort.
function artifactLabel(file: string): string {
  return roleFromPath(file)?.name ?? FOUNDATION_FILE_LABELS[file] ?? file;
}

// Read-mode body for an opened file. A few files need reader-friendly handling
// instead of raw markdown: pending_hooks.md (a wide tracking table) renders as
// cards, current_state.md hides its engineering seed note, and files with YAML
// frontmatter (story_frame.md) render structured cards above clean prose.
function renderTruthBody(
  file: string | null,
  content: string,
  frontmatter: TruthFrontmatter | null,
  body: string | null,
  t: (key: any) => string,
) {
  if (file === "pending_hooks.md") {
    return <PendingHooksView content={content} />;
  }
  if (file === "current_state.md") {
    const { isEmpty, body: stateBody } = presentCurrentState(content);
    return isEmpty ? (
      <p className="text-[14px] leading-6 text-muted-foreground/60 italic">
        {t("truth.noState")}
      </p>
    ) : (
      <MarkdownView mode="static" preset="cjk">{stateBody}</MarkdownView>
    );
  }
  if (file === "emotional_arcs.md" && !hasTableRows(content)) {
    return (
      <p className="text-[14px] leading-6 text-muted-foreground/60 italic">
        {t("truth.noArcs")}
      </p>
    );
  }
  return (
    <>
      <FrontmatterCards cards={frontmatterToCards(frontmatter)} />
      <MarkdownView mode="static" preset="cjk">
        {normalizeRoleCardForDisplay(file, relabelOkrJargon(stripStructuralMarkers(body ?? content)))}
      </MarkdownView>
    </>
  );
}

function ArtifactView({ bookId }: { readonly bookId: string }) {
  const { t } = useI18n();
  const artifactFile = useChatStore((s) => s.artifactFile);
  const artifactChapter = useChatStore((s) => s.artifactChapter);
  const closeArtifact = useChatStore((s) => s.closeArtifact);
  const [content, setContent] = useState<string | null>(null);
  const [frontmatter, setFrontmatter] = useState<TruthFrontmatter | null>(null);
  const [body, setBody] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [editContent, setEditContent] = useState("");
  const [saving, setSaving] = useState(false);

  const isChapter = artifactChapter !== null;
  const label = isChapter
    ? t("truth.chapterLabel").replace("{n}", artifactChapter.toString())
    : artifactFile ? artifactLabel(artifactFile) : "";

  useEffect(() => {
    setEditing(false);
    setLoading(true);
    setFrontmatter(null);
    setBody(null);
    if (isChapter) {
      fetchJson<{ content: string }>(`/books/${bookId}/chapters/${artifactChapter}`)
        .then((data) => setContent(data.content ?? ""))
        .catch(() => setContent(null))
        .finally(() => setLoading(false));
    } else if (artifactFile) {
      fetchJson<{ content: string | null; frontmatter?: TruthFrontmatter; body?: string }>(
        `/books/${bookId}/truth/${artifactFile}`,
      )
        .then((data) => {
          setContent(data.content ?? "");
          setFrontmatter(data.frontmatter ?? null);
          setBody(data.body ?? null);
        })
        .catch(() => setContent(null))
        .finally(() => setLoading(false));
    }
  }, [bookId, artifactFile, artifactChapter, isChapter]);

  const handleEdit = useCallback(() => {
    setEditContent(content ?? "");
    setEditing(true);
  }, [content]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      if (isChapter) {
        await fetchJson(`/books/${bookId}/chapters/${artifactChapter}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: editContent }),
        });
      } else if (artifactFile) {
        await fetchJson(`/books/${bookId}/truth/${artifactFile}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: editContent }),
        });
      }
      setContent(editContent);
      setEditing(false);
    } catch {
      // keep editing state on error
    } finally {
      setSaving(false);
    }
  }, [bookId, artifactFile, artifactChapter, isChapter, editContent]);

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 px-3 py-2.5 border-b border-border/20 shrink-0">
        <button
          onClick={closeArtifact}
          className="w-6 h-6 rounded-md flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-secondary/50 transition-colors"
        >
          <ArrowLeft size={14} />
        </button>
        <span className="text-[15px] leading-6 font-medium truncate flex-1">{label}</span>
        {!loading && content !== null && !editing && (
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
          <p className="text-[14px] leading-6 text-muted-foreground/50 italic px-4 py-3">文件不存在</p>
        ) : editing ? (
          <textarea
            value={editContent}
            onChange={(e) => setEditContent(e.target.value)}
            className="w-full h-full min-h-[300px] bg-transparent text-[15px] leading-7 px-4 py-3 resize-none outline-none border-0 font-mono"
          />
        ) : (
          <div className="px-4 py-3 text-[15px] leading-7">
            {renderTruthBody(isChapter ? null : artifactFile, content, frontmatter, body, t)}
          </div>
        )}
      </div>
    </div>
  );
}

function PanelView({ bookId, theme: _theme, t, sse, onOpenKnowledge }: BookSidebarProps) {
  const isZh = t("nav.connected") === "\u5DF2\u8FDE\u63A5";
  const openRelationshipGraph = useChatStore((s) => s.openRelationshipGraph);

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
          <span className="text-[14px] leading-5 text-primary font-medium">
            {OP_LABELS[activeOp] ?? activeOp}
          </span>
        </div>
      )}
      <SidebarCard title="关系">
        <button
          onClick={openRelationshipGraph}
          className="flex w-full items-center gap-2 rounded-lg bg-secondary/30 px-2.5 py-2 text-left transition-colors hover:bg-secondary/50"
        >
          <Network size={16} className="shrink-0 text-primary" />
          <span className="min-w-0 flex-1 truncate text-[15px] font-medium leading-6 text-foreground">
            关系图谱
          </span>
          <span className="text-[12px] leading-4 text-muted-foreground/60">Graph</span>
        </button>
      </SidebarCard>
      <SidebarCard title="知识库">
        <button
          onClick={() => onOpenKnowledge?.(bookId)}
          disabled={!onOpenKnowledge}
          className="flex w-full items-center gap-2 rounded-lg bg-secondary/30 px-2.5 py-2 text-left transition-colors hover:bg-secondary/50 disabled:cursor-not-allowed disabled:opacity-60"
        >
          <Database size={16} className="shrink-0 text-primary" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[15px] font-medium leading-6 text-foreground">资料分析与仿写</span>
            <span className="block truncate text-[12px] leading-4 text-muted-foreground/60">上传资料，生成风格参考</span>
          </span>
          <span className="text-[12px] leading-4 text-muted-foreground/60">KB</span>
        </button>
      </SidebarCard>
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

export function BookSidebar({ bookId, theme, t, sse, onOpenKnowledge }: BookSidebarProps) {
  const sidebarView = useChatStore((s) => s.sidebarView);
  const closeArtifact = useChatStore((s) => s.closeArtifact);
  const [width, setWidth] = useState(defaultSidebarWidth);
  const dragging = useRef(false);

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
      ) : sidebarView === "graph" ? (
        <RelationshipGraph source="book" bookId={bookId} sessionId={null} onClose={closeArtifact} />
      ) : (
        <PanelView bookId={bookId} theme={theme} t={t} sse={sse} onOpenKnowledge={onOpenKnowledge} />
      )}
    </aside>
  );
}

export function BookSidebarToggle({ bookId, theme, t, sse, onOpenKnowledge }: BookSidebarProps) {
  const [open, setOpen] = useState(false);
  const sidebarView = useChatStore((s) => s.sidebarView);
  const closeArtifact = useChatStore((s) => s.closeArtifact);

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="fixed right-3 top-[88px] z-20 flex h-11 w-11 items-center justify-center rounded-xl border border-border/40 bg-card text-muted-foreground shadow-sm transition-colors hover:text-foreground lg:hidden"
        aria-label="打开书籍信息"
      >
        <PanelRightOpen size={17} />
      </button>

      {open && (
        <div className="fixed inset-0 z-40 lg:hidden" onClick={() => setOpen(false)}>
          <div className="absolute inset-0 bg-black/20 backdrop-blur-sm" />
          <aside
            className="absolute right-0 top-0 h-full w-[420px] max-w-[85vw] bg-background border-l border-border/20 overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-border/20 px-4 pb-3 pt-[calc(env(safe-area-inset-top)+1rem)]">
              <span className="text-[15px] leading-6 font-medium text-muted-foreground">书籍信息</span>
              <button
                onClick={() => setOpen(false)}
                className="flex h-11 w-11 items-center justify-center rounded-xl text-muted-foreground transition-colors hover:bg-secondary/60 hover:text-foreground"
                aria-label="收起书籍信息"
              >
                <PanelRightClose size={17} />
              </button>
            </div>
            {sidebarView === "artifact" ? (
              <ArtifactView bookId={bookId} />
            ) : sidebarView === "graph" ? (
              <RelationshipGraph source="book" bookId={bookId} sessionId={null} onClose={closeArtifact} />
            ) : (
              <PanelView bookId={bookId} theme={theme} t={t} sse={sse} onOpenKnowledge={onOpenKnowledge} />
            )}
          </aside>
        </div>
      )}
    </>
  );
}
