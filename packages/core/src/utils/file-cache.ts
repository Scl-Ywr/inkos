import { readFile } from "node:fs/promises";

/**
 * Per-chapter in-memory cache for truth file reads. Eliminates redundant
 * disk I/O when the same truth files are read by composer, writer, and
 * validator within a single writeNextChapter cycle.
 *
 * Cache is instantiated once per _writeNextChapterLocked() call and
 * discarded after persistence completes.
 */
export class FileCache {
  private store = new Map<string, string | null>();
  private accessOrder: string[] = [];
  private maxSize: number;

  constructor(maxSize: number = 100) {
    this.maxSize = maxSize;
  }

  /** Retrieve a cached file's content. Returns null if not cached. */
  get(filePath: string): string | null | undefined {
    const value = this.store.get(filePath);
    if (value !== undefined) {
      this.updateAccessOrder(filePath);
    }
    return value;
  }

  /** Cache a file's content (null = file doesn't exist). */
  set(filePath: string, content: string | null): void {
    if (this.store.size >= this.maxSize && !this.store.has(filePath)) {
      const lru = this.accessOrder.shift();
      if (lru) this.store.delete(lru);
    }
    this.store.set(filePath, content);
    this.updateAccessOrder(filePath);
  }

  /** Check if a file is already cached. */
  has(filePath: string): boolean {
    return this.store.has(filePath);
  }

  /** Clear all cached entries (call between chapters). */
  clear(): void {
    this.store.clear();
    this.accessOrder = [];
  }

  size(): number {
    return this.store.size;
  }

  private updateAccessOrder(path: string): void {
    const index = this.accessOrder.indexOf(path);
    if (index > -1) {
      this.accessOrder.splice(index, 1);
    }
    this.accessOrder.push(path);
  }
}

/**
 * Read a file through the cache if available, falling back to direct
 * disk read. The cache is populated on first read.
 *
 * @param filePath - Absolute path to the file.
 * @param cache - Optional FileCache instance.
 * @returns File content as string, or null if the file doesn't exist.
 */
export async function cachedReadFile(
  filePath: string,
  cache?: FileCache,
): Promise<string | null> {
  if (cache) {
    const cached = cache.get(filePath);
    if (cached !== undefined) return cached;
  }
  try {
    const content = await readFile(filePath, "utf-8");
    cache?.set(filePath, content);
    return content;
  } catch {
    cache?.set(filePath, null);
    return null;
  }
}
