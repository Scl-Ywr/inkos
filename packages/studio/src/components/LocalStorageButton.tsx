import { useState, useEffect } from "react";
import { createPortal } from "react-dom";
import {
  CheckCircle2,
  Copy,
  Database,
  FileText,
  FolderOpen,
  MapPin,
  ShieldCheck,
  X,
} from "lucide-react";
import { fetchJson } from "../hooks/use-api";
import { formatLocalStorageInfo, type LocalStorageInfo } from "./app-utils";

export function LocalStorageButton() {
  const [info, setInfo] = useState<LocalStorageInfo | null>(null);
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void fetchJson<LocalStorageInfo>("/local-storage")
      .then((payload) => {
        if (!cancelled) setInfo(payload);
      })
      .catch(() => {
        if (!cancelled) setInfo(null);
      });
    return () => { cancelled = true; };
  }, []);

  if (!info || (info.mode !== "local" && info.mode !== "node")) return null;

  const handleClick = async () => {
    setOpen(true);
    setCopied(false);
  };

  const copyInfo = async () => {
    try {
      await navigator.clipboard?.writeText(formatLocalStorageInfo(info));
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  const modal = open ? createPortal(
    <div
      className="fixed inset-0 z-[9999] bg-background/70 backdrop-blur-xl"
      style={{
        position: "fixed",
        inset: 0,
        width: "100vw",
        height: "100dvh",
      }}
      role="dialog"
      aria-modal="true"
      aria-label="本地文件保存位置"
      onClick={() => setOpen(false)}
    >
      <div className="flex min-h-[100dvh] w-full items-center justify-center px-4 py-[calc(env(safe-area-inset-top)+1rem)] pb-[calc(env(safe-area-inset-bottom)+1rem)]">
        <div
          className="glass-panel fade-in flex max-h-[min(42rem,calc(100dvh-env(safe-area-inset-top)-env(safe-area-inset-bottom)-2rem))] w-full max-w-md flex-col overflow-hidden rounded-[2rem] border border-border/70 bg-card/95 shadow-2xl shadow-primary/10"
          onClick={(event) => event.stopPropagation()}
        >
          <div className="flex shrink-0 items-start justify-between gap-4 px-5 pt-5 sm:px-6 sm:pt-6">
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-sm font-semibold text-primary">
                <ShieldCheck size={16} />
                本地保存
              </div>
              <h2 className="mt-2 text-2xl font-semibold tracking-normal text-foreground">InkOS 数据目录</h2>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">
                书籍、章节和索引会保存在当前设备，AI 请求之外的数据不需要上传服务器。
              </p>
            </div>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="soft-pill flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground"
              aria-label="关闭"
            >
              <X size={16} />
            </button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-4 sm:px-6">
            <div className="mt-5 flex flex-wrap gap-2">
              <span className="inline-flex items-center gap-1.5 rounded-full bg-primary/12 px-3 py-1.5 text-xs font-semibold text-primary">
                <CheckCircle2 size={14} />
                {info.available ? "已启用" : "暂不可用"}
              </span>
              <span className="inline-flex items-center gap-1.5 rounded-full bg-secondary/80 px-3 py-1.5 text-xs font-medium text-secondary-foreground">
                <Database size={14} />
                本地 JSON 数据库
              </span>
            </div>

            <div className="mt-5 space-y-3">
              <section className="rounded-2xl border border-border/55 bg-background/45 p-4">
                <div className="flex items-center gap-2 text-xs font-semibold uppercase text-muted-foreground">
                  <MapPin size={14} />
                  保存位置
                </div>
                <p className="mt-2 break-words text-base font-semibold text-foreground">
                  {info.path ?? "暂未获取到路径"}
                </p>
              </section>

              {info.uri && (
                <section className="rounded-2xl border border-border/55 bg-background/45 p-4">
                  <div className="flex items-center gap-2 text-xs font-semibold uppercase text-muted-foreground">
                    <FolderOpen size={14} />
                    系统 URI
                  </div>
                  <p className="mt-2 break-all font-mono text-xs leading-5 text-muted-foreground">{info.uri}</p>
                </section>
              )}

              <section className="rounded-2xl border border-border/55 bg-background/45 p-4">
                <div className="flex items-center gap-2 text-xs font-semibold uppercase text-muted-foreground">
                  <FileText size={14} />
                  保存内容
                </div>
                <div className="mt-3 grid gap-2 text-sm text-foreground">
                  <div className="flex items-center justify-between gap-3 rounded-xl bg-secondary/55 px-3 py-2">
                    <span>书籍数据库</span>
                    <span className="font-mono text-xs text-muted-foreground">inkos-db.json</span>
                  </div>
                  <div className="flex items-center justify-between gap-3 rounded-xl bg-secondary/55 px-3 py-2">
                    <span>章节索引</span>
                    <span className="font-mono text-xs text-muted-foreground">manifest.json</span>
                  </div>
                  <div className="rounded-xl bg-secondary/55 px-3 py-2">
                    <div>章节文件</div>
                    <div className="mt-1 break-all font-mono text-xs text-muted-foreground">
                      books/&lt;书籍ID&gt;/chapters/*.md
                    </div>
                  </div>
                </div>
              </section>

              <p className="rounded-2xl border border-primary/20 bg-primary/8 px-4 py-3 text-sm leading-6 text-muted-foreground">
                {info.permission}
              </p>
            </div>
          </div>

          <div className="grid shrink-0 grid-cols-[1fr_auto] gap-3 border-t border-border/45 bg-card/75 px-5 py-4 sm:px-6">
            <button
              type="button"
              onClick={copyInfo}
              className="inline-flex h-12 items-center justify-center gap-2 rounded-2xl bg-primary px-4 text-sm font-semibold text-primary-foreground shadow-lg shadow-primary/20 transition-colors hover:bg-primary/90"
            >
              {copied ? <CheckCircle2 size={16} /> : <Copy size={16} />}
              {copied ? "已复制" : "复制信息"}
            </button>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="soft-pill h-12 rounded-2xl px-5 text-sm font-semibold text-foreground"
            >
              关闭
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  ) : null;

  return (
    <>
      <button
        onClick={handleClick}
        className="soft-pill flex h-10 w-10 shrink-0 touch-manipulation items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground"
        aria-label="查看本地文件保存位置"
        title={info.path ?? "本地文件保存位置"}
      >
        <FolderOpen size={14} />
      </button>
      {modal}
    </>
  );
}
