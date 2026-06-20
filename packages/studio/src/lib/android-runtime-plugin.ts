import { registerPlugin } from "@capacitor/core";
import { isNativeRuntime } from "./mobile-runtime";

interface InkOSRuntimePlugin {
  restartNode(): Promise<{ ok: boolean }>;
  resetNodeRuntime(): Promise<{ ok: boolean }>;
  appVersion(): Promise<{
    packageName: string;
    versionCode: number;
    versionName: string;
    canRequestPackageInstalls: boolean;
  }>;
  installPermissionStatus(): Promise<{ canRequestPackageInstalls: boolean }>;
  openInstallPermissionSettings(): Promise<{ ok: boolean }>;
  downloadUpdateApk(options: {
    url: string;
    sha256: string;
    fileName?: string;
  }): Promise<{
    ok: boolean;
    path: string;
    size: number;
    sha256: string;
  }>;
  pingUpdateUrl(options: {
    url: string;
  }): Promise<{
    ok: boolean;
    statusCode: number;
    latencyMs: number;
    error?: string;
  }>;
  installDownloadedApk(options: {
    path: string;
  }): Promise<{
    ok: boolean;
    path?: string;
    needsPermission?: boolean;
    message?: string;
  }>;
  requestBatteryOptimizationExemption(): Promise<{ ok: boolean; ignoring?: boolean }>;
  batteryOptimizationStatus(): Promise<{ ignoring: boolean }>;
  updateTaskNotification(options: {
    title: string;
    message: string;
    busy: boolean;
  }): Promise<{ ok: boolean }>;
  checkNodeStatus(): Promise<{
    state: string;
    message: string;
    nativeLibSize?: number;
    packagedRuntimeVersion?: string;
  }>;
}

const InkOSRuntime = registerPlugin<InkOSRuntimePlugin>("InkOSRuntime");
let lastTaskNotificationSignature = "";

export async function restartEmbeddedNode(): Promise<boolean> {
  if (!isNativeRuntime()) return false;
  try {
    await InkOSRuntime.restartNode();
    return true;
  } catch {
    return false;
  }
}

export async function ensureEmbeddedNodeRunning(): Promise<boolean> {
  return restartEmbeddedNode();
}

/**
 * Read the Node runtime status directly from the native filesystem.
 * Bypasses both network fetch and Capacitor Filesystem plugin,
 * which may not work reliably on GeckoView.
 */
export async function checkNodeStatusFromNative(): Promise<{
  state: string;
  message: string;
  nativeLibSize?: number;
  packagedRuntimeVersion?: string;
} | null> {
  if (!isNativeRuntime()) return null;
  try {
    return await InkOSRuntime.checkNodeStatus();
  } catch {
    return null;
  }
}

export async function resetEmbeddedNodeRuntime(): Promise<boolean> {
  if (!isNativeRuntime()) return false;
  try {
    await InkOSRuntime.resetNodeRuntime();
    return true;
  } catch {
    return false;
  }
}

export async function getAndroidAppVersion(): Promise<{
  packageName: string;
  versionCode: number;
  versionName: string;
  canRequestPackageInstalls: boolean;
} | null> {
  if (!isNativeRuntime()) return null;
  return await InkOSRuntime.appVersion();
}

export async function getInstallPermissionStatus(): Promise<boolean | null> {
  if (!isNativeRuntime()) return null;
  const result = await InkOSRuntime.installPermissionStatus();
  return result.canRequestPackageInstalls;
}

export async function openInstallPermissionSettings(): Promise<boolean> {
  if (!isNativeRuntime()) return false;
  // Use HTTP endpoint instead of Capacitor bridge (more reliable in GeckoView)
  const res = await fetch("/__cap_install_permission", { method: "POST" });
  if (!res.ok) throw new Error("Failed to open permission settings");
  return true;
}

// ==================== Download ====================

let downloadRequestId = 0;
let downloadAbortController: AbortController | null = null;
let progressCallback: ((progress: DownloadProgress) => void) | null = null;

export interface DownloadProgress {
  readonly bytesDownloaded: number;
  readonly totalBytes: number;
  readonly percent: number;
  readonly speedBytesPerSec: number;
}

export function subscribeToDownloadProgress(
  callback: (progress: DownloadProgress) => void,
): () => void {
  progressCallback = callback;
  return () => {
    progressCallback = null;
  };
}

export async function downloadUpdateApk(options: {
  readonly url: string;
  readonly sha256: string;
  readonly fileName?: string;
}): Promise<{
  readonly ok: boolean;
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
}> {
  if (!isNativeRuntime()) {
    throw new Error("APK update downloads are only available in the Android app.");
  }
  const id = ++downloadRequestId;

  // Start download directly via HTTP (same pattern as ping — no content script needed)
  const startRes = await fetch("/__cap_download_apk", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: options.url, sha256: options.sha256, fileName: options.fileName }),
  });
  if (!startRes.ok) throw new Error("Failed to start download");
  const startData = await startRes.json() as { downloadId?: string; error?: string };
  if (startData.error) throw new Error(startData.error);
  const downloadId = startData.downloadId;
  if (!downloadId) throw new Error("No downloadId returned");

  // Poll for progress and completion
  const abortCtrl = new AbortController();
  downloadAbortController = abortCtrl;

  return new Promise<{
    readonly ok: boolean;
    readonly path: string;
    readonly size: number;
    readonly sha256: string;
  }>((resolve, reject) => {
    const timeout = setTimeout(() => {
      abortCtrl.abort();
      reject(new Error("download timeout"));
    }, 600000);

    let lastBytes = 0;
    let lastTime = Date.now();

    function cleanup() {
      clearTimeout(timeout);
      downloadAbortController = null;
    }

    abortCtrl.signal.addEventListener("abort", () => {
      cleanup();
      reject(new Error("cancelled"));
    });

    function pollProgress() {
      if (abortCtrl.signal.aborted) return;
      fetch(`/__cap_download_apk/${downloadId}`)
        .then(r => r.json())
        .then((status: any) => {
          if (abortCtrl.signal.aborted) return;

          // Calculate speed
          const now = Date.now();
          const elapsed = (now - lastTime) / 1000;
          const bytesDownloaded = status.bytesDownloaded ?? 0;
          const speed = elapsed > 0 ? Math.round((bytesDownloaded - lastBytes) / elapsed) : 0;
          lastBytes = bytesDownloaded;
          lastTime = now;

          // Report progress
          if (progressCallback) {
            progressCallback({
              bytesDownloaded,
              totalBytes: status.totalBytes ?? 0,
              percent: status.totalBytes > 0 ? Math.round((bytesDownloaded * 100) / status.totalBytes) : 0,
              speedBytesPerSec: speed,
            });
          }
          if (status.done) {
            cleanup();
            if (status.error) {
              reject(new Error(status.error));
            } else {
              resolve({ ok: true, path: status.path ?? "", size: status.size ?? 0, sha256: options.sha256 });
            }
          } else {
            setTimeout(pollProgress, 500);
          }
        })
        .catch(err => {
          if (!abortCtrl.signal.aborted) {
            cleanup();
            reject(new Error(err.message || "download poll failed"));
          }
        });
    }
    pollProgress();
  });
}

export async function cancelDownload(): Promise<void> {
  if (!isNativeRuntime()) return;
  // Abort the waiting promise so the dialog can close
  if (downloadAbortController) {
    downloadAbortController.abort();
  }
}

// ==================== Ping ====================

export async function pingUpdateUrl(url: string): Promise<{
  readonly ok: boolean;
  readonly statusCode: number;
  readonly latencyMs: number;
  readonly error?: string;
}> {
  if (!isNativeRuntime()) {
    throw new Error("APK update source checks are only available in the Android app.");
  }
  return await InkOSRuntime.pingUpdateUrl({ url });
}

export async function pingUpdateUrls(urls: string[]): Promise<Array<{
  readonly ok: boolean;
  readonly statusCode: number;
  readonly latencyMs: number;
  readonly error?: string;
}>> {
  if (!isNativeRuntime()) {
    throw new Error("APK update source checks are only available in the Android app.");
  }

  // Use HTTP batch ping endpoint (more reliable in GeckoView than Capacitor bridge)
  try {
    const startRes = await fetch("/__cap_ping_batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(urls),
    });
    if (!startRes.ok) throw new Error("failed to start batch ping");
    const { batchId } = await startRes.json() as { batchId: string };

    // Poll until done
    const maxAttempts = 120; // 60 seconds max
    for (let i = 0; i < maxAttempts; i++) {
      await new Promise(r => setTimeout(r, 500));
      const statusRes = await fetch(`/__cap_ping_batch/${batchId}`);
      if (!statusRes.ok) continue;
      const status = await statusRes.json() as { done: boolean; results?: Array<{ ok: boolean; statusCode: number; latencyMs: number; error?: string }> };
      if (status.done && status.results) {
        return status.results;
      }
    }
    // Timeout — return failures
    return urls.map(() => ({ ok: false, statusCode: 0, latencyMs: 0, error: "ping timeout" }));
  } catch (err) {
    return urls.map(() => ({ ok: false, statusCode: 0, latencyMs: 0, error: err instanceof Error ? err.message : "ping failed" }));
  }
}

// ==================== Install ====================

export async function installDownloadedApk(path: string): Promise<{
  readonly ok: boolean;
  readonly path?: string;
  readonly needsPermission?: boolean;
  readonly message?: string;
}> {
  if (!isNativeRuntime()) {
    throw new Error("APK installation is only available in the Android app.");
  }
  // Use HTTP endpoint instead of Capacitor bridge (more reliable in GeckoView)
  const res = await fetch("/__cap_install_apk", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });
  const data = await res.json() as { ok?: boolean; path?: string; needsPermission?: boolean; message?: string; error?: string };
  if (data.error) throw new Error(data.error);
  return {
    ok: data.ok ?? false,
    path: data.path,
    needsPermission: data.needsPermission,
    message: data.message,
  };
}

// ==================== Battery ====================

export async function requestBatteryOptimizationExemption(): Promise<boolean> {
  if (!isNativeRuntime()) throw new Error("仅在 Android 应用中可用");
  // Use direct HTTP endpoint to bypass broken Capacitor bridge in GeckoView
  const res = await fetch("/__cap_battery_exemption", { method: "POST" });
  const data = await res.json() as { ok?: boolean; error?: string };
  if (!res.ok || data.error) {
    throw new Error(data.error ?? "打开权限设置失败");
  }
  return data.ok === true;
}

export async function isBatteryOptimizationIgnored(): Promise<boolean | null> {
  if (!isNativeRuntime()) return null;
  try {
    const result = await InkOSRuntime.batteryOptimizationStatus();
    return result.ignoring;
  } catch {
    return null;
  }
}

// ==================== Task Notification ====================

export async function updateAndroidTaskNotification(options: {
  readonly title: string;
  readonly message: string;
  readonly busy: boolean;
}): Promise<boolean> {
  if (!isNativeRuntime()) return false;
  const title = options.title.trim() || (options.busy ? "InkOS 正在执行任务" : "InkOS Studio");
  const message = options.message.trim() || (options.busy ? "任务正在运行" : "本地 Node 后端运行中");
  const signature = JSON.stringify({ title, message, busy: options.busy });
  if (signature === lastTaskNotificationSignature) return true;
  lastTaskNotificationSignature = signature;
  try {
    await InkOSRuntime.updateTaskNotification({ title, message, busy: options.busy });
    return true;
  } catch {
    lastTaskNotificationSignature = "";
    return false;
  }
}
