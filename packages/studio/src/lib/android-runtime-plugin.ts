import { registerPlugin } from "@capacitor/core";
import { isNativeRuntime } from "./mobile-runtime";

interface InkOSRuntimePlugin {
  restartNode(): Promise<{ ok: boolean }>;
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
