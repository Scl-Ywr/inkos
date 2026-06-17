import { useState, useEffect, useCallback } from "react";
import type { Dispatch, SetStateAction } from "react";
import { localizeKnownRuntimeMessage } from "../lib/error-copy";
import { buildApiUrl } from "../lib/api-url";

const API_INVALIDATE_EVENT = "inkos:api-invalidate";
const apiDataCache = new Map<string, unknown>();

interface ApiInvalidateDetail {
  readonly paths: ReadonlyArray<string>;
}

export { buildApiUrl } from "../lib/api-url";

function getApiPathname(path: string): string {
  const normalized = buildApiUrl(path);
  if (!normalized) return "";
  try {
    const base = typeof window === "undefined" ? "http://localhost" : window.location.origin;
    return new URL(normalized, base).pathname;
  } catch {
    return normalized;
  }
}

function getApiCacheKey(path: string): string {
  return buildApiUrl(path) ?? "";
}

export function deriveInvalidationPaths(path: string): ReadonlyArray<string> {
  const normalized = getApiPathname(path);
  if (!normalized) return [];

  if (normalized === "/api/v1/books/create") {
    return [getApiCacheKey("/books")];
  }

  if (/^\/api\/v1\/(spinoff|imitation)\/init$/.test(normalized)) {
    return [getApiCacheKey("/books")];
  }

  if (normalized === "/api/v1/project") {
    return [getApiCacheKey("/project")];
  }

  if (normalized.startsWith("/api/v1/project/")) {
    return [getApiCacheKey("/project"), getApiCacheKey(normalized)];
  }

  const bookAction = normalized.match(/^\/api\/v1\/books\/([^/]+)\/(write-next|draft)$/);
  if (bookAction) {
    return [
      getApiCacheKey("/books"),
      getApiCacheKey(`/books/${bookAction[1]}`),
      getApiCacheKey(`/books/${bookAction[1]}/chapters/*`),
    ];
  }

  const chapterAction = normalized.match(/^\/api\/v1\/books\/([^/]+)\/chapters\/\d+\/(approve|reject)$/);
  if (chapterAction) {
    return [getApiCacheKey("/books"), getApiCacheKey(`/books/${chapterAction[1]}`)];
  }

  const chapterResource = normalized.match(/^\/api\/v1\/books\/([^/]+)\/chapters\/\d+$/);
  if (chapterResource) {
    return [getApiCacheKey("/books"), getApiCacheKey(`/books/${chapterResource[1]}`), getApiCacheKey(normalized)];
  }

  if (/^\/api\/v1\/daemon\/(start|stop)$/.test(normalized)) {
    return [getApiCacheKey("/daemon")];
  }

  if (normalized === "/api/v1/logs") {
    return [getApiCacheKey("/logs")];
  }

  if (normalized === "/api/v1/images/generate") {
    return [getApiCacheKey("/images/library")];
  }

  return [];
}

export function invalidateApiPaths(paths: ReadonlyArray<string>): void {
  if (!paths.length || typeof window === "undefined") {
    return;
  }
  for (const path of paths) {
    if (path.endsWith("*")) {
      const prefix = path.slice(0, -1);
      for (const key of [...apiDataCache.keys()]) {
        if (key.startsWith(prefix)) {
          apiDataCache.delete(key);
        }
      }
    } else {
      apiDataCache.delete(path);
    }
  }

  window.dispatchEvent(new CustomEvent<ApiInvalidateDetail>(API_INVALIDATE_EVENT, {
    detail: { paths: [...new Set(paths)] },
  }));
}

async function readErrorMessage(res: Response): Promise<string> {
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    try {
      const json = await res.json() as { error?: unknown };
      if (typeof json.error === "string" && json.error.trim()) {
        return localizeKnownRuntimeMessage(json.error);
      }
      if (
        json.error &&
        typeof json.error === "object" &&
        "message" in json.error &&
        typeof (json.error as { message?: unknown }).message === "string" &&
        (json.error as { message: string }).message.trim()
      ) {
        return localizeKnownRuntimeMessage((json.error as { message: string }).message);
      }
    } catch {
      // fall through
    }
  }
  return localizeKnownRuntimeMessage(`${res.status} ${res.statusText}`.trim());
}

export async function fetchJson<T>(
  path: string,
  init: RequestInit = {},
  deps?: { readonly fetchImpl?: typeof fetch },
): Promise<T> {
  const url = buildApiUrl(path);
  if (!url) {
    throw new Error("API path is required");
  }

  const fetchImpl = deps?.fetchImpl ?? fetch;
  const method = init.method?.toUpperCase() ?? "GET";
  const requestInit: RequestInit = method === "GET"
    ? {
        ...init,
        cache: init.cache ?? "no-store",
        headers: {
          "Cache-Control": "no-cache",
          Pragma: "no-cache",
          ...(init.headers ?? {}),
        },
      }
    : init;
  const res = await fetchImpl(url, requestInit);

  if (!res.ok) {
    throw new Error(await readErrorMessage(res));
  }

  if (res.status === 204) {
    return undefined as T;
  }

  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    const text = await res.text();
    if (!text.trim()) {
      return undefined as T;
    }
    return JSON.parse(text) as T;
  }

  return await res.json() as T;
}

function getCachedApiData<T>(path: string): T | null {
  const url = buildApiUrl(path);
  if (!url || !apiDataCache.has(url)) {
    return null;
  }
  return apiDataCache.get(url) as T;
}

export function useApi<T>(path: string) {
  const [data, setData] = useState<T | null>(() => getCachedApiData<T>(path));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    const url = buildApiUrl(path);
    if (!url) {
      setData(null);
      setError(null);
      setLoading(false);
      return null;
    }

    // Don't update state when app is in background — the request will
    // likely fail due to WebView network restrictions, and we don't
    // want to show error screens for transient background failures.
    const isBackground = typeof document !== "undefined"
      && document.visibilityState !== "visible";

    setLoading(true);
    if (!isBackground) setError(null);
    try {
      const json = await fetchJson<T>(url);
      apiDataCache.set(url, json);
      setData(json);
      return json;
    } catch (e) {
      if (!isBackground) {
        setError(e instanceof Error ? e.message : String(e));
      }
      return null;
    } finally {
      setLoading(false);
    }
  }, [path]);

  const mutate = useCallback<Dispatch<SetStateAction<T | null>>>((value) => {
    const url = buildApiUrl(path);
    setData((current) => {
      const next = typeof value === "function"
        ? (value as (prev: T | null) => T | null)(current)
        : value;
      if (url) {
        if (next === null) {
          apiDataCache.delete(url);
        } else {
          apiDataCache.set(url, next);
        }
      }
      return next;
    });
  }, [path]);

  useEffect(() => {
    refetch();
  }, [refetch]);

  useEffect(() => {
    const url = buildApiUrl(path);
    if (!url || typeof window === "undefined") {
      return;
    }

    const handleInvalidate = (event: Event) => {
      const detail = (event as CustomEvent<ApiInvalidateDetail>).detail;
      if (!detail?.paths.some((candidate) => matchesInvalidationPath(url, candidate))) return;
      void refetch();
    };

    window.addEventListener(API_INVALIDATE_EVENT, handleInvalidate);
    return () => {
      window.removeEventListener(API_INVALIDATE_EVENT, handleInvalidate);
    };
  }, [path, refetch]);

  return { data, loading, error, refetch, mutate };
}

function matchesInvalidationPath(url: string, candidate: string): boolean {
  if (candidate.endsWith("*")) {
    return url.startsWith(candidate.slice(0, -1));
  }
  return url === candidate;
}

export async function postApi<T>(path: string, body?: unknown): Promise<T> {
  const result = await fetchJson<T>(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  invalidateApiPaths(deriveInvalidationPaths(path));
  return result;
}

export async function putApi<T>(path: string, body?: unknown): Promise<T> {
  const result = await fetchJson<T>(path, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  invalidateApiPaths(deriveInvalidationPaths(path));
  return result;
}

export async function deleteApi<T>(path: string): Promise<T> {
  const result = await fetchJson<T>(path, { method: "DELETE" });
  invalidateApiPaths(deriveInvalidationPaths(path));
  return result;
}
