import { estimateTextTokens } from "../llm/provider.js";

export interface TruthContextCacheMetrics {
  readonly hits: number;
  readonly misses: number;
  readonly entries: number;
  readonly chars: number;
  readonly loadMs: number;
  readonly budgetReads: number;
  readonly trimmedReads: number;
  readonly charsBeforeTrim: number;
  readonly charsAfterTrim: number;
  readonly tokensBeforeTrim: number;
  readonly tokensAfterTrim: number;
  readonly fields: Readonly<Record<string, TruthContextFieldMetrics>>;
}

export interface TruthContextFieldMetrics {
  readonly reads: number;
  readonly trimmedReads: number;
  readonly charsBefore: number;
  readonly charsAfter: number;
  readonly charsOmitted: number;
  readonly tokensBefore: number;
  readonly tokensAfter: number;
  readonly tokensOmitted: number;
}

export class TruthContextCache {
  private readonly entries = new Map<string, Promise<unknown>>();
  private hits = 0;
  private misses = 0;
  private chars = 0;
  private loadMs = 0;
  private budgetReads = 0;
  private trimmedReads = 0;
  private charsBeforeTrim = 0;
  private charsAfterTrim = 0;
  private tokensBeforeTrim = 0;
  private tokensAfterTrim = 0;
  private readonly fieldMetrics = new Map<string, TruthContextFieldMetrics>();

  has(key: string): boolean {
    return this.entries.has(key);
  }

  async peek<T>(key: string): Promise<T | undefined> {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.hits++;
    return await entry as T;
  }

  async getOrLoad<T>(key: string, loader: () => Promise<T>): Promise<T> {
    const existing = this.entries.get(key);
    if (existing) {
      this.hits++;
      return await existing as T;
    }

    this.misses++;
    const startedAt = Date.now();
    const pending = loader().then((value) => {
      this.loadMs += Date.now() - startedAt;
      this.chars += estimateStringChars(value);
      return value;
    });
    this.entries.set(key, pending);
    try {
      return await pending;
    } catch (error) {
      this.entries.delete(key);
      throw error;
    }
  }

  recordBudget(result: TruthContextBudgetResult<object>): void {
    this.budgetReads++;
    if (result.afterTokens < result.beforeTokens) this.trimmedReads++;
    this.charsBeforeTrim += result.beforeChars;
    this.charsAfterTrim += result.afterChars;
    this.tokensBeforeTrim += result.beforeTokens;
    this.tokensAfterTrim += result.afterTokens;
    for (const [field, metrics] of Object.entries(result.fields)) {
      const previous = this.fieldMetrics.get(field);
      this.fieldMetrics.set(field, {
        reads: (previous?.reads ?? 0) + 1,
        trimmedReads: (previous?.trimmedReads ?? 0) + (metrics.tokensAfter < metrics.tokensBefore ? 1 : 0),
        charsBefore: (previous?.charsBefore ?? 0) + metrics.charsBefore,
        charsAfter: (previous?.charsAfter ?? 0) + metrics.charsAfter,
        charsOmitted: (previous?.charsOmitted ?? 0) + metrics.charsOmitted,
        tokensBefore: (previous?.tokensBefore ?? 0) + metrics.tokensBefore,
        tokensAfter: (previous?.tokensAfter ?? 0) + metrics.tokensAfter,
        tokensOmitted: (previous?.tokensOmitted ?? 0) + metrics.tokensOmitted,
      });
    }
  }

  metrics(): TruthContextCacheMetrics {
    return {
      hits: this.hits,
      misses: this.misses,
      entries: this.entries.size,
      chars: this.chars,
      loadMs: this.loadMs,
      budgetReads: this.budgetReads,
      trimmedReads: this.trimmedReads,
      charsBeforeTrim: this.charsBeforeTrim,
      charsAfterTrim: this.charsAfterTrim,
      tokensBeforeTrim: this.tokensBeforeTrim,
      tokensAfterTrim: this.tokensAfterTrim,
      fields: Object.fromEntries(this.fieldMetrics),
    };
  }

  summary(): string {
    const metrics = this.metrics();
    if (metrics.budgetReads === 0) {
      return `context cache: ${metrics.hits} hit(s), ${metrics.misses} load(s); compression not checked`;
    }
    const savedTokens = Math.max(0, metrics.tokensBeforeTrim - metrics.tokensAfterTrim);
    if (savedTokens === 0) {
      return `context compression: not needed (${metrics.tokensAfterTrim} tokens within budget)`;
    }
    const savedPercent = metrics.tokensBeforeTrim > 0
      ? Math.round((savedTokens / metrics.tokensBeforeTrim) * 100)
      : 0;
    return `context compression: applied ${metrics.tokensBeforeTrim} -> ${metrics.tokensAfterTrim} tokens, saved ${savedTokens} (${savedPercent}%)`;
  }
}

export interface TruthContextReadOptions {
  readonly cache?: TruthContextCache;
  readonly maxChars?: number;
  readonly maxTokens?: number;
  readonly inputTokenBudget?: number;
  readonly cacheFiles?: boolean;
}

export interface TruthContextBudgetOptions {
  readonly labels?: Readonly<Record<string, string>>;
  readonly weights?: Readonly<Record<string, number>>;
}

export interface TruthContextBudgetResult<T extends object> {
  readonly context: T;
  readonly beforeChars: number;
  readonly afterChars: number;
  readonly beforeTokens: number;
  readonly afterTokens: number;
  readonly fields: Readonly<Record<string, Omit<TruthContextFieldMetrics, "reads" | "trimmedReads">>>;
}

export function contextCacheKey(
  kind: string,
  bookDir: string,
  fallback: string,
  budget?: Pick<TruthContextReadOptions, "maxChars" | "maxTokens" | "inputTokenBudget">,
): string {
  const maxCharsKey = Number.isFinite(budget?.maxChars)
    ? `:maxChars=${Math.max(0, Math.floor(budget!.maxChars!))}`
    : "";
  const maxTokensKey = Number.isFinite(budget?.maxTokens)
    ? `:maxTokens=${Math.max(0, Math.floor(budget!.maxTokens!))}`
    : "";
  const inputTokenBudgetKey = Number.isFinite(budget?.inputTokenBudget)
    ? `:inputTokens=${Math.max(0, Math.floor(budget!.inputTokenBudget!))}`
    : "";
  return `${kind}:${bookDir}:${fallback}${maxCharsKey}${maxTokensKey}${inputTokenBudgetKey}`;
}

export function fileCacheKey(path: string, fallback: string): string {
  return `file:${path}:${fallback}`;
}

export function contextTokenBudgetFromWindow(
  contextWindowTokens: number | undefined,
  reservedOutputTokens: number,
  fixedInputTokens = 0,
): number | undefined {
  if (!Number.isFinite(contextWindowTokens) || !contextWindowTokens || contextWindowTokens <= 0) {
    return undefined;
  }
  return Math.max(
    0,
    Math.floor(contextWindowTokens - Math.max(0, reservedOutputTokens) - Math.max(0, fixedInputTokens)),
  );
}

export function applyTruthContextBudget<T extends object>(
  context: T,
  budget: Pick<TruthContextReadOptions, "maxChars" | "maxTokens" | "inputTokenBudget">,
  options: TruthContextBudgetOptions = {},
): TruthContextBudgetResult<T> {
  const entries = Object.entries(context).filter((entry): entry is [string, string] => typeof entry[1] === "string");
  const beforeChars = entries.reduce((sum, [, content]) => sum + content.length, 0);
  const beforeTokens = entries.reduce((sum, [, content]) => sum + estimateTextTokens(content), 0);
  const maxTokens = resolveTokenBudget(budget);
  if (maxTokens === undefined || beforeTokens <= maxTokens) {
    return buildBudgetResult(context, context, entries);
  }

  const fixedEntries = entries.filter(([, content]) => isMissingContextPlaceholder(content));
  const trimmableEntries = entries.filter(([, content]) => !isMissingContextPlaceholder(content));
  const fixedTokens = fixedEntries.reduce((sum, [, content]) => sum + estimateTextTokens(content), 0);
  const allocations = allocateWeightedTokens(
    trimmableEntries.map(([key, content]) => [key, estimateTextTokens(content)] as const),
    Math.max(0, maxTokens - fixedTokens),
    options.weights,
  );
  const trimmed = { ...context } as Record<string, unknown>;
  for (const [key, content] of trimmableEntries) {
    trimmed[key] = trimStructuredTextToTokens(
      content,
      allocations.get(key) ?? 0,
      options.labels?.[key] ?? key,
    );
  }
  return buildBudgetResult(context, trimmed as T, entries);
}

export function isTruthContextBudgeted(options?: TruthContextReadOptions): boolean {
  return options?.cacheFiles === false
    || Number.isFinite(options?.maxChars)
    || Number.isFinite(options?.maxTokens)
    || Number.isFinite(options?.inputTokenBudget);
}

function allocateWeightedTokens(
  entries: ReadonlyArray<readonly [string, number]>,
  maxTokens: number,
  weights: Readonly<Record<string, number>> | undefined,
): ReadonlyMap<string, number> {
  const allocations = new Map(entries.map(([key]) => [key, 0]));
  let remainingBudget = maxTokens;
  let active = entries.map(([key, tokens]) => ({
    key,
    tokens,
    weight: normalizeWeight(weights?.[key]),
  }));

  while (active.length > 0 && remainingBudget > 0) {
    const totalWeight = active.reduce((sum, entry) => sum + entry.weight, 0);
    const fullyFunded = active.filter((entry) =>
      entry.tokens <= Math.floor(remainingBudget * entry.weight / totalWeight)
    );
    if (fullyFunded.length === 0) break;
    const fundedKeys = new Set(fullyFunded.map((entry) => entry.key));
    for (const entry of fullyFunded) {
      allocations.set(entry.key, entry.tokens);
      remainingBudget -= entry.tokens;
    }
    active = active.filter((entry) => !fundedKeys.has(entry.key));
  }

  if (active.length === 0 || remainingBudget <= 0) return allocations;

  const totalWeight = active.reduce((sum, entry) => sum + entry.weight, 0);
  for (const entry of active) {
    const share = Math.min(entry.tokens, Math.floor(remainingBudget * entry.weight / totalWeight));
    allocations.set(entry.key, share);
  }

  let allocated = [...allocations.values()].reduce((sum, value) => sum + value, 0);
  while (allocated < maxTokens) {
    const candidate = active.find((entry) => (allocations.get(entry.key) ?? 0) < entry.tokens);
    if (!candidate) break;
    allocations.set(candidate.key, (allocations.get(candidate.key) ?? 0) + 1);
    allocated++;
  }
  return allocations;
}

function normalizeWeight(value: number | undefined): number {
  return Number.isFinite(value) && value! > 0 ? value! : 1;
}

function resolveTokenBudget(
  budget: Pick<TruthContextReadOptions, "maxChars" | "maxTokens" | "inputTokenBudget">,
): number | undefined {
  if (Number.isFinite(budget.inputTokenBudget)) {
    return Math.max(0, Math.floor(budget.inputTokenBudget!));
  }
  if (Number.isFinite(budget.maxTokens)) return Math.max(0, Math.floor(budget.maxTokens!));
  if (Number.isFinite(budget.maxChars)) return estimateTextTokens("x".repeat(Math.max(0, Math.floor(budget.maxChars!))));
  return undefined;
}

function buildBudgetResult<T extends object>(
  before: T,
  after: T,
  entries: ReadonlyArray<readonly [string, string]>,
): TruthContextBudgetResult<T> {
  const fields = Object.fromEntries(entries.map(([key, content]) => {
    const afterContent = String((after as Record<string, unknown>)[key] ?? "");
    return [key, {
      charsBefore: content.length,
      charsAfter: afterContent.length,
      charsOmitted: Math.max(0, content.length - afterContent.length),
      tokensBefore: estimateTextTokens(content),
      tokensAfter: estimateTextTokens(afterContent),
      tokensOmitted: Math.max(0, estimateTextTokens(content) - estimateTextTokens(afterContent)),
    }];
  }));
  return {
    context: after,
    beforeChars: entries.reduce((sum, [, content]) => sum + content.length, 0),
    afterChars: Object.values(fields).reduce((sum, metrics) => sum + metrics.charsAfter, 0),
    beforeTokens: Object.values(fields).reduce((sum, metrics) => sum + metrics.tokensBefore, 0),
    afterTokens: Object.values(fields).reduce((sum, metrics) => sum + metrics.tokensAfter, 0),
    fields,
  };
}

function trimStructuredTextToTokens(content: string, maxTokens: number, label: string): string {
  if (maxTokens <= 0) return "";
  if (estimateTextTokens(content) <= maxTokens) return content;
  const json = trimJsonToTokens(content, maxTokens, label);
  if (json !== undefined) return json;

  const blocks = splitMarkdownBlocks(content);
  const marker = `\n\n[InkOS context budget: omitted content from ${label}; kept complete structural blocks from beginning and latest tail.]\n\n`;
  if (estimateTextTokens(marker) >= maxTokens) return sliceTextToTokens(content, maxTokens);

  const selectedHead: string[] = [];
  const selectedTail: string[] = [];
  let used = estimateTextTokens(marker);
  let head = 0;
  let tail = blocks.length - 1;
  while (head <= tail) {
    const takeHead = selectedHead.length <= selectedTail.length;
    const index = takeHead ? head : tail;
    const block = blocks[index]!;
    const nextHead = takeHead ? [...selectedHead, block] : selectedHead;
    const nextTail = takeHead ? selectedTail : [block, ...selectedTail];
    const candidate = `${nextHead.join("\n\n")}${marker}${nextTail.join("\n\n")}`;
    if (estimateTextTokens(candidate) <= maxTokens) {
      if (takeHead) {
        selectedHead.push(block);
        head++;
      } else {
        selectedTail.unshift(block);
        tail--;
      }
      used = estimateTextTokens(candidate);
      continue;
    }
    if (selectedHead.length === 0 && selectedTail.length === 0) {
      return sliceTextToTokens(content, maxTokens, marker);
    }
    if (takeHead) head++;
    else tail--;
  }
  return `${selectedHead.join("\n\n")}${marker}${selectedTail.join("\n\n")}`;
}

function splitMarkdownBlocks(content: string): string[] {
  const lines = content.split(/\r?\n/);
  const blocks: string[] = [];
  let current: string[] = [];
  const flush = () => {
    if (current.length > 0) blocks.push(current.join("\n"));
    current = [];
  };
  for (const line of lines) {
    if (/^#{1,6}\s/.test(line) || line.trim() === "") {
      flush();
      if (line.trim()) blocks.push(line);
      continue;
    }
    if (line.startsWith("|")) {
      flush();
      blocks.push(line);
      continue;
    }
    current.push(line);
  }
  flush();
  return blocks;
}

function trimJsonToTokens(content: string, maxTokens: number, label: string): string | undefined {
  const trimmed = content.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined;
  try {
    JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  const marker = JSON.stringify({ _inkos_context_budget: `omitted ${label}` });
  if (estimateTextTokens(marker) <= maxTokens) return marker;
  return "{}";
}

function sliceTextToTokens(content: string, maxTokens: number, marker = ""): string {
  const markerTokens = estimateTextTokens(marker);
  if (markerTokens >= maxTokens) return binarySearchPrefix(content, maxTokens);
  const remaining = maxTokens - markerTokens;
  const headBudget = Math.ceil(remaining * 0.55);
  const tailBudget = remaining - headBudget;
  return `${binarySearchPrefix(content, headBudget)}${marker}${binarySearchSuffix(content, tailBudget)}`;
}

function binarySearchPrefix(content: string, maxTokens: number): string {
  let low = 0;
  let high = content.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (estimateTextTokens(content.slice(0, mid)) <= maxTokens) low = mid;
    else high = mid - 1;
  }
  return content.slice(0, low);
}

function binarySearchSuffix(content: string, maxTokens: number): string {
  let low = 0;
  let high = content.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (estimateTextTokens(content.slice(-mid)) <= maxTokens) low = mid;
    else high = mid - 1;
  }
  return content.slice(-low);
}

function isMissingContextPlaceholder(content: string): boolean {
  return content === "(文件不存在)" || content === "(文件尚未创建)";
}

function estimateStringChars(value: unknown): number {
  if (typeof value === "string") return value.length;
  if (Array.isArray(value)) {
    return value.reduce((sum, item) => sum + estimateStringChars(item), 0);
  }
  if (value && typeof value === "object") {
    return Object.values(value).reduce((sum, item) => sum + estimateStringChars(item), 0);
  }
  return 0;
}
