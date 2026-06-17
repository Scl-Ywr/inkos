import { useState, useEffect, useCallback } from "react";
import { fetchJson, postApi, deleteApi } from "../../hooks/use-api";
import type { Theme } from "../../hooks/use-theme";
import type { TFunction } from "../../hooks/use-i18n";
import { useColors } from "../../hooks/use-colors";
import { Lightbulb, X, Trash2, Plus, Link } from "lucide-react";

export interface ScratchEntry {
  readonly id: string;
  readonly text: string;
  readonly tags: string[];
  readonly createdAt: string;
  readonly linkedChapter?: number;
}

export interface ScratchpadPanelProps {
  readonly bookId: string;
  readonly theme: Theme;
  readonly t: TFunction;
  readonly onClose: () => void;
}

export function ScratchpadPanel({ bookId, theme, t, onClose }: ScratchpadPanelProps) {
  const c = useColors(theme);
  const [entries, setEntries] = useState<ReadonlyArray<ScratchEntry>>([]);
  const [loading, setLoading] = useState(true);
  const [inputText, setInputText] = useState("");
  const [inputTags, setInputTags] = useState("");
  const [inputChapter, setInputChapter] = useState("");
  const [saving, setSaving] = useState(false);

  const loadEntries = useCallback(async () => {
    try {
      const data = await fetchJson<ReadonlyArray<ScratchEntry>>(`/books/${bookId}/scratchpad`);
      setEntries(data ?? []);
    } catch {
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, [bookId]);

  useEffect(() => { loadEntries(); }, [loadEntries]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  const handleSave = async () => {
    if (!inputText.trim()) return;
    setSaving(true);
    try {
      const tags = inputTags.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
      const chapterNum = inputChapter ? parseInt(inputChapter, 10) : undefined;
      const updated = await postApi<ReadonlyArray<ScratchEntry>>(`/books/${bookId}/scratchpad`, {
        text: inputText.trim(),
        tags,
        ...(chapterNum != null && Number.isFinite(chapterNum) ? { linkedChapter: chapterNum } : {}),
      });
      setEntries(updated ?? []);
      setInputText("");
      setInputTags("");
      setInputChapter("");
    } catch {
      // keep local state
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (entryId: string) => {
    try {
      const updated = await deleteApi<ReadonlyArray<ScratchEntry>>(`/books/${bookId}/scratchpad/${entryId}`);
      setEntries(updated ?? []);
    } catch {
      // keep local state
    }
  };

  const isZh = t("scratchpad.title") !== "Scratchpad";

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="w-full max-w-lg sm:mx-4 rounded-t-xl sm:rounded-xl border border-border bg-card shadow-2xl max-h-[80vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <div className="flex items-center gap-2">
            <Lightbulb size={16} className="text-amber-500" />
            <h2 className="text-sm font-semibold text-foreground">{t("scratchpad.title")}</h2>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors">
            <X size={16} />
          </button>
        </div>

        {/* Input area */}
        <div className="px-4 py-3 space-y-2 border-b border-border/30">
          <textarea
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            placeholder={isZh ? "记录灵感碎片..." : "Capture an idea..."}
            rows={3}
            className="w-full rounded-md border border-border/50 bg-transparent px-3 py-2 text-sm text-foreground resize-none focus:outline-none focus:ring-1 focus:ring-primary/50"
            onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) handleSave(); }}
          />
          <div className="flex gap-2">
            <input
              value={inputTags}
              onChange={(e) => setInputTags(e.target.value)}
              placeholder={isZh ? "标签（逗号分隔）" : "Tags (comma separated)"}
              className="flex-1 rounded-md border border-border/50 bg-transparent px-3 py-1.5 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary/50"
            />
            <div className="flex items-center gap-1">
              <Link size={12} className="text-muted-foreground" />
              <input
                value={inputChapter}
                onChange={(e) => setInputChapter(e.target.value.replace(/\D/g, ""))}
                placeholder={isZh ? "章节" : "Ch."}
                className="w-14 rounded-md border border-border/50 bg-transparent px-2 py-1.5 text-xs text-foreground text-center focus:outline-none focus:ring-1 focus:ring-primary/50"
              />
            </div>
          </div>
          <button
            onClick={handleSave}
            disabled={!inputText.trim() || saving}
            className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-40 disabled:pointer-events-none"
          >
            <Plus size={12} />
            {saving ? (isZh ? "保存中..." : "Saving...") : (isZh ? "保存灵感" : "Save idea")}
          </button>
        </div>

        {/* Entries list */}
        <div className="flex-1 overflow-y-auto px-4 py-2 space-y-2">
          {loading ? (
            <div className="text-center py-8 text-sm text-muted-foreground">{t("common.loading")}</div>
          ) : entries.length === 0 ? (
            <div className="text-center py-8 text-sm text-muted-foreground">
              {isZh ? "暂无灵感记录" : "No ideas yet"}
            </div>
          ) : (
            entries.map((entry) => (
              <div key={entry.id} className="rounded-lg border border-border/30 p-3 space-y-1.5">
                <div className="flex items-start justify-between gap-2">
                  <p className="text-sm text-foreground whitespace-pre-wrap break-words flex-1">{entry.text}</p>
                  <button
                    onClick={() => handleDelete(entry.id)}
                    className="p-1 rounded shrink-0 text-muted-foreground hover:text-destructive transition-colors"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
                <div className="flex items-center gap-1.5 flex-wrap">
                  {entry.tags.map((tag) => (
                    <span key={tag} className="inline-flex rounded-full px-2 py-0.5 text-[10px] font-medium bg-amber-500/10 text-amber-600 dark:text-amber-400">
                      {tag}
                    </span>
                  ))}
                  {entry.linkedChapter != null && (
                    <span className="inline-flex items-center gap-0.5 rounded-full px-2 py-0.5 text-[10px] font-medium bg-primary/10 text-primary">
                      <Link size={8} />
                      {isZh ? `第${entry.linkedChapter}章` : `Ch.${entry.linkedChapter}`}
                    </span>
                  )}
                  <span className="text-[10px] text-muted-foreground ml-auto">
                    {new Date(entry.createdAt).toLocaleDateString()}
                  </span>
                </div>
              </div>
            ))
          )}
        </div>

        {/* Footer hint */}
        <div className="px-4 py-2 text-[10px] text-muted-foreground border-t border-border/20">
          {isZh ? "Ctrl+Enter 保存 · Esc 关闭" : "Ctrl+Enter to save · Esc to close"}
        </div>
      </div>
    </div>
  );
}
