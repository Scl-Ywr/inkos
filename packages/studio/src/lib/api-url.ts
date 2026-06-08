import { isEmbeddedNodeMode } from "./mobile-runtime";

const API_PATH_BASE = "/api/v1";
const DEFAULT_PRODUCTION_API_ORIGIN = "https://inkos.christmas.qzz.io";
const EMBEDDED_NODE_API_ORIGIN = "http://127.0.0.1:4567";

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, "");
}

export function getApiOrigin(): string {
  if (isEmbeddedNodeMode()) {
    return EMBEDDED_NODE_API_ORIGIN;
  }

  const envOrigin = String(import.meta.env.VITE_INKOS_API_ORIGIN ?? "").trim();
  if (envOrigin) {
    return trimTrailingSlashes(envOrigin);
  }

  return import.meta.env.PROD ? DEFAULT_PRODUCTION_API_ORIGIN : "";
}

export function buildApiUrl(path: string): string | null {
  const normalized = String(path ?? "").trim();
  if (!normalized) return null;

  const apiOrigin = getApiOrigin();
  const apiBase = `${apiOrigin}${API_PATH_BASE}`;

  if (/^https?:\/\//i.test(normalized)) {
    return normalized;
  }

  if (normalized.startsWith(`${API_PATH_BASE}/`) || normalized === API_PATH_BASE) {
    return `${apiOrigin}${normalized}`;
  }

  const pathWithSlash = normalized.startsWith("/") ? normalized : `/${normalized}`;
  return `${apiBase}${pathWithSlash}`;
}
