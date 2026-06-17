import { useMemo, useState } from "react";
import { AlertTriangle, Check, FolderOpen, Gamepad2, ImageOff, Images, Pencil, RefreshCw, Trash2, Wallpaper, X } from "lucide-react";
import { fetchJson, useApi } from "../hooks/use-api";
import { buildApiUrl } from "../lib/api-url";
import { appAlert, appConfirm } from "../lib/app-dialog";
import { clearChatBackground, readChatBackground, selectChatBackground } from "../lib/chat-background";

type ImageKind = "all" | "cover" | "scene" | "actor" | "item" | "short" | "wallpaper" | "other";
type ImageSource = "all" | "play" | "project";

interface GeneratedImageItem {
  readonly id: string;
  readonly source: "play" | "project";
  readonly kind: "scene" | "actor" | "item" | "cover" | "short" | "wallpaper" | "other";
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
  wallpaper: "壁纸",
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
  const [previewImageError, setPreviewImageError] = useState(false);
  const [activeWallpaperUrl, setActiveWallpaperUrl] = useState(() => readChatBackground().imageUrl);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
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
      if (item.url && activeWallpaperUrl === item.url) {
        clearChatBackground();
        setActiveWallpaperUrl(null);
      }
      if (preview?.id === item.id) setPreview(null);
      await refetch();
    } catch (e) {
      await appAlert({ title: "删除失败", message: e instanceof Error ? e.message : String(e), tone: "danger" });
      await refetch();
    } finally {
      setDeletingId(null);
    }
  };

  const useAsWallpaper = (item: GeneratedImageItem) => {
    if (!item.url) return;
    selectChatBackground(item.url);
    setActiveWallpaperUrl(item.url);
  };

  const renameWallpaper = async (item: GeneratedImageItem) => {
    const title = editingTitle.trim();
    if (!title) return;
    setRenamingId(item.id);
    try {
      const response = await fetchJson<{ item: GeneratedImageItem }>("/images/library", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: item.id, title }),
      });
      mutate((current) => current ? {
        items: current.items.map((candidate) => candidate.id === item.id ? response.item : candidate),
      } : current);
      if (activeWallpaperUrl === item.url && response.item.url) {
        selectChatBackground(response.item.url);
        setActiveWallpaperUrl(response.item.url);
      }
      setPreview((current) => current?.id === item.id ? response.item : current);
      setEditingId(null);
      setEditingTitle("");
    } catch (error) {
      await appAlert({
        title: "重命名失败",
        message: error instanceof Error ? error.message : String(error),
        tone: "danger",
      });
    } finally {
      setRenamingId(null);
    }
  };

  return (
    <div className="relative space-y-5 pb-16">
      <button
        type="button"
        onClick={() => void refetch()}
        disabled={loading}
        title="刷新"
        aria-label="刷新图片库"
        className="fixed right-3 top-[calc(env(safe-area-inset-top)+4.75rem)] z-40 inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-border/60 bg-card/95 text-foreground shadow-lg shadow-background/30 backdrop-blur transition-colors hover:bg-secondary disabled:opacity-60 sm:right-5 sm:top-24 sm:h-10 sm:w-auto sm:px-3"
      >
        <RefreshCw size={16} className={loading ? "animate-spin" : ""} />
        <span className="hidden pl-2 text-sm font-semibold sm:inline">刷新</span>
      </button>
      <header className="border-b border-border/40 pb-4 pr-14 sm:pr-24">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-semibold text-primary">
            <Images size={16} />
            图片库
          </div>
          <h1 className="mt-2 text-2xl font-bold tracking-normal text-foreground">已生成图片</h1>
          <p className="mt-1 text-sm leading-6 text-muted-foreground">查看开放世界、封面和短篇生成过的图片，清理不需要的文件。</p>
        </div>
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
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
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
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
          {filtered.map((item) => {
            const src = imageUrl(item.url);
            const failed = item.status === "failed";
            return (
              <article key={item.id} className="group overflow-hidden rounded-lg border border-border/45 bg-card/70">
                <button
                  type="button"
                  onClick={() => { if (src) { setPreview(item); setPreviewImageError(false); } }}
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
                      {editingId === item.id ? (
                        <div className="space-y-2">
                          <input
                            type="text"
                            value={editingTitle}
                            onChange={(event) => setEditingTitle(event.target.value)}
                            onKeyDown={(event) => {
                              if (event.key === "Enter") void renameWallpaper(item);
                              if (event.key === "Escape") setEditingId(null);
                            }}
                            maxLength={80}
                            autoFocus
                            className="h-10 w-full min-w-0 rounded-md border border-primary/45 bg-background px-3 text-sm text-foreground outline-none"
                          />
                          <div className="flex items-center gap-2">
                            <button type="button" onClick={() => void renameWallpaper(item)} disabled={renamingId === item.id} className="flex h-9 min-w-20 items-center justify-center gap-1.5 rounded-md text-sm font-medium text-primary hover:bg-primary/10 disabled:opacity-50" aria-label="保存名称">
                              <Check size={14} />
                              保存
                            </button>
                            <button type="button" onClick={() => setEditingId(null)} className="flex h-9 min-w-20 items-center justify-center gap-1.5 rounded-md text-sm text-muted-foreground hover:bg-secondary" aria-label="取消改名">
                              <X size={14} />
                              取消
                            </button>
                          </div>
                        </div>
                      ) : (
                        <>
                          <h2 className="truncate text-sm font-bold text-foreground">{item.title}</h2>
                          <p className="mt-0.5 truncate text-xs text-muted-foreground">{item.subtitle || formatDate(item.updatedAt) || KIND_LABELS[item.kind]}</p>
                        </>
                      )}
                    </div>
                    {item.kind === "wallpaper" && editingId !== item.id ? (
                      <button
                        type="button"
                        onClick={() => {
                          setEditingId(item.id);
                          setEditingTitle(item.title);
                        }}
                        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-primary/10 hover:text-primary"
                        title="重命名壁纸"
                        aria-label={`重命名 ${item.title}`}
                      >
                        <Pencil size={14} />
                      </button>
                    ) : null}
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
                  {item.kind === "wallpaper" && item.url ? (
                    <button
                      type="button"
                      onClick={() => useAsWallpaper(item)}
                      className={`flex h-9 w-full items-center justify-center gap-2 rounded-lg border text-sm font-medium transition-colors ${
                        activeWallpaperUrl === item.url
                          ? "border-primary/40 bg-primary/10 text-primary"
                          : "border-border/50 bg-secondary/30 text-foreground hover:border-primary/40 hover:text-primary"
                      }`}
                    >
                      {activeWallpaperUrl === item.url ? <Check size={15} /> : <Wallpaper size={15} />}
                      {activeWallpaperUrl === item.url ? "当前背景" : "设为聊天背景"}
                    </button>
                  ) : null}
                  {item.error ? <p className="line-clamp-2 text-xs leading-5 text-destructive/80">{item.error}</p> : null}
                </div>
              </article>
            );
          })}
        </div>
      )}

      {preview ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/85 p-4 backdrop-blur-sm" onClick={() => { setPreview(null); setPreviewImageError(false); }}>
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
            <div className="flex max-h-[76dvh] min-h-[200px] items-center justify-center bg-secondary/20">
              {previewImageError ? (
                <div className="flex flex-col items-center gap-3 text-destructive p-8">
                  <AlertTriangle size={32} />
                  <p className="text-sm font-medium">图片加载失败</p>
                  <p className="text-xs text-muted-foreground">图片文件可能已损坏或过大</p>
                </div>
              ) : imageUrl(preview.url) ? (
                <img
                  src={imageUrl(preview.url)}
                  alt={preview.title}
                  className="max-h-[76dvh] w-full object-contain"
                  loading="lazy"
                  decoding="async"
                  onError={() => setPreviewImageError(true)}
                />
              ) : null}
            </div>
            {preview.kind === "wallpaper" && preview.url ? (
              <div className="border-t border-border/40 p-3">
                <button
                  type="button"
                  onClick={() => useAsWallpaper(preview)}
                  className="flex h-10 w-full items-center justify-center gap-2 rounded-lg bg-primary text-sm font-semibold text-primary-foreground"
                >
                  {activeWallpaperUrl === preview.url ? <Check size={16} /> : <Wallpaper size={16} />}
                  {activeWallpaperUrl === preview.url ? "当前聊天背景" : "设为聊天背景"}
                </button>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
