import { registerPlugin } from "@capacitor/core";
import { isNativeRuntime } from "./mobile-runtime";

interface InkOSRuntimePlugin {
  restartNode(): Promise<{ ok: boolean }>;
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
  await InkOSRuntime.openInstallPermissionSettings();
  return true;
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
  return await InkOSRuntime.downloadUpdateApk({
    url: options.url,
    sha256: options.sha256,
    fileName: options.fileName,
  });
}

export async function installDownloadedApk(path: string): Promise<{
  readonly ok: boolean;
  readonly path?: string;
  readonly needsPermission?: boolean;
  readonly message?: string;
}> {
  if (!isNativeRuntime()) {
    throw new Error("APK installation is only available in the Android app.");
  }
  return await InkOSRuntime.installDownloadedApk({ path });
}

export async function requestBatteryOptimizationExemption(): Promise<boolean> {
  if (!isNativeRuntime()) return false;
  try {
    await InkOSRuntime.requestBatteryOptimizationExemption();
    return true;
  } catch {
    return false;
  }
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
