import { useState, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import {
  Activity,
  Cpu,
  Database,
  FileText,
  Radio,
  Server,
  ShieldCheck,
  Wrench,
  X,
} from "lucide-react";
import { fetchJson, postApi } from "../hooks/use-api";
import { useSSE } from "../hooks/use-sse";
import { formatBytes, readAndroidRuntimeDiagnostics } from "./app-utils";
import type { AndroidRuntimeFileStatus } from "./app-utils";
import { RuntimeStatusRow } from "./RuntimeStatusRow";

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

export function TokenDiagnosticsButton() {
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

  const refresh = useCallback(async () => {
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
  }, []);

  const runMaintenance = useCallback(async () => {
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
  }, [refresh]);

  const checkHeadroom = useCallback(async () => {
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
  }, [refresh]);

  const checkPython = useCallback(async () => {
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
  }, [refresh]);

  const runProjectHealthScan = useCallback(async () => {
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
  }, []);

  const loadRepairPlan = useCallback(async () => {
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
  }, []);

  const executeRepair = useCallback(async () => {
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
  }, [selectedActions, maintenanceReport, loadRepairPlan, runProjectHealthScan]);

  const toggleAction = useCallback((action: string) => {
    setSelectedActions((prev) => {
      const next = new Set(prev);
      if (next.has(action)) {
        next.delete(action);
      } else {
        next.add(action);
      }
      return next;
    });
  }, []);

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
