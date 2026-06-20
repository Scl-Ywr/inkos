import { Directory, Encoding, Filesystem } from "@capacitor/filesystem";
import { isNativeRuntime } from "../lib/mobile-runtime";

export interface LocalStorageInfo {
  readonly mode: string;
  readonly available: boolean;
  readonly directory: string | null;
  readonly uri: string | null;
  readonly path: string | null;
  readonly permission: string;
}

export interface AndroidRuntimeFileStatus {
  readonly state?: string;
  readonly message?: string;
  readonly updatedAt?: number;
  readonly packagedRuntimeVersion?: string;
  readonly installedRuntimeVersion?: string;
  readonly nativeLibSize?: number;
  readonly nativeLibSha256?: string;
}

export interface RuntimeDiagnostics {
  readonly status: AndroidRuntimeFileStatus | null;
  readonly output: string | null;
}

export function formatLocalStorageInfo(info: LocalStorageInfo): string {
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

export async function readAndroidTextFile(path: string): Promise<string | null> {
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

export async function readAndroidRuntimeDiagnostics(): Promise<RuntimeDiagnostics> {
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

export function isNativeNodeBooting(state?: string): boolean {
  if (!state) return false;
  return /^(checking|extracting|extracted|starting|node-starting|restart-scheduled|restart-skipped)$/i.test(state);
}

export function formatBytes(bytes: number): string {
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

import type { HashRoute } from "../hooks/use-hash-route";

export function deriveActiveBookId(route: HashRoute): string | undefined {
  if ("bookId" in route) return route.bookId;
  return undefined;
}

export function isBookCreateChatRoute(route: HashRoute): boolean {
  return route.page === "book-create";
}
