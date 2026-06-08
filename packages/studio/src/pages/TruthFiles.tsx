import { fetchJson, useApi } from "../hooks/use-api";
import { useRef, useState } from "react";
import type { Theme } from "../hooks/use-theme";
import type { TFunction } from "../hooks/use-i18n";
import { useColors } from "../hooks/use-colors";
import { mobileTextInputHandlers } from "../lib/mobile-input";
import { appAlert } from "../lib/app-dialog";
import { Pencil, Save, X } from "lucide-react";

interface TruthFile {
  readonly name: string;
  readonly size: number;
  readonly preview: string;
  readonly legacy?: boolean;
}

// Phase 5 hotfix: shim files are read-only — point users at the
// authoritative outline/* path so edits actually land where the runtime
// reads them.
export const SHIM_AUTHORITATIVE_PATH: Readonly<Record<string, string>> = {
  "story_bible.md": "outline/story_frame.md",
  "book_rules.md": "outline/story_frame.md",
};

/**
 * When the GET response carries `legacy: true`, the file is a Phase 5 compat
 * entry. Hide the Edit button and point at the authoritative outline path.
 */
export interface FilePresentation {
  readonly canEdit: boolean;
  readonly legacy: boolean;
  readonly authoritativePath: string | null;
}

export function deriveFilePresentation(
  fileName: string | null,
  fileData: { content: string | null; legacy?: boolean } | null | undefined,
): FilePresentation {
  const legacy = fileData?.legacy === true;
  const authoritativePath = fileName ? SHIM_AUTHORITATIVE_PATH[fileName] ?? null : null;
  // Edit only makes sense when we actually have content AND it's not a shim.
  const canEdit = !!fileName && !!fileData && fileData.content != null && !legacy;
  return { canEdit, legacy, authoritativePath };
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
  const editRef = useRef<HTMLTextAreaElement>(null);
  const { data: fileData, refetch: refetchFile } = useApi<{ file: string; content: string | null; legacy?: boolean }>(
    selected ? `/books/${bookId}/truth/${selected}` : "",
  );

  const presentation = deriveFilePresentation(selected, fileData);
  const isLegacyShim = presentation.legacy;

  const startEdit = () => {
    setEditText(fileData?.content ?? "");
    setEditMode(true);
  };

  const cancelEdit = () => {
    setEditMode(false);
  };

  const handleSaveEdit = async () => {
    if (!selected) return;
    const nextText = editRef.current?.value ?? editText;
    setEditText(nextText);
    setSavingEdit(true);
    try {
      await fetchJson(`/books/${bookId}/truth/${selected}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: nextText }),
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

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[240px_minmax(0,1fr)] lg:gap-6">
        {/* File list */}
        <div className={`border ${c.cardStatic} rounded-lg overflow-hidden`}>
          {data?.files.map((f) => (
            <button
              key={f.name}
              onClick={() => { setSelected(f.name); setEditMode(false); }}
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
        <div className={`min-w-0 border ${c.cardStatic} rounded-lg p-4 sm:p-5 min-h-[400px] flex flex-col overflow-hidden`}>
          {selected && fileData?.content != null ? (
            <>
              {isLegacyShim && (
                <div
                  data-testid="legacy-shim-warning"
                  className="mb-3 px-3 py-2 rounded-md border border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300 text-xs leading-relaxed"
                >
                  <div className="font-medium">只读兼容入口 / Read-only compat entry</div>
                  <div className="mt-1">
                    本文件只是旧入口的索引和摘录；实际写作读取与编辑请使用：
                    <code className="ml-1 px-1 py-0.5 rounded bg-background/40 font-mono">
                      {SHIM_AUTHORITATIVE_PATH[selected] ?? "outline/"}
                    </code>
                  </div>
                </div>
              )}
              <div className="flex items-center justify-end gap-2 mb-3">
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
                  !isLegacyShim && (
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
              {editMode ? (
                <textarea
                  ref={editRef}
                  defaultValue={editText}
                  {...mobileTextInputHandlers(setEditText)}
                  className={`${c.input} flex-1 rounded-md p-3 text-sm font-mono leading-relaxed resize-none min-h-[360px]`}
                />
              ) : (
                <pre className="truth-file-pre min-w-full overflow-x-auto text-sm leading-relaxed font-mono text-foreground/80">{fileData.content}</pre>
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
