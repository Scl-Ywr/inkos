import { fetchJson, useApi, postApi } from "../hooks/use-api";
import { useRef, useState } from "react";
import type { Theme } from "../hooks/use-theme";
import type { TFunction } from "../hooks/use-i18n";
import { useI18n } from "../hooks/use-i18n";
import { useColors } from "../hooks/use-colors";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { StudioSelect } from "../components/StudioSelect";
import { mobileTextInputHandlers } from "../lib/mobile-input";
import { appAlert } from "../lib/app-dialog";
import { Plus, Pencil, Trash2 } from "lucide-react";

interface GenreInfo {
  readonly id: string;
  readonly name: string;
  readonly source: "project" | "builtin";
  readonly language: "zh" | "en";
}

interface GenreDetail {
  readonly profile: {
    readonly name: string;
    readonly id: string;
    readonly language: string;
    readonly chapterTypes: ReadonlyArray<string>;
    readonly fatigueWords: ReadonlyArray<string>;
    readonly numericalSystem: boolean;
    readonly powerScaling: boolean;
    readonly eraResearch: boolean;
    readonly pacingRule: string;
    readonly auditDimensions: ReadonlyArray<number>;
  };
  readonly body: string;
}

interface GenreFormData {
  readonly id: string;
  readonly name: string;
  readonly language: "zh" | "en";
  readonly chapterTypes: string;
  readonly fatigueWords: string;
  readonly numericalSystem: boolean;
  readonly powerScaling: boolean;
  readonly eraResearch: boolean;
  readonly pacingRule: string;
  readonly body: string;
}

const EMPTY_FORM: GenreFormData = {
  id: "",
  name: "",
  language: "zh",
  chapterTypes: "",
  fatigueWords: "",
  numericalSystem: false,
  powerScaling: false,
  eraResearch: false,
  pacingRule: "",
  body: "",
};

function parseCommaSeparated(value: string): ReadonlyArray<string> {
  return value.split(",").map((s) => s.trim()).filter(Boolean);
}

function GenreForm({
  form,
  onChange,
  onSubmit,
  onCancel,
  isEdit,
  c,
  t,
}: {
  readonly form: GenreFormData;
  readonly onChange: (next: GenreFormData) => void;
  readonly onSubmit: (next: GenreFormData) => void;
  readonly onCancel: () => void;
  readonly isEdit: boolean;
  readonly c: ReturnType<typeof useColors>;
  readonly t: TFunction;
}) {
  const idRef = useRef<HTMLInputElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const chapterTypesRef = useRef<HTMLInputElement>(null);
  const fatigueWordsRef = useRef<HTMLInputElement>(null);
  const pacingRuleRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const set = <K extends keyof GenreFormData>(key: K, value: GenreFormData[K]) =>
    onChange({ ...form, [key]: value });
  const textHandlers = <K extends keyof GenreFormData>(key: K) =>
    mobileTextInputHandlers((value) => set(key, value as GenreFormData[K]));
  const readForm = (): GenreFormData => ({
    ...form,
    id: idRef.current?.value ?? form.id,
    name: nameRef.current?.value ?? form.name,
    chapterTypes: chapterTypesRef.current?.value ?? form.chapterTypes,
    fatigueWords: fatigueWordsRef.current?.value ?? form.fatigueWords,
    pacingRule: pacingRuleRef.current?.value ?? form.pacingRule,
    body: bodyRef.current?.value ?? form.body,
  });

  return (
    <div className="min-w-0 space-y-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <label className="text-xs text-muted-foreground uppercase tracking-wide">ID</label>
          <input
            ref={idRef}
            type="text"
            defaultValue={form.id}
            {...textHandlers("id")}
            disabled={isEdit}
            className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm disabled:opacity-50"
          />
        </div>
        <div>
          <label className="text-xs text-muted-foreground uppercase tracking-wide">{t("genre.name")}</label>
          <input
            ref={nameRef}
            type="text"
            defaultValue={form.name}
            {...textHandlers("name")}
            className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
          />
        </div>
      </div>

      <div>
        <label className="text-xs text-muted-foreground uppercase tracking-wide">{t("create.language")}</label>
        <StudioSelect
          value={form.language}
          onValueChange={(value) => set("language", value)}
          options={[
            { value: "zh", label: "zh" },
            { value: "en", label: "en" },
          ]}
          triggerClassName="mt-1"
        />
      </div>

      <div>
        <label className="text-xs text-muted-foreground uppercase tracking-wide">
          {t("genre.chapterTypes")} ({t("genre.commaSeparated")})
        </label>
        <input
          ref={chapterTypesRef}
          type="text"
          defaultValue={form.chapterTypes}
          {...textHandlers("chapterTypes")}
          className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
        />
      </div>

      <div>
        <label className="text-xs text-muted-foreground uppercase tracking-wide">
          {t("genre.fatigueWords")} ({t("genre.commaSeparated")})
        </label>
        <input
          ref={fatigueWordsRef}
          type="text"
          defaultValue={form.fatigueWords}
          {...textHandlers("fatigueWords")}
          className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
        />
      </div>

      <div className="flex flex-wrap gap-3 sm:gap-6">
        <label className="flex min-h-10 items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={form.numericalSystem}
            onChange={(e) => set("numericalSystem", e.target.checked)}
          />
          {t("genre.numericalSystem")}
        </label>
        <label className="flex min-h-10 items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={form.powerScaling}
            onChange={(e) => set("powerScaling", e.target.checked)}
          />
          {t("genre.powerScaling")}
        </label>
        <label className="flex min-h-10 items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={form.eraResearch}
            onChange={(e) => set("eraResearch", e.target.checked)}
          />
          {t("genre.eraResearch")}
        </label>
      </div>

      <div>
        <label className="text-xs text-muted-foreground uppercase tracking-wide">{t("genre.pacingRule")}</label>
        <input
          ref={pacingRuleRef}
          type="text"
          defaultValue={form.pacingRule}
          {...textHandlers("pacingRule")}
          className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
        />
      </div>

      <div>
        <label className="text-xs text-muted-foreground uppercase tracking-wide">{t("genre.rulesMd")}</label>
        <textarea
          ref={bodyRef}
          defaultValue={form.body}
          {...textHandlers("body")}
          rows={6}
          className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm font-mono"
        />
      </div>

      <div className="flex flex-wrap gap-2">
        <button onClick={() => onSubmit(readForm())} className={`min-h-10 rounded-md px-4 py-2 text-sm ${c.btnPrimary}`}>
          {isEdit ? t("genre.saveChanges") : t("genre.createNew")}
        </button>
        <button onClick={onCancel} className={`min-h-10 rounded-md px-4 py-2 text-sm ${c.btnSecondary}`}>
          {t("genre.cancel")}
        </button>
      </div>
    </div>
  );
}

interface Nav {
  toDashboard: () => void;
}

export function GenreManager({ nav, theme, t }: { nav: Nav; theme: Theme; t: TFunction }) {
  const c = useColors(theme);
  const { lang } = useI18n();
  const { data, refetch } = useApi<{ genres: ReadonlyArray<GenreInfo> }>("/genres");
  const [selected, setSelected] = useState<string | null>(null);
  const [formMode, setFormMode] = useState<"hidden" | "create" | "edit">("hidden");
  const [form, setForm] = useState<GenreFormData>(EMPTY_FORM);
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);

  // Keep the built-in list visible on mobile even if a runtime config uses a
  // different language code or the language switch has not finished syncing.
  const allGenres = data?.genres ?? [];
  const languageGenres = allGenres.filter((g) => g.language === lang || g.source === "project");
  const filteredGenres = languageGenres.length > 0 ? languageGenres : allGenres;
  const validSelected = selected && filteredGenres.some((g) => g.id === selected) ? selected : null;
  const selectedGenre = filteredGenres.find((g) => g.id === validSelected) ?? null;

  const { data: detail } = useApi<GenreDetail>(validSelected ? `/genres/${validSelected}` : "");

  const handleCopy = async (id: string) => {
    await postApi(`/genres/${id}/copy`);
    await appAlert({ title: "已复制", message: `Copied ${id} to project genres/`, tone: "success" });
    refetch();
  };

  const openCreateForm = () => {
    setForm(EMPTY_FORM);
    setFormMode("create");
  };

  const openEditForm = () => {
    if (!detail) return;
    setForm({
      id: detail.profile.id,
      name: detail.profile.name,
      language: detail.profile.language as "zh" | "en",
      chapterTypes: detail.profile.chapterTypes.join(", "),
      fatigueWords: detail.profile.fatigueWords.join(", "),
      numericalSystem: detail.profile.numericalSystem,
      powerScaling: detail.profile.powerScaling,
      eraResearch: detail.profile.eraResearch ?? false,
      pacingRule: detail.profile.pacingRule,
      body: detail.body,
    });
    setFormMode("edit");
  };

  const closeForm = () => {
    setFormMode("hidden");
  };

  const handleCreate = async (nextForm = form) => {
    setForm(nextForm);
    try {
      await postApi("/genres/create", {
        id: nextForm.id,
        name: nextForm.name,
        language: nextForm.language,
        chapterTypes: parseCommaSeparated(nextForm.chapterTypes),
        fatigueWords: parseCommaSeparated(nextForm.fatigueWords),
        numericalSystem: nextForm.numericalSystem,
        powerScaling: nextForm.powerScaling,
        eraResearch: nextForm.eraResearch,
        pacingRule: nextForm.pacingRule,
        body: nextForm.body,
      });
      setFormMode("hidden");
      setSelected(nextForm.id);
      await refetch();
    } catch (e) {
      await appAlert({ title: "创建失败", message: e instanceof Error ? e.message : "Failed to create genre", tone: "danger" });
    }
  };

  const handleEdit = async (nextForm = form) => {
    if (!validSelected) return;
    setForm(nextForm);
    try {
      await fetchJson(`/genres/${validSelected}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          profile: {
            id: nextForm.id,
            name: nextForm.name,
            language: nextForm.language,
            chapterTypes: parseCommaSeparated(nextForm.chapterTypes),
            fatigueWords: parseCommaSeparated(nextForm.fatigueWords),
            numericalSystem: nextForm.numericalSystem,
            powerScaling: nextForm.powerScaling,
            eraResearch: nextForm.eraResearch,
            pacingRule: nextForm.pacingRule,
          },
          body: nextForm.body,
        }),
      });
      setFormMode("hidden");
      await refetch();
    } catch (e) {
      await appAlert({ title: "更新失败", message: e instanceof Error ? e.message : "Failed to update genre", tone: "danger" });
    }
  };

  const handleDelete = async () => {
    if (!validSelected) return;
    setConfirmDeleteOpen(false);
    try {
      await fetchJson(`/genres/${validSelected}`, { method: "DELETE" });
      setSelected(null);
      await refetch();
    } catch (e) {
      await appAlert({ title: "删除失败", message: e instanceof Error ? e.message : "Failed to delete genre", tone: "danger" });
    }
  };

  return (
    <div className="min-w-0 space-y-6 sm:space-y-8">
      <div className="flex min-w-0 items-center gap-2 text-sm text-muted-foreground">
        <button onClick={nav.toDashboard} className={c.link}>{t("bread.home")}</button>
        <span className="text-border">/</span>
        <span className="truncate">{t("create.genre")}</span>
      </div>

      <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
        <h1 className="font-serif text-3xl">{t("create.genre")}</h1>
        <button
          onClick={openCreateForm}
          className={`inline-flex min-h-11 shrink-0 touch-manipulation items-center gap-1.5 rounded-full px-4 py-2 text-sm ${c.btnPrimary}`}
        >
          <Plus size={16} />
          {t("genre.createNew")}
        </button>
      </div>

      {formMode !== "hidden" && (
        <div className={`min-w-0 rounded-lg border p-4 sm:p-6 ${c.cardStatic}`}>
          <h2 className="text-lg font-medium mb-4">
            {formMode === "create" ? t("genre.createNew") : `${t("common.edit")}: ${form.id}`}
          </h2>
          <GenreForm
            form={form}
            onChange={setForm}
            onSubmit={formMode === "create" ? handleCreate : handleEdit}
            onCancel={closeForm}
            isEdit={formMode === "edit"}
            c={c}
            t={t}
          />
        </div>
      )}

      <div className="grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-[250px_minmax(0,1fr)] lg:gap-6">
        {/* Genre list */}
        <div className={`min-w-0 overflow-hidden rounded-lg border ${c.cardStatic}`}>
          {filteredGenres.map((g) => (
            <button
              key={g.id}
              onClick={() => setSelected(g.id)}
              className={`w-full text-left px-4 py-3 border-b border-border/40 transition-colors ${
                validSelected === g.id ? "bg-primary/10 text-primary" : "hover:bg-muted/30"
              }`}
            >
              <div className="text-sm font-medium">{g.name}</div>
              <div className="mt-0.5 break-words text-xs text-muted-foreground">
                {g.id} · {g.language} · {g.source}
              </div>
            </button>
          ))}
        </div>

        {/* Detail panel */}
        <div className={`min-w-0 rounded-lg border p-4 sm:p-6 ${c.cardStatic}`}>
          {validSelected && detail ? (
            <div className="min-w-0 space-y-6">
              <div className="flex min-w-0 flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <h2 className="break-words text-xl font-medium">{detail.profile.name}</h2>
                  <div className="mt-1 break-words text-sm text-muted-foreground">
                    {detail.profile.id} · {detail.profile.language} ·
                    {detail.profile.numericalSystem ? " Numerical" : ""}
                    {detail.profile.powerScaling ? " Power" : ""}
                    {detail.profile.eraResearch ? " Era" : ""}
                  </div>
                </div>
                <div className="flex min-w-0 flex-wrap gap-2">
                  <button
                    onClick={openEditForm}
                    className={`inline-flex min-h-10 touch-manipulation items-center gap-1.5 rounded-md px-3 py-2 text-sm ${c.btnSecondary}`}
                  >
                    <Pencil size={14} />
                    {t("common.edit")}
                  </button>
                  {selectedGenre?.source === "project" && (
                    <button
                      onClick={() => setConfirmDeleteOpen(true)}
                      className={`inline-flex min-h-10 touch-manipulation items-center gap-1.5 rounded-md px-3 py-2 text-sm ${c.btnDanger}`}
                    >
                      <Trash2 size={14} />
                      {t("common.delete")}
                    </button>
                  )}
                  <button
                    onClick={() => validSelected && handleCopy(validSelected)}
                    className={`min-h-10 touch-manipulation rounded-md px-3 py-2 text-sm ${c.btnSecondary}`}
                  >
                    {t("genre.copyToProject")}
                  </button>
                </div>
              </div>

              <div>
                <div className="text-xs text-muted-foreground uppercase tracking-wide mb-2">{t("genre.chapterTypes")}</div>
                <div className="flex gap-2 flex-wrap">
                  {detail.profile.chapterTypes.map((ct) => (
                    <span key={ct} className="max-w-full break-words rounded bg-secondary px-2 py-1 text-xs">{ct}</span>
                  ))}
                </div>
              </div>

              <div>
                <div className="text-xs text-muted-foreground uppercase tracking-wide mb-2">{t("genre.fatigueWords")}</div>
                <div className="flex gap-2 flex-wrap">
                  {detail.profile.fatigueWords.slice(0, 15).map((w) => (
                    <span key={w} className="max-w-full break-words rounded bg-secondary px-2 py-1 text-xs">{w}</span>
                  ))}
                  {detail.profile.fatigueWords.length > 15 && (
                    <span className="text-xs text-muted-foreground">+{detail.profile.fatigueWords.length - 15}</span>
                  )}
                </div>
              </div>

              <div>
                <div className="text-xs text-muted-foreground uppercase tracking-wide mb-2">{t("genre.pacingRule")}</div>
                <div className="break-words text-sm">{detail.profile.pacingRule || "—"}</div>
              </div>

              <div>
                <div className="text-xs text-muted-foreground uppercase tracking-wide mb-2">{t("genre.rules")}</div>
                <pre className="max-h-[300px] max-w-full overflow-y-auto whitespace-pre-wrap break-words rounded-md bg-muted/30 p-4 font-mono text-sm leading-relaxed text-foreground/80">
                  {detail.body || "—"}
                </pre>
              </div>
            </div>
          ) : (
            <div className="text-muted-foreground text-sm italic flex items-center justify-center h-full">
              {t("genre.selectHint")}
            </div>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={confirmDeleteOpen}
        title={t("genre.deleteGenre")}
        message={`${t("genre.confirmDelete")} "${validSelected}"`}
        confirmLabel={t("common.delete") ?? "Delete"}
        cancelLabel={t("genre.cancel") ?? "Cancel"}
        variant="danger"
        onConfirm={() => void handleDelete()}
        onCancel={() => setConfirmDeleteOpen(false)}
      />
    </div>
  );
}
