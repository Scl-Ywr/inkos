import { Capacitor } from "@capacitor/core";

function envFlag(name: string): string {
  return String(import.meta.env[name] ?? "").trim().toLowerCase();
}

export function isNativeRuntime(): boolean {
  if (Capacitor.isNativePlatform()) return true;
  if (typeof window === "undefined") return false;
  const bridge = (window as Window & {
    Capacitor?: { isNativePlatform?: () => boolean; getPlatform?: () => string };
  }).Capacitor;
  if (bridge?.isNativePlatform?.()) return true;
  const platform = bridge?.getPlatform?.();
  return platform === "android" || platform === "ios" || window.location.protocol === "capacitor:";
}

export function isEmbeddedNodeMode(): boolean {
  const flag = envFlag("VITE_INKOS_EMBEDDED_NODE");
  if (["0", "false", "no", "off"].includes(flag)) return false;
  if (["1", "true", "yes", "on"].includes(flag)) return true;
  return isNativeRuntime();
}
