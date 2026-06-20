import { useState, useEffect } from "react";
import { createPortal } from "react-dom";
import {
  Activity,
  Cpu,
  Database,
  Server,
  ShieldCheck,
  Wrench,
  X,
} from "lucide-react";
import { fetchJson } from "../hooks/use-api";
import { buildApiUrl } from "../lib/api-url";
import { appAlert } from "../lib/app-dialog";
import {
  ensureEmbeddedNodeRunning,
  requestBatteryOptimizationExemption,
  resetEmbeddedNodeRuntime,
} from "../lib/android-runtime-plugin";
import {
  isNativeNodeBooting,
  type LocalStorageInfo,
} from "./app-utils";
import { RuntimeStatusRow } from "./RuntimeStatusRow";

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

export function RuntimeStatusButton() {
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
