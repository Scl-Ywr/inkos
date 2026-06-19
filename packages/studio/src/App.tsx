import { useState, useEffect, useMemo, useCallback, Suspense, lazy } from "react";
import { createPortal } from "react-dom";
import { Directory, Encoding, Filesystem } from "@capacitor/filesystem";
import { useHashRoute } from "./hooks/use-hash-route";
import type { HashRoute } from "./hooks/use-hash-route";
import { Sidebar } from "./components/Sidebar";

const Dashboard       = lazy(() => import("./pages/Dashboard").then(m => ({ default: m.Dashboard })));
const ChatPage        = lazy(() => import("./pages/ChatPage").then(m => ({ default: m.ChatPage })));
const BookDetail      = lazy(() => import("./pages/BookDetail").then(m => ({ default: m.BookDetail })));
const ChapterReader   = lazy(() => import("./pages/ChapterReader").then(m => ({ default: m.ChapterReader })));
const Analytics       = lazy(() => import("./pages/Analytics").then(m => ({ default: m.Analytics })));
const ServiceListPage = lazy(() => import("./pages/ServiceListPage").then(m => ({ default: m.ServiceListPage })));
const ServiceDetailPage = lazy(() => import("./pages/ServiceDetailPage").then(m => ({ default: m.ServiceDetailPage })));
const ProjectSettings = lazy(() => import("./pages/ProjectSettings").then(m => ({ default: m.ProjectSettings })));
const TruthFiles      = lazy(() => import("./pages/TruthFiles").then(m => ({ default: m.TruthFiles })));
const DaemonControl   = lazy(() => import("./pages/DaemonControl").then(m => ({ default: m.DaemonControl })));
const LogViewer       = lazy(() => import("./pages/LogViewer").then(m => ({ default: m.LogViewer })));
const GenreManager    = lazy(() => import("./pages/GenreManager").then(m => ({ default: m.GenreManager })));
const StyleManager    = lazy(() => import("./pages/StyleManager").then(m => ({ default: m.StyleManager })));
const ImportManager   = lazy(() => import("./pages/ImportManager").then(m => ({ default: m.ImportManager })));
const ImageLibraryPage = lazy(() => import("./pages/ImageLibraryPage").then(m => ({ default: m.ImageLibraryPage })));
const ImageGenPage    = lazy(() => import("./pages/ImageGenPage").then(m => ({ default: m.ImageGenPage })));
const KnowledgePage   = lazy(() => import("./pages/KnowledgePage").then(m => ({ default: m.KnowledgePage })));
const TimelinePage    = lazy(() => import("./pages/TimelinePage").then(m => ({ default: m.TimelinePage })));
const SchedulePage    = lazy(() => import("./pages/SchedulePage").then(m => ({ default: m.SchedulePage })));
const CharacterGraphPage = lazy(() => import("./pages/CharacterGraphPage").then(m => ({ default: m.CharacterGraphPage })));
const WorldSettingsPage  = lazy(() => import("./pages/WorldSettingsPage").then(m => ({ default: m.WorldSettingsPage })));
const ForeshadowingPage  = lazy(() => import("./pages/ForeshadowingPage").then(m => ({ default: m.ForeshadowingPage })));
const EndingsPage     = lazy(() => import("./pages/EndingsPage").then(m => ({ default: m.EndingsPage })));
const RadarView       = lazy(() => import("./pages/RadarView").then(m => ({ default: m.RadarView })));
const DoctorView      = lazy(() => import("./pages/DoctorView").then(m => ({ default: m.DoctorView })));
const LanguageSelector = lazy(() => import("./pages/LanguageSelector").then(m => ({ default: m.LanguageSelector })));

function PageLoading() {
  return (
    <div className="flex h-full w-full items-center justify-center p-8">
      <div className="h-8 w-8 rounded-full border-[3px] border-primary/20 border-t-primary animate-spin" />
    </div>
  );
}
import { BookSidebar, BookSidebarToggle } from "./components/chat/BookSidebar";
import { useSSE } from "./hooks/use-sse";
import { useSessionEvents } from "./hooks/use-session-events";
import { useTheme } from "./hooks/use-theme";
import { useStyle } from "./hooks/use-style";
import { StylePanel } from "./components/StylePanel";
import { publishLanguageChange, useI18n } from "./hooks/use-i18n";
import { fetchJson, postApi, putApi, useApi } from "./hooks/use-api";
import { buildApiUrl } from "./lib/api-url";
import { AppDialogProvider, appAlert } from "./lib/app-dialog";
import {
  ensureEmbeddedNodeRunning,
  requestBatteryOptimizationExemption,
  resetEmbeddedNodeRuntime,
  updateAndroidTaskNotification,
  checkNodeStatusFromNative,
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
  Radio,
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

export function normalizeAndroidFileText(data: string): string {
  const text = data.trim();
  if (!text) return data;
  if (text.startsWith("{") || text.startsWith("[") || /\s/.test(text)) return data;
  if (text.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(text)) return data;

  try {
    const binary = atob(text);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  } catch {
    return data;
  }
}

export function parseAndroidRuntimeStatus(text: string): AndroidRuntimeFileStatus {
  try {
    return JSON.parse(normalizeAndroidFileText(text)) as AndroidRuntimeFileStatus;
  } catch {
    const normalizedText = normalizeAndroidFileText(text);
    const jsonBlocks = normalizedText.match(/\{[\s\S]*\}/g) ?? [];
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
      readonly state: "disabled" | "idle" | "connecting" | "online" | "offline";
      readonly mode: "external-mcp" | "bundled";
      readonly command: string;
      readonly args: readonly string[];
      readonly tools: readonly string[];
      readonly lastCheckedAt: string | null;
      readonly lastCompressionOk: boolean | null;
      readonly lastCompressionAt: string | null;
      readonly lastError: string | null;
      readonly stats: {
        readonly compressions?: number;
        readonly retrievals?: number;
        readonly tokens_saved?: number;
        readonly savings_percent?: number;
        readonly estimated_cost_saved_usd?: number;
      } | null;
      readonly session: {
        readonly compressions: number;
        readonly originalTokens: number;
        readonly compressedTokens: number;
        readonly tokensSaved: number;
        readonly originalChars: number;
        readonly compressedChars: number;
      };
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

interface PythonRuntimePayload {
  readonly ok: boolean;
  readonly python: {
    readonly available: boolean;
    readonly command: string | null;
    readonly version: string | null;
    readonly platform: string;
    readonly arch: string;
    readonly android: boolean;
    readonly lastError: string | null;
    readonly capabilities: readonly string[];
  };
}

interface RepairPlanItem {
  readonly action: string;
  readonly title: string;
  readonly detail: string;
  readonly count: number;
  readonly bytes: number;
  readonly enabled: boolean;
  readonly severity: "info" | "warning" | "danger";
}

interface RepairPlanPayload {
  readonly ok: boolean;
  readonly root?: string;
  readonly actions?: readonly RepairPlanItem[];
}

interface RepairExecuteResult {
  readonly ok: boolean;
  readonly root?: string;
  readonly actions?: readonly string[];
  readonly results?: ReadonlyArray<{
    readonly action: string;
    readonly changed: number;
    readonly bytes: number;
    readonly message: string;
  }>;
}

interface MaintenanceScanPayload {
  readonly ok: boolean;
  readonly method?: string;
  readonly error?: string;
  readonly python?: PythonRuntimePayload["python"];
  readonly summary: {
    readonly root: string;
    readonly totalFiles: number;
    readonly totalBytes: number;
    readonly durationMs: number;
    readonly issueCount: number;
    readonly scannedAt: number;
  };
  readonly sections: Record<string, {
    readonly name: string;
    readonly path: string;
    readonly exists: boolean;
    readonly fileCount: number;
    readonly dirCount: number;
    readonly totalBytes: number;
    readonly largestFiles?: ReadonlyArray<{ readonly path: string; readonly bytes: number }>;
    readonly invalidFiles?: readonly unknown[];
    readonly candidateCleanupFiles?: ReadonlyArray<{ readonly path: string; readonly bytes: number }>;
    readonly knowledge?: {
      readonly libraryCount: number;
      readonly sourceCount: number;
      readonly chunkCount: number;
      readonly missingSearchIndexes: readonly string[];
      readonly sourceChunkMismatches: readonly unknown[];
    };
  }>;
  readonly duplicates?: readonly unknown[];
  readonly issues: ReadonlyArray<{
    readonly severity: "info" | "warning" | "danger";
    readonly category: string;
    readonly path: string;
    readonly message: string;
  }>;
  readonly recommendations: ReadonlyArray<{
    readonly title: string;
    readonly detail: string;
    readonly severity: "info" | "warning" | "danger";
  }>;
}

async function readAndroidTextFile(path: string): Promise<string | null> {
  if (!isNativeRuntime()) return null;
  try {
    // GeckoView may not connect the Capacitor bridge properly, causing
    // Filesystem.readFile() to hang forever. Use a hard timeout to prevent
    // the entire refresh cycle from blocking.
    const result = await Promise.race([
      Filesystem.readFile({
        path,
        directory: Directory.Data,
        encoding: Encoding.UTF8,
      }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 2000)),
    ]);
    if (!result) return null;
    if (typeof result.data === "string") return normalizeAndroidFileText(result.data);
    return normalizeAndroidFileText(await result.data.text());
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
      node: { state: "checking", message: "正在检测内置 Node..." },
      localTools: { state: "checking", implemented: 0, total: 0, message: "正在检测本地工具..." },
      storage: { state: "checking", path: null, message: "正在检测本地保存..." },
    });

    const next: RuntimeStatus = {
      node: { state: "offline", message: "Node API 未响应。当前 APK 已禁用 JS fallback，必须等待内置 Node 后端启动成功。" },
      localTools: { state: "unavailable", implemented: 0, total: 0, message: "本地工具状态未知。" },
      storage: { state: "unavailable", path: null, message: "本地保存状态未知。" },
    };

    // 1) Check Node status via Java-side /api/health (no Node proxy, no Capacitor bridge).
    //    LocalAssetServer reads runtime-status.json directly in Java and returns JSON.
    try {
      const healthUrl = buildApiUrl("/health");
      if (healthUrl) {
        const controller = new AbortController();
        const timeout = window.setTimeout(() => controller.abort(), 3000);
        const healthRes = await fetch(healthUrl, { signal: controller.signal, cache: "no-store" });
        window.clearTimeout(timeout);
        if (healthRes.ok) {
          const body = await healthRes.json() as { ok?: boolean; state?: string };
          if (body.ok || body.state === "running") {
            next.node = { state: "running", message: "Node 后端运行中。" };
          }
        }
      }
    } catch {
      // Java health check failed — fall through to HTTP probe.
    }

    // 2) Try HTTP probe via proxy — may confirm or override the native state.
    try {
      const url = buildApiUrl("/project");
      if (url) {
        const controller = new AbortController();
        const timeout = window.setTimeout(() => controller.abort(), 1800);
        const response = await fetch(url, { signal: controller.signal, cache: "no-store" });
        window.clearTimeout(timeout);
        if (response.ok) {
          next.node = { state: "running", message: "Node API 已启动并响应。" };
        } else if (next.node.state !== "running") {
          next.node = { state: "offline", message: `Node API 返回 HTTP ${response.status}。` };
        }
      }
    } catch {
      // Fetch failed — health check from step 1 already determines the result.
    }

    // 3) Also try the /runtime/status endpoint for extra detail.
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
      if (nativeState === "running") {
        next.node = { ...next.node, state: "running" };
      }
    } catch {
      // /runtime/status fetch also failed — use whatever state we already have.
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
    // Node service starts 1.5s after Activity launch and takes a few more seconds to become ready.
    // Auto-retry so the status updates without requiring the user to manually click refresh.
    const t1 = window.setTimeout(() => void refresh(), 3500);
    const t2 = window.setTimeout(() => void refresh(), 9000);
    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
    };
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
    try {
      setActionStatus("正在打开后台保活权限设置...");
      const ok = await requestBatteryOptimizationExemption();
      if (ok) {
        setActionStatus("请在系统弹窗或设置页允许 InkOS 保持后台运行。");
      } else {
        setActionStatus("");
        await appAlert({ title: "无法打开", message: "无法自动打开权限页面。请手动进入系统设置 → 电池 → 后台耗电管理，找到 InkOS 并允许后台运行。" });
      }
    } catch (error) {
      setActionStatus("");
      await appAlert({ title: "操作失败", message: `打开后台权限设置失败：${error instanceof Error ? error.message : "未知错误"}。请手动在系统设置中关闭本应用的电池优化。` });
    }
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

function RuntimeStatusRow({ icon, title, tone, message, details }: {
  icon: React.ReactNode;
  title: string;
  tone: "ok" | "warn" | "wait";
  message?: string;
  details?: ReadonlyArray<{ label: string; value: string }>;
}) {
  const prioritizeDetails = title === "Headroom MCP" && Boolean(details?.length);
  const toneClass =
    tone === "ok"
      ? "bg-emerald-500/12 text-emerald-500"
      : tone === "warn"
        ? "bg-amber-500/12 text-amber-500"
        : "bg-secondary text-muted-foreground";
  return (
    <section className="rounded-2xl border border-border/55 bg-background/45 p-4">
      <div className="flex items-start gap-3">
        <span className={`flex h-9 w-9 items-center justify-center rounded-full ${toneClass}`}>{icon}</span>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-foreground">{title}</div>
          {message && !prioritizeDetails ? <p className="mt-1 break-words text-xs leading-5 text-muted-foreground">{message}</p> : null}
          {details && details.length > 0 ? (
            <dl className="mt-3 grid gap-2 sm:grid-cols-2">
              {details.map((detail) => (
                <div key={`${title}-${detail.label}`} className="rounded-xl border border-border/45 bg-card/55 px-3 py-2">
                  <dt className="text-[11px] font-medium text-muted-foreground/80">{detail.label}</dt>
                  <dd className="mt-1 break-words text-xs leading-5 text-foreground">{detail.value}</dd>
                </div>
              ))}
            </dl>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function TokenDiagnosticsButton() {
  const [open, setOpen] = useState(false);
  const [diagnostics, setDiagnostics] = useState<TokenDiagnosticsPayload | null>(null);
  const [nodeInfo, setNodeInfo] = useState<RuntimeNodeInfoPayload | null>(null);
  const [pythonInfo, setPythonInfo] = useState<PythonRuntimePayload["python"] | null>(null);
  const [maintenanceReport, setMaintenanceReport] = useState<MaintenanceScanPayload | null>(null);
  const [maintenanceLoading, setMaintenanceLoading] = useState(false);
  const [repairPlan, setRepairPlan] = useState<RepairPlanPayload | null>(null);
  const [repairPlanLoading, setRepairPlanLoading] = useState(false);
  const [repairExecuting, setRepairExecuting] = useState(false);
  const [selectedActions, setSelectedActions] = useState<Set<string>>(new Set());
  const [runtimeStatus, setRuntimeStatus] = useState<AndroidRuntimeFileStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [actionStatus, setActionStatus] = useState("");

  const refresh = async () => {
    setLoading(true);
    setActionStatus("");
    const [tokenPayload, runtimeNodeInfo, pythonRuntimeInfo, androidDiagnostics] = await Promise.all([
      fetchJson<TokenDiagnosticsPayload>("/token-diagnostics").catch(() => null),
      fetchJson<RuntimeNodeInfoPayload>("/runtime/node-info").catch(() => null),
      fetchJson<PythonRuntimePayload>("/runtime/python").catch(() => null),
      readAndroidRuntimeDiagnostics().catch(() => ({ status: null, output: null })),
    ]);
    setDiagnostics(tokenPayload);
    setNodeInfo(runtimeNodeInfo);
    setPythonInfo(pythonRuntimeInfo?.python ?? null);
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

  const checkHeadroom = async () => {
    setActionStatus("正在执行 Headroom 压缩自检...");
    try {
      const result = await postApi<{
        ok: boolean;
        headroom?: TokenDiagnosticsPayload["diagnostics"]["headroom"];
        result?: { originalTokens?: number; compressedTokens?: number; savingsPercent?: number };
      }>("/token-diagnostics/headroom/self-test");
      const session = result.headroom?.session;
      const saved = session?.tokensSaved ?? Math.max(0, (result.result?.originalTokens ?? 0) - (result.result?.compressedTokens ?? 0));
      setActionStatus(result.ok
        ? `Headroom 压缩自检成功：累计压缩 ${session?.compressions ?? 1} 块，估算节省 ${saved.toLocaleString()} tokens。`
        : "Headroom 压缩自检未通过。");
    } catch (error) {
      setActionStatus(`Headroom 压缩自检失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      await refresh();
    }
  };

  const checkPython = async () => {
    setActionStatus("正在执行内置 Python 自检...");
    try {
      const result = await fetchJson<{
        ok: boolean;
        python?: PythonRuntimePayload["python"];
        extraction?: {
          readonly ok?: boolean;
          readonly method?: string;
          readonly text?: string;
          readonly warnings?: readonly string[];
        };
      }>("/runtime/python/self-test", { method: "POST" });
      const python = result.python;
      const extraction = result.extraction;
      setPythonInfo(python ?? null);
      setActionStatus(result.ok && extraction?.ok
        ? `Python 自检成功：${python?.command ?? "embedded-python"} · ${python?.version ?? "runtime ready"} · ${extraction.method ?? "extract"}`
        : `Python 自检未通过：${python?.lastError ?? extraction?.warnings?.join("；") ?? "未知错误"}`);
    } catch (error) {
      setActionStatus(`Python 自检失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      await refresh();
    }
  };

  const runProjectHealthScan = async () => {
    setMaintenanceLoading(true);
    setActionStatus("正在执行 Python 项目体检...");
    try {
      const result = await fetchJson<MaintenanceScanPayload>("/runtime/maintenance/scan");
      setMaintenanceReport(result);
      if (result.python) setPythonInfo(result.python);
      setActionStatus(result.ok
        ? `项目体检完成：扫描 ${result.summary.totalFiles.toLocaleString()} 个文件，发现 ${result.summary.issueCount} 个提示。`
        : `项目体检未完成：${result.error ?? "Python 维护扫描不可用"}`);
    } catch (error) {
      setActionStatus(`项目体检失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setMaintenanceLoading(false);
    }
  };

  const loadRepairPlan = async () => {
    setRepairPlanLoading(true);
    try {
      const plan = await fetchJson<RepairPlanPayload>("/runtime/maintenance/repair-plan");
      setRepairPlan(plan);
      if (plan.actions) {
        setSelectedActions(new Set(plan.actions.filter((item) => item.enabled).map((item) => item.action)));
      }
      setActionStatus(plan.ok && plan.actions
        ? `修复计划已加载：${plan.actions.filter((item) => item.enabled).length} 项可操作。`
        : "修复计划为空。");
    } catch (error) {
      setActionStatus(`加载修复计划失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setRepairPlanLoading(false);
    }
  };

  const executeRepair = async () => {
    if (selectedActions.size === 0) {
      setActionStatus("请至少勾选一项修复操作。");
      return;
    }
    setRepairExecuting(true);
    try {
      const result = await fetchJson<RepairExecuteResult>("/runtime/maintenance/repair", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: true, actions: [...selectedActions] }),
      });
      if (result.ok && result.results) {
        const summary = result.results
          .map((item) => `${item.action}：已处理 ${item.changed} 项${item.bytes > 0 ? `，释放 ${formatBytes(item.bytes)}` : ""}`)
          .join("；");
        setActionStatus(`修复完成：${summary}`);
        await loadRepairPlan();
        if (maintenanceReport) await runProjectHealthScan();
      } else {
        setActionStatus("修复未返回有效结果。");
      }
    } catch (error) {
      setActionStatus(`修复执行失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setRepairExecuting(false);
    }
  };

  const toggleAction = (action: string) => {
    setSelectedActions((prev) => {
      const next = new Set(prev);
      if (next.has(action)) {
        next.delete(action);
      } else {
        next.add(action);
      }
      return next;
    });
  };

  const maintenanceSections = maintenanceReport
    ? Object.entries(maintenanceReport.sections)
      .map(([key, section]) => ({ key, ...section }))
      .sort((a, b) => b.totalBytes - a.totalBytes)
    : [];
  const maintenanceLargestFiles = maintenanceSections
    .flatMap((section) => (section.largestFiles ?? []).map((file) => ({ ...file, section: section.key })))
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, 8);
  const maintenanceInvalidFiles = maintenanceSections
    .flatMap((section) => (section.invalidFiles ?? []).map((file) => ({ section: section.key, file })))
    .slice(0, 8);

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
                  icon={<Radio size={16} />}
                  title="Headroom MCP"
                  tone={data.headroom.state === "online" ? "ok" : data.headroom.state === "idle" || data.headroom.state === "connecting" ? "wait" : "warn"}
                  message={[
                    data.headroom.state === "online"
                      ? data.headroom.mode === "bundled" ? "手机端内置 Headroom-compatible 压缩已启用" : "官方 MCP 在线"
                      : data.headroom.state === "connecting"
                        ? "连接中"
                        : data.headroom.state === "idle"
                          ? "等待检查"
                          : data.headroom.state === "disabled"
                            ? "已禁用"
                            : "离线，使用 InkOS 本地压缩",
                    data.headroom.mode === "external-mcp" && data.headroom.configured
                      ? `命令：${data.headroom.command} ${data.headroom.args.join(" ")}`
                      : data.headroom.mode === "bundled"
                        ? "随 APK 内置，无需用户安装 Python 或 headroom 命令"
                        : "未配置启动命令",
                    data.headroom.tools.length > 0 ? `工具：${data.headroom.tools.join(" / ")}` : "",
                    data.headroom.stats?.tokens_saved !== undefined
                      ? `官方累计节省 ${data.headroom.stats.tokens_saved.toLocaleString()} tokens`
                      : "",
                    data.headroom.session.compressions === 0
                      ? "本次 Node 启动后还没有触发 Headroom 压缩；点击下方压缩自检可立即验证。"
                      : "",
                    data.headroom.lastCompressionOk === true
                      ? `本次运行已压缩 ${data.headroom.session.compressions} 块，节省 ${data.headroom.session.tokensSaved.toLocaleString()} tokens`
                      : "",
                    data.headroom.lastError ? `最近错误：${data.headroom.lastError}` : "",
                  ].filter(Boolean).join(" ")}
                  details={[
                    {
                      label: "模式",
                      value: data.headroom.mode === "bundled" ? "Bundled（APK 内置）" : "External MCP",
                    },
                    {
                      label: "连接状态",
                      value: data.headroom.state === "online"
                        ? "在线"
                        : data.headroom.state === "connecting"
                          ? "连接中"
                          : data.headroom.state === "idle"
                            ? "待检查"
                            : data.headroom.state === "disabled"
                              ? "已禁用"
                              : "离线（已回退本地压缩）",
                    },
                    {
                      label: "本次会话压缩",
                      value: data.headroom.session.compressions > 0
                        ? `${data.headroom.session.compressions} 次，节省 ${data.headroom.session.tokensSaved.toLocaleString()} tokens`
                        : "0 次（尚未触发）",
                    },
                    {
                      label: "最近一次结果",
                      value: data.headroom.lastCompressionOk === true
                        ? `成功${data.headroom.lastCompressionAt ? ` · ${new Date(data.headroom.lastCompressionAt).toLocaleString()}` : ""}`
                        : data.headroom.lastCompressionOk === false
                          ? `失败${data.headroom.lastError ? ` · ${data.headroom.lastError}` : ""}`
                          : "暂无记录",
                    },
                    {
                      label: "累计节省",
                      value: data.headroom.stats?.tokens_saved !== undefined
                        ? `${data.headroom.stats.tokens_saved.toLocaleString()} tokens`
                        : "暂无统计",
                    },
                    {
                      label: data.headroom.mode === "external-mcp" ? "启动命令" : "运行来源",
                      value: data.headroom.mode === "external-mcp" && data.headroom.configured
                        ? `${data.headroom.command} ${data.headroom.args.join(" ")}`
                        : data.headroom.mode === "bundled"
                          ? "随 APK 内置，无需单独安装"
                          : "尚未配置启动命令",
                    },
                    ...(data.headroom.tools.length > 0
                      ? [{ label: "可用工具", value: data.headroom.tools.join(" / ") }]
                      : []),
                  ]}
                />
                <RuntimeStatusRow
                  icon={<Cpu size={16} />}
                  title="内置 Python"
                  tone={pythonInfo?.available ? "ok" : pythonInfo ? "warn" : "wait"}
                  message={pythonInfo
                    ? [
                        pythonInfo.available ? "可用" : "不可用",
                        pythonInfo.command ? `运行时：${pythonInfo.command}` : "",
                        pythonInfo.version ? `版本：${pythonInfo.version}` : "",
                        pythonInfo.android ? "Android APK 内置桥接" : "桌面/系统 Python",
                        pythonInfo.capabilities.length ? `能力：${pythonInfo.capabilities.join(" / ")}` : "",
                        pythonInfo.lastError ? `最近错误：${pythonInfo.lastError}` : "",
                      ].filter(Boolean).join(" · ")
                    : "还未检测到 Python 状态，点击刷新或 Python 自检。"}
                />
                <RuntimeStatusRow
                  icon={<Activity size={16} />}
                  title="上下文压缩"
                  tone={data.telemetry.ccrBlocksCompressed > 0 ? "ok" : "wait"}
                  message={data.telemetry.ccrBlocksCompressed > 0
                    ? `压缩块 ${data.telemetry.ccrBlocksCompressed} 个，估算节省 ${data.telemetry.estimatedTokensSaved.toLocaleString()} tokens，字符 ${data.telemetry.originalChars.toLocaleString()} -> ${data.telemetry.optimizedChars.toLocaleString()}。`
                    : "本次 Node 启动后还没有上下文进入 Headroom 压缩。长 truth 文件、超预算书籍上下文，或点击压缩自检后会出现统计。"}
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
                {maintenanceReport ? (
                  <section className="rounded-2xl border border-border/55 bg-background/45 p-4">
                    <div className="flex items-start gap-3">
                      <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${maintenanceReport.ok ? "bg-emerald-500/12 text-emerald-500" : "bg-amber-500/12 text-amber-500"}`}>
                        <ShieldCheck size={16} />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-semibold text-foreground">项目体检中心</div>
                        <p className="mt-1 text-xs leading-5 text-muted-foreground">
                          {maintenanceReport.ok
                            ? `扫描 ${maintenanceReport.summary.totalFiles.toLocaleString()} 个文件，${formatBytes(maintenanceReport.summary.totalBytes)}，耗时 ${maintenanceReport.summary.durationMs}ms，发现 ${maintenanceReport.summary.issueCount} 个提示。`
                            : `体检不可用：${maintenanceReport.error ?? "Python 维护扫描未返回结果"}`}
                        </p>
                        <div className="mt-3 grid grid-cols-2 gap-2 text-xs sm:grid-cols-3">
                          {maintenanceSections.slice(0, 6).map((section) => (
                            <div key={section.key} className="rounded-xl border border-border/35 bg-card/60 px-3 py-2">
                              <div className="font-semibold text-foreground">{section.key}</div>
                              <div className="mt-1 text-muted-foreground">{section.fileCount} files · {formatBytes(section.totalBytes)}</div>
                            </div>
                          ))}
                        </div>
                        {maintenanceReport.sections.knowledge?.knowledge ? (
                          <p className="mt-3 rounded-xl border border-border/35 bg-card/55 px-3 py-2 text-xs leading-5 text-muted-foreground">
                            知识库：{maintenanceReport.sections.knowledge.knowledge.libraryCount} 个库，
                            {maintenanceReport.sections.knowledge.knowledge.sourceCount} 个资料，
                            {maintenanceReport.sections.knowledge.knowledge.chunkCount} 个分块；
                            缺失索引 {maintenanceReport.sections.knowledge.knowledge.missingSearchIndexes.length}，
                            分块不一致 {maintenanceReport.sections.knowledge.knowledge.sourceChunkMismatches.length}。
                          </p>
                        ) : null}
                        {maintenanceLargestFiles.length > 0 ? (
                          <div className="mt-3">
                            <div className="text-xs font-semibold text-foreground">大文件</div>
                            <div className="mt-1 space-y-1">
                              {maintenanceLargestFiles.map((file) => (
                                <div key={`${file.section}:${file.path}`} className="truncate rounded-lg bg-secondary/35 px-2 py-1 text-xs text-muted-foreground">
                                  {file.path} · {formatBytes(file.bytes)}
                                </div>
                              ))}
                            </div>
                          </div>
                        ) : null}
                        {maintenanceInvalidFiles.length > 0 ? (
                          <div className="mt-3">
                            <div className="text-xs font-semibold text-foreground">异常文件</div>
                            <div className="mt-1 space-y-1">
                              {maintenanceInvalidFiles.map((item, index) => (
                                <div key={`${item.section}:${index}`} className="rounded-lg bg-destructive/8 px-2 py-1 text-xs leading-5 text-muted-foreground">
                                  {typeof item.file === "object" && item.file && "path" in item.file ? String((item.file as { path?: unknown }).path) : JSON.stringify(item.file).slice(0, 120)}
                                </div>
                              ))}
                            </div>
                          </div>
                        ) : null}
                        {maintenanceReport.issues.length > 0 ? (
                          <div className="mt-3">
                            <div className="text-xs font-semibold text-foreground">提示</div>
                            <div className="mt-1 space-y-1">
                              {maintenanceReport.issues.slice(0, 8).map((issue, index) => (
                                <div key={`${issue.category}:${issue.path}:${index}`} className="rounded-lg bg-secondary/35 px-2 py-1 text-xs leading-5 text-muted-foreground">
                                  [{issue.severity}] {issue.category} · {issue.path}: {issue.message}
                                </div>
                              ))}
                            </div>
                          </div>
                        ) : (
                          <p className="mt-3 rounded-xl bg-emerald-500/10 px-3 py-2 text-xs font-medium text-emerald-500">项目健康，未发现需要关注的问题。</p>
                        )}
                        {maintenanceReport.recommendations.length > 0 ? (
                          <div className="mt-3">
                            <div className="text-xs font-semibold text-foreground">建议</div>
                            <div className="mt-1 space-y-1">
                              {maintenanceReport.recommendations.map((item) => (
                                <div key={item.title} className="rounded-lg border border-border/35 bg-card/55 px-2 py-1 text-xs leading-5 text-muted-foreground">
                                  {item.title}：{item.detail}
                                </div>
                              ))}
                            </div>
                          </div>
                        ) : null}
                        <div className="mt-4 rounded-2xl border border-border/55 bg-background/45 p-4">
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2 text-xs font-semibold uppercase text-muted-foreground">
                              <Wrench size={14} />
                              手动确认修复
                            </div>
                            <button
                              type="button"
                              onClick={() => void loadRepairPlan()}
                              disabled={repairPlanLoading}
                              className="rounded-lg bg-primary/10 px-2.5 py-1 text-[11px] font-bold text-primary hover:bg-primary/15 transition-colors disabled:opacity-60"
                            >
                              {repairPlanLoading ? "加载中..." : "加载修复计划"}
                            </button>
                          </div>
                          {repairPlan && repairPlan.actions ? (
                            <>
                              <div className="mt-3 space-y-2">
                                {repairPlan.actions.map((item) => (
                                  <label
                                    key={item.action}
                                    className={`flex items-start gap-3 rounded-xl border px-3 py-2.5 cursor-pointer transition-colors ${
                                      item.enabled
                                        ? selectedActions.has(item.action)
                                          ? "border-primary/40 bg-primary/[0.06]"
                                          : "border-border/40 bg-card/50 hover:border-border/60"
                                        : "border-border/25 bg-secondary/20 opacity-60 cursor-default"
                                    }`}
                                  >
                                    <input
                                      type="checkbox"
                                      checked={selectedActions.has(item.action)}
                                      disabled={!item.enabled}
                                      onChange={() => toggleAction(item.action)}
                                      className="mt-0.5 rounded border-border/50"
                                    />
                                    <div className="min-w-0 flex-1">
                                      <div className="flex items-center gap-2">
                                        <span className="text-sm font-semibold text-foreground">{item.title}</span>
                                        {item.count > 0 && (
                                          <span className={`inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-bold ${
                                            item.severity === "danger"
                                              ? "bg-destructive/10 text-destructive"
                                              : item.severity === "warning"
                                                ? "bg-amber-500/10 text-amber-600"
                                                : "bg-primary/10 text-primary"
                                          }`}>
                                            {item.count} 项
                                          </span>
                                        )}
                                        {item.bytes > 0 && (
                                          <span className="text-[10px] font-mono text-muted-foreground">{formatBytes(item.bytes)}</span>
                                        )}
                                        {!item.enabled && (
                                          <span className="text-[10px] text-muted-foreground">无需操作</span>
                                        )}
                                      </div>
                                      <p className="mt-1 text-xs leading-5 text-muted-foreground">{item.detail}</p>
                                    </div>
                                  </label>
                                ))}
                              </div>
                              <div className="mt-3 flex items-center justify-between">
                                <p className="text-[11px] text-muted-foreground/70">
                                  勾选后点击「执行修复」，删除文件和压缩操作不可撤销。
                                </p>
                                <button
                                  type="button"
                                  onClick={() => void executeRepair()}
                                  disabled={repairExecuting || selectedActions.size === 0}
                                  className="inline-flex items-center gap-1.5 rounded-xl bg-primary px-3.5 py-2 text-xs font-bold text-primary-foreground shadow-sm shadow-primary/20 transition-all hover:bg-primary/90 disabled:opacity-50"
                                >
                                  {repairExecuting ? (
                                    <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-primary-foreground/20 border-t-primary-foreground" />
                                  ) : (
                                    <Wrench size={13} />
                                  )}
                                  {repairExecuting ? "执行中..." : "执行修复"}
                                </button>
                              </div>
                            </>
                          ) : (
                            <p className="mt-3 text-xs text-muted-foreground">
                              点击「加载修复计划」查看可执行的修复操作。
                            </p>
                          )}
                        </div>
                        <p className="mt-3 text-[11px] leading-5 text-muted-foreground/80">
                          修复操作需要确认后才会执行，删除文件和压缩备份均不可撤销。
                        </p>
                      </div>
                    </div>
                  </section>
                ) : null}
              </>
            ) : !loading ? (
              <p className="rounded-2xl border border-destructive/20 bg-destructive/8 px-4 py-3 text-sm text-muted-foreground">
                暂时无法读取 Token 诊断。请确认本地 Node API 已启动。
              </p>
            ) : null}
            {repairPlan && repairPlan.actions && repairPlan.actions.length > 0 && !maintenanceReport && (
              <section className="rounded-2xl border border-border/55 bg-background/45 p-4">
                <div className="flex items-start gap-3">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/12 text-primary">
                    <Wrench size={16} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-semibold text-foreground">手动确认修复</div>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">
                      可执行的修复操作：{repairPlan.actions.filter((item) => item.enabled).length} 项。
                      勾选后点击「执行修复」。
                    </p>
                    <div className="mt-3 space-y-2">
                      {repairPlan.actions.map((item) => (
                        <label
                          key={item.action}
                          className={`flex items-start gap-3 rounded-xl border px-3 py-2.5 cursor-pointer transition-colors ${
                            item.enabled
                              ? selectedActions.has(item.action)
                                ? "border-primary/40 bg-primary/[0.06]"
                                : "border-border/40 bg-card/50 hover:border-border/60"
                              : "border-border/25 bg-secondary/20 opacity-60 cursor-default"
                          }`}
                        >
                          <input
                            type="checkbox"
                            checked={selectedActions.has(item.action)}
                            disabled={!item.enabled}
                            onChange={() => toggleAction(item.action)}
                            className="mt-0.5 rounded border-border/50"
                          />
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-semibold text-foreground">{item.title}</span>
                              {item.count > 0 && (
                                <span className={`inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-bold ${
                                  item.severity === "danger"
                                    ? "bg-destructive/10 text-destructive"
                                    : item.severity === "warning"
                                      ? "bg-amber-500/10 text-amber-600"
                                      : "bg-primary/10 text-primary"
                                }`}>
                                  {item.count} 项
                                </span>
                              )}
                              {item.bytes > 0 && (
                                <span className="text-[10px] font-mono text-muted-foreground">{formatBytes(item.bytes)}</span>
                              )}
                              {!item.enabled && (
                                <span className="text-[10px] text-muted-foreground">无需操作</span>
                              )}
                            </div>
                            <p className="mt-1 text-xs leading-5 text-muted-foreground">{item.detail}</p>
                          </div>
                        </label>
                      ))}
                    </div>
                    <div className="mt-3 flex items-center justify-between">
                      <p className="text-[11px] text-muted-foreground/70">
                        勾选后点击「执行修复」，删除文件和压缩操作不可撤销。
                      </p>
                      <button
                        type="button"
                        onClick={() => void executeRepair()}
                        disabled={repairExecuting || selectedActions.size === 0}
                        className="inline-flex items-center gap-1.5 rounded-xl bg-primary px-3.5 py-2 text-xs font-bold text-primary-foreground shadow-sm shadow-primary/20 transition-all hover:bg-primary/90 disabled:opacity-50"
                      >
                        {repairExecuting ? (
                          <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-primary-foreground/20 border-t-primary-foreground" />
                        ) : (
                          <Wrench size={13} />
                        )}
                        {repairExecuting ? "执行中..." : "执行修复"}
                      </button>
                    </div>
                  </div>
                </div>
              </section>
            )}
            {actionStatus && (
              <p className="rounded-2xl border border-primary/20 bg-primary/8 px-4 py-3 text-xs leading-5 text-muted-foreground">
                {actionStatus}
              </p>
            )}
          </div>

          <div className="grid shrink-0 grid-cols-2 gap-3 border-t border-border/45 bg-card/75 px-5 py-4 sm:grid-cols-[1fr_1fr_1fr_1fr_1fr_auto_auto] sm:px-6">
            <button
              type="button"
              onClick={() => void checkHeadroom()}
              className="inline-flex h-12 items-center justify-center gap-2 rounded-2xl bg-primary px-4 text-sm font-semibold text-primary-foreground shadow-lg shadow-primary/20 transition-colors hover:bg-primary/90"
            >
              <Radio size={16} />
              压缩自检
            </button>
            <button
              type="button"
              onClick={() => void checkPython()}
              className="soft-pill inline-flex h-12 items-center justify-center gap-2 rounded-2xl px-4 text-sm font-semibold text-foreground"
            >
              <Cpu size={16} />
              Python 自检
            </button>
            <button
              type="button"
              onClick={() => void runProjectHealthScan()}
              disabled={maintenanceLoading}
              className="soft-pill inline-flex h-12 items-center justify-center gap-2 rounded-2xl px-4 text-sm font-semibold text-foreground disabled:opacity-60"
            >
              <ShieldCheck size={16} />
              {maintenanceLoading ? "体检中" : "项目体检"}
            </button>
            <button
              type="button"
              onClick={() => void loadRepairPlan()}
              disabled={repairPlanLoading}
              className="soft-pill inline-flex h-12 items-center justify-center gap-2 rounded-2xl px-4 text-sm font-semibold text-foreground disabled:opacity-60"
            >
              <Wrench size={16} />
              {repairPlanLoading ? "加载中" : "修复计划"}
            </button>
            <button
              type="button"
              onClick={() => void runMaintenance()}
              className="soft-pill inline-flex h-12 items-center justify-center gap-2 rounded-2xl px-4 text-sm font-semibold text-foreground"
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
  const styleApi = useStyle();
  const { t, lang: currentLang } = useI18n();
  const { data: project, error: projectError, refetch: refetchProject } = useApi<{ language: string; languageExplicit: boolean }>("/project");
  const [showLanguageSelector, setShowLanguageSelector] = useState(false);
  const [ready, setReady] = useState(false);
  const [startupRetryCount, setStartupRetryCount] = useState(0);
  const [startupDiagnostics, setStartupDiagnostics] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const closeSidebar = useCallback(() => setSidebarOpen(false), []);

  const isDark = theme === "dark";

  useEffect(() => {
    document.documentElement.classList.toggle("dark", isDark);
  }, [isDark]);

  // project 加载完成后，等待 SSE 连接就绪，超时 8 秒则直接放行
  useEffect(() => {
    if (!project || sse.connected) return;
    const timer = window.setTimeout(() => setReady(true), 8000);
    return () => window.clearTimeout(timer);
  }, [project, sse.connected]);

  useEffect(() => {
    if (project) {
      setStartupRetryCount(0);
      if (!project.languageExplicit) {
        setShowLanguageSelector(true);
      }
      // 等待 SSE 连接就绪后再进入主界面，避免出现"重连中"闪烁
      if (sse.connected) {
        setReady(true);
      }
    }
  }, [project, sse.connected]);

  useEffect(() => {
    if (!isNativeRuntime()) return;
    const wakeNode = () => {
      if (document.visibilityState === "visible") {
        void ensureEmbeddedNodeRunning();
        window.setTimeout(() => refetchProject(), 300);
        window.setTimeout(() => refetchProject(), 1200);
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

  useEffect(() => {
    if (!projectError || !isNativeRuntime()) {
      setStartupDiagnostics("");
      return;
    }
    void readAndroidRuntimeDiagnostics().then(({ status, output }) => {
      setStartupDiagnostics([
        status?.state ? `状态：${status.state}` : "",
        status?.message ?? "",
        output?.trim().slice(-4000) ?? "",
      ].filter(Boolean).join("\n\n"));
    });
  }, [projectError, startupRetryCount]);

  useSessionEvents(sse, route, setRoute);

  const nav = useMemo(() => ({
    toDashboard: () => { setRoute({ page: "dashboard" }); closeSidebar(); },
    toChat: () => { setRoute({ page: "chat" }); closeSidebar(); },
    toBook: (bookId: string) => { setRoute({ page: "book", bookId }); closeSidebar(); },
    toBookSettings: (bookId: string) => { setRoute({ page: "book-settings", bookId }); closeSidebar(); },
    toBookCreate: () => { setRoute({ page: "book-create" }); closeSidebar(); },
    toChapter: (bookId: string, chapterNumber: number) =>
      { setRoute({ page: "chapter", bookId, chapterNumber }); closeSidebar(); },
    toAnalytics: (bookId: string) => { setRoute({ page: "analytics", bookId }); closeSidebar(); },
    toServices: () => { setRoute({ page: "services" }); closeSidebar(); },
    toProjectSettings: () => { setRoute({ page: "project-settings" }); closeSidebar(); },
    toServiceDetail: (id: string) => { setRoute({ page: "service-detail", serviceId: id }); closeSidebar(); },
    toTruth: (bookId: string) => { setRoute({ page: "truth", bookId }); closeSidebar(); },
    toKnowledge: (bookId: string) => { setRoute({ page: "knowledge", bookId }); closeSidebar(); },
    toTimeline: (bookId: string) => { setRoute({ page: "timeline", bookId }); closeSidebar(); },
    toSchedule: (bookId: string) => { setRoute({ page: "schedule", bookId }); closeSidebar(); },
    toCharacterGraph: (bookId: string) => { setRoute({ page: "character-graph", bookId }); closeSidebar(); },
    toWorldSettings: (bookId: string) => { setRoute({ page: "world-settings", bookId }); closeSidebar(); },
    toForeshadowing: (bookId: string) => { setRoute({ page: "foreshadowing", bookId }); closeSidebar(); },
    toEndings: (bookId: string) => { setRoute({ page: "endings", bookId }); closeSidebar(); },
    toDaemon: () => { setRoute({ page: "daemon" }); closeSidebar(); },
    toLogs: () => { setRoute({ page: "logs" }); closeSidebar(); },
    toGenres: () => { setRoute({ page: "genres" }); closeSidebar(); },
    toStyle: () => { setRoute({ page: "style" }); closeSidebar(); },
    toImport: (tab?: "chapters" | "canon" | "fanfic" | "spinoff" | "imitation") => { setRoute({ page: "import", ...(tab ? { tab } : {}) }); closeSidebar(); },
    toImageGen: () => { setRoute({ page: "image-gen" }); closeSidebar(); },
    toImages: () => { setRoute({ page: "images" }); closeSidebar(); },
    toRadar: () => { setRoute({ page: "radar" }); closeSidebar(); },
    toDoctor: () => { setRoute({ page: "doctor" }); closeSidebar(); },
  }), [setRoute, closeSidebar]);

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
          <div className="mt-5 text-base font-semibold text-foreground">
            {isNativeRuntime() && !sse.connected
              ? (currentLang === "zh" ? "正在连接后端服务..." : "Connecting to backend...")
              : "正在启动本机 Node 后端"}
          </div>
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
          {startupDiagnostics && (
            <pre className="mt-4 max-h-48 overflow-auto whitespace-pre-wrap rounded-2xl border border-border/60 bg-muted/40 p-3 text-left text-xs leading-5 text-muted-foreground">
              {startupDiagnostics}
            </pre>
          )}
          <div className="mt-5 flex flex-wrap gap-2">
            <button
              onClick={async () => {
                await ensureEmbeddedNodeRunning();
                setReady(false);
                setStartupRetryCount(0);
                refetchProject();
              }}
              className="rounded-full bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
            >
              重启并重试
            </button>
            {isNativeRuntime() && (
              <button
                onClick={async () => {
                  await resetEmbeddedNodeRuntime();
                  setReady(false);
                  setStartupRetryCount(0);
                  window.setTimeout(() => refetchProject(), 1500);
                }}
                className="rounded-full border border-border bg-card px-4 py-2 text-sm font-medium text-foreground"
              >
                重置运行时缓存
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }

  if (showLanguageSelector) {
    return (
      <Suspense fallback={<PageLoading />}>
        <LanguageSelector
          onSelect={async (lang) => {
            await postApi("/project/language", { language: lang });
            setShowLanguageSelector(false);
            refetchProject();
          }}
        />
      </Suspense>
    );
  }

  return (
    <AppDialogProvider>
    <div className="app-shell h-[100dvh] claude-surface text-foreground flex overflow-hidden font-sans">
      {/* Left Sidebar — hidden on mobile, shown as overlay when toggled */}
      <div className="hidden md:block h-full">
        <Sidebar nav={nav} activePage={activePage} sse={sse} t={t} />
      </div>
      <Sidebar nav={nav} activePage={activePage} sse={sse} t={t} onClose={closeSidebar} mobileOpen={sidebarOpen} />

      {/* Center Content */}
      <div className="app-shell-content flex-1 flex flex-col min-w-0 bg-background/20">
        {/* Header Strip */}
        <header className="app-shell-header relative z-40 min-h-13 sm:min-h-16 shrink-0 flex items-center gap-1.5 overflow-visible px-2 sm:gap-2 sm:px-4 md:px-8 border-b border-border/45 claude-topbar shadow-sm shadow-primary/5 mobile-safe-top">
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
               className="app-shell-home-button soft-pill inline-flex h-10 w-10 shrink-0 touch-manipulation items-center justify-center gap-2 rounded-full px-0 text-sm font-medium text-foreground transition-colors hover:border-primary/40 sm:w-auto sm:max-w-none sm:justify-start sm:px-3.5"
             >
               <House size={14} />
               <span className="hidden sm:inline">{t("bread.home")}</span>
               <span className="hidden sm:inline text-muted-foreground/70">/</span>
               <span className="hidden truncate font-serif sm:inline">InkOS Studio</span>
             </button>
          </div>

          <div className="app-shell-header-actions flex min-w-0 flex-1 items-center justify-end gap-1 overflow-visible pl-0 pr-0 sm:gap-3">
            {!sse.connected && isNativeRuntime() && (
              <span className="flex items-center gap-1.5 rounded-full bg-amber-500/10 px-2.5 py-1 text-[11px] font-medium text-amber-600">
                <span className="h-1.5 w-1.5 rounded-full bg-amber-500 animate-pulse" />
                {currentLang === "zh" ? "重连中" : "Reconnecting"}
              </span>
            )}
            <RuntimeStatusButton />
            <TokenDiagnosticsButton />
            <LocalStorageButton />
            <div className="app-shell-lang-switch soft-pill flex h-10 shrink-0 gap-0 rounded-full p-0.5">
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
              aria-label={isDark ? (currentLang === "zh" ? "切换到亮色模式" : "Switch to light mode") : (currentLang === "zh" ? "切换到暗色模式" : "Switch to dark mode")}
            >
              {isDark ? <Sun size={14} /> : <Moon size={14} />}
            </button>
            <StylePanel {...styleApi} />
          </div>
        </header>

        {/* Main Content Area */}
        <main className="app-shell-main mobile-scroll-area mobile-safe-bottom flex-1 relative overflow-y-auto scroll-smooth">
          <Suspense fallback={<PageLoading />}>
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
              <BookSidebar bookId={route.bookId} theme={theme} t={t} sse={sse} onOpenKnowledge={nav.toKnowledge} />
              <BookSidebarToggle bookId={route.bookId} theme={theme} t={t} sse={sse} onOpenKnowledge={nav.toKnowledge} />
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
          {route.page === "project-settings" && (
            <div className="max-w-6xl mx-auto px-4 py-6 md:px-10 md:py-10 lg:py-12 fade-in">
              <ProjectSettings nav={nav} theme={theme} t={t} />
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
          {route.page === "knowledge" && (
            <div className="max-w-6xl mx-auto px-4 py-6 md:px-10 md:py-10 lg:py-12 fade-in">
              <KnowledgePage bookId={route.bookId} nav={nav} theme={theme} t={t} />
            </div>
          )}
          {route.page === "timeline" && (
            <div className="max-w-6xl mx-auto px-4 py-6 md:px-10 md:py-10 lg:py-12 fade-in">
              <TimelinePage bookId={route.bookId} nav={nav} theme={theme} t={t} />
            </div>
          )}
          {route.page === "schedule" && (
            <div className="max-w-6xl mx-auto px-4 py-6 md:px-10 md:py-10 lg:py-12 fade-in">
              <SchedulePage bookId={route.bookId} nav={nav} theme={theme} t={t} />
            </div>
          )}
          {route.page === "character-graph" && (
            <div className="max-w-6xl mx-auto px-4 py-6 md:px-10 md:py-10 lg:py-12 fade-in">
              <CharacterGraphPage bookId={route.bookId} nav={nav} theme={theme} t={t} />
            </div>
          )}
          {route.page === "world-settings" && (
            <div className="max-w-6xl mx-auto px-4 py-6 md:px-10 md:py-10 lg:py-12 fade-in">
              <WorldSettingsPage bookId={route.bookId} nav={nav} theme={theme} t={t} />
            </div>
          )}
          {route.page === "foreshadowing" && (
            <div className="max-w-6xl mx-auto px-4 py-6 md:px-10 md:py-10 lg:py-12 fade-in">
              <ForeshadowingPage bookId={route.bookId} nav={nav} theme={theme} t={t} />
            </div>
          )}
          {route.page === "endings" && (
            <div className="max-w-6xl mx-auto px-4 py-6 md:px-10 md:py-10 lg:py-12 fade-in">
              <EndingsPage bookId={route.bookId} nav={nav} theme={theme} t={t} />
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
              <ImportManager nav={nav} theme={theme} t={t} initialTab={route.tab} />
            </div>
          )}
          {route.page === "image-gen" && (
            <div className="max-w-6xl mx-auto px-4 py-6 md:px-10 md:py-10 lg:py-12 fade-in">
              <ImageGenPage nav={nav} />
            </div>
          )}
          {route.page === "images" && (
            <div className="max-w-6xl mx-auto px-4 py-6 md:px-10 md:py-10 lg:py-12 fade-in">
              <ImageLibraryPage />
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
          </Suspense>
        </main>
      </div>
    </div>
    </AppDialogProvider>
  );
}
