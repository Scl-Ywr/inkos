import { useEffect, useMemo, useState } from "react";
import { fetchJson, useApi } from "../hooks/use-api";
import type { Theme } from "../hooks/use-theme";
import type { TFunction } from "../hooks/use-i18n";
import { appAlert } from "../lib/app-dialog";
import {
  ArrowLeft,
  BookOpen,
  Database,
  FileText,
  RefreshCw,
  Search,
  Sparkles,
  Trash2,
  Upload,
} from "lucide-react";

interface KnowledgeSource {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly charCount: number;
  readonly chunkCount: number;
  readonly summary: string;
  readonly styleProfile: string;
  readonly keywords: readonly string[];
}

interface KnowledgeLibrary {
  readonly sources: readonly KnowledgeSource[];
  readonly stats: {
    readonly sourceCount: number;
    readonly chunkCount: number;
    readonly charCount: number;
    readonly updatedAt: string | null;
  };
}

interface KnowledgeUploadResponse extends KnowledgeLibrary {
  readonly extraction?: {
    readonly ok?: boolean;
    readonly method?: string;
    readonly warnings?: readonly string[];
  };
}

interface KnowledgeSearchResult {
  readonly chunks: ReadonlyArray<{
    readonly id: string;
    readonly sourceName: string;
    readonly index: number;
    readonly text: string;
    readonly score: number;
  }>;
  readonly context: string;
}

interface Nav {
  toBookSettings: (bookId: string) => void;
}

export function KnowledgePage({ bookId, nav, theme: _theme, t: _t }: {
  readonly bookId: string;
  readonly nav: Nav;
  readonly theme: Theme;
  readonly t: TFunction;
}) {
  const { data, loading, error, refetch, mutate } = useApi<KnowledgeLibrary>(`/books/${bookId}/knowledge`);
  const [uploading, setUploading] = useState(false);
  const [pastedName, setPastedName] = useState("资料片段.md");
  const [pastedText, setPastedText] = useState("");
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchResult, setSearchResult] = useState<KnowledgeSearchResult | null>(null);
  const [pythonStatus, setPythonStatus] = useState<string>("检测中");

  const canPaste = pastedName.trim().length > 0 && pastedText.trim().length > 0;
  const topKeywords = useMemo(() => {
    const counts = new Map<string, number>();
    for (const source of data?.sources ?? []) {
      for (const keyword of source.keywords.slice(0, 12)) {
        counts.set(keyword, (counts.get(keyword) ?? 0) + 1);
      }
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 18).map(([keyword]) => keyword);
  }, [data?.sources]);

  useEffect(() => {
    void fetchJson<{ python?: { available?: boolean; version?: string | null; lastError?: string | null } }>("/runtime/python")
      .then((payload) => {
        setPythonStatus(payload.python?.available ? `Python 可用：${payload.python.version ?? "已连接"}` : "Python 不可用，使用 JS fallback");
      })
      .catch((error) => {
        setPythonStatus(`Python 不可用：${error instanceof Error ? error.message : "未检测到"}`);
      });
  }, []);

  const uploadSource = async (name: string, content: string, fileBase64?: string) => {
    setUploading(true);
    try {
      const next = await fetchJson<KnowledgeUploadResponse>(`/books/${bookId}/knowledge/sources`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, content, ...(fileBase64 ? { fileBase64 } : {}) }),
      });
      mutate(next);
      setPastedText("");
      const method = next.extraction?.method ? `\n解析方式：${next.extraction.method}` : "";
      const warnings = next.extraction?.warnings?.length ? `\n提示：${next.extraction.warnings.join("；")}` : "";
      await appAlert({ title: "知识库已更新", message: `已导入《${name}》。${method}${warnings}`, tone: "success" });
    } catch (e) {
      await appAlert({ title: "导入失败", message: e instanceof Error ? e.message : "Upload failed", tone: "danger" });
    } finally {
      setUploading(false);
    }
  };

  const handleFiles = async (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    const [base64, text] = await Promise.all([
      readFileAsBase64(file),
      file.text().catch(() => ""),
    ]);
    await uploadSource(file.name, text, base64);
  };

  const handleDelete = async (source: KnowledgeSource) => {
    const next = await fetchJson<KnowledgeLibrary>(
      `/books/${bookId}/knowledge/sources/${encodeURIComponent(source.id)}`,
      { method: "DELETE" },
    );
    mutate(next);
  };

  const handleRebuild = async () => {
    const next = await fetchJson<KnowledgeLibrary>(`/books/${bookId}/knowledge/rebuild`, { method: "POST" });
    mutate(next);
    await appAlert({ title: "索引已重建", message: "知识库分块和摘要已经刷新。", tone: "success" });
  };

  const handleSearch = async () => {
    setSearching(true);
    try {
      setSearchResult(await fetchJson<KnowledgeSearchResult>(`/books/${bookId}/knowledge/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, limit: 5 }),
      }));
    } finally {
      setSearching(false);
    }
  };

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center py-32 space-y-4">
        <div className="w-8 h-8 border-2 border-primary/20 border-t-primary rounded-full animate-spin" />
        <span className="text-sm text-muted-foreground">正在读取知识库</span>
      </div>
    );
  }
  if (error) return <div className="rounded-2xl border border-destructive/20 bg-destructive/5 p-6 text-destructive">Error: {error}</div>;

  return (
    <div className="space-y-7 fade-in">
      <nav className="flex items-center gap-2 text-[13px] font-medium text-muted-foreground">
        <button onClick={() => nav.toBookSettings(bookId)} className="flex items-center gap-1 transition-colors hover:text-primary">
          <ArrowLeft size={14} />
          书籍设置
        </button>
        <span className="text-border">/</span>
        <span className="text-foreground">知识库</span>
      </nav>

      <section className="rounded-3xl border border-border/45 bg-card/75 p-5 shadow-xl shadow-primary/5 sm:p-7">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <div className="flex items-center gap-2 text-sm font-bold text-primary">
              <Database size={16} />
              书籍知识库
            </div>
            <h1 className="mt-3 text-3xl font-serif font-semibold text-foreground sm:text-4xl">资料分析与仿写参考</h1>
            <p className="mt-3 max-w-2xl text-sm leading-7 text-muted-foreground">
              上传资料后，系统会自动分块、提取摘要和文风特征。写下一章、草稿写作和开放互动会检索相关片段作为参考，但不会直接照抄原文。
            </p>
          </div>
          <div className="grid grid-cols-3 gap-2 rounded-2xl border border-border/45 bg-background/45 p-2 text-center">
            <Stat label="资料" value={data?.stats.sourceCount ?? 0} />
            <Stat label="分块" value={data?.stats.chunkCount ?? 0} />
            <Stat label="字符" value={(data?.stats.charCount ?? 0).toLocaleString()} />
          </div>
        </div>
      </section>

      <section className="grid gap-4 lg:grid-cols-[0.95fr_1.05fr]">
        <div className="rounded-3xl border border-border/45 bg-card/70 p-5">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 font-bold text-foreground">
              <Upload size={16} className="text-primary" />
              导入资料
            </div>
            <button
              onClick={handleRebuild}
              className="inline-flex min-h-10 items-center gap-2 rounded-xl border border-border/50 bg-secondary/60 px-3 text-xs font-bold text-muted-foreground transition-colors hover:text-foreground"
            >
              <RefreshCw size={14} />
              重建索引
            </button>
          </div>
          <label className="mt-4 flex min-h-28 cursor-pointer flex-col items-center justify-center rounded-2xl border border-dashed border-primary/35 bg-primary/[0.04] px-4 text-center transition-colors hover:bg-primary/[0.08]">
            <Upload size={22} className="text-primary" />
            <span className="mt-2 text-sm font-bold text-foreground">{uploading ? "正在导入..." : "选择 TXT / Markdown 文件"}</span>
            <span className="mt-1 text-xs text-muted-foreground">{pythonStatus}</span>
            <input
              type="file"
              accept=".txt,.md,.markdown,.json,.csv,.html,.htm,.docx,.pdf,text/plain,text/markdown,application/json,text/csv,text/html,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/pdf"
              className="hidden"
              disabled={uploading}
              onChange={(event) => void handleFiles(event.currentTarget.files)}
            />
          </label>

          <div className="mt-5 space-y-3">
            <input
              value={pastedName}
              onChange={(event) => setPastedName(event.target.value)}
              className="h-11 w-full rounded-xl border border-border/50 bg-background/60 px-3 text-sm outline-none focus:border-primary/50"
              placeholder="资料名称"
            />
            <textarea
              value={pastedText}
              onChange={(event) => setPastedText(event.target.value)}
              className="min-h-36 w-full resize-y rounded-xl border border-border/50 bg-background/60 p-3 text-sm leading-6 outline-none focus:border-primary/50"
              placeholder="也可以直接粘贴参考资料、设定、样章或风格片段..."
            />
            <button
              disabled={!canPaste || uploading}
              onClick={() => void uploadSource(pastedName, pastedText)}
              className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 text-sm font-bold text-primary-foreground transition-all hover:scale-[1.01] active:scale-95 disabled:opacity-50"
            >
              <Sparkles size={16} />
              保存到知识库
            </button>
          </div>
        </div>

        <div className="rounded-3xl border border-border/45 bg-card/70 p-5">
          <div className="flex items-center gap-2 font-bold text-foreground">
            <Search size={16} className="text-primary" />
            检索预览
          </div>
          <div className="mt-4 flex gap-2">
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              className="h-11 min-w-0 flex-1 rounded-xl border border-border/50 bg-background/60 px-3 text-sm outline-none focus:border-primary/50"
              placeholder="输入下一章目标、角色、地点或主题"
            />
            <button
              onClick={handleSearch}
              disabled={searching}
              className="inline-flex min-h-11 shrink-0 items-center gap-2 rounded-xl border border-primary/30 bg-primary/10 px-4 text-sm font-bold text-primary"
            >
              <Search size={15} />
              检索
            </button>
          </div>
          {topKeywords.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-2">
              {topKeywords.map((keyword) => (
                <button
                  key={keyword}
                  onClick={() => setQuery(keyword)}
                  className="rounded-full border border-border/45 bg-background/45 px-2.5 py-1 text-xs text-muted-foreground"
                >
                  {keyword}
                </button>
              ))}
            </div>
          )}
          <div className="mt-4 space-y-3">
            {searchResult?.chunks.map((chunk) => (
              <div key={chunk.id} className="rounded-2xl border border-border/45 bg-background/45 p-4">
                <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
                  <span className="font-bold text-primary">《{chunk.sourceName}》#{chunk.index}</span>
                  <span>score {chunk.score}</span>
                </div>
                <p className="mt-2 line-clamp-5 text-sm leading-6 text-foreground/80">{chunk.text}</p>
              </div>
            ))}
            {searchResult && searchResult.chunks.length === 0 && (
              <div className="rounded-2xl border border-border/45 bg-background/35 p-5 text-sm text-muted-foreground">
                暂无命中。可以换一个角色名、地点或主题词。
              </div>
            )}
          </div>
        </div>
      </section>

      <section className="space-y-3">
        {(data?.sources ?? []).map((source) => (
          <article key={source.id} className="rounded-3xl border border-border/45 bg-card/70 p-5">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <FileText size={16} className="shrink-0 text-primary" />
                  <h2 className="truncate text-xl font-bold text-foreground">{source.name}</h2>
                </div>
                <p className="mt-3 text-sm leading-7 text-muted-foreground">{source.summary}</p>
                <p className="mt-2 text-sm leading-7 text-foreground/75">
                  <span className="font-bold text-primary">文风：</span>{source.styleProfile}
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {source.keywords.slice(0, 12).map((keyword) => (
                    <span key={keyword} className="rounded-full bg-secondary/60 px-2.5 py-1 text-xs text-muted-foreground">
                      {keyword}
                    </span>
                  ))}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <div className="rounded-2xl border border-border/45 bg-background/45 px-3 py-2 text-right text-xs text-muted-foreground">
                  <div>{source.charCount.toLocaleString()} 字符</div>
                  <div>{source.chunkCount} 分块</div>
                </div>
                <button
                  onClick={() => void handleDelete(source)}
                  className="flex h-10 w-10 items-center justify-center rounded-xl border border-destructive/20 bg-destructive/5 text-destructive"
                  aria-label={`删除 ${source.name}`}
                >
                  <Trash2 size={15} />
                </button>
              </div>
            </div>
          </article>
        ))}
        {(data?.sources.length ?? 0) === 0 && (
          <div className="rounded-3xl border border-border/45 bg-card/55 p-10 text-center">
            <BookOpen size={28} className="mx-auto text-primary" />
            <div className="mt-3 text-lg font-bold text-foreground">还没有资料</div>
            <p className="mt-2 text-sm text-muted-foreground">上传样章、设定集、人物资料或参考文本后，写作时会自动检索。</p>
          </div>
        )}
      </section>
    </div>
  );
}

function Stat({ label, value }: { readonly label: string; readonly value: string | number }) {
  return (
    <div className="min-w-20 rounded-xl px-3 py-2">
      <div className="text-lg font-bold text-foreground">{value}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  );
}

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read file."));
    reader.onload = () => {
      const value = String(reader.result ?? "");
      resolve(value.includes(",") ? value.split(",").pop() ?? "" : value);
    };
    reader.readAsDataURL(file);
  });
}
