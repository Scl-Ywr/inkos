import { useState, useEffect } from "react";
import { createPortal } from "react-dom";
import { Directory, Filesystem } from "@capacitor/filesystem";
import { useHashRoute } from "./hooks/use-hash-route";
import type { HashRoute } from "./hooks/use-hash-route";
import { Sidebar } from "./components/Sidebar";
import { Dashboard } from "./pages/Dashboard";
import { ChatPage } from "./pages/ChatPage";
import { BookDetail } from "./pages/BookDetail";
import { ChapterReader } from "./pages/ChapterReader";
import { Analytics } from "./pages/Analytics";
import { ServiceListPage } from "./pages/ServiceListPage";
import { ServiceDetailPage } from "./pages/ServiceDetailPage";
import { TruthFiles } from "./pages/TruthFiles";
import { DaemonControl } from "./pages/DaemonControl";
import { LogViewer } from "./pages/LogViewer";
import { GenreManager } from "./pages/GenreManager";
import { StyleManager } from "./pages/StyleManager";
import { ImportManager } from "./pages/ImportManager";
import { RadarView } from "./pages/RadarView";
import { DoctorView } from "./pages/DoctorView";
import { LanguageSelector } from "./pages/LanguageSelector";
import { BookSidebar, BookSidebarToggle } from "./components/chat/BookSidebar";
import { useSSE } from "./hooks/use-sse";
import { useSessionEvents } from "./hooks/use-session-events";
import { useTheme } from "./hooks/use-theme";
import { publishLanguageChange, useI18n } from "./hooks/use-i18n";
import { fetchJson, postApi, putApi, useApi } from "./hooks/use-api";
import { buildApiUrl } from "./lib/api-url";
import { AppDialogProvider } from "./lib/app-dialog";
import {
  ensureEmbeddedNodeRunning,
  requestBatteryOptimizationExemption,
  resetEmbeddedNodeRuntime,
  updateAndroidTaskNotification,
} from "./lib/android-runtime-plugin";
import { isNativeRuntime } from "./lib/mobile-runtime";
import {
  Activity,
  CheckCircle2,
  Copy,
  Cpu,
  Database,
  FileText,
  FolderOpen,
  House,
  MapPin,
  Menu,
  Moon,
  ShieldCheck,
  Server,
  Sun,
  Wrench,
  X,
} from "lucide-react";

export type { HashRoute as Route } from "./hooks/use-hash-route";

export function deriveActiveBookId(route: HashRoute): string | undefined {
  if ("bookId" in route) return route.bookId;
  return undefined;
}

export function isBookCreateChatRoute(route: HashRoute): boolean {
  return route.page === "book-create";
}

interface LocalStorageInfo {
  readonly mode: string;
  readonly available: boolean;
  readonly directory: string | null;
  readonly uri: string | null;
  readonly path: string | null;
  readonly permission: string;
}

function formatLocalStorageInfo(info: LocalStorageInfo): string {
  return [
    info.available ? "本地文件保存已启用" : "本地文件保存暂不可用",
    `保存位置: ${info.path ?? "未知"}`,
    info.uri ? `系统 URI: ${info.uri}` : "",
    info.permission,
    "书籍数据库: inkos-db.json",
    "章节索引: manifest.json",
    "章节文件: books/<书籍ID>/chapters/*.md",
  ].filter(Boolean).join("\n");
}

interface AndroidRuntimeFileStatus {
  readonly state?: string;
  readonly message?: string;
  readonly updatedAt?: number;
  readonly packagedRuntimeVersion?: string;
  readonly installedRuntimeVersion?: string;
  readonly nativeLibSize?: number;
  readonly nativeLibSha256?: string;
}

function parseAndroidRuntimeStatus(text: string): AndroidRuntimeFileStatus {
  try {
    return JSON.parse(text) as AndroidRuntimeFileStatus;
  } catch {
    const jsonBlocks = text.match(/\{[\s\S]*\}/g) ?? [];
    for (const block of jsonBlocks.reverse()) {
      try {
        return JSON.parse(block) as AndroidRuntimeFileStatus;
      } catch {
        // Keep trying older native status files that may contain log prefixes.
      }
    }
    return {
      state: "status-legacy",
      message: "原生 runtime 状态文件是旧版格式；如果 Node API 和 node:sqlite 可用，可以忽略这条兼容提示。",
    };
  }
}

interface TokenDiagnosticsPayload {
  readonly diagnostics: {
    readonly headroom: {
      readonly enabled: boolean;
      readonly configured: boolean;
      readonly lastCompressionOk: boolean | null;
      readonly lastCompressionAt: number | null;
      readonly lastError: string | null;
    };
    readonly embedding: {
      readonly configured: boolean;
      readonly endpoint: string | null;
      readonly model: string;
      readonly lastExternalOk: boolean | null;
      readonly lastExternalAt: number | null;
      readonly lastFallbackAt: number | null;
      readonly lastError: string | null;
    };
    readonly telemetry: {
      readonly semanticL1Hits: number;
      readonly semanticL2Hits: number;
      readonly semanticMisses: number;
      readonly cacheSkippedCalls: number;
      readonly ccrBlocksCompressed: number;
      readonly originalChars: number;
      readonly optimizedChars: number;
      readonly estimatedTokensSaved: number;
      readonly pipeline?: ReadonlyArray<{
        readonly kind: string;
        readonly label: string;
        readonly at: number;
      }>;
    };
    readonly semanticCache: {
      readonly storage: {
        readonly sqliteAvailable: boolean;
        readonly path: string;
        readonly fallbackPath: string;
        readonly error?: string;
      };
      readonly l1Entries: number;
      readonly l1Limit: number;
      readonly rowCount: number;
      readonly dbBytes: number;
      readonly fallbackRows: number;
      readonly fallbackBytes: number;
      readonly l3ArchiveBytes: number;
      readonly hitRate: number;
      readonly lastMaintenanceAt: number | null;
    };
  };
}

interface RuntimeNodeInfoPayload {
  readonly node: {
    readonly version: string;
    readonly platform: string;
    readonly arch: string;
    readonly abi?: string;
    readonly execPath?: string;
  };
  readonly sqlite: {
    readonly available: boolean;
    readonly databaseSync: boolean;
    readonly exports: string[];
    readonly error: string | null;
  };
}

async function readAndroidTextFile(path: string): Promise<string | null> {
  if (!isNativeRuntime()) return null;
  try {
    const result = await Filesystem.readFile({
      path,
      directory: Directory.Data,
    });
    if (typeof result.data === "string") return result.data;
    return await result.data.text();
  } catch {
    return null;
  }
}

async function readAndroidRuntimeDiagnostics(): Promise<{
  readonly status: AndroidRuntimeFileStatus | null;
  readonly output: string | null;
}> {
  const [statusText, outputText] = await Promise.all([
    readAndroidTextFile("InkOS Studio/runtime-status.json"),
    readAndroidTextFile("InkOS Studio/node-output.log"),
  ]);
  let status: AndroidRuntimeFileStatus | null = null;
  if (statusText) {
    status = parseAndroidRuntimeStatus(statusText);
  }
  return {
    status,
    output: outputText ? outputText.slice(-1600) : null,
  };
}

function isNativeNodeBooting(state?: string): boolean {
  if (!state) return false;
  return /^(checking|extracting|extracted|starting|node-starting|restart-scheduled|restart-skipped)$/i.test(state);
}

function LocalStorageButton() {
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

interface RuntimeStatus {
  node: {
    readonly state: "checking" | "running" | "offline";
    readonly message: string;
    readonly nativeState?: string;
    readonly nodeOutput?: string | null;
  };
  localTools: {
    readonly state: "checking" | "available" | "unavailable";
    readonly implemented: number;
    readonly total: number;
    readonly message: string;
  };
  storage: {
    readonly state: "checking" | "available" | "unavailable";
    readonly path: string | null;
    readonly message: string;
  };
}

function RuntimeStatusButton() {
  const [open, setOpen] = useState(false);
  const [actionStatus, setActionStatus] = useState("");
  const [status, setStatus] = useState<RuntimeStatus>({
    node: { state: "checking", message: "正在检测内置 Node..." },
    localTools: { state: "checking", implemented: 0, total: 0, message: "正在检测本地工具..." },
    storage: { state: "checking", path: null, message: "正在检测本地保存..." },
  });

  const refresh = async () => {
    setStatus({
      node: { state: "checking", message: "正在检测 127.0.0.1:4567..." },
      localTools: { state: "checking", implemented: 0, total: 0, message: "正在检测本地工具..." },
      storage: { state: "checking", path: null, message: "正在检测本地保存..." },
    });

    const next: RuntimeStatus = {
      node: { state: "offline", message: "Node API 未响应。当前 APK 已禁用 JS fallback，必须等待内置 Node 后端启动成功。" },
      localTools: { state: "unavailable", implemented: 0, total: 0, message: "本地工具状态未知。" },
      storage: { state: "unavailable", path: null, message: "本地保存状态未知。" },
    };

    try {
      const url = buildApiUrl("/project");
      if (url) {
        const controller = new AbortController();
        const timeout = window.setTimeout(() => controller.abort(), 1800);
        const response = await fetch(url, { signal: controller.signal, cache: "no-store" });
        window.clearTimeout(timeout);
        if (response.ok) {
          next.node = { state: "running", message: "Node API 已启动并响应 127.0.0.1:4567。" };
        } else {
          next.node = { state: "offline", message: `Node API 有响应但返回 HTTP ${response.status}。` };
        }
      }
    } catch {
      next.node = { state: "offline", message: "Node API 未响应，主界面不会因此闪退。" };
    }

    const diagnostics = await readAndroidRuntimeDiagnostics();
    try {
      const runtime = await fetchJson<{
        state?: string;
        message?: string;
        updatedAt?: number | null;
      }>("/runtime/status");
      const nativeState = runtime.state;
      const nativeMessage = runtime.message;
      if (nativeState && next.node.state !== "running") {
        next.node = {
          ...next.node,
          nativeState,
          message: nativeMessage
            ? `${next.node.message} 原生状态：${nativeState}，${nativeMessage}`
            : `${next.node.message} 原生状态：${nativeState}。`,
        };
      }
    } catch {
      if (diagnostics.status?.state || diagnostics.output) {
        const nativeStateMessage = diagnostics.status?.state === "status-legacy"
          ? "原生状态：旧版状态文件，Node API 探测结果优先。"
          : diagnostics.status?.state ? `原生状态：${diagnostics.status.state}` : "";
        const parts = [
          next.node.message,
          nativeStateMessage,
          diagnostics.status?.message ?? "",
          diagnostics.output ? `Node 输出：${diagnostics.output}` : "",
        ].filter(Boolean);
        next.node = {
          ...next.node,
          nativeState: diagnostics.status?.state,
          nodeOutput: diagnostics.output,
          message: parts.join("\n"),
        };
      }
    }

    try {
      const tools = await fetchJson<{ capabilities: ReadonlyArray<{ apkStatus: string }> }>("/tools/capabilities");
      const capabilities = tools.capabilities ?? [];
      const callable = capabilities.filter((item) => item.apkStatus !== "unsupported").length;
      const degraded = capabilities.filter((item) => item.apkStatus === "degraded" || item.apkStatus === "partial").length;
      next.localTools = {
        state: callable > 0 ? "available" : "unavailable",
        implemented: callable,
        total: capabilities.length,
        message: callable > 0
          ? `APK 本地工具可调用：${callable}/${capabilities.length} 项。${degraded > 0 ? `${degraded} 项桌面增强在 APK 中使用本地降级实现。` : "全部为完整本地实现。"}`
          : "没有读取到本地工具清单。",
      };
    } catch (error) {
      next.localTools = {
        state: "unavailable",
        implemented: 0,
        total: 0,
        message: error instanceof Error ? error.message : String(error),
      };
    }

    try {
      const info = await fetchJson<LocalStorageInfo>("/local-storage");
      next.storage = {
        state: info?.available ? "available" : "unavailable",
        path: info?.path ?? null,
        message: info?.available ? "本地数据保存可用。" : "本地数据目录暂不可用。",
      };
    } catch (error) {
      next.storage = {
        state: "unavailable",
        path: null,
        message: error instanceof Error ? error.message : String(error),
      };
    }

    setStatus(next);
  };

  useEffect(() => {
    void refresh();
  }, []);

  const handleEnsureNode = async () => {
    setActionStatus("正在重建内置 Node 运行时...");
    const resetOk = await resetEmbeddedNodeRuntime();
    const ok = resetOk || await ensureEmbeddedNodeRunning();
    setActionStatus(ok ? "已发送修复请求，正在重新检测..." : "当前环境无法直接启动 Node。");
    window.setTimeout(() => void refresh(), 900);
    window.setTimeout(() => void refresh(), 2400);
    window.setTimeout(() => void refresh(), 6000);
  };

  const handleBatteryPermission = async () => {
    setActionStatus("正在打开后台保活权限设置...");
    const ok = await requestBatteryOptimizationExemption();
    setActionStatus(ok ? "请在系统弹窗或设置页允许 InkOS 保持后台运行。" : "无法自动打开权限页面，请在系统设置里关闭本应用的电池优化。");
  };

  const summary =
    status.node.state === "running"
      ? "Node 运行中"
      : status.localTools.state === "available"
        ? "本地兜底可用"
        : "运行异常";
  const canRepairNode = status.node.state === "offline" && !isNativeNodeBooting(status.node.nativeState);

  const modal = open ? createPortal(
    <div
      className="fixed inset-0 z-[9999] bg-background/70 backdrop-blur-xl"
      role="dialog"
      aria-modal="true"
      aria-label="本地运行状态"
      onClick={() => setOpen(false)}
    >
      <div className="flex min-h-[100dvh] w-full items-center justify-center px-4 py-[calc(env(safe-area-inset-top)+1rem)] pb-[calc(env(safe-area-inset-bottom)+1rem)]">
        <div
          className="glass-panel fade-in w-full max-w-md overflow-hidden rounded-[2rem] border border-border/70 bg-card/95 shadow-2xl shadow-primary/10"
          onClick={(event) => event.stopPropagation()}
        >
          <div className="flex items-start justify-between gap-4 px-5 pt-5 sm:px-6 sm:pt-6">
            <div>
              <div className="flex items-center gap-2 text-sm font-semibold text-primary">
                <Activity size={16} />
                本地运行状态
              </div>
              <h2 className="mt-2 text-2xl font-semibold tracking-normal text-foreground">{summary}</h2>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">
                APK 现在只使用内置 Node 后端；如果连接失败，这里会显示原生启动状态和 Node 输出。
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

          <div className="space-y-3 px-5 py-5 sm:px-6">
            <RuntimeStatusRow
              icon={<Server size={16} />}
              title="内置 Node API"
              tone={status.node.state === "running" ? "ok" : status.node.state === "checking" ? "wait" : "warn"}
              message={status.node.message}
            />
            <RuntimeStatusRow
              icon={<Wrench size={16} />}
              title="本地工具后台"
              tone={status.localTools.state === "available" ? "ok" : status.localTools.state === "checking" ? "wait" : "warn"}
              message={status.localTools.message}
            />
            <RuntimeStatusRow
              icon={<Database size={16} />}
              title="本地数据保存"
              tone={status.storage.state === "available" ? "ok" : status.storage.state === "checking" ? "wait" : "warn"}
              message={status.storage.path ? `${status.storage.message} ${status.storage.path}` : status.storage.message}
            />
            {actionStatus && (
              <p className="rounded-2xl border border-primary/20 bg-primary/8 px-4 py-3 text-xs leading-5 text-muted-foreground">
                {actionStatus}
              </p>
            )}
          </div>

          <div className={`grid grid-cols-1 gap-3 border-t border-border/45 bg-card/75 px-5 py-4 sm:px-6 ${canRepairNode ? "sm:grid-cols-[1fr_1fr_auto]" : "sm:grid-cols-2"}`}>
            {canRepairNode && (
              <button
                type="button"
                onClick={() => void handleEnsureNode()}
                className="inline-flex h-12 items-center justify-center gap-2 rounded-2xl bg-primary px-4 text-sm font-semibold text-primary-foreground shadow-lg shadow-primary/20 transition-colors hover:bg-primary/90"
              >
                <Wrench size={16} />
                修复 Node
              </button>
            )}
            <button
              type="button"
              onClick={() => void handleBatteryPermission()}
              className="soft-pill inline-flex h-12 items-center justify-center gap-2 rounded-2xl px-4 text-sm font-semibold text-foreground"
            >
              <ShieldCheck size={16} />
              后台权限
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
        onClick={() => {
          setOpen(true);
          void refresh();
        }}
        className="soft-pill flex h-10 w-10 shrink-0 touch-manipulation items-center justify-center gap-1.5 rounded-full px-0 text-muted-foreground transition-colors hover:text-foreground sm:w-auto sm:min-w-11 sm:px-3"
        aria-label="查看本地运行状态"
        title={summary}
      >
        <Cpu size={14} />
        <span className="hidden text-xs font-semibold sm:inline">{status.node.state === "running" ? "Node" : "本地"}</span>
      </button>
      {modal}
    </>
  );
}

function RuntimeStatusRow({ icon, title, tone, message }: {
  icon: React.ReactNode;
  title: string;
  tone: "ok" | "warn" | "wait";
  message: string;
}) {
  const toneClass =
    tone === "ok"
      ? "bg-emerald-500/12 text-emerald-500"
      : tone === "warn"
        ? "bg-amber-500/12 text-amber-500"
        : "bg-secondary text-muted-foreground";
  return (
    <section className="rounded-2xl border border-border/55 bg-background/45 p-4">
      <div className="flex items-center gap-3">
        <span className={`flex h-9 w-9 items-center justify-center rounded-full ${toneClass}`}>{icon}</span>
        <div className="min-w-0">
          <div className="text-sm font-semibold text-foreground">{title}</div>
          <p className="mt-1 break-words text-xs leading-5 text-muted-foreground">{message}</p>
        </div>
      </div>
    </section>
  );
}

function TokenDiagnosticsButton() {
  const [open, setOpen] = useState(false);
  const [diagnostics, setDiagnostics] = useState<TokenDiagnosticsPayload | null>(null);
  const [nodeInfo, setNodeInfo] = useState<RuntimeNodeInfoPayload | null>(null);
  const [runtimeStatus, setRuntimeStatus] = useState<AndroidRuntimeFileStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [actionStatus, setActionStatus] = useState("");

  const refresh = async () => {
    setLoading(true);
    setActionStatus("");
    const [tokenPayload, runtimeNodeInfo, androidDiagnostics] = await Promise.all([
      fetchJson<TokenDiagnosticsPayload>("/token-diagnostics").catch(() => null),
      fetchJson<RuntimeNodeInfoPayload>("/runtime/node-info").catch(() => null),
      readAndroidRuntimeDiagnostics().catch(() => ({ status: null, output: null })),
    ]);
    setDiagnostics(tokenPayload);
    setNodeInfo(runtimeNodeInfo);
    setRuntimeStatus(androidDiagnostics.status);
    setLoading(false);
  };

  const runMaintenance = async () => {
    setActionStatus("正在维护语义缓存...");
    try {
      const result = await postApi<{ ok: boolean; removedRows: number; archivedRows: number; error?: string }>(
        "/token-cache/maintenance",
        { vacuum: true },
      );
      setActionStatus(result.ok
        ? `缓存维护完成：清理 ${result.removedRows} 条，归档 ${result.archivedRows} 条。`
        : `缓存维护失败：${result.error ?? "未知错误"}`);
      await refresh();
    } catch (error) {
      setActionStatus(error instanceof Error ? error.message : String(error));
    }
  };

  const data = diagnostics?.diagnostics;
  const summary = data
    ? data.semanticCache.storage.sqliteAvailable
      ? "Token 诊断"
      : "缓存降级"
    : "Token 诊断";

  const modal = open ? createPortal(
    <div
      className="fixed inset-0 z-[9999] bg-background/70 backdrop-blur-xl"
      role="dialog"
      aria-modal="true"
      aria-label="Token 节省诊断"
      onClick={() => setOpen(false)}
    >
      <div className="flex min-h-[100dvh] w-full items-center justify-center px-4 py-[calc(env(safe-area-inset-top)+1rem)] pb-[calc(env(safe-area-inset-bottom)+1rem)]">
        <div
          className="glass-panel fade-in flex max-h-[min(46rem,calc(100dvh-env(safe-area-inset-top)-env(safe-area-inset-bottom)-2rem))] w-full max-w-lg flex-col overflow-hidden rounded-[2rem] border border-border/70 bg-card/95 shadow-2xl shadow-primary/10"
          onClick={(event) => event.stopPropagation()}
        >
          <div className="flex shrink-0 items-start justify-between gap-4 px-5 pt-5 sm:px-6 sm:pt-6">
            <div>
              <div className="flex items-center gap-2 text-sm font-semibold text-primary">
                <Database size={16} />
                Token 节省诊断
              </div>
              <h2 className="mt-2 text-2xl font-semibold tracking-normal text-foreground">{summary}</h2>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">
                这里显示 Headroom、Embedding、SQLite 缓存和 Android runtime 的真实启用状态。
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

          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-5 py-5 sm:px-6">
            {loading && <p className="text-sm text-muted-foreground">正在刷新诊断...</p>}
            {data ? (
              <>
                <RuntimeStatusRow
                  icon={<Cpu size={16} />}
                  title="Headroom"
                  tone={data.headroom.lastCompressionOk === false ? "warn" : "ok"}
                  message={[
                    data.headroom.enabled ? "官方 Headroom 已启用。" : "本地 Headroom light 已启用。",
                    data.headroom.configured ? "已配置官方服务参数。" : "未配置官方 HEADROOM_BASE_URL/API_KEY，当前走本地压缩 fallback。",
                    data.headroom.lastCompressionOk === true ? "最近一次官方压缩成功。" : "",
                    data.headroom.lastCompressionOk === false ? `最近一次已回退：${data.headroom.lastError ?? "未知原因"}` : "",
                  ].filter(Boolean).join(" ")}
                />
                <RuntimeStatusRow
                  icon={<Activity size={16} />}
                  title="上下文压缩"
                  tone={data.telemetry.ccrBlocksCompressed > 0 ? "ok" : "wait"}
                  message={`压缩块 ${data.telemetry.ccrBlocksCompressed} 个，估算节省 ${data.telemetry.estimatedTokensSaved.toLocaleString()} tokens，字符 ${data.telemetry.originalChars.toLocaleString()} -> ${data.telemetry.optimizedChars.toLocaleString()}。`}
                />
                <RuntimeStatusRow
                  icon={<Server size={16} />}
                  title="Embedding"
                  tone={data.embedding.lastExternalOk === false ? "warn" : "ok"}
                  message={[
                    data.embedding.configured ? `外部 bge 模型已配置：${data.embedding.model}` : "本地轻量 embedding 已启用；未配置外部 bge endpoint 时会自动 fallback。",
                    data.embedding.lastExternalOk === true ? "最近一次外部 embedding 成功。" : "",
                    data.embedding.lastExternalOk === false ? `最近一次外部 embedding 失败并回退：${data.embedding.lastError ?? "未知原因"}` : "",
                  ].filter(Boolean).join(" ")}
                />
                <RuntimeStatusRow
                  icon={<Database size={16} />}
                  title="语义缓存"
                  tone={data.semanticCache.storage.sqliteAvailable ? "ok" : "warn"}
                  message={`SQLite ${data.semanticCache.storage.sqliteAvailable ? "可用" : "不可用，使用 JSON fallback"}；行数 ${data.semanticCache.rowCount}，L1 ${data.semanticCache.l1Entries}/${data.semanticCache.l1Limit}，命中率 ${(data.semanticCache.hitRate * 100).toFixed(0)}%，DB ${formatBytes(data.semanticCache.dbBytes)}。路径：${data.semanticCache.storage.path}`}
                />
                <RuntimeStatusRow
                  icon={<FileText size={16} />}
                  title="最近流水线"
                  tone={(data.telemetry.pipeline?.length ?? 0) > 0 ? "ok" : "wait"}
                  message={(data.telemetry.pipeline ?? []).slice(-5).map((event) => event.label).join(" / ") || "还没有 AI 请求触发流水线。"}
                />
                <RuntimeStatusRow
                  icon={<Wrench size={16} />}
                  title="Android Runtime"
                  tone={nodeInfo?.node.version || runtimeStatus?.packagedRuntimeVersion ? "ok" : "wait"}
                  message={[
                    nodeInfo?.node.version ? `Node ${nodeInfo.node.version}` : "",
                    nodeInfo?.sqlite.available ? `node:sqlite ${nodeInfo.sqlite.databaseSync ? "DatabaseSync 可用" : "已加载但缺 DatabaseSync"}` : nodeInfo?.sqlite.error ? `node:sqlite 不可用：${nodeInfo.sqlite.error}` : "",
                    runtimeStatus?.state
                      ? `状态：${runtimeStatus.state === "status-legacy" ? "旧版状态文件，Node API 状态以上方探测为准" : runtimeStatus.state}`
                      : "桌面或未读取到原生状态文件。",
                    runtimeStatus?.packagedRuntimeVersion ? `packaged=${runtimeStatus.packagedRuntimeVersion.slice(0, 12)}` : "",
                    runtimeStatus?.installedRuntimeVersion ? `installed=${runtimeStatus.installedRuntimeVersion.slice(0, 12)}` : "",
                    runtimeStatus?.nativeLibSize ? `libnode=${formatBytes(runtimeStatus.nativeLibSize)}` : "",
                    runtimeStatus?.nativeLibSha256 ? `sha256=${runtimeStatus.nativeLibSha256.slice(0, 12)}` : "",
                  ].filter(Boolean).join(" · ")}
                />
              </>
            ) : !loading ? (
              <p className="rounded-2xl border border-destructive/20 bg-destructive/8 px-4 py-3 text-sm text-muted-foreground">
                暂时无法读取 Token 诊断。请确认本地 Node API 已启动。
              </p>
            ) : null}
            {actionStatus && (
              <p className="rounded-2xl border border-primary/20 bg-primary/8 px-4 py-3 text-xs leading-5 text-muted-foreground">
                {actionStatus}
              </p>
            )}
          </div>

          <div className="grid shrink-0 grid-cols-1 gap-3 border-t border-border/45 bg-card/75 px-5 py-4 sm:grid-cols-[1fr_auto_auto] sm:px-6">
            <button
              type="button"
              onClick={() => void runMaintenance()}
              className="inline-flex h-12 items-center justify-center gap-2 rounded-2xl bg-primary px-4 text-sm font-semibold text-primary-foreground shadow-lg shadow-primary/20 transition-colors hover:bg-primary/90"
            >
              <Database size={16} />
              维护缓存
            </button>
            <button
              type="button"
              onClick={() => void refresh()}
              className="soft-pill inline-flex h-12 items-center justify-center gap-2 rounded-2xl px-4 text-sm font-semibold text-foreground"
            >
              <Activity size={16} />
              刷新
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
        onClick={() => {
          setOpen(true);
          void refresh();
        }}
        className="soft-pill flex h-10 w-10 shrink-0 touch-manipulation items-center justify-center gap-1.5 rounded-full px-0 text-muted-foreground transition-colors hover:text-foreground sm:w-auto sm:min-w-11 sm:px-3"
        aria-label="查看 Token 节省诊断"
        title={summary}
      >
        <Database size={14} />
        <span className="hidden text-xs font-semibold sm:inline">Token</span>
      </button>
      {modal}
    </>
  );
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

export function App() {
  const { route, setRoute } = useHashRoute();
  const sse = useSSE();
  const { theme, setTheme } = useTheme();
  const { t, lang: currentLang } = useI18n();
  const { data: project, error: projectError, refetch: refetchProject } = useApi<{ language: string; languageExplicit: boolean }>("/project");
  const [showLanguageSelector, setShowLanguageSelector] = useState(false);
  const [ready, setReady] = useState(false);
  const [startupRetryCount, setStartupRetryCount] = useState(0);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const closeSidebar = () => setSidebarOpen(false);

  const isDark = theme === "dark";

  useEffect(() => {
    document.documentElement.classList.toggle("dark", isDark);
  }, [isDark]);

  useEffect(() => {
    if (project) {
      setStartupRetryCount(0);
      if (!project.languageExplicit) {
        setShowLanguageSelector(true);
      }
      setReady(true);
    }
  }, [project]);

  useEffect(() => {
    if (!isNativeRuntime()) return;
    const wakeNode = () => {
      if (document.visibilityState === "visible") {
        void ensureEmbeddedNodeRunning();
        window.setTimeout(() => refetchProject(), 800);
        window.setTimeout(() => refetchProject(), 2200);
      }
    };
    void ensureEmbeddedNodeRunning();
    document.addEventListener("visibilitychange", wakeNode);
    window.addEventListener("focus", wakeNode);
    window.addEventListener("online", wakeNode);
    return () => {
      document.removeEventListener("visibilitychange", wakeNode);
      window.removeEventListener("focus", wakeNode);
      window.removeEventListener("online", wakeNode);
    };
  }, [refetchProject]);

  useEffect(() => {
    if (!isNativeRuntime()) return;
    const operation = sse.activeOperations[0];
    if (!operation) {
      void updateAndroidTaskNotification({
        title: "InkOS Studio",
        message: "本地 Node 后端运行中，暂无写作任务",
        busy: false,
      });
      return;
    }
    void updateAndroidTaskNotification({
      title: operation.label?.trim() || "InkOS 正在执行任务",
      message: operation.message?.trim() || "任务正在运行",
      busy: true,
    });
  }, [sse.activeOperations]);

  useEffect(() => {
    if (!projectError || project) return;
    if (startupRetryCount < 24) {
      const timer = window.setTimeout(() => {
        setStartupRetryCount((count) => count + 1);
        refetchProject();
      }, startupRetryCount < 8 ? 1000 : 2500);
      return () => window.clearTimeout(timer);
    }
    setReady(true);
  }, [projectError, project, refetchProject, startupRetryCount]);

  useSessionEvents(sse, route, setRoute);

  const nav = {
    toDashboard: () => { setRoute({ page: "dashboard" }); closeSidebar(); },
    toChat: () => { setRoute({ page: "chat" }); closeSidebar(); },
    toBook: (bookId: string) => { setRoute({ page: "book", bookId }); closeSidebar(); },
    toBookSettings: (bookId: string) => { setRoute({ page: "book-settings", bookId }); closeSidebar(); },
    toBookCreate: () => { setRoute({ page: "book-create" }); closeSidebar(); },
    toChapter: (bookId: string, chapterNumber: number) =>
      { setRoute({ page: "chapter", bookId, chapterNumber }); closeSidebar(); },
    toAnalytics: (bookId: string) => { setRoute({ page: "analytics", bookId }); closeSidebar(); },
    toServices: () => { setRoute({ page: "services" }); closeSidebar(); },
    toServiceDetail: (id: string) => { setRoute({ page: "service-detail", serviceId: id }); closeSidebar(); },
    toTruth: (bookId: string) => { setRoute({ page: "truth", bookId }); closeSidebar(); },
    toDaemon: () => { setRoute({ page: "daemon" }); closeSidebar(); },
    toLogs: () => { setRoute({ page: "logs" }); closeSidebar(); },
    toGenres: () => { setRoute({ page: "genres" }); closeSidebar(); },
    toStyle: () => { setRoute({ page: "style" }); closeSidebar(); },
    toImport: () => { setRoute({ page: "import" }); closeSidebar(); },
    toRadar: () => { setRoute({ page: "radar" }); closeSidebar(); },
    toDoctor: () => { setRoute({ page: "doctor" }); closeSidebar(); },
  };

  const activeBookId = deriveActiveBookId(route);
  const activePage =
    activeBookId
      ? `book:${activeBookId}`
      : route.page === "service-detail"
        ? "services"
        : route.page;

  if (!ready) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center px-6">
        <div className="max-w-sm text-center">
          <div className="mx-auto w-12 h-12 border-4 border-primary/20 border-t-primary rounded-full animate-spin" />
          <div className="mt-5 text-base font-semibold text-foreground">正在启动本机 Node 后端</div>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            首次打开需要解压并启动内置 Node.js 服务，请稍等。
            {startupRetryCount > 0 ? ` 已检测 ${startupRetryCount} 次。` : ""}
          </p>
        </div>
      </div>
    );
  }

  if (projectError) {
    return (
      <div className="min-h-screen claude-surface text-foreground flex items-center justify-center px-6 font-sans">
        <div className="max-w-md rounded-3xl border border-destructive/20 bg-card/85 p-6 shadow-xl shadow-primary/5">
          <div className="text-sm font-semibold text-destructive">Studio 暂时连不上后端</div>
          <p className="mt-3 text-sm leading-7 text-muted-foreground">{projectError}</p>
          <button
            onClick={async () => {
              await ensureEmbeddedNodeRunning();
              setReady(false);
              refetchProject();
            }}
            className="mt-5 rounded-full bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
          >
            重试
          </button>
        </div>
      </div>
    );
  }

  if (showLanguageSelector) {
    return (
      <LanguageSelector
        onSelect={async (lang) => {
          await postApi("/project/language", { language: lang });
          setShowLanguageSelector(false);
          refetchProject();
        }}
      />
    );
  }

  return (
    <AppDialogProvider>
    <div className="h-[100dvh] claude-surface text-foreground flex overflow-hidden font-sans">
      {/* Left Sidebar — hidden on mobile, shown as overlay when toggled */}
      <div className="hidden md:block h-full">
        <Sidebar nav={nav} activePage={activePage} sse={sse} t={t} />
      </div>
      <Sidebar nav={nav} activePage={activePage} sse={sse} t={t} onClose={closeSidebar} mobileOpen={sidebarOpen} />

      {/* Center Content */}
      <div className="flex-1 flex flex-col min-w-0 bg-background/20">
        {/* Header Strip */}
        <header className="relative z-40 min-h-13 sm:min-h-16 shrink-0 flex items-center gap-1.5 overflow-visible px-2 sm:gap-2 sm:px-4 md:px-8 border-b border-border/45 claude-topbar shadow-sm shadow-primary/5 mobile-safe-top">
          <div className="flex shrink-0 items-center gap-1 sm:gap-2">
             <button
               onClick={() => setSidebarOpen(true)}
               className="md:hidden flex h-[2.05rem] w-[2.05rem] shrink-0 touch-manipulation items-center justify-center rounded-2xl text-muted-foreground hover:bg-secondary/80 hover:text-foreground transition-colors sm:h-10 sm:w-10"
               aria-label="打开导航"
             >
               <Menu size={17} />
             </button>
             <button
               onClick={nav.toDashboard}
               className="soft-pill inline-flex h-10 w-10 shrink-0 touch-manipulation items-center justify-center gap-2 rounded-full px-0 text-sm font-medium text-foreground transition-colors hover:border-primary/40 sm:w-auto sm:max-w-none sm:justify-start sm:px-3.5"
             >
               <House size={14} />
               <span className="hidden sm:inline">首页</span>
               <span className="hidden sm:inline text-muted-foreground/70">/</span>
               <span className="hidden truncate font-serif sm:inline">InkOS Studio</span>
             </button>
          </div>

          <div className="flex min-w-0 flex-1 items-center justify-end gap-1 overflow-visible pl-0 pr-0 sm:gap-3">
            <RuntimeStatusButton />
            <TokenDiagnosticsButton />
            <LocalStorageButton />
            <div className="soft-pill flex h-10 shrink-0 gap-0 rounded-full p-0.5">
              <button
                onClick={async () => {
                  publishLanguageChange("zh");
                  await putApi("/project", { language: "zh" });
                  refetchProject();
                }}
                className={`min-h-9 min-w-8 touch-manipulation rounded-full px-1.5 text-xs transition-colors sm:min-h-8 sm:min-w-8 sm:px-2.5 ${currentLang === "zh" ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
              >
                中
              </button>
              <button
                onClick={async () => {
                  publishLanguageChange("en");
                  await putApi("/project", { language: "en" });
                  refetchProject();
                }}
                className={`min-h-9 min-w-8 touch-manipulation rounded-full px-1.5 text-xs transition-colors sm:min-h-8 sm:min-w-8 sm:px-2.5 ${currentLang === "en" ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
              >
                EN
              </button>
            </div>

            <button
              onClick={() => setTheme(isDark ? "light" : "dark")}
              className="soft-pill flex h-10 w-10 shrink-0 touch-manipulation items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground"
              aria-label={isDark ? "切换到亮色模式" : "切换到暗色模式"}
            >
              {isDark ? <Sun size={14} /> : <Moon size={14} />}
            </button>
          </div>
        </header>

        {/* Main Content Area */}
        <main className="mobile-scroll-area mobile-safe-bottom flex-1 relative overflow-y-auto scroll-smooth">
          {route.page === "dashboard" && (
            <div className="max-w-6xl mx-auto px-3 py-4 sm:px-4 sm:py-6 md:px-10 md:py-10 lg:py-12 fade-in">
              <Dashboard nav={nav} sse={sse} theme={theme} t={t} />
            </div>
          )}
          {isBookCreateChatRoute(route) && (
            <div className="absolute inset-0 flex min-w-0">
              <ChatPage
                mode="book-create"
                nav={nav}
                theme={theme}
                t={t}
                sse={sse}
              />
            </div>
          )}
          {route.page === "chat" && (
            <div className="absolute inset-0 flex min-w-0">
              <ChatPage
                mode="project-chat"
                nav={nav}
                theme={theme}
                t={t}
                sse={sse}
              />
            </div>
          )}
          {route.page === "book" && (
            <div className="absolute inset-0 flex min-w-0">
              <ChatPage
                activeBookId={route.bookId}
                mode="book"
                nav={nav}
                theme={theme}
                t={t}
                sse={sse}
              />
              <BookSidebar bookId={route.bookId} theme={theme} t={t} sse={sse} />
              <BookSidebarToggle bookId={route.bookId} theme={theme} t={t} sse={sse} />
            </div>
          )}
          {route.page === "book-settings" && (
            <div className="max-w-6xl mx-auto px-4 py-6 md:px-10 md:py-10 lg:py-12 fade-in">
              <BookDetail bookId={route.bookId} nav={nav} theme={theme} t={t} sse={sse} />
            </div>
          )}
          {route.page === "chapter" && (
            <div className="max-w-6xl mx-auto px-4 py-6 md:px-10 md:py-10 lg:py-12 fade-in">
              <ChapterReader bookId={route.bookId} chapterNumber={route.chapterNumber} nav={nav} theme={theme} t={t} />
            </div>
          )}
          {route.page === "analytics" && (
            <div className="max-w-6xl mx-auto px-4 py-6 md:px-10 md:py-10 lg:py-12 fade-in">
              <Analytics bookId={route.bookId} nav={nav} theme={theme} t={t} />
            </div>
          )}
          {route.page === "services" && (
            <div className="max-w-6xl mx-auto px-4 py-6 md:px-10 md:py-10 lg:py-12 fade-in">
              <ServiceListPage nav={nav} />
            </div>
          )}
          {route.page === "service-detail" && (
            <div className="max-w-6xl mx-auto px-4 py-6 md:px-10 md:py-10 lg:py-12 fade-in">
              <ServiceDetailPage serviceId={route.serviceId} nav={nav} />
            </div>
          )}
          {route.page === "truth" && (
            <div className="max-w-6xl mx-auto px-4 py-6 md:px-10 md:py-10 lg:py-12 fade-in">
              <TruthFiles bookId={route.bookId} nav={nav} theme={theme} t={t} />
            </div>
          )}
          {route.page === "daemon" && (
            <div className="max-w-6xl mx-auto px-4 py-6 md:px-10 md:py-10 lg:py-12 fade-in">
              <DaemonControl nav={nav} theme={theme} t={t} sse={sse} />
            </div>
          )}
          {route.page === "logs" && (
            <div className="max-w-6xl mx-auto px-4 py-6 md:px-10 md:py-10 lg:py-12 fade-in">
              <LogViewer nav={nav} theme={theme} t={t} sse={sse} />
            </div>
          )}
          {route.page === "genres" && (
            <div className="max-w-6xl mx-auto px-4 py-6 md:px-10 md:py-10 lg:py-12 fade-in">
              <GenreManager nav={nav} theme={theme} t={t} />
            </div>
          )}
          {route.page === "style" && (
            <div className="max-w-6xl mx-auto px-4 py-6 md:px-10 md:py-10 lg:py-12 fade-in">
              <StyleManager nav={nav} theme={theme} t={t} />
            </div>
          )}
          {route.page === "import" && (
            <div className="max-w-6xl mx-auto px-4 py-6 md:px-10 md:py-10 lg:py-12 fade-in">
              <ImportManager nav={nav} theme={theme} t={t} />
            </div>
          )}
          {route.page === "radar" && (
            <div className="max-w-6xl mx-auto px-4 py-6 md:px-10 md:py-10 lg:py-12 fade-in">
              <RadarView nav={nav} theme={theme} t={t} />
            </div>
          )}
          {route.page === "doctor" && (
            <div className="max-w-6xl mx-auto px-4 py-6 md:px-10 md:py-10 lg:py-12 fade-in">
              <DoctorView nav={nav} theme={theme} t={t} />
            </div>
          )}
        </main>
      </div>
    </div>
    </AppDialogProvider>
  );
}
