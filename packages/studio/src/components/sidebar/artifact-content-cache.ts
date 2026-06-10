import { fetchJson } from "../../hooks/use-api";

export type ArtifactContentTarget =
  | { readonly type: "chapter"; readonly chapter: number }
  | { readonly type: "truth"; readonly file: string };

const artifactContentCache = new Map<string, string | null>();
const artifactContentRequests = new Map<string, Promise<string | null>>();
const artifactContentVersions = new Map<string, number>();

function artifactContentKey(bookId: string, target: ArtifactContentTarget): string {
  return target.type === "chapter"
    ? `${bookId}:chapter:${target.chapter}`
    : `${bookId}:truth:${target.file}`;
}

function artifactContentPath(bookId: string, target: ArtifactContentTarget): string {
  return target.type === "chapter"
    ? `/books/${bookId}/chapters/${target.chapter}`
    : `/books/${bookId}/truth/${target.file}`;
}

function artifactContentVersion(bookId: string): number {
  return artifactContentVersions.get(bookId) ?? 0;
}

export function invalidateBookArtifactContent(bookId: string): void {
  const prefix = `${bookId}:`;
  artifactContentVersions.set(bookId, artifactContentVersion(bookId) + 1);
  for (const key of artifactContentCache.keys()) {
    if (key.startsWith(prefix)) {
      artifactContentCache.delete(key);
    }
  }
  for (const key of artifactContentRequests.keys()) {
    if (key.startsWith(prefix)) {
      artifactContentRequests.delete(key);
    }
  }
}

export function getCachedArtifactContent(
  bookId: string,
  target: ArtifactContentTarget,
): string | null | undefined {
  const key = artifactContentKey(bookId, target);
  return artifactContentCache.has(key) ? artifactContentCache.get(key) ?? null : undefined;
}

export function setCachedArtifactContent(
  bookId: string,
  target: ArtifactContentTarget,
  content: string | null,
): void {
  artifactContentCache.set(artifactContentKey(bookId, target), content);
}

export function loadArtifactContent(
  bookId: string,
  target: ArtifactContentTarget,
): Promise<string | null> {
  const key = artifactContentKey(bookId, target);
  const cached = getCachedArtifactContent(bookId, target);
  if (cached !== undefined) {
    return Promise.resolve(cached);
  }

  const existing = artifactContentRequests.get(key);
  if (existing) return existing;

  const requestVersion = artifactContentVersion(bookId);
  const request = fetchJson<{ content: string | null }>(artifactContentPath(bookId, target))
    .then((data) => {
      const content = data.content ?? "";
      if (artifactContentVersion(bookId) === requestVersion) {
        artifactContentCache.set(key, content);
      }
      return content;
    })
    .catch(() => {
      if (artifactContentVersion(bookId) === requestVersion) {
        artifactContentCache.set(key, null);
      }
      return null;
    })
    .finally(() => {
      artifactContentRequests.delete(key);
    });

  artifactContentRequests.set(key, request);
  return request;
}

export function prefetchArtifactContents(
  bookId: string,
  targets: ReadonlyArray<ArtifactContentTarget>,
): void {
  if (!targets.length || typeof window === "undefined") return;

  const pending = targets.filter((target) => getCachedArtifactContent(bookId, target) === undefined);
  if (!pending.length) return;

  const run = () => {
    for (const target of pending) {
      void loadArtifactContent(bookId, target);
    }
  };

  window.setTimeout(run, 0);
}
