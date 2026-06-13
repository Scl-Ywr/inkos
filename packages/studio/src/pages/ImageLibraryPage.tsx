import { useMemo, useState } from "react";
import { AlertTriangle, FolderOpen, Gamepad2, ImageOff, Images, RefreshCw, Trash2 } from "lucide-react";
import { fetchJson, useApi } from "../hooks/use-api";
import { buildApiUrl } from "../lib/api-url";
import { appAlert, appConfirm } from "../lib/app-dialog";

type ImageKind = "all" | "cover" | "scene" | "actor" | "item" | "short" | "other";
type ImageSource = "all" | "play" | "project";

interface GeneratedImageItem {
  readonly id: string;
  readonly source: "play" | "project";
  readonly kind: "scene" | "actor" | "item" | "cover" | "short" | "other";
  readonly status: "ready" | "failed";
  readonly title: string;
  readonly subtitle?: string;
  readonly url?: string;
  readonly error?: string;
  readonly updatedAt?: string;
  readonly path?: string;
}

interface ImageLibraryResponse {
  readonly items: ReadonlyArray<GeneratedImageItem>;
}

const KIND_LABELS: Record<ImageKind, string> = {
  all: "全部",
  cover: "封面",
  scene: "场景",
  actor: "角色",
  item: "物品",
  short: "短篇",
  other: "其他",
};

const SOURCE_LABELS: Record<ImageSource, string> = {
  all: "全部来源",
  play: "开放世界",
  project: "封面/短篇",
};

function imageUrl(url?: string): string | undefined {
  return url ? buildApiUrl(url) ?? url : undefined;
}

function formatDate(value?: string): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function ImageLibraryPage() {
  const { data, loading, error, refetch, mutate } = useApi<ImageLibraryResponse>("/images/library");
  const [kind, setKind] = useState<ImageKind>("all");
  const [source, setSource] = useState<ImageSource>("all");
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [preview, setPreview] = useState<GeneratedImageItem | null>(null);
  const items = data?.items ?? [];

  const filtered = useMemo(() => items.filter((item) => {
    if (kind !== "all" && item.kind !== kind) return false;
    if (source !== "all" && item.source !== source) return false;
    return true;
  }), [items, kind, source]);

  const counts = useMemo(() => {
    const byKind = new Map<ImageKind, number>();
    const bySource = new Map<ImageSource, number>();
    byKind.set("all", items.length);
    bySource.set("all", items.length);
    for (const item of items) {
      byKind.set(item.kind, (byKind.get(item.kind) ?? 0) + 1);
      bySource.set(item.source, (bySource.get(item.source) ?? 0) + 1);
    }
    return { byKind, bySource };
  }, [items]);

  const deleteItem = async (item: GeneratedImageItem) => {
    const confirmed = await appConfirm({
      title: "删除图片",
      message: `确认删除“${item.title}”？\n\n图片文件会被移除，开放世界图片也会从生成清单里清理。`,
      tone: "danger",
      confirmLabel: "删除",
      cancelLabel: "取消",
    });
    if (!confirmed) return;

    setDeletingId(item.id);
    try {
      mutate((current) => current ? { items: current.items.filter((candidate) => candidate.id !== item.id) } : current);
      await fetchJson(`/images/library?id=${encodeURIComponent(item.id)}`, { method: "DELETE" });
      if (preview?.id === item.id) setPreview(null);
      await refetch();
    } catch (e) {
      await appAlert({ title: "删除失败", message: e instanceof Error ? e.message : String(e), tone: "danger" });
      await refetch();
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className="space-y-5">
      <header className="flex flex-col gap-3 border-b border-border/40 pb-4 md:flex-row md:items-end md:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-semibold text-primary">
            <Images size={16} />
            图片库
          </div>
          <h1 className="mt-2 text-2xl font-bold tracking-normal text-foreground">已生成图片</h1>
          <p className="mt-1 text-sm leading-6 text-muted-foreground">查看开放世界、封面和短篇生成过的图片，清理不需要的文件。</p>
        </div>
        <button
          type="button"
          onClick={() => void refetch()}
          disabled={loading}
          className="inline-flex h-10 items-center justify-center gap-2 rounded-lg border border-border/60 bg-secondary/40 px-3 text-sm font-semibold text-foreground transition-colors hover:bg-secondary disabled:opacity-60"
        >
          <RefreshCw size={15} className={loading ? "animate-spin" : ""} />
          刷新
        </button>
      </header>

      <section className="space-y-3">
        <div className="flex gap-2 overflow-x-auto pb-1">
          {(Object.keys(SOURCE_LABELS) as ImageSource[]).map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => setSource(value)}
              data-active={source === value}
              className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg border border-border/50 bg-secondary/25 px-3 text-sm font-medium text-muted-foreground data-[active=true]:border-primary/40 data-[active=true]:bg-primary/10 data-[active=true]:text-primary"
            >
              {value === "play" ? <Gamepad2 size={14} /> : value === "project" ? <FolderOpen size={14} /> : <Images size={14} />}
              {SOURCE_LABELS[value]}
              <span className="text-xs text-muted-foreground/70">{counts.bySource.get(value) ?? 0}</span>
            </button>
          ))}
        </div>
        <div className="flex gap-2 overflow-x-auto pb-1">
          {(Object.keys(KIND_LABELS) as ImageKind[]).map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => setKind(value)}
              data-active={kind === value}
              className="inline-flex h-9 shrink-0 items-center rounded-lg border border-border/50 bg-secondary/25 px-3 text-sm font-medium text-muted-foreground data-[active=true]:border-primary/40 data-[active=true]:bg-primary/10 data-[active=true]:text-primary"
            >
              {KIND_LABELS[value]}
              <span className="ml-1.5 text-xs text-muted-foreground/70">{counts.byKind.get(value) ?? 0}</span>
            </button>
          ))}
        </div>
      </section>

      {error ? (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      {loading && items.length === 0 ? (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4">
          {Array.from({ length: 8 }).map((_, index) => (
            <div key={index} className="h-52 animate-pulse rounded-lg border border-border/40 bg-secondary/30" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex min-h-72 flex-col items-center justify-center rounded-lg border border-dashed border-border/60 bg-secondary/20 px-4 text-center">
          <ImageOff size={34} className="text-muted-foreground/60" />
          <div className="mt-3 text-base font-semibold text-foreground">暂无匹配图片</div>
          <p className="mt-1 max-w-sm text-sm leading-6 text-muted-foreground">生成封面或在开放世界里启用/手动生成图片后，会出现在这里。</p>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4">
          {filtered.map((item) => {
            const src = imageUrl(item.url);
            const failed = item.status === "failed";
            return (
              <article key={item.id} className="group overflow-hidden rounded-lg border border-border/45 bg-card/70">
                <button
                  type="button"
                  onClick={() => src ? setPreview(item) : undefined}
                  disabled={!src}
                  className="flex aspect-square w-full items-center justify-center bg-secondary/25 text-muted-foreground"
                >
                  {src ? (
                    <img src={src} alt={item.title} className="h-full w-full object-cover" loading="lazy" />
                  ) : failed ? (
                    <AlertTriangle size={28} className="text-destructive/70" />
                  ) : (
                    <ImageOff size={28} />
                  )}
                </button>
                <div className="space-y-2 px-3 py-3">
                  <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <h2 className="truncate text-sm font-bold text-foreground">{item.title}</h2>
                      <p className="mt-0.5 truncate text-xs text-muted-foreground">{item.subtitle || formatDate(item.updatedAt) || KIND_LABELS[item.kind]}</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => void deleteItem(item)}
                      disabled={deletingId === item.id}
                      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
                      title="删除图片"
                      aria-label={`删除 ${item.title}`}
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                  <div className="flex items-center justify-between gap-2 text-xs">
                    <span className="rounded-full bg-secondary/60 px-2 py-1 text-muted-foreground">{KIND_LABELS[item.kind]}</span>
                    <span className={failed ? "text-destructive" : "text-muted-foreground/70"}>{failed ? "生成失败" : formatDate(item.updatedAt)}</span>
                  </div>
                  {item.error ? <p className="line-clamp-2 text-xs leading-5 text-destructive/80">{item.error}</p> : null}
                </div>
              </article>
            );
          })}
        </div>
      )}

      {preview ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/85 p-4 backdrop-blur-sm" onClick={() => setPreview(null)}>
          <div className="max-h-[92dvh] w-full max-w-4xl overflow-hidden rounded-lg border border-border/60 bg-card shadow-2xl" onClick={(event) => event.stopPropagation()}>
            <div className="flex items-center justify-between gap-3 border-b border-border/40 px-4 py-3">
              <div className="min-w-0">
                <div className="truncate text-sm font-bold text-foreground">{preview.title}</div>
                <div className="truncate text-xs text-muted-foreground">{preview.subtitle ?? preview.path ?? ""}</div>
              </div>
              <button
                type="button"
                onClick={() => void deleteItem(preview)}
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                title="删除图片"
                aria-label="删除图片"
              >
                <Trash2 size={16} />
              </button>
            </div>
            <div className="flex max-h-[76dvh] items-center justify-center bg-secondary/20">
              {imageUrl(preview.url) ? <img src={imageUrl(preview.url)} alt={preview.title} className="max-h-[76dvh] w-full object-contain" /> : null}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
