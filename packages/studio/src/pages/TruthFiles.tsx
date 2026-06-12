import { fetchJson, useApi } from "../hooks/use-api";
import { useState } from "react";
import type { Theme } from "../hooks/use-theme";
import type { TFunction } from "../hooks/use-i18n";
import { useColors } from "../hooks/use-colors";
import { Clock3, Pencil, Save, X } from "lucide-react";
import { appAlert } from "../lib/app-dialog";

interface TruthFile {
  readonly name: string;
  readonly size: number;
  readonly preview: string;
  readonly legacy?: boolean;
  readonly readonly?: boolean;
  readonly readonlyReason?: string;
}

interface TruthFileHistoryVersion {
  readonly chapter: number;
  readonly size: number;
  readonly preview: string;
}

// Phase 5 hotfix: shim files are read-only — point users at the
// authoritative outline/* path so edits actually land where the runtime
// reads them.
export const SHIM_AUTHORITATIVE_PATH: Readonly<Record<string, string>> = {
  "story_bible.md": "outline/story_frame.md",
  "book_rules.md": "outline/story_frame.md",
};

/**
 * Phase hotfix 2: when the GET response carries `legacy: true`, the file is
 * a Phase 5 compat shim. The UI must hide the Edit button and surface a
 * warning pointing at the authoritative outline path. This helper centralizes
 * the rule so it's unit-testable without a DOM.
 */
export interface FilePresentation {
  readonly canEdit: boolean;
  readonly legacy: boolean;
  readonly authoritativePath: string | null;
  readonly readonly: boolean;
  readonly readonlyReason: string | null;
}

export function deriveFilePresentation(
  fileName: string | null,
  fileData: { content: string | null; legacy?: boolean; readonly?: boolean; readonlyReason?: string } | null | undefined,
): FilePresentation {
  const legacy = fileData?.legacy === true;
  const readonly = fileData?.readonly === true;
  const authoritativePath = fileName ? SHIM_AUTHORITATIVE_PATH[fileName] ?? null : null;
  // Edit only makes sense when we actually have content AND it's not a shim.
  const canEdit = !!fileName && !!fileData && fileData.content != null && !legacy && !readonly;
  return {
    canEdit,
    legacy,
    authoritativePath,
    readonly,
    readonlyReason: readonly ? fileData?.readonlyReason ?? "readonly" : null,
  };
}

interface Nav {
  toBook: (id: string) => void;
  toDashboard: () => void;
}

export function TruthFiles({ bookId, nav, theme, t }: { bookId: string; nav: Nav; theme: Theme; t: TFunction }) {
  const c = useColors(theme);
  const { data } = useApi<{ files: ReadonlyArray<TruthFile> }>(`/books/${bookId}/truth`);
  const [selected, setSelected] = useState<string | null>(null);
  const [editMode, setEditMode] = useState(false);
  const [editText, setEditText] = useState("");
  const [savingEdit, setSavingEdit] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [selectedHistoryChapter, setSelectedHistoryChapter] = useState<number | null>(null);
  const { data: fileData, refetch: refetchFile } = useApi<{ file: string; content: string | null; legacy?: boolean; readonly?: boolean; readonlyReason?: string }>(
    selected ? `/books/${bookId}/truth/${selected}` : "",
  );
  const { data: historyData } = useApi<{ file: string; versions: ReadonlyArray<TruthFileHistoryVersion> }>(
    selected && historyOpen ? `/books/${bookId}/truth/${selected}/history` : "",
  );
  const { data: historyFileData } = useApi<{ file: string; chapter: number; content: string | null }>(
    selected && selectedHistoryChapter !== null ? `/books/${bookId}/truth/${selected}/history/${selectedHistoryChapter}` : "",
  );

  const presentation = deriveFilePresentation(selected, fileData);
  const isLegacyShim = presentation.legacy;
  const isRuntimeDiagnostic = presentation.readonlyReason === "runtime-diagnostic";
  const isRuntimeState = presentation.readonlyReason === "runtime-state";
  const viewingHistory = selectedHistoryChapter !== null;
  const displayContent = viewingHistory ? historyFileData?.content : fileData?.content;
  const hasViewerContent = selected && (fileData?.content != null || viewingHistory);

  const startEdit = () => {
    setSelectedHistoryChapter(null);
    setEditText(fileData?.content ?? "");
    setEditMode(true);
  };

  const cancelEdit = () => {
    setEditMode(false);
  };

  const selectFile = (fileName: string) => {
    setSelected(fileName);
    setEditMode(false);
    setHistoryOpen(false);
    setSelectedHistoryChapter(null);
  };

  const toggleHistory = () => {
    setEditMode(false);
    setHistoryOpen((open) => {
      const next = !open;
      if (!next) setSelectedHistoryChapter(null);
      return next;
    });
  };

  const handleSaveEdit = async () => {
    if (!selected) return;
    setSavingEdit(true);
    try {
      await fetchJson(`/books/${bookId}/truth/${selected}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: editText }),
      });
      setEditMode(false);
      refetchFile();
    } catch (e) {
      await appAlert({ title: "保存失败", message: e instanceof Error ? e.message : "Failed to save", tone: "danger" });
    } finally {
      setSavingEdit(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <button onClick={nav.toDashboard} className={c.link}>{t("bread.books")}</button>
        <span className="text-border">/</span>
        <button onClick={() => nav.toBook(bookId)} className={c.link}>{bookId}</button>
        <span className="text-border">/</span>
        <span className="text-foreground">{t("truth.title")}</span>
      </div>

      <h1 className="font-serif text-3xl">{t("truth.title")}</h1>

      <div className="grid grid-cols-[240px_1fr] gap-6">
        {/* File list */}
        <div className={`border ${c.cardStatic} rounded-lg overflow-hidden`}>
          {data?.files.map((f) => (
            <button
              key={f.name}
              onClick={() => selectFile(f.name)}
              className={`w-full text-left px-3 py-2.5 text-sm border-b border-border/40 transition-colors ${
                selected === f.name
                  ? "bg-primary/10 text-primary"
                  : "hover:bg-muted/30 text-muted-foreground"
              }`}
            >
              <div className="font-mono text-sm truncate">{f.name}</div>
              <div className="text-xs text-muted-foreground mt-0.5">{f.size.toLocaleString()} {t("truth.chars")}</div>
            </button>
          ))}
          {(!data?.files || data.files.length === 0) && (
            <div className="px-3 py-4 text-sm text-muted-foreground text-center">{t("truth.empty")}</div>
          )}
        </div>

        {/* Content viewer */}
        <div className={`border ${c.cardStatic} rounded-lg p-5 min-h-[400px] flex flex-col`}>
          {hasViewerContent ? (
            <>
              {isLegacyShim && (
                <div
                  data-testid="legacy-shim-warning"
                  className="mb-3 px-3 py-2 rounded-md border border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300 text-xs leading-relaxed"
                >
                  <div className="font-medium">兼容层只读 / Read-only compat shim</div>
                  <div className="mt-1">
                    本文件已废弃，仅供外部读取。权威来源：
                    <code className="ml-1 px-1 py-0.5 rounded bg-background/40 font-mono">
                      {SHIM_AUTHORITATIVE_PATH[selected] ?? "outline/"}
                    </code>
                  </div>
                </div>
              )}
              {isRuntimeDiagnostic && (
                <div
                  data-testid="runtime-diagnostic-warning"
                  className="mb-3 px-3 py-2 rounded-md border border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300 text-xs leading-relaxed"
                >
                  <div className="font-medium">运行时诊断文件 / Runtime diagnostic</div>
                  <div className="mt-1">
                    这里展示本章写作时的上下文选择、保护层、可压缩层和预算 trace。它只用于追溯系统看了什么，不作为可编辑设定。
                  </div>
                </div>
              )}
              {isRuntimeState && (
                <div
                  data-testid="runtime-state-warning"
                  className="mb-3 px-3 py-2 rounded-md border border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 text-xs leading-relaxed"
                >
                  <div className="font-medium">结构化状态文件 / Runtime state</div>
                  <div className="mt-1">
                    这里展示写作核心维护的结构化真相数据，关系线通常在 hooks.json 中以 relationship 类型记录；为避免破坏 schema，当前只读。
                  </div>
                </div>
              )}
              <div className="flex items-center justify-between gap-2 mb-3">
                <div className="min-w-0">
                  {viewingHistory ? (
                    <div className="text-xs text-muted-foreground">
                      历史快照：第 {selectedHistoryChapter} 章后
                    </div>
                  ) : (
                    <div className="text-xs text-muted-foreground">当前版本</div>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  {selected && (
                    <button
                      onClick={toggleHistory}
                      className={`inline-flex items-center gap-1 px-3 py-1.5 text-xs rounded-md ${historyOpen ? c.btnPrimary : c.btnSecondary}`}
                    >
                      <Clock3 size={14} />
                      历史
                    </button>
                  )}
                {editMode ? (
                  <>
                    <button
                      onClick={cancelEdit}
                      className={`inline-flex items-center gap-1 px-3 py-1.5 text-xs rounded-md ${c.btnSecondary}`}
                    >
                      <X size={14} />
                      Cancel
                    </button>
                    <button
                      onClick={handleSaveEdit}
                      disabled={savingEdit}
                      className={`inline-flex items-center gap-1 px-3 py-1.5 text-xs rounded-md ${c.btnPrimary} disabled:opacity-50`}
                    >
                      <Save size={14} />
                      {savingEdit ? t("truth.saving") : t("truth.save")}
                    </button>
                  </>
                ) : (
                  presentation.canEdit && !viewingHistory && (
                    <button
                      onClick={startEdit}
                      className={`inline-flex items-center gap-1 px-3 py-1.5 text-xs rounded-md ${c.btnSecondary}`}
                    >
                      <Pencil size={14} />
                      Edit
                    </button>
                  )
                )}
                </div>
              </div>
              {historyOpen && (
                <div className="mb-3 rounded-md border border-border/60 bg-muted/20 p-3">
                  <div className="flex items-center justify-between gap-2 mb-2">
                    <div className="text-xs font-medium text-muted-foreground">历史版本</div>
                    {viewingHistory && (
                      <button
                        onClick={() => setSelectedHistoryChapter(null)}
                        className={`px-2.5 py-1 text-xs rounded-md ${c.btnSecondary}`}
                      >
                        返回当前
                      </button>
                    )}
                  </div>
                  <div className="flex gap-2 overflow-x-auto pb-1">
                    {historyData?.versions.map((version) => (
                      <button
                        key={version.chapter}
                        onClick={() => setSelectedHistoryChapter(version.chapter)}
                        className={`shrink-0 rounded-md border px-3 py-2 text-left text-xs transition-colors ${
                          selectedHistoryChapter === version.chapter
                            ? "border-primary bg-primary/10 text-primary"
                            : "border-border/60 bg-background/50 text-muted-foreground hover:bg-muted/40"
                        }`}
                      >
                        <div className="font-medium">第 {version.chapter} 章后</div>
                        <div className="mt-0.5 opacity-70">{version.size.toLocaleString()} {t("truth.chars")}</div>
                      </button>
                    ))}
                    {historyData && historyData.versions.length === 0 && (
                      <div className="py-2 text-xs text-muted-foreground">暂无历史快照</div>
                    )}
                    {!historyData && (
                      <div className="py-2 text-xs text-muted-foreground">加载历史...</div>
                    )}
                  </div>
                </div>
              )}
              {editMode ? (
                <textarea
                  value={editText}
                  onChange={(e) => setEditText(e.target.value)}
                  className={`${c.input} flex-1 rounded-md p-3 text-sm font-mono leading-relaxed resize-none min-h-[360px]`}
                />
              ) : (
                <pre className="text-sm leading-relaxed whitespace-pre-wrap font-mono text-foreground/80">
                  {displayContent ?? "加载历史..."}
                </pre>
              )}
            </>
          ) : selected && fileData?.content === null ? (
            <div className="text-muted-foreground text-sm">{t("truth.notFound")}</div>
          ) : (
            <div className="text-muted-foreground/50 text-sm italic">{t("truth.selectFile")}</div>
          )}
        </div>
      </div>
    </div>
  );
}
