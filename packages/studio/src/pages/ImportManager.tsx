import { useRef, useState } from "react";
import { fetchJson, useApi, postApi } from "../hooks/use-api";
import type { Theme } from "../hooks/use-theme";
import type { TFunction } from "../hooks/use-i18n";
import { useI18n } from "../hooks/use-i18n";
import { useColors } from "../hooks/use-colors";
import { StudioSelect } from "../components/StudioSelect";
import { mobileTextInputHandlers } from "../lib/mobile-input";
import { FileInput, BookCopy, Feather } from "lucide-react";

interface BookSummary {
  readonly id: string;
  readonly title: string;
}

interface Nav { toDashboard: () => void }

type Tab = "chapters" | "canon" | "fanfic";

export function ImportManager({ nav, theme, t }: { nav: Nav; theme: Theme; t: TFunction }) {
  const c = useColors(theme);
  const { lang } = useI18n();
  const { data: booksData } = useApi<{ books: ReadonlyArray<BookSummary> }>("/books");
  const [tab, setTab] = useState<Tab>("chapters");
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(false);

  // Chapters state
  const [chText, setChText] = useState("");
  const [chBookId, setChBookId] = useState("");
  const [chSplitRegex, setChSplitRegex] = useState("");

  // Canon state
  const [canonTarget, setCanonTarget] = useState("");
  const [canonFrom, setCanonFrom] = useState("");

  // Fanfic state
  const [ffTitle, setFfTitle] = useState("");
  const [ffText, setFfText] = useState("");
  const [ffMode, setFfMode] = useState("canon");
  const [ffGenre, setFfGenre] = useState("other");
  const [ffLang, setFfLang] = useState(lang);
  const chTextRef = useRef<HTMLTextAreaElement>(null);
  const chSplitRegexRef = useRef<HTMLInputElement>(null);
  const ffTitleRef = useRef<HTMLInputElement>(null);
  const ffTextRef = useRef<HTMLTextAreaElement>(null);

  const readChapterImportInput = () => {
    const nextText = chTextRef.current?.value ?? chText;
    const nextSplitRegex = chSplitRegexRef.current?.value ?? chSplitRegex;
    setChText(nextText);
    setChSplitRegex(nextSplitRegex);
    return {
      text: nextText,
      splitRegex: nextSplitRegex,
    };
  };

  const readFanficInput = () => {
    const nextTitle = ffTitleRef.current?.value ?? ffTitle;
    const nextText = ffTextRef.current?.value ?? ffText;
    setFfTitle(nextTitle);
    setFfText(nextText);
    return {
      title: nextTitle,
      text: nextText,
    };
  };

  const handleImportChapters = async () => {
    const input = readChapterImportInput();
    if (!input.text.trim() || !chBookId) return;
    setLoading(true);
    setStatus("");
    try {
      const data = await fetchJson<{ importedCount?: number }>(`/books/${chBookId}/import/chapters`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: input.text, splitRegex: input.splitRegex || undefined }),
      });
      setStatus(`Imported ${data.importedCount} chapters`);
    } catch (e) {
      setStatus(`Error: ${e instanceof Error ? e.message : String(e)}`);
    }
    setLoading(false);
  };

  const handleImportCanon = async () => {
    if (!canonTarget || !canonFrom) return;
    setLoading(true);
    setStatus("");
    try {
      await postApi(`/books/${canonTarget}/import/canon`, { fromBookId: canonFrom });
      setStatus("Canon imported successfully!");
    } catch (e) {
      setStatus(`Error: ${e instanceof Error ? e.message : String(e)}`);
    }
    setLoading(false);
  };

  const handleFanficInit = async () => {
    const input = readFanficInput();
    if (!input.title.trim() || !input.text.trim()) return;
    setLoading(true);
    setStatus("");
    try {
      const data = await fetchJson<{ bookId?: string }>("/fanfic/init", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: input.title, sourceText: input.text, mode: ffMode,
          genre: ffGenre, language: ffLang,
        }),
      });
      setStatus(`Fanfic created: ${data.bookId}`);
    } catch (e) {
      setStatus(`Error: ${e instanceof Error ? e.message : String(e)}`);
    }
    setLoading(false);
  };

  const tabs: { id: Tab; label: string; icon: React.ReactNode }[] = [
    { id: "chapters", label: t("import.chapters"), icon: <FileInput size={14} /> },
    { id: "canon", label: t("import.canon"), icon: <BookCopy size={14} /> },
    { id: "fanfic", label: t("import.fanfic"), icon: <Feather size={14} /> },
  ];
  const bookOptions = booksData?.books.map((b) => ({ value: b.id, label: b.title })) ?? [];
  const chSplitRegexHandlers = mobileTextInputHandlers(setChSplitRegex);
  const chTextHandlers = mobileTextInputHandlers(setChText);
  const ffTitleHandlers = mobileTextInputHandlers(setFfTitle);
  const ffTextHandlers = mobileTextInputHandlers(setFfText);

  return (
    <div className="space-y-8">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <button onClick={nav.toDashboard} className={c.link}>{t("bread.home")}</button>
        <span className="text-border">/</span>
        <span>{t("nav.import")}</span>
      </div>

      <h1 className="font-serif text-3xl flex items-center gap-3">
        <FileInput size={28} className="text-primary" />
        {t("import.title")}
      </h1>

      {/* Tabs */}
      <div className="flex gap-1 bg-secondary/30 rounded-lg p-1 w-fit">
        {tabs.map((tb) => (
          <button
            key={tb.id}
            onClick={() => { setTab(tb.id); setStatus(""); }}
            className={`px-4 py-2 rounded-md text-sm font-medium flex items-center gap-2 transition-all ${
              tab === tb.id ? "bg-card shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {tb.icon} {tb.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className={`border ${c.cardStatic} rounded-lg p-6 space-y-4`}>
        {tab === "chapters" && (
          <>
            <StudioSelect
              value={chBookId}
              onValueChange={setChBookId}
              options={bookOptions}
              placeholder={t("import.selectTarget")}
              triggerClassName="bg-secondary/30 shadow-none"
            />
            <input
              ref={chSplitRegexRef}
              type="text" defaultValue={chSplitRegex} {...chSplitRegexHandlers}
              placeholder={t("import.splitRegex")}
              className="w-full px-3 py-2 rounded-lg bg-secondary/30 border border-border text-sm font-mono"
            />
            <textarea ref={chTextRef} defaultValue={chText} {...chTextHandlers} rows={10}
              placeholder={t("import.pasteChapters")}
              className="w-full px-3 py-2 rounded-lg bg-secondary/30 border border-border text-sm resize-none font-mono"
            />
            <button onClick={handleImportChapters} disabled={loading || !chBookId}
              className={`px-4 py-2 text-sm rounded-lg ${c.btnPrimary} disabled:opacity-30`}>
              {loading ? t("import.importing") : t("import.chapters")}
            </button>
          </>
        )}

        {tab === "canon" && (
          <>
            <StudioSelect
              value={canonFrom}
              onValueChange={setCanonFrom}
              options={bookOptions}
              placeholder={t("import.selectSource")}
              triggerClassName="bg-secondary/30 shadow-none"
            />
            <StudioSelect
              value={canonTarget}
              onValueChange={setCanonTarget}
              options={bookOptions}
              placeholder={t("import.selectDerivative")}
              triggerClassName="bg-secondary/30 shadow-none"
            />
            <button onClick={handleImportCanon} disabled={loading || !canonTarget || !canonFrom}
              className={`px-4 py-2 text-sm rounded-lg ${c.btnPrimary} disabled:opacity-30`}>
              {loading ? t("import.importing") : t("import.canon")}
            </button>
          </>
        )}

        {tab === "fanfic" && (
          <>
            <input ref={ffTitleRef} type="text" defaultValue={ffTitle} {...ffTitleHandlers}
              placeholder={t("import.fanficTitle")}
              className="w-full px-3 py-2 rounded-lg bg-secondary/30 border border-border text-sm"
            />
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <StudioSelect
                value={ffMode}
                onValueChange={setFfMode}
                options={[
                  { value: "canon", label: "Canon" },
                  { value: "au", label: "AU" },
                  { value: "ooc", label: "OOC" },
                  { value: "cp", label: "CP" },
                ]}
                triggerClassName="bg-secondary/30 shadow-none"
              />
              <StudioSelect
                value={ffGenre}
                onValueChange={setFfGenre}
                options={[
                  { value: "other", label: "Other" },
                  { value: "xuanhuan", label: "玄幻" },
                  { value: "urban", label: "都市" },
                  { value: "xianxia", label: "仙侠" },
                ]}
                triggerClassName="bg-secondary/30 shadow-none"
              />
              <StudioSelect
                value={ffLang}
                onValueChange={(value) => setFfLang(value)}
                options={[
                  { value: "zh", label: "中文" },
                  { value: "en", label: "English" },
                ]}
                triggerClassName="bg-secondary/30 shadow-none"
              />
            </div>
            <textarea ref={ffTextRef} defaultValue={ffText} {...ffTextHandlers} rows={10}
              placeholder={t("import.pasteMaterial")}
              className="w-full px-3 py-2 rounded-lg bg-secondary/30 border border-border text-sm resize-none font-mono"
            />
            <button onClick={handleFanficInit} disabled={loading}
              className={`px-4 py-2 text-sm rounded-lg ${c.btnPrimary} disabled:opacity-30`}>
              {loading ? t("import.creating") : t("import.fanfic")}
            </button>
          </>
        )}

        {status && (
          <div className={`text-sm px-3 py-2 rounded-lg ${status.startsWith("Error") ? "bg-destructive/10 text-destructive" : "bg-emerald-500/10 text-emerald-600"}`}>
            {status}
          </div>
        )}
      </div>
    </div>
  );
}
