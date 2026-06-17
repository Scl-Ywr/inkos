import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";

export type KnowledgeScope = "project" | "book" | "world";

export interface KnowledgeSource {
  readonly id: string;
  readonly name: string;
  readonly type: "text" | "markdown" | "unknown";
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly charCount: number;
  readonly chunkCount: number;
  readonly summary: string;
  readonly styleProfile: string;
  readonly keywords: readonly string[];
}

export interface KnowledgeChunk {
  readonly id: string;
  readonly sourceId: string;
  readonly sourceName: string;
  readonly index: number;
  readonly text: string;
  readonly keywords: readonly string[];
  readonly vector?: readonly number[];
  readonly charCount: number;
}

interface KnowledgeSearchIndex {
  readonly version: 1;
  readonly chunkCount: number;
  readonly terms: Record<string, readonly string[]>;
}

export interface KnowledgeLibrary {
  readonly scope: KnowledgeScope;
  readonly ownerId: string;
  readonly sources: readonly KnowledgeSource[];
  readonly chunks: readonly KnowledgeChunk[];
  readonly stats: {
    readonly sourceCount: number;
    readonly chunkCount: number;
    readonly charCount: number;
    readonly updatedAt: string | null;
  };
}

export interface AddKnowledgeSourceInput {
  readonly name: string;
  readonly content: string;
}

export interface AddKnowledgeSourceResult extends KnowledgeLibrary {
  readonly truncated: boolean;
  readonly originalCharCount: number;
}

export interface KnowledgeSearchResult {
  readonly query: string;
  readonly sources: readonly KnowledgeSource[];
  readonly chunks: ReadonlyArray<KnowledgeChunk & { readonly score: number }>;
  readonly context: string;
}

export interface KnowledgeContextOptions {
  readonly sourceIds?: readonly string[];
}

const SOURCE_INDEX_FILE = "sources.json";
const CHUNK_INDEX_FILE = "chunks.json";
const SEARCH_INDEX_FILE = "search-index.json";
const MAX_CHARS_PER_SOURCE = 800_000;
const CHUNK_TARGET_CHARS = 1_200;
const CHUNK_OVERLAP_CHARS = 160;
const MAX_CONTEXT_CHARS = 8_000;
const EMBEDDING_DIMENSIONS = 48;
const MAX_SEARCH_CANDIDATES = 240;

const STOP_WORDS = new Set([
  "the", "and", "that", "with", "this", "from", "have", "into", "your", "you", "for", "are", "was",
  "一个", "一种", "这个", "那个", "他们", "她们", "我们", "你们", "自己", "已经", "因为", "所以", "但是",
  "然后", "只是", "没有", "不是", "可以", "需要", "进行", "通过", "以及", "如果", "时候",
]);

export class KnowledgeStore {
  constructor(private readonly projectRoot: string) {}

  async load(scope: KnowledgeScope, ownerId: string): Promise<KnowledgeLibrary> {
    const dir = this.libraryDir(scope, ownerId);
    const [sources, chunks] = await Promise.all([
      readJsonFile<KnowledgeSource[]>(join(dir, SOURCE_INDEX_FILE), []),
      readJsonFile<KnowledgeChunk[]>(join(dir, CHUNK_INDEX_FILE), []),
    ]);
    const updatedAt = sources.reduce<string | null>((latest, source) => {
      if (!latest || source.updatedAt > latest) return source.updatedAt;
      return latest;
    }, null);
    return {
      scope,
      ownerId,
      sources,
      chunks,
      stats: {
        sourceCount: sources.length,
        chunkCount: chunks.length,
        charCount: sources.reduce((sum, source) => sum + source.charCount, 0),
        updatedAt,
      },
    };
  }

  async loadOverview(scope: KnowledgeScope, ownerId: string): Promise<KnowledgeLibrary> {
    const library = await this.load(scope, ownerId);
    return {
      ...library,
      chunks: library.chunks.map((chunk) => ({
        ...chunk,
        text: "",
        vector: undefined,
      })),
    };
  }

  async addSource(scope: KnowledgeScope, ownerId: string, input: AddKnowledgeSourceInput): Promise<AddKnowledgeSourceResult> {
    const name = sanitizeSourceName(input.name);
    const normalized = normalizeKnowledgeText(input.content);
    const originalCharCount = normalized.length;
    const truncated = originalCharCount > MAX_CHARS_PER_SOURCE;
    const content = normalized.slice(0, MAX_CHARS_PER_SOURCE);
    if (!content.trim()) {
      throw new Error("Knowledge source content is empty.");
    }
    const now = new Date().toISOString();
    const sourceId = createSourceId(name, content);
    const dir = this.libraryDir(scope, ownerId);
    await mkdir(join(dir, "raw"), { recursive: true });
    await writeFile(join(dir, "raw", `${sourceId}.txt`), content, "utf-8");

    const library = await this.load(scope, ownerId);
    const chunks = splitIntoChunks(content).map((text, index): KnowledgeChunk => ({
      id: `${sourceId}-${index + 1}`,
      sourceId,
      sourceName: name,
      index: index + 1,
      text,
      keywords: extractKeywords(text, 14),
      vector: embedText(text),
      charCount: text.length,
    }));
    const source: KnowledgeSource = {
      id: sourceId,
      name,
      type: inferSourceType(name),
      createdAt: library.sources.find((item) => item.id === sourceId)?.createdAt ?? now,
      updatedAt: now,
      charCount: content.length,
      chunkCount: chunks.length,
      summary: summarizeSource(content),
      styleProfile: buildStyleProfile(content),
      keywords: extractKeywords(content, 24),
    };

    const nextSources = [
      ...library.sources.filter((item) => item.id !== sourceId),
      source,
    ].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const nextChunks = [
      ...library.chunks.filter((item) => item.sourceId !== sourceId),
      ...chunks,
    ];
    await this.saveIndexes(scope, ownerId, nextSources, nextChunks);
    const updated = await this.load(scope, ownerId);
    return { ...updated, truncated, originalCharCount };
  }

  async removeSource(scope: KnowledgeScope, ownerId: string, sourceId: string): Promise<KnowledgeLibrary> {
    const library = await this.load(scope, ownerId);
    const nextSources = library.sources.filter((item) => item.id !== sourceId);
    const nextChunks = library.chunks.filter((item) => item.sourceId !== sourceId);
    await rm(join(this.libraryDir(scope, ownerId), "raw", `${sourceId}.txt`), { force: true }).catch(() => undefined);
    await this.saveIndexes(scope, ownerId, nextSources, nextChunks);
    return this.load(scope, ownerId);
  }

  async rebuild(scope: KnowledgeScope, ownerId: string): Promise<KnowledgeLibrary> {
    const dir = this.libraryDir(scope, ownerId);
    const rawDir = join(dir, "raw");
    const entries = await readdir(rawDir).catch(() => []);
    const sources: KnowledgeSource[] = [];
    const chunks: KnowledgeChunk[] = [];
    for (const entry of entries.filter((item) => item.endsWith(".txt"))) {
      const content = await readFile(join(rawDir, entry), "utf-8").catch(() => "");
      if (!content.trim()) continue;
      const sourceId = entry.replace(/\.txt$/i, "");
      const name = sourceId.replace(/^[a-f0-9]{12}-/, "") || sourceId;
      const now = new Date().toISOString();
      const sourceChunks = splitIntoChunks(content).map((text, index): KnowledgeChunk => ({
        id: `${sourceId}-${index + 1}`,
        sourceId,
        sourceName: name,
        index: index + 1,
        text,
        keywords: extractKeywords(text, 14),
        vector: embedText(text),
        charCount: text.length,
      }));
      sources.push({
        id: sourceId,
        name,
        type: inferSourceType(name),
        createdAt: now,
        updatedAt: now,
        charCount: content.length,
        chunkCount: sourceChunks.length,
        summary: summarizeSource(content),
        styleProfile: buildStyleProfile(content),
        keywords: extractKeywords(content, 24),
      });
      chunks.push(...sourceChunks);
    }
    await this.saveIndexes(scope, ownerId, sources, chunks);
    return this.load(scope, ownerId);
  }

  async search(
    scope: KnowledgeScope,
    ownerId: string,
    query: string,
    limit = 6,
    options: KnowledgeContextOptions = {},
  ): Promise<KnowledgeSearchResult> {
    const library = await this.load(scope, ownerId);
    const allowedSourceIds = new Set((options.sourceIds ?? []).filter(Boolean));
    const filteredSources = allowedSourceIds.size > 0
      ? library.sources.filter((source) => allowedSourceIds.has(source.id))
      : library.sources;
    const filteredChunks = allowedSourceIds.size > 0
      ? library.chunks.filter((chunk) => allowedSourceIds.has(chunk.sourceId))
      : library.chunks;
    const queryKeywords = extractKeywords(query, 20);
    const index = await readJsonFile<KnowledgeSearchIndex | null>(join(this.libraryDir(scope, ownerId), SEARCH_INDEX_FILE), null);
    const queryVector = embedText(query);
    const candidateIds = selectCandidateChunkIds(filteredChunks, index, query, queryKeywords);
    const chunksById = new Map(filteredChunks.map((chunk) => [chunk.id, chunk]));
    const candidates = candidateIds
      .map((id) => chunksById.get(id))
      .filter((chunk): chunk is KnowledgeChunk => Boolean(chunk));
    const searchSpace = candidates.length > 0 ? candidates : filteredChunks.slice(0, MAX_SEARCH_CANDIDATES);
    const scored = searchSpace
      .map((chunk) => ({ ...chunk, score: scoreChunk(chunk, query, queryKeywords) }))
      .map((chunk) => ({
        ...chunk,
        score: chunk.score + cosineSimilarity(chunk.vector ?? embedText(chunk.text), queryVector) * 8,
      }))
      .filter((chunk) => chunk.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(1, limit));
    const sourceIds = new Set(scored.map((chunk) => chunk.sourceId));
    const sources = filteredSources.filter((source) => sourceIds.has(source.id));
    return {
      query,
      sources,
      chunks: scored,
      context: renderKnowledgeContext({ query, sources, chunks: scored }),
    };
  }

  async buildContext(scope: KnowledgeScope, ownerId: string, query: string, options: KnowledgeContextOptions = {}): Promise<string> {
    const result = await this.search(scope, ownerId, query, 6, options);
    return result.context;
  }

  private libraryDir(scope: KnowledgeScope, ownerId: string): string {
    const safeOwner = sanitizeOwnerId(ownerId);
    if (scope === "project") return join(this.projectRoot, "knowledge", "project", safeOwner);
    if (scope === "world") return join(this.projectRoot, "knowledge", "worlds", safeOwner);
    return join(this.projectRoot, "knowledge", "books", safeOwner);
  }

  private async saveIndexes(
    scope: KnowledgeScope,
    ownerId: string,
    sources: readonly KnowledgeSource[],
    chunks: readonly KnowledgeChunk[],
  ): Promise<void> {
    const dir = this.libraryDir(scope, ownerId);
    await mkdir(dir, { recursive: true });
    await Promise.all([
      writeFile(join(dir, SOURCE_INDEX_FILE), `${JSON.stringify(sources, null, 2)}\n`, "utf-8"),
      writeFile(join(dir, CHUNK_INDEX_FILE), `${JSON.stringify(chunks, null, 2)}\n`, "utf-8"),
      writeFile(join(dir, SEARCH_INDEX_FILE), `${JSON.stringify(buildSearchIndex(chunks))}\n`, "utf-8"),
    ]);
  }
}

export async function buildBookKnowledgeContext(input: {
  readonly projectRoot: string;
  readonly bookId: string;
  readonly query: string;
  readonly sourceIds?: readonly string[];
  readonly includeProject?: boolean;
}): Promise<string> {
  const store = new KnowledgeStore(input.projectRoot);
  const selectedSourceIds = (input.sourceIds ?? []).filter(Boolean);
  const includeProject = input.includeProject ?? selectedSourceIds.length === 0;
  const [bookContext, projectContext] = await Promise.all([
    store.buildContext("book", input.bookId, input.query, selectedSourceIds.length ? { sourceIds: selectedSourceIds } : {}),
    includeProject ? store.buildContext("project", "global", input.query) : Promise.resolve(""),
  ]);
  return [bookContext, projectContext].filter(Boolean).join("\n\n");
}

export async function buildWorldKnowledgeContext(input: {
  readonly projectRoot: string;
  readonly worldId: string;
  readonly query: string;
}): Promise<string> {
  const store = new KnowledgeStore(input.projectRoot);
  const [worldContext, projectContext] = await Promise.all([
    store.buildContext("world", input.worldId, input.query),
    store.buildContext("project", "global", input.query),
  ]);
  return [worldContext, projectContext].filter(Boolean).join("\n\n");
}

function renderKnowledgeContext(input: {
  readonly query: string;
  readonly sources: readonly KnowledgeSource[];
  readonly chunks: ReadonlyArray<KnowledgeChunk & { readonly score: number }>;
}): string {
  if (input.chunks.length === 0) return "";
  const sourceBlock = input.sources
    .map((source) => [
      `- ${source.name}`,
      `  摘要：${source.summary}`,
      `  文风：${source.styleProfile}`,
      source.keywords.length ? `  关键词：${source.keywords.slice(0, 10).join("、")}` : "",
    ].filter(Boolean).join("\n"))
    .join("\n");
  const chunkBlock = input.chunks
    .map((chunk, index) => {
      const excerpt = chunk.text.length > 520 ? `${chunk.text.slice(0, 520)}...` : chunk.text;
      return `${index + 1}. 来源《${chunk.sourceName}》#${chunk.index}：\n${excerpt}`;
    })
    .join("\n\n");
  return [
    "## 知识库参考",
    "以下内容来自用户上传资料，只用于保持设定、术语、语气和素材一致；不得照抄原文连续表达，必须改写成当前作品的原创正文。",
    input.query.trim() ? `检索意图：${input.query.trim().slice(0, 240)}` : "",
    sourceBlock ? `### 命中资料\n${sourceBlock}` : "",
    `### 相关片段\n${chunkBlock}`,
  ].filter(Boolean).join("\n\n").slice(0, MAX_CONTEXT_CHARS);
}

function splitIntoChunks(content: string): string[] {
  const paragraphs = content.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
  const chunks: string[] = [];
  let current = "";
  for (const paragraph of (paragraphs.length ? paragraphs : [content]).flatMap(splitOversizedBlock)) {
    if ((current + "\n\n" + paragraph).length > CHUNK_TARGET_CHARS && current.trim()) {
      chunks.push(current.trim());
      current = current.slice(Math.max(0, current.length - CHUNK_OVERLAP_CHARS));
    }
    current = [current, paragraph].filter(Boolean).join("\n\n");
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks.length ? chunks : [content.trim()];
}

function splitOversizedBlock(block: string): string[] {
  if (block.length <= CHUNK_TARGET_CHARS * 1.35) return [block];
  const parts: string[] = [];
  let offset = 0;
  while (offset < block.length) {
    const hardEnd = Math.min(block.length, offset + CHUNK_TARGET_CHARS);
    const window = block.slice(offset, hardEnd);
    const sentenceBreak = Math.max(
      window.lastIndexOf("。"),
      window.lastIndexOf("！"),
      window.lastIndexOf("？"),
      window.lastIndexOf(". "),
      window.lastIndexOf("! "),
      window.lastIndexOf("? "),
    );
    const end = sentenceBreak > CHUNK_TARGET_CHARS * 0.55
      ? offset + sentenceBreak + 1
      : hardEnd;
    parts.push(block.slice(offset, end).trim());
    if (end >= block.length) break;
    offset = Math.max(end - CHUNK_OVERLAP_CHARS, offset + 1);
  }
  return parts.filter(Boolean);
}

function normalizeKnowledgeText(content: string): string {
  return content
    .replace(/\r\n?/g, "\n")
    .replace(/\u0000/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}

function summarizeSource(content: string): string {
  const cleaned = content.replace(/[#>*_`|[\]()]/g, " ").replace(/\s+/g, " ").trim();
  if (cleaned.length <= 180) return cleaned;
  const firstSentence = cleaned.split(/(?<=[。！？.!?])\s*/).find((part) => part.length >= 24);
  return (firstSentence ?? cleaned).slice(0, 180);
}

function buildStyleProfile(content: string): string {
  const normalized = content.replace(/\s+/g, "");
  const punctuation = (normalized.match(/[，。！？；：、,.!?;:]/g) ?? []).length;
  const dialogue = (content.match(/[“”"「」『』]/g) ?? []).length;
  const sentences = content.split(/[。！？.!?]+/).map((part) => part.trim()).filter(Boolean);
  const avgSentence = sentences.length
    ? Math.round(sentences.reduce((sum, item) => sum + item.length, 0) / sentences.length)
    : 0;
  const density = normalized.length ? punctuation / normalized.length : 0;
  const rhythm = avgSentence > 55 ? "长句铺陈" : avgSentence < 24 ? "短句推进" : "中等句长";
  const dialogueStyle = dialogue > 20 ? "对话感明显" : dialogue > 4 ? "对话适中" : "叙述为主";
  const texture = density > 0.12 ? "标点密集、节奏切分强" : "段落连贯、节奏较稳";
  return `${rhythm}；${dialogueStyle}；${texture}`;
}

function extractKeywords(content: string, limit: number): string[] {
  const words = new Map<string, number>();
  const ascii = content.toLowerCase().match(/[a-z][a-z0-9_-]{2,}/g) ?? [];
  for (const word of ascii) {
    if (!STOP_WORDS.has(word)) words.set(word, (words.get(word) ?? 0) + 1);
  }
  const cjk = content.match(/[\p{Script=Han}]{2,8}/gu) ?? [];
  for (const raw of cjk) {
    for (const word of sliceCjkTerms(raw)) {
      if (!STOP_WORDS.has(word)) words.set(word, (words.get(word) ?? 0) + 1);
    }
  }
  return [...words.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].length - b[0].length)
    .slice(0, limit)
    .map(([word]) => word);
}

function sliceCjkTerms(value: string): string[] {
  if (value.length <= 4) return [value];
  const terms: string[] = [];
  for (let i = 0; i < value.length - 1; i += 2) {
    terms.push(value.slice(i, Math.min(value.length, i + 4)));
  }
  return terms;
}

function buildSearchIndex(chunks: readonly KnowledgeChunk[]): KnowledgeSearchIndex {
  const terms = new Map<string, Set<string>>();
  for (const chunk of chunks) {
    for (const term of termsForIndex([chunk.sourceName, ...chunk.keywords, chunk.text].join("\n"))) {
      if (!terms.has(term)) terms.set(term, new Set());
      terms.get(term)?.add(chunk.id);
    }
  }
  return {
    version: 1,
    chunkCount: chunks.length,
    terms: Object.fromEntries(
      [...terms.entries()].map(([term, ids]) => [term, [...ids].slice(0, MAX_SEARCH_CANDIDATES)]),
    ),
  };
}

function selectCandidateChunkIds(
  chunks: readonly KnowledgeChunk[],
  index: KnowledgeSearchIndex | null,
  query: string,
  queryKeywords: readonly string[],
): readonly string[] {
  if (!query.trim()) return chunks.slice(0, MAX_SEARCH_CANDIDATES).map((chunk) => chunk.id);
  const scores = new Map<string, number>();
  const queryTerms = termsForIndex([query, ...queryKeywords].join(" "));
  if (index?.version === 1 && index.chunkCount > 0) {
    for (const term of queryTerms) {
      const ids = index.terms[term] ?? [];
      for (const id of ids) scores.set(id, (scores.get(id) ?? 0) + 3);
    }
  }
  if (scores.size === 0) {
    for (const chunk of chunks) {
      let score = 0;
      const name = chunk.sourceName.toLowerCase();
      for (const keyword of queryKeywords) {
        const lower = keyword.toLowerCase();
        if (name.includes(lower)) score += 3;
        if (chunk.keywords.some((item) => item.toLowerCase() === lower)) score += 2;
      }
      if (score > 0) scores.set(chunk.id, score);
      if (scores.size >= MAX_SEARCH_CANDIDATES) break;
    }
  }
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_SEARCH_CANDIDATES)
    .map(([id]) => id);
}

function termsForIndex(content: string): readonly string[] {
  const terms = new Set<string>();
  for (const keyword of extractKeywords(content, 80)) {
    const lower = keyword.toLowerCase();
    if (lower.length >= 2) terms.add(lower);
  }
  const ascii = content.toLowerCase().match(/[a-z][a-z0-9_-]{2,}/g) ?? [];
  for (const word of ascii) {
    if (!STOP_WORDS.has(word)) terms.add(word);
  }
  return [...terms];
}

function embedText(content: string): readonly number[] {
  const vector = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
  for (const term of termsForIndex(content)) {
    const hash = hashTerm(term);
    const index = hash % EMBEDDING_DIMENSIONS;
    const sign = hash % 2 === 0 ? 1 : -1;
    vector[index] += sign * Math.min(3, Math.max(1, term.length / 2));
  }
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (!magnitude) return vector;
  return vector.map((value) => Number((value / magnitude).toFixed(5)));
}

function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  let score = 0;
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    score += (a[i] ?? 0) * (b[i] ?? 0);
  }
  return Number.isFinite(score) ? Math.max(0, score) : 0;
}

function hashTerm(term: string): number {
  let hash = 2166136261;
  for (let i = 0; i < term.length; i += 1) {
    hash ^= term.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function scoreChunk(chunk: KnowledgeChunk, query: string, queryKeywords: readonly string[]): number {
  if (!query.trim()) return chunk.index === 1 ? 1 : 0.2;
  const text = chunk.text.toLowerCase();
  const sourceName = chunk.sourceName.toLowerCase();
  let score = 0;
  for (const keyword of queryKeywords) {
    const lower = keyword.toLowerCase();
    if (text.includes(lower)) score += 4;
    if (sourceName.includes(lower)) score += 3;
    if (chunk.keywords.some((item) => item.toLowerCase() === lower)) score += 2;
  }
  const compactQuery = query.replace(/\s+/g, "");
  if (compactQuery.length >= 4 && chunk.text.includes(compactQuery.slice(0, 24))) score += 6;
  return score;
}

function inferSourceType(name: string): KnowledgeSource["type"] {
  const ext = extname(name).toLowerCase();
  if (ext === ".md" || ext === ".markdown") return "markdown";
  if (ext === ".txt") return "text";
  return "unknown";
}

function createSourceId(name: string, content: string): string {
  const digest = createHash("sha256").update(`${name}\n${content}`).digest("hex").slice(0, 12);
  const stem = basename(name, extname(name)).replace(/[^\p{Letter}\p{Number}_-]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return `${digest}-${stem || "source"}`;
}

function sanitizeSourceName(name: string): string {
  return basename(name.trim() || "knowledge.txt").replace(/[\\/:*?"<>|]+/g, "-").slice(0, 120);
}

function sanitizeOwnerId(ownerId: string): string {
  return ownerId.replace(/[\\/:*?"<>|]+/g, "_").slice(0, 160) || "global";
}

async function readJsonFile<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, "utf-8")) as T;
  } catch {
    return fallback;
  }
}
