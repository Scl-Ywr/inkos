import { BaseAgent } from "./base.js";
import type { BookConfig } from "../models/book.js";
import type { GenreProfile } from "../models/genre-profile.js";
import type { BookRules } from "../models/book-rules.js";
import { buildWriterSystemPrompt, type FanficContext } from "./writer-prompts.js";
import { WRITING_MAX_OUTPUT_TOKENS } from "../llm/provider.js";
import { buildSettlerSystemPrompt, buildSettlerUserPrompt } from "./settler-prompts.js";
import { parseSettlerDeltaOutput } from "./settler-delta-parser.js";
import { parseSettlementOutput } from "./settler-parser.js";
import { readGenreProfile, readBookRules } from "./rules-reader.js";
import {
  detectCrossChapterRepetition,
  detectParagraphLengthDrift,
  normalizePostWriteSurface,
  validatePostWrite,
  type PostWriteViolation,
} from "./post-write-validator.js";
import { analyzeAITells } from "./ai-tells.js";
import type { FileCache } from "../utils/file-cache.js";
import type { ChapterIntent, ChapterMemo, ContextPackage, RuleStack } from "../models/input-governance.js";
import type { LengthSpec } from "../models/length-governance.js";
import type { RuntimeStateDelta } from "../models/runtime-state.js";
import { buildLengthSpec, countChapterLength } from "../utils/length-metrics.js";
import {
  capContextBlock,
  filterHooks,
  filterSummaries,
  filterSubplots,
  filterEmotionalArcs,
  filterCharacterMatrix,
} from "../utils/context-filter.js";
import { buildGovernedMemoryEvidenceBlocks } from "../utils/governed-context.js";
import {
  buildGovernedCharacterMatrixWorkingSet,
  buildGovernedHookWorkingSet,
  mergeCharacterMatrixMarkdown,
  mergeTableMarkdownByKey,
} from "../utils/governed-working-set.js";
import { extractPOVFromOutline, filterMatrixByPOV, filterHooksByPOV } from "../utils/pov-filter.js";
import { parseCreativeOutput } from "./writer-parser.js";
import { buildRuntimeStateArtifacts, saveRuntimeStateSnapshot, type RuntimeStateArtifacts } from "../state/runtime-state-store.js";
import type { RuntimeStateSnapshot } from "../state/state-reducer.js";
import { parsePendingHooksMarkdown } from "../utils/memory-retrieval.js";
import { analyzeHookHealth } from "../utils/hook-health.js";
import { buildEnglishVarianceBrief } from "../utils/long-span-fatigue.js";
import {
  buildNarrativeIntentBrief,
  renderMemoAsNarrativeBlock,
  renderNarrativeSelectedContext,
  sanitizeNarrativeEvidenceBlock,
} from "../utils/narrative-control.js";
import { compressWithCcr } from "../utils/headroom-cache.js";
import { INKOS_PROMPT_CACHE_POLICY, normalizePromptForCache, type HeadroomLightMode } from "../utils/prompt-optimizer.js";
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";

const LEGACY_WRITER_CONTEXT_BUDGET = {
  storyBible: 14_000,
  currentState: 7_000,
  ledger: 6_000,
  hooks: 9_000,
  chapterSummaries: 9_000,
  subplotBoard: 7_000,
  emotionalArcs: 7_000,
  characterMatrix: 12_000,
  parentCanon: 12_000,
  volumeOutline: 12_000,
  recentChapters: 16_000,
  dialogueFingerprints: 6_000,
  relevantSummaries: 6_000,
  governedSelectedContext: 14_000,
  governedEvidence: 10_000,
} as const;
import {
  readStoryFrame,
  readVolumeMap,
  readCharacterContext,
  readCurrentStateWithFallback,
} from "../utils/outline-paths.js";

export interface WriteChapterInput {
  readonly book: BookConfig;
  readonly bookDir: string;
  readonly chapterNumber: number;
  readonly externalContext?: string;
  readonly chapterIntent?: string;
  readonly chapterMemo?: ChapterMemo;
  readonly chapterIntentData?: ChapterIntent;
  readonly contextPackage?: ContextPackage;
  readonly ruleStack?: RuleStack;
  readonly lengthSpec?: LengthSpec;
  readonly wordCountOverride?: number;
  readonly temperatureOverride?: number;
  readonly fileCache?: FileCache;
  readonly skipSettlement?: boolean;
}

export interface SettleChapterStateInput {
  readonly book: BookConfig;
  readonly bookDir: string;
  readonly chapterNumber: number;
  readonly title: string;
  readonly content: string;
  readonly allowReapply?: boolean;
  readonly chapterIntent?: string;
  readonly contextPackage?: ContextPackage;
  readonly ruleStack?: RuleStack;
  readonly validationFeedback?: string;
  readonly fileCache?: FileCache;
}

export interface TokenUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
}

export interface WriteChapterOutput {
  readonly chapterNumber: number;
  readonly title: string;
  readonly content: string;
  readonly wordCount: number;
  readonly preWriteCheck: string;
  readonly postSettlement: string;
  readonly runtimeStateDelta?: RuntimeStateDelta;
  readonly runtimeStateSnapshot?: RuntimeStateSnapshot;
  readonly updatedState: string;
  readonly updatedLedger: string;
  readonly updatedHooks: string;
  readonly chapterSummary: string;
  readonly updatedChapterSummaries?: string;
  readonly updatedSubplots: string;
  readonly updatedEmotionalArcs: string;
  readonly updatedCharacterMatrix: string;
  readonly postWriteErrors: ReadonlyArray<PostWriteViolation>;
  readonly postWriteWarnings: ReadonlyArray<PostWriteViolation>;
  readonly hookHealthIssues?: ReadonlyArray<{
    readonly severity: "critical" | "warning" | "info";
    readonly category: string;
    readonly description: string;
    readonly suggestion: string;
  }>;
  readonly tokenUsage?: TokenUsage;
}

export class WriterAgent extends BaseAgent {
  get name(): string {
    return "writer";
  }

  private localize(language: "zh" | "en", messages: { zh: string; en: string }): string {
    return language === "en" ? messages.en : messages.zh;
  }

  private logInfo(language: "zh" | "en", messages: { zh: string; en: string }): void {
    this.ctx.logger?.info(this.localize(language, messages));
  }

  private logWarn(language: "zh" | "en", messages: { zh: string; en: string }): void {
    this.ctx.logger?.warn(this.localize(language, messages));
  }

  private fileCache?: FileCache;

  async writeChapter(input: WriteChapterInput): Promise<WriteChapterOutput> {
    const { book, bookDir, chapterNumber } = input;
    this.fileCache = input.fileCache;

    const placeholder = "(文件尚未创建)";
    const cache = this.fileCache;
    const truthFilesPromise = Promise.all([
        readStoryFrame(bookDir, placeholder),
        readVolumeMap(bookDir, placeholder),
        this.readFileOrDefault(join(bookDir, "story/style_guide.md"), cache),
        // Phase 5 consolidation: architect no longer emits an initial current_state
        // section. When the file is only a seed placeholder, derive initial state
        // from roles/*.Current_State + pending_hooks startChapter=0 rows so the
        // writer still sees substantive content instead of a runtime-append note.
        readCurrentStateWithFallback(bookDir, placeholder),
        this.readFileOrDefault(join(bookDir, "story/particle_ledger.md"), cache),
        this.readFileOrDefault(join(bookDir, "story/pending_hooks.md"), cache),
        this.readFileOrDefault(join(bookDir, "story/chapter_summaries.md"), cache),
        this.readFileOrDefault(join(bookDir, "story/subplot_board.md"), cache),
        this.readFileOrDefault(join(bookDir, "story/emotional_arcs.md"), cache),
        readCharacterContext(bookDir, placeholder),
        this.readFileOrDefault(join(bookDir, "story/style_profile.json"), cache),
        this.readFileOrDefault(join(bookDir, "story/parent_canon.md"), cache),
        this.readFileOrDefault(join(bookDir, "story/fanfic_canon.md"), cache),
      ]);
    const recentChapterListPromise = this.loadRecentChapterList(bookDir, INKOS_PROMPT_CACHE_POLICY.rollingChapterWindow);
    const genreProfilePromise = readGenreProfile(this.ctx.projectRoot, book.genre);
    const bookRulesPromise = readBookRules(bookDir);

    const [
      [
        storyBible, volumeOutline, styleGuide, currentState, ledger, hooks,
        chapterSummaries, subplotBoard, emotionalArcs, characterMatrix, styleProfileRaw,
        parentCanon, fanficCanonRaw,
      ],
      recentChapterList,
      { profile: genreProfile, body: genreBody },
      parsedBookRules,
    ] = await Promise.all([
      truthFilesPromise,
      recentChapterListPromise,
      genreProfilePromise,
      bookRulesPromise,
    ]);
    const recentChapterPayload = recentChapterList as ReadonlyArray<string> | string;
    const recentChapters = typeof recentChapterPayload === "string"
      ? recentChapterPayload
      : this.joinRecentChapterList(recentChapterPayload.slice(-1));
    // Load more chapters for dialogue fingerprint extraction (voice consistency over longer span)
    const fingerprintChapters = this.joinRecentChapterList(recentChapterPayload);
    const bookRules = parsedBookRules?.rules ?? null;
    const bookRulesBody = parsedBookRules?.body ?? "";

    const styleFingerprint = this.buildStyleFingerprint(styleProfileRaw);

    const dialogueFingerprints = this.extractDialogueFingerprints(fingerprintChapters, storyBible);
    const relevantSummaries = this.findRelevantSummaries(chapterSummaries, volumeOutline, chapterNumber);

    const hasParentCanon = parentCanon !== "(文件尚未创建)";
    const hasFanficCanon = fanficCanonRaw !== "(文件尚未创建)";
    const resolvedLanguage = book.language ?? genreProfile.language;
    const targetWords = input.lengthSpec?.target ?? input.wordCountOverride ?? book.chapterWordCount;
    const resolvedLengthSpec = input.lengthSpec ?? buildLengthSpec(targetWords, resolvedLanguage);
    const governedMemoryBlocks = input.contextPackage
      ? buildGovernedMemoryEvidenceBlocks(input.contextPackage, resolvedLanguage)
      : undefined;
    const englishVarianceBrief = resolvedLanguage === "en"
      ? await buildEnglishVarianceBrief({
          bookDir,
          chapterNumber,
        })
      : null;

    // Build fanfic context if fanfic_canon.md exists
    const fanficContext: FanficContext | undefined = hasFanficCanon && bookRules?.fanficMode
      ? {
          fanficCanon: fanficCanonRaw,
          fanficMode: bookRules.fanficMode,
          allowedDeviations: bookRules.allowedDeviations ?? [],
        }
      : undefined;

    // ── Phase 1: Creative writing (temperature 0.7) ──
    const creativeSystemPrompt = buildWriterSystemPrompt(
      book, genreProfile, bookRules, bookRulesBody, genreBody, styleGuide, styleFingerprint,
      chapterNumber, "creative", fanficContext, resolvedLanguage,
      input.chapterMemo ? "governed" : "legacy",
      resolvedLengthSpec,
    );

    const creativeUserPrompt = input.chapterMemo && input.contextPackage && input.ruleStack
      ? this.buildGovernedUserPrompt({
          chapterNumber,
          chapterMemo: input.chapterMemo,
          chapterIntentData: input.chapterIntentData,
          contextPackage: input.contextPackage,
          ruleStack: input.ruleStack,
          externalContext: input.externalContext,
          lengthSpec: resolvedLengthSpec,
          language: book.language ?? genreProfile.language,
          varianceBrief: englishVarianceBrief?.text,
          selectedEvidenceBlock: this.joinGovernedEvidenceBlocks(governedMemoryBlocks),
        })
      : (() => {
          // Smart context filtering: inject only relevant parts of truth files
          const filteredHooks = filterHooks(hooks);
          const filteredSummaries = filterSummaries(chapterSummaries, chapterNumber);
          const filteredSubplots = filterSubplots(subplotBoard);
          const filteredArcs = filterEmotionalArcs(emotionalArcs, chapterNumber);
          const filteredMatrix = filterCharacterMatrix(characterMatrix, volumeOutline, bookRules?.protagonist?.name);

          // POV-aware filtering: limit context to what the POV character knows
          const povCharacter = extractPOVFromOutline(volumeOutline, chapterNumber);
          const povFilteredMatrix = povCharacter
            ? filterMatrixByPOV(filteredMatrix, povCharacter)
            : filteredMatrix;
          const povFilteredHooks = povCharacter
            ? filterHooksByPOV(filteredHooks, povCharacter, chapterSummaries)
            : filteredHooks;

          return this.buildUserPrompt({
            chapterNumber,
            storyBible,
            currentState,
            ledger,
            hooks: povFilteredHooks,
            recentChapters,
            lengthSpec: resolvedLengthSpec,
            externalContext: input.externalContext,
            chapterSummaries: filteredSummaries,
            subplotBoard: filteredSubplots,
            emotionalArcs: filteredArcs,
            characterMatrix: povFilteredMatrix,
            dialogueFingerprints,
            relevantSummaries,
            parentCanon: hasParentCanon ? parentCanon : undefined,
            language: book.language ?? genreProfile.language,
          });
        })();

    const creativeTemperature = input.temperatureOverride ?? 0.7;

    this.logInfo(resolvedLanguage, {
      zh: `阶段 1：创作正文（第${chapterNumber}章）`,
      en: `Phase 1: creative writing for chapter ${chapterNumber}`,
    });

    const creativeResponse = await this.chat(
      [
        { role: "system", content: creativeSystemPrompt },
        { role: "user", content: creativeUserPrompt },
      ],
      {
        temperature: creativeTemperature,
        maxTokens: WRITING_MAX_OUTPUT_TOKENS,
        tokenOptimization: { cacheRead: false },
      },
    );
    const creativeUsage = creativeResponse.usage;

    const creative = parseCreativeOutput(chapterNumber, creativeResponse.content, resolvedLengthSpec.countingMode);

    // Phase 4: soft-check that PRE_WRITE_CHECK aligns with the chapter memo.
    // Memo was already parse-validated in the planner, so this only warns —
    // the LLM self-check may have skipped or abbreviated a row.
    if (input.chapterMemo) {
      this.verifyPreWriteCheckAlignsWithMemo(creative.preWriteCheck, chapterNumber, resolvedLanguage);
    }

    if (input.skipSettlement) {
      this.logInfo(resolvedLanguage, {
        zh: `快速模式：跳过状态结算 LLM（第${chapterNumber}章）`,
        en: `Quick mode: skipping state settlement LLM for chapter ${chapterNumber}`,
      });
      const surfaceNormalizedContent = normalizePostWriteSurface(creative.content, resolvedLanguage);
      const surfaceNormalizedWordCount = countChapterLength(surfaceNormalizedContent, resolvedLengthSpec.countingMode);
      const ruleViolations = [
        ...validatePostWrite(surfaceNormalizedContent, genreProfile, bookRules, resolvedLanguage),
        ...detectCrossChapterRepetition(surfaceNormalizedContent, fingerprintChapters, resolvedLanguage),
        ...detectParagraphLengthDrift(surfaceNormalizedContent, fingerprintChapters, resolvedLanguage),
      ];
      const postWriteErrors = ruleViolations.filter(v => v.severity === "error");
      const postWriteWarnings = ruleViolations.filter(v => v.severity === "warning");
      return {
        chapterNumber,
        title: creative.title,
        content: surfaceNormalizedContent,
        wordCount: surfaceNormalizedWordCount,
        preWriteCheck: creative.preWriteCheck,
        postSettlement: resolvedLanguage === "en"
          ? "Quick mode skipped AI state settlement; existing truth files were preserved. Run resync/repair for authoritative state updates."
          : "快速模式已跳过 AI 状态结算；现有真相文件保持不变。需要权威状态更新时可运行重同步/修复。",
        updatedState: "",
        updatedLedger: "",
        updatedHooks: "",
        chapterSummary: this.buildFastChapterSummaryRow({
          chapterNumber,
          title: creative.title,
          content: surfaceNormalizedContent,
          language: resolvedLanguage,
        }),
        updatedSubplots: "",
        updatedEmotionalArcs: "",
        updatedCharacterMatrix: "",
        postWriteErrors,
        postWriteWarnings,
        hookHealthIssues: [],
        tokenUsage: creativeUsage,
      };
    }

    // ── Phase 2: State settlement (temperature 0.3) ──
    this.logInfo(resolvedLanguage, {
      zh: `阶段 2：状态结算（第${chapterNumber}章，${creative.wordCount}字）`,
      en: `Phase 2: state settlement for chapter ${chapterNumber} (${creative.wordCount} words)`,
    });
    const isGovernedSettlement = Boolean(input.chapterIntent && input.contextPackage && input.ruleStack);
    const filteredHooksForSettlement = isGovernedSettlement && input.contextPackage
      ? buildGovernedHookWorkingSet({
          hooksMarkdown: hooks,
          contextPackage: input.contextPackage,
          chapterIntent: input.chapterIntent,
          chapterNumber,
          language: resolvedLanguage,
        })
      : hooks;
    const filteredSubplotsForSettlement = isGovernedSettlement
      ? filterSubplots(subplotBoard)
      : subplotBoard;
    const filteredArcsForSettlement = isGovernedSettlement
      ? filterEmotionalArcs(emotionalArcs, chapterNumber)
      : emotionalArcs;
    const filteredMatrixForSettlement = isGovernedSettlement
      ? buildGovernedCharacterMatrixWorkingSet({
          matrixMarkdown: characterMatrix,
          chapterIntent: input.chapterIntent ?? volumeOutline,
          contextPackage: input.contextPackage!,
          protagonistName: bookRules?.protagonist?.name,
        })
      : characterMatrix;

    const settleResult = await this.settle({
      book,
      genreProfile,
      bookRules,
      chapterNumber,
      title: creative.title,
      content: creative.content,
      currentState,
      ledger,
      hooks: filteredHooksForSettlement,
      chapterSummaries: input.contextPackage ? filterSummaries(chapterSummaries, chapterNumber) : chapterSummaries,
      subplotBoard: filteredSubplotsForSettlement,
      emotionalArcs: filteredArcsForSettlement,
      characterMatrix: filteredMatrixForSettlement,
      volumeOutline,
      selectedEvidenceBlock: governedMemoryBlocks
        ? this.joinGovernedEvidenceBlocks(governedMemoryBlocks)
        : undefined,
      chapterIntent: input.chapterIntent,
      contextPackage: input.contextPackage,
      ruleStack: input.ruleStack,
      validationFeedback: undefined,
      originalHooks: hooks,
      originalSubplots: subplotBoard,
      originalEmotionalArcs: emotionalArcs,
      originalCharacterMatrix: characterMatrix,
    });
    const settlement = settleResult.settlement;
    const settleUsage = settleResult.usage;
    const runtimeStateArtifacts = await this.buildRuntimeStateArtifactsIfPresent(
      bookDir,
      settlement.runtimeStateDelta,
      resolvedLanguage,
      chapterNumber,
    );
    const resolvedRuntimeStateDelta = runtimeStateArtifacts?.resolvedDelta ?? settlement.runtimeStateDelta;
    const priorHookIds = new Set(parsePendingHooksMarkdown(hooks).map((hook) => hook.hookId));
    const hookHealthIssues = resolvedRuntimeStateDelta
      && (runtimeStateArtifacts?.snapshot ?? settlement.runtimeStateSnapshot)
      ? analyzeHookHealth({
          language: resolvedLanguage,
          chapterNumber,
          targetChapters: book.targetChapters,
          hooks: (runtimeStateArtifacts?.snapshot ?? settlement.runtimeStateSnapshot)!.hooks.hooks,
          delta: resolvedRuntimeStateDelta,
          existingHookIds: [...priorHookIds],
        })
      : [];

    // ── Post-write validation (regex + rule-based, zero LLM cost) ──
    const surfaceNormalizedContent = normalizePostWriteSurface(creative.content, resolvedLanguage);
    const surfaceNormalizedWordCount = countChapterLength(surfaceNormalizedContent, resolvedLengthSpec.countingMode);
    const ruleViolations = [
      ...validatePostWrite(surfaceNormalizedContent, genreProfile, bookRules, resolvedLanguage),
      ...detectCrossChapterRepetition(surfaceNormalizedContent, fingerprintChapters, resolvedLanguage),
      ...detectParagraphLengthDrift(surfaceNormalizedContent, fingerprintChapters, resolvedLanguage),
    ];
    const aiTellIssues = analyzeAITells(surfaceNormalizedContent, resolvedLanguage).issues;

    const postWriteErrors = ruleViolations.filter(v => v.severity === "error");
    const postWriteWarnings = ruleViolations.filter(v => v.severity === "warning");

    if (ruleViolations.length > 0) {
      this.logWarn(resolvedLanguage, {
        zh: `后写校验：第${chapterNumber}章 ${postWriteErrors.length} 个错误，${postWriteWarnings.length} 个警告`,
        en: `Post-write: ${postWriteErrors.length} errors, ${postWriteWarnings.length} warnings in chapter ${chapterNumber}`,
      });
      for (const v of ruleViolations) {
        this.ctx.logger?.warn(`[${v.severity}] ${v.rule}: ${v.description}`);
      }
    }
    if (aiTellIssues.length > 0) {
      this.logWarn(resolvedLanguage, {
        zh: `AI 味检查：第${chapterNumber}章发现 ${aiTellIssues.length} 个问题`,
        en: `AI-tell check: ${aiTellIssues.length} issues in chapter ${chapterNumber}`,
      });
      for (const issue of aiTellIssues) {
        this.ctx.logger?.warn(`[${issue.severity}] ${issue.category}: ${issue.description}`);
      }
    }
    if (hookHealthIssues.length > 0) {
      this.logWarn(resolvedLanguage, {
        zh: `伏笔健康：第${chapterNumber}章发现 ${hookHealthIssues.length} 条警告`,
        en: `Hook health: ${hookHealthIssues.length} warning(s) in chapter ${chapterNumber}`,
      });
      for (const issue of hookHealthIssues) {
        this.ctx.logger?.warn(`[${issue.severity}] ${issue.category}: ${issue.description}`);
      }
    }

    // ── Merge into WriteChapterOutput ──
    const tokenUsage: TokenUsage = {
      promptTokens: creativeUsage.promptTokens + settleUsage.promptTokens,
      completionTokens: creativeUsage.completionTokens + settleUsage.completionTokens,
      totalTokens: creativeUsage.totalTokens + settleUsage.totalTokens,
    };

    return {
      chapterNumber,
      title: creative.title,
      content: surfaceNormalizedContent,
      wordCount: surfaceNormalizedWordCount,
      preWriteCheck: creative.preWriteCheck,
      postSettlement: settlement.postSettlement,
      runtimeStateDelta: resolvedRuntimeStateDelta,
      runtimeStateSnapshot: runtimeStateArtifacts?.snapshot ?? settlement.runtimeStateSnapshot,
      updatedState: runtimeStateArtifacts?.currentStateMarkdown ?? settlement.updatedState,
      updatedLedger: settlement.updatedLedger,
      updatedHooks: runtimeStateArtifacts?.hooksMarkdown ?? settlement.updatedHooks,
      chapterSummary: resolvedRuntimeStateDelta
        ? this.renderDeltaSummaryRow(resolvedRuntimeStateDelta)
        : settlement.chapterSummary,
      updatedChapterSummaries: runtimeStateArtifacts?.chapterSummariesMarkdown,
      updatedSubplots: settlement.updatedSubplots,
      updatedEmotionalArcs: settlement.updatedEmotionalArcs,
      updatedCharacterMatrix: settlement.updatedCharacterMatrix,
      postWriteErrors,
      postWriteWarnings,
      hookHealthIssues,
      tokenUsage,
    };
  }

  async settleChapterState(input: SettleChapterStateInput): Promise<WriteChapterOutput> {
    this.fileCache = input.fileCache;
    const cache = this.fileCache;
    const [
      currentState,
      ledger,
      hooks,
      chapterSummaries,
      subplotBoard,
      emotionalArcs,
      characterMatrix,
      volumeOutline,
    ] = await Promise.all([
      // Phase 5 consolidation fallback: derive initial state when only seed on disk.
      readCurrentStateWithFallback(input.bookDir, "(文件尚未创建)"),
      this.readFileOrDefault(join(input.bookDir, "story/particle_ledger.md"), cache),
      this.readFileOrDefault(join(input.bookDir, "story/pending_hooks.md"), cache),
      this.readFileOrDefault(join(input.bookDir, "story/chapter_summaries.md"), cache),
      this.readFileOrDefault(join(input.bookDir, "story/subplot_board.md"), cache),
      this.readFileOrDefault(join(input.bookDir, "story/emotional_arcs.md"), cache),
      readCharacterContext(input.bookDir, "(文件尚未创建)"),
      readVolumeMap(input.bookDir, "(文件尚未创建)"),
    ]);

    const { profile: genreProfile } = await readGenreProfile(this.ctx.projectRoot, input.book.genre);
    const parsedBookRules = await readBookRules(input.bookDir);
    const bookRules = parsedBookRules?.rules ?? null;
    const resolvedLanguage = input.book.language ?? genreProfile.language;
    const governedMemoryBlocks = input.contextPackage
      ? buildGovernedMemoryEvidenceBlocks(input.contextPackage, resolvedLanguage)
      : undefined;

    const settleResult = await this.settle({
      book: input.book,
      genreProfile,
      bookRules,
      chapterNumber: input.chapterNumber,
      title: input.title,
      content: input.content,
      currentState,
      ledger,
      hooks,
      chapterSummaries,
      subplotBoard,
      emotionalArcs,
      characterMatrix,
      volumeOutline,
      selectedEvidenceBlock: governedMemoryBlocks
        ? this.joinGovernedEvidenceBlocks(governedMemoryBlocks)
        : undefined,
      chapterIntent: input.chapterIntent,
      contextPackage: input.contextPackage,
      ruleStack: input.ruleStack,
      validationFeedback: input.validationFeedback,
      originalHooks: hooks,
      originalSubplots: subplotBoard,
      originalEmotionalArcs: emotionalArcs,
      originalCharacterMatrix: characterMatrix,
    });
    const settlement = settleResult.settlement;
    const runtimeStateArtifacts = await this.buildRuntimeStateArtifactsIfPresent(
      input.bookDir,
      settlement.runtimeStateDelta,
      resolvedLanguage,
      input.chapterNumber,
      input.allowReapply,
    );

    return {
      chapterNumber: input.chapterNumber,
      title: input.title,
      content: input.content,
      wordCount: countChapterLength(
        input.content,
        resolvedLanguage === "en" ? "en_words" : "zh_chars",
      ),
      preWriteCheck: "",
      postSettlement: settlement.postSettlement,
      runtimeStateDelta: runtimeStateArtifacts?.resolvedDelta ?? settlement.runtimeStateDelta,
      runtimeStateSnapshot: runtimeStateArtifacts?.snapshot ?? settlement.runtimeStateSnapshot,
      updatedState: runtimeStateArtifacts?.currentStateMarkdown ?? settlement.updatedState,
      updatedLedger: settlement.updatedLedger,
      updatedHooks: runtimeStateArtifacts?.hooksMarkdown ?? settlement.updatedHooks,
      chapterSummary: settlement.runtimeStateDelta
        ? this.renderDeltaSummaryRow(settlement.runtimeStateDelta)
        : settlement.chapterSummary,
      updatedChapterSummaries: runtimeStateArtifacts?.chapterSummariesMarkdown,
      updatedSubplots: settlement.updatedSubplots,
      updatedEmotionalArcs: settlement.updatedEmotionalArcs,
      updatedCharacterMatrix: settlement.updatedCharacterMatrix,
      postWriteErrors: [],
      postWriteWarnings: [],
      tokenUsage: settleResult.usage,
    };
  }

  private async settle(params: {
    readonly book: BookConfig;
    readonly genreProfile: GenreProfile;
    readonly bookRules: BookRules | null;
    readonly chapterNumber: number;
    readonly title: string;
    readonly content: string;
    readonly currentState: string;
    readonly ledger: string;
    readonly hooks: string;
    readonly chapterSummaries: string;
    readonly subplotBoard: string;
    readonly emotionalArcs: string;
    readonly characterMatrix: string;
    readonly volumeOutline: string;
    readonly selectedEvidenceBlock?: string;
    readonly chapterIntent?: string;
    readonly contextPackage?: ContextPackage;
    readonly ruleStack?: RuleStack;
    readonly validationFeedback?: string;
    readonly originalHooks: string;
    readonly originalSubplots: string;
    readonly originalEmotionalArcs: string;
    readonly originalCharacterMatrix: string;
  }): Promise<{
    settlement: ReturnType<typeof parseSettlementOutput> & {
      runtimeStateDelta?: RuntimeStateDelta;
      runtimeStateSnapshot?: RuntimeStateSnapshot;
    };
    usage: TokenUsage;
  }> {
    // Phase 2: Settler — extract facts from chapter and update truth files
    // (Observer extraction merged into Settler's enhanced analysis dimensions)
    const resolvedLang = params.book.language ?? params.genreProfile.language;
    const settlerSystem = buildSettlerSystemPrompt(
      params.book, params.genreProfile, params.bookRules, resolvedLang,
    );
    const governedControlBlock = params.chapterIntent && params.contextPackage && params.ruleStack
      ? this.buildSettlerGovernedControlBlock(
          params.chapterIntent,
          params.contextPackage,
          params.ruleStack,
          resolvedLang,
        )
      : undefined;

    const settlerUser = buildSettlerUserPrompt({
      chapterNumber: params.chapterNumber,
      title: params.title,
      content: params.content,
      currentState: this.capLegacyContext("current_state", params.currentState, LEGACY_WRITER_CONTEXT_BUDGET.currentState),
      ledger: this.capLegacyContext("particle_ledger", params.ledger, LEGACY_WRITER_CONTEXT_BUDGET.ledger),
      hooks: this.capLegacyContext("pending_hooks", params.hooks, LEGACY_WRITER_CONTEXT_BUDGET.hooks),
      chapterSummaries: this.capLegacyContext(
        "chapter_summaries",
        params.chapterSummaries,
        LEGACY_WRITER_CONTEXT_BUDGET.chapterSummaries,
      ),
      subplotBoard: this.capLegacyContext("subplot_board", params.subplotBoard, LEGACY_WRITER_CONTEXT_BUDGET.subplotBoard),
      emotionalArcs: this.capLegacyContext("emotional_arcs", params.emotionalArcs, LEGACY_WRITER_CONTEXT_BUDGET.emotionalArcs),
      characterMatrix: this.capLegacyContext(
        "character_matrix",
        params.characterMatrix,
        LEGACY_WRITER_CONTEXT_BUDGET.characterMatrix,
      ),
      volumeOutline: this.capLegacyContext("volume_outline", params.volumeOutline, LEGACY_WRITER_CONTEXT_BUDGET.volumeOutline),
      selectedEvidenceBlock: params.selectedEvidenceBlock,
      governedControlBlock,
      validationFeedback: params.validationFeedback,
    });

    const response = await this.chat(
      [
        { role: "system", content: settlerSystem },
        { role: "user", content: settlerUser },
      ],
      {
        temperature: 0.3,
        maxTokens: WRITING_MAX_OUTPUT_TOKENS,
        tokenOptimization: { cacheRead: false },
      },
    );

    let mergedSettlement: ReturnType<typeof parseSettlementOutput> & {
      runtimeStateDelta?: RuntimeStateDelta;
      runtimeStateSnapshot?: RuntimeStateSnapshot;
    };
    try {
      const deltaOutput = parseSettlerDeltaOutput(response.content);
      mergedSettlement = {
        postSettlement: deltaOutput.postSettlement,
        runtimeStateDelta: deltaOutput.runtimeStateDelta,
        updatedState: "",
        updatedLedger: "",
        updatedHooks: "",
        chapterSummary: "",
        updatedSubplots: "",
        updatedEmotionalArcs: "",
        updatedCharacterMatrix: "",
      };
    } catch {
      const settlement = parseSettlementOutput(response.content, params.genreProfile);
      mergedSettlement = governedControlBlock
        ? {
            ...settlement,
            updatedHooks: mergeTableMarkdownByKey(params.originalHooks, settlement.updatedHooks, [0]),
            updatedSubplots: settlement.updatedSubplots
              ? mergeTableMarkdownByKey(params.originalSubplots, settlement.updatedSubplots, [0])
              : settlement.updatedSubplots,
            updatedEmotionalArcs: settlement.updatedEmotionalArcs
              ? mergeTableMarkdownByKey(params.originalEmotionalArcs, settlement.updatedEmotionalArcs, [0, 1])
              : settlement.updatedEmotionalArcs,
            updatedCharacterMatrix: settlement.updatedCharacterMatrix
              ? mergeCharacterMatrixMarkdown(params.originalCharacterMatrix, settlement.updatedCharacterMatrix)
              : settlement.updatedCharacterMatrix,
          }
        : settlement;
    }

    return {
      settlement: mergedSettlement,
      usage: response.usage,
    };
  }

  async saveChapter(
    bookDir: string,
    output: WriteChapterOutput,
    _numericalSystem: boolean = true,
    language: "zh" | "en" = "zh",
  ): Promise<void> {
    const chaptersDir = join(bookDir, "chapters");
    const storyDir = join(bookDir, "story");
    await mkdir(chaptersDir, { recursive: true });

    const paddedNum = String(output.chapterNumber).padStart(4, "0");
    const filename = `${paddedNum}_${this.sanitizeFilename(output.title)}.md`;

    const heading = language === "en"
      ? `# Chapter ${output.chapterNumber}: ${output.title}`
      : `# 第${output.chapterNumber}章 ${output.title}`;
    const chapterContent = [
      heading,
      "",
      output.content,
    ].join("\n");
    const runtimeStateArtifacts = await this.resolveRuntimeStateArtifactsForOutput(
      bookDir,
      output,
      language,
    );
    const stateMarkdown = await this.resolveTruthMarkdownForOutput(
      storyDir,
      "current_state.md",
      runtimeStateArtifacts?.currentStateMarkdown ?? output.updatedState,
      language === "en" ? "# Current State\n\n(Updated after chapter writing.)\n" : "# 当前状态\n\n（等待章节写作后更新。）\n",
    );
    const hooksMarkdown = await this.resolveTruthMarkdownForOutput(
      storyDir,
      "pending_hooks.md",
      runtimeStateArtifacts?.hooksMarkdown ?? output.updatedHooks,
      language === "en" ? "# Pending Hooks\n\n(None yet.)\n" : "# 待回收伏笔\n\n（暂无。）\n",
    );

    const writes: Array<Promise<void>> = [
      writeFile(join(chaptersDir, filename), chapterContent, "utf-8"),
      writeFile(join(storyDir, "current_state.md"), stateMarkdown, "utf-8"),
      writeFile(join(storyDir, "pending_hooks.md"), hooksMarkdown, "utf-8"),
    ];

    if (runtimeStateArtifacts?.chapterSummariesMarkdown) {
      writes.push(
        writeFile(join(storyDir, "chapter_summaries.md"), runtimeStateArtifacts.chapterSummariesMarkdown, "utf-8"),
      );
    } else if (output.updatedChapterSummaries?.trim()) {
      writes.push(
        writeFile(join(storyDir, "chapter_summaries.md"), output.updatedChapterSummaries, "utf-8"),
      );
    }

    if (runtimeStateArtifacts?.snapshot ?? output.runtimeStateSnapshot) {
      writes.push(saveRuntimeStateSnapshot(bookDir, runtimeStateArtifacts?.snapshot ?? output.runtimeStateSnapshot!));
    }

    writes.push(
      writeFile(
        join(storyDir, "particle_ledger.md"),
        await this.resolveLedgerMarkdownForOutput(storyDir, output, language),
        "utf-8",
      ),
    );

    if (output.updatedSubplots.trim()) {
      writes.push(writeFile(join(storyDir, "subplot_board.md"), output.updatedSubplots, "utf-8"));
    }
    if (output.updatedEmotionalArcs.trim()) {
      writes.push(writeFile(join(storyDir, "emotional_arcs.md"), output.updatedEmotionalArcs, "utf-8"));
    }
    if (output.updatedCharacterMatrix.trim()) {
      writes.push(writeFile(join(storyDir, "character_matrix.md"), output.updatedCharacterMatrix, "utf-8"));
    }

    await Promise.all(writes);
  }

  private async resolveTruthMarkdownForOutput(
    storyDir: string,
    filename: string,
    candidate: string,
    fallback: string,
  ): Promise<string> {
    if (this.isMeaningfulTruthMarkdown(candidate)) {
      return candidate;
    }

    const existing = await readFile(join(storyDir, filename), "utf-8").catch(() => "");
    if (this.isMeaningfulTruthMarkdown(existing)) {
      return existing;
    }

    return fallback;
  }

  private async resolveLedgerMarkdownForOutput(
    storyDir: string,
    output: WriteChapterOutput,
    language: "zh" | "en",
  ): Promise<string> {
    if (this.isMeaningfulTruthMarkdown(output.updatedLedger)) {
      return output.updatedLedger;
    }

    const existing = await readFile(join(storyDir, "particle_ledger.md"), "utf-8").catch(() => "");
    const fallbackRow = this.renderFallbackLedgerRow(output, language);
    if (!fallbackRow) {
      return this.isMeaningfulTruthMarkdown(existing)
        ? existing
        : this.defaultLedgerMarkdown(language);
    }

    if (existing.includes(`| ${output.chapterNumber} |`) || existing.includes(`| 第${output.chapterNumber}章 |`)) {
      return existing;
    }

    const base = this.isMeaningfulTruthMarkdown(existing)
      ? existing.trimEnd()
      : this.defaultLedgerMarkdown(language).trimEnd();

    return `${base}\n${fallbackRow}\n`;
  }

  private isMeaningfulTruthMarkdown(value: string | undefined): boolean {
    const trimmed = value?.trim() ?? "";
    if (!trimmed) return false;
    const placeholders = [
      "(状态卡未更新)",
      "(state card not updated)",
      "(账本未更新)",
      "(ledger not updated)",
      "(伏笔池未更新)",
      "(hooks pool not updated)",
      "（暂无。）",
      "(None yet.)",
      "待补充。",
    ];
    return !placeholders.some((placeholder) => trimmed === placeholder || trimmed.includes(placeholder));
  }

  private defaultLedgerMarkdown(language: "zh" | "en"): string {
    return language === "en"
      ? "# Resource Ledger\n\n| Chapter | Name | Type | State/Change | Evidence |\n| --- | --- | --- | --- | --- |"
      : "# 资源账本\n\n| 章节 | 名称 | 类型 | 状态/变化 | 依据 |\n|------|------|------|-----------|------|";
  }

  private renderFallbackLedgerRow(output: WriteChapterOutput, language: "zh" | "en"): string {
    const summary = output.runtimeStateDelta?.chapterSummary;
    const facts = [
      summary?.events,
      summary?.stateChanges,
      summary?.hookActivity,
      output.chapterSummary,
      ...(output.runtimeStateDelta?.notes ?? []),
    ]
      .map((item) => item?.trim())
      .filter((item): item is string => Boolean(item));

    if (facts.length === 0) return "";

    const safe = (value: string) => value.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
    const title = safe(output.title || summary?.title || String(output.chapterNumber));
    const change = safe(facts.join("；")).slice(0, 240);

    return language === "en"
      ? `| ${output.chapterNumber} | Chapter ${output.chapterNumber}: ${title} | narrative resource | ${change} | Chapter ${output.chapterNumber} settlement |`
      : `| ${output.chapterNumber} | 第${output.chapterNumber}章：${title} | 剧情资源 | ${change} | 第${output.chapterNumber}章结算 |`;
  }

  private buildUserPrompt(params: {
    readonly chapterNumber: number;
    readonly storyBible: string;
    readonly currentState: string;
    readonly ledger: string;
    readonly hooks: string;
    readonly recentChapters: string;
    readonly lengthSpec: LengthSpec;
    readonly externalContext?: string;
    readonly chapterSummaries: string;
    readonly subplotBoard: string;
    readonly emotionalArcs: string;
    readonly characterMatrix: string;
    readonly dialogueFingerprints?: string;
    readonly relevantSummaries?: string;
    readonly parentCanon?: string;
    readonly language?: "zh" | "en";
  }): string {
    const currentState = this.capLegacyContext("current_state", params.currentState, LEGACY_WRITER_CONTEXT_BUDGET.currentState);
    const ledger = this.capLegacyContext("particle_ledger", params.ledger, LEGACY_WRITER_CONTEXT_BUDGET.ledger);
    const hooks = this.capLegacyContext("pending_hooks", params.hooks, LEGACY_WRITER_CONTEXT_BUDGET.hooks);
    const chapterSummaries = this.capLegacyContext(
      "chapter_summaries",
      params.chapterSummaries,
      LEGACY_WRITER_CONTEXT_BUDGET.chapterSummaries,
    );
    const subplotBoard = this.capLegacyContext("subplot_board", params.subplotBoard, LEGACY_WRITER_CONTEXT_BUDGET.subplotBoard);
    const emotionalArcs = this.capLegacyContext("emotional_arcs", params.emotionalArcs, LEGACY_WRITER_CONTEXT_BUDGET.emotionalArcs);
    const characterMatrix = this.capLegacyContext(
      "character_matrix",
      params.characterMatrix,
      LEGACY_WRITER_CONTEXT_BUDGET.characterMatrix,
    );
    const storyBible = this.capLegacyContext("story_bible", params.storyBible, LEGACY_WRITER_CONTEXT_BUDGET.storyBible);
    const recentChapters = capContextBlock(params.recentChapters, {
      label: "recent_chapters",
      maxChars: LEGACY_WRITER_CONTEXT_BUDGET.recentChapters,
    });
    const dialogueFingerprints = params.dialogueFingerprints
      ? this.compressContextForModel(
          "dialogue_fingerprints",
          params.dialogueFingerprints,
          "setting",
          LEGACY_WRITER_CONTEXT_BUDGET.dialogueFingerprints,
        )
      : undefined;
    const relevantSummaries = params.relevantSummaries
      ? this.compressContextForModel(
          "relevant_summaries",
          params.relevantSummaries,
          "narrative",
          LEGACY_WRITER_CONTEXT_BUDGET.relevantSummaries,
        )
      : undefined;
    const parentCanon = params.parentCanon
      ? this.capLegacyContext("parent_canon", params.parentCanon, LEGACY_WRITER_CONTEXT_BUDGET.parentCanon)
      : undefined;
    const contextBlock = params.externalContext
      ? `\n## 外部指令\n以下是来自外部系统的创作指令，请在本章中融入：\n\n${params.externalContext}\n`
      : "";

    const ledgerBlock = ledger
      ? `\n## 资源账本\n${ledger}\n`
      : "";

    const summariesBlock = chapterSummaries !== "(文件尚未创建)"
      ? `\n## 章节摘要（全部历史章节压缩上下文）\n${chapterSummaries}\n`
      : "";

    const subplotBlock = subplotBoard !== "(文件尚未创建)"
      ? `\n## 支线进度板\n${subplotBoard}\n`
      : "";

    const emotionalBlock = emotionalArcs !== "(文件尚未创建)"
      ? `\n## 情感弧线\n${emotionalArcs}\n`
      : "";

    const matrixBlock = characterMatrix !== "(文件尚未创建)"
      ? `\n## 角色交互矩阵\n${characterMatrix}\n`
      : "";

    const fingerprintBlock = dialogueFingerprints
      ? `\n## 角色对话指纹\n${dialogueFingerprints}\n`
      : "";

    const relevantBlock = relevantSummaries
      ? `\n## 相关历史章节摘要\n${relevantSummaries}\n`
      : "";

    const canonBlock = parentCanon
      ? `\n## 正传正典参照（番外写作专用）
本书是番外作品。以下正典约束不可违反，角色不得引用超出其信息边界的信息。
${parentCanon}\n`
      : "";
    const lengthRequirementBlock = this.buildLengthRequirementBlock(params.lengthSpec, params.language ?? "zh");

    if (params.language === "en") {
      return normalizePromptForCache(`Write chapter ${params.chapterNumber}.
${contextBlock}
## Current State
${currentState}
${ledgerBlock}
## Plot Threads
${hooks}
${summariesBlock}${subplotBlock}${emotionalBlock}${matrixBlock}${fingerprintBlock}${relevantBlock}${canonBlock}
## Recent Chapters
    ${recentChapters || "(This is the first chapter, no previous text)"}

## Worldbuilding
${storyBible}

${lengthRequirementBlock}
- Output PRE_WRITE_CHECK first, then the chapter
- Output only PRE_WRITE_CHECK, CHAPTER_TITLE, and CHAPTER_CONTENT blocks`);
    }

    return normalizePromptForCache(`请续写第${params.chapterNumber}章。
${contextBlock}
## 当前状态卡
${currentState}
${ledgerBlock}
## 伏笔池
${hooks}
${summariesBlock}${subplotBlock}${emotionalBlock}${matrixBlock}${fingerprintBlock}${relevantBlock}${canonBlock}
## 最近章节
${recentChapters || "(这是第一章，无前文)"}

## 世界观设定
${storyBible}

${lengthRequirementBlock}
- 先输出写作自检表，再写正文
      - 只需输出 PRE_WRITE_CHECK、CHAPTER_TITLE、CHAPTER_CONTENT 三个区块`);
  }

  private capLegacyContext(label: string, content: string, maxChars: number): string {
    const mode = label === "current_state" || label === "pending_hooks" || label === "chapter_summaries"
      ? "narrative"
      : "setting";
    return this.compressContextForModel(label, content, mode, maxChars);
  }

  private compressContextForModel(
    label: string,
    content: string,
    mode: HeadroomLightMode,
    maxChars: number,
  ): string {
    if (!content || content === "(文件尚未创建)") return content;
    return capContextBlock(compressWithCcr({
      projectRoot: this.ctx.projectRoot,
      label,
      content,
      mode,
    }), { label, maxChars });
  }

  private buildGovernedUserPrompt(params: {
    readonly chapterNumber: number;
    readonly chapterMemo: ChapterMemo;
    readonly chapterIntentData?: ChapterIntent;
    readonly contextPackage: ContextPackage;
    readonly ruleStack: RuleStack;
    readonly externalContext?: string;
    readonly lengthSpec: LengthSpec;
    readonly language?: "zh" | "en";
    readonly varianceBrief?: string;
    readonly selectedEvidenceBlock?: string;
  }): string {
    const language = params.language ?? "zh";
    const contextSectionsRaw = renderNarrativeSelectedContext(
      params.contextPackage.selectedContext,
      language,
    );
    const contextSections = this.compressContextForModel(
      `writer-ch${params.chapterNumber}-selected-context`,
      contextSectionsRaw,
      "setting",
      LEGACY_WRITER_CONTEXT_BUDGET.governedSelectedContext,
    );

    const diagnosticLines = params.ruleStack.sections.diagnostic.length > 0
      ? params.ruleStack.sections.diagnostic.join(", ")
      : "none";

    const lengthRequirementBlock = this.buildLengthRequirementBlock(params.lengthSpec, params.language ?? "zh");
    const varianceBlock = params.varianceBrief
      ? `\n${params.varianceBrief}\n`
      : "";
    const selectedEvidence = sanitizeNarrativeEvidenceBlock(params.selectedEvidenceBlock, language);
    const selectedEvidenceBlock = selectedEvidence
      ? `\n${this.compressContextForModel(
          `writer-ch${params.chapterNumber}-selected-evidence`,
          selectedEvidence,
          "setting",
          LEGACY_WRITER_CONTEXT_BUDGET.governedEvidence,
        )}\n`
      : "";
    const chapterContextBlock = this.buildChapterContextBlock(params.externalContext, language);
    const briefNarrative = renderMemoAsNarrativeBlock(params.chapterMemo, params.chapterIntentData, language);

    if (params.language === "en") {
      return normalizePromptForCache(`Write chapter ${params.chapterNumber}.

${chapterContextBlock}

${briefNarrative}

## Selected Context
${contextSections || "(none)"}
${selectedEvidenceBlock}

## Rule Stack
- Hard: ${params.ruleStack.sections.hard.join(", ") || "(none)"}
- Soft: ${params.ruleStack.sections.soft.join(", ") || "(none)"}
- Diagnostic: ${diagnosticLines}

${varianceBlock}
${lengthRequirementBlock}
- Output PRE_WRITE_CHECK first, then the chapter
- Output only PRE_WRITE_CHECK, CHAPTER_TITLE, and CHAPTER_CONTENT blocks`);
    }

    return normalizePromptForCache(`请续写第${params.chapterNumber}章。

${chapterContextBlock}

${briefNarrative}

## 已选上下文
${contextSections || "(无)"}
${selectedEvidenceBlock}

## 规则栈
- 硬护栏：${params.ruleStack.sections.hard.join("、") || "(无)"}
- 软约束：${params.ruleStack.sections.soft.join("、") || "(无)"}
- 诊断规则：${diagnosticLines}

${varianceBlock}
${lengthRequirementBlock}
- 先输出写作自检表，再写正文
- 只需输出 PRE_WRITE_CHECK、CHAPTER_TITLE、CHAPTER_CONTENT 三个区块`);
  }

  private buildChapterContextBlock(externalContext: string | undefined, language: "zh" | "en"): string {
    const trimmed = externalContext?.trim();
    if (!trimmed) return "";
    if (language === "en") {
      return `## Per-chapter user instruction (highest priority)
${trimmed}

Obey this direct instruction for the current chapter. If it specifies a chapter title, use that title exactly in CHAPTER_TITLE. Keep continuity, but do not replace this instruction with the outline fallback.`;
    }
    return `## 本章用户指令（最高优先级）
${trimmed}

这是用户对当前章节的直接指令。若其中指定章节标题，CHAPTER_TITLE 必须原样使用该标题。保持连续性，但不要用卷纲兜底替换这条指令。`;
  }

  private joinGovernedEvidenceBlocks(blocks: ReturnType<typeof buildGovernedMemoryEvidenceBlocks> | undefined): string | undefined {
    if (!blocks) {
      return undefined;
    }

    const joined = [
      blocks.titleHistoryBlock,
      blocks.moodTrailBlock,
      blocks.canonBlock,
      blocks.hookDebtBlock,
      blocks.hooksBlock,
      blocks.summariesBlock,
      blocks.volumeSummariesBlock,
    ]
      .filter((block): block is string => Boolean(block))
      .join("\n");

    return joined || undefined;
  }

  private buildSettlerGovernedControlBlock(
    chapterIntent: string,
    contextPackage: ContextPackage,
    ruleStack: RuleStack,
    language: "zh" | "en",
  ): string {
    const selectedContext = renderNarrativeSelectedContext(contextPackage.selectedContext, language)
      .replace(/^### /gm, "- ");
    const overrides = ruleStack.activeOverrides.length > 0
      ? ruleStack.activeOverrides
        .map((override) => `- ${override.from} -> ${override.to}: ${override.reason} (${override.target})`)
        .join("\n")
      : "- none";
    const narrativeIntent = buildNarrativeIntentBrief(chapterIntent, language);

    if (language === "en") {
      return `\n## Chapter Control Inputs
${narrativeIntent || "(none)"}

### Selected Context
${selectedContext || "- none"}

### Rule Stack
- Hard guardrails: ${ruleStack.sections.hard.join(", ") || "(none)"}
- Soft constraints: ${ruleStack.sections.soft.join(", ") || "(none)"}
- Diagnostic rules: ${ruleStack.sections.diagnostic.join(", ") || "(none)"}

### Active Overrides
${overrides}\n`;
    }

    return `\n## 本章控制输入
${narrativeIntent || "(无)"}

### 已选上下文
${selectedContext || "- none"}

### 规则栈
- 硬护栏：${ruleStack.sections.hard.join("、") || "(无)"}
- 软约束：${ruleStack.sections.soft.join("、") || "(无)"}
- 诊断规则：${ruleStack.sections.diagnostic.join("、") || "(无)"}

### 当前覆盖
${overrides}\n`;
  }

  /**
   * Soft-check that the LLM's PRE_WRITE_CHECK output references the three
   * non-negotiable memo sections: 当前任务, 不要做, 章尾必须发生的改变.
   *
   * This is NOT a hard gate — the memo was already parse-validated in the
   * planner, and the writer prompt already tells the LLM to align to memo.
   * We only warn when the LLM skipped a section, so the chapter still ships.
   */
  private verifyPreWriteCheckAlignsWithMemo(
    preWriteCheck: string,
    chapterNumber: number,
    language: "zh" | "en",
  ): void {
    if (!preWriteCheck || preWriteCheck.trim().length === 0) {
      this.logWarn(language, {
        zh: `第${chapterNumber}章 PRE_WRITE_CHECK 为空，无法对齐 chapter_memo`,
        en: `Chapter ${chapterNumber} PRE_WRITE_CHECK is empty; cannot verify memo alignment`,
      });
      return;
    }

    const missing: string[] = [];
    if (!preWriteCheck.includes("当前任务")) missing.push("当前任务");
    if (!preWriteCheck.includes("不要做")) missing.push("不要做");
    if (!preWriteCheck.includes("章尾")) missing.push("章尾必须发生的改变");

    if (missing.length > 0) {
      this.logWarn(language, {
        zh: `第${chapterNumber}章 PRE_WRITE_CHECK 缺少 memo 章节检查：${missing.join("、")}`,
        en: `Chapter ${chapterNumber} PRE_WRITE_CHECK missing memo sections: ${missing.join(", ")}`,
      });
    }
  }

  private buildLengthRequirementBlock(lengthSpec: LengthSpec, language: "zh" | "en"): string {
    if (language === "en") {
      return `Requirements:
- Target length: ${lengthSpec.target} words
- Acceptable range: ${lengthSpec.softMin}-${lengthSpec.softMax} words`;
    }

    return `要求：
- 目标字数：${lengthSpec.target}字
- 允许区间：${lengthSpec.softMin}-${lengthSpec.softMax}字`;
  }

  private async loadRecentChapters(
    bookDir: string,
    currentChapter: number,
    count = 1,
  ): Promise<string> {
    return this.joinRecentChapterList(await this.loadRecentChapterList(bookDir, count));
  }

  private async loadRecentChapterList(
    bookDir: string,
    count: number,
  ): Promise<string[]> {
    const chaptersDir = join(bookDir, "chapters");
    try {
      const files = await readdir(chaptersDir);
      const mdFiles = files
        .filter((f) => f.endsWith(".md") && !f.startsWith("index"))
        .sort()
        .slice(-count);

      if (mdFiles.length === 0) return [];

      const contents = await Promise.all(
        mdFiles.map(async (f) => {
          const content = await readFile(join(chaptersDir, f), "utf-8");
          return this.compressContextForModel(
            `writer-recent-${f}`,
            content,
            "narrative",
            LEGACY_WRITER_CONTEXT_BUDGET.recentChapters,
          );
        }),
      );

      return contents;
    } catch {
      return [];
    }
  }

  private joinRecentChapterList(chapters: ReadonlyArray<string> | string): string {
    if (typeof chapters === "string") return chapters;
    return chapters.join("\n\n---\n\n");
  }

  private async readFileOrDefault(path: string, cache?: FileCache): Promise<string> {
    if (cache) {
      const cached = cache.get(path);
      if (cached !== undefined) return cached ?? "(文件尚未创建)";
    }
    try {
      const content = await readFile(path, "utf-8");
      cache?.set(path, content);
      return content;
    } catch {
      cache?.set(path, null);
      return "(文件尚未创建)";
    }
  }

  /** Save new truth files (summaries, subplots, emotional arcs, character matrix). */
  async saveNewTruthFiles(
    bookDir: string,
    output: WriteChapterOutput,
    language: "zh" | "en" = "zh",
  ): Promise<void> {
    const storyDir = join(bookDir, "story");
    const writes: Array<Promise<void>> = [];

    // Append chapter summary to chapter_summaries.md
    if (!output.runtimeStateDelta && output.updatedChapterSummaries) {
      writes.push(writeFile(
        join(storyDir, "chapter_summaries.md"),
        output.updatedChapterSummaries,
        "utf-8",
      ));
    } else if (!output.runtimeStateDelta && output.chapterSummary) {
      writes.push(this.appendChapterSummary(storyDir, output.chapterSummary, language));
    }

    // Overwrite subplot board
    if (output.updatedSubplots) {
      writes.push(writeFile(join(storyDir, "subplot_board.md"), output.updatedSubplots, "utf-8"));
    }

    // Overwrite emotional arcs
    if (output.updatedEmotionalArcs) {
      writes.push(writeFile(join(storyDir, "emotional_arcs.md"), output.updatedEmotionalArcs, "utf-8"));
    }

    // Overwrite character matrix
    if (output.updatedCharacterMatrix) {
      writes.push(writeFile(join(storyDir, "character_matrix.md"), output.updatedCharacterMatrix, "utf-8"));
    }

    await Promise.all(writes);
  }

  private renderDeltaSummaryRow(delta: RuntimeStateDelta): string {
    if (!delta.chapterSummary) return "";
    const summary = delta.chapterSummary;
    const row = [
      summary.chapter,
      summary.title,
      summary.characters,
      summary.events,
      summary.stateChanges,
      summary.hookActivity,
      summary.mood,
      summary.chapterType,
    ].map((value) => String(value).replace(/\|/g, "\\|").trim()).join(" | ");

    return `| ${row} |`;
  }

  private normalizeRuntimeStateDeltaChapter(
    delta: RuntimeStateDelta,
    authoritativeChapterNumber: number,
  ): RuntimeStateDelta {
    const hookOps = delta.hookOps ?? {
      upsert: [],
      mention: [],
      resolve: [],
      defer: [],
    };
    let changed = delta.chapter !== authoritativeChapterNumber;
    const normalizedUpserts = hookOps.upsert.map((hook) => {
      const startChapter = Math.min(hook.startChapter, authoritativeChapterNumber);
      const lastAdvancedChapter = Math.min(hook.lastAdvancedChapter, authoritativeChapterNumber);
      if (startChapter !== hook.startChapter || lastAdvancedChapter !== hook.lastAdvancedChapter) {
        changed = true;
      }
      if (startChapter === hook.startChapter && lastAdvancedChapter === hook.lastAdvancedChapter) {
        return hook;
      }
      return {
        ...hook,
        startChapter,
        lastAdvancedChapter,
      };
    });

    if (delta.chapterSummary?.chapter !== undefined && delta.chapterSummary.chapter !== authoritativeChapterNumber) {
      changed = true;
    }
    if (!changed) {
      return delta;
    }

    return {
      ...delta,
      chapter: authoritativeChapterNumber,
      hookOps: {
        ...hookOps,
        upsert: normalizedUpserts,
      },
      chapterSummary: delta.chapterSummary
        ? {
            ...delta.chapterSummary,
            chapter: authoritativeChapterNumber,
          }
        : undefined,
    };
  }

  private async buildRuntimeStateArtifactsIfPresent(
    bookDir: string,
    delta: RuntimeStateDelta | undefined,
    language: "zh" | "en",
    authoritativeChapterNumber?: number,
    allowReapply?: boolean,
  ): Promise<RuntimeStateArtifacts | null> {
    if (!delta) return null;
    const safeDelta = authoritativeChapterNumber === undefined
      ? delta
      : this.normalizeRuntimeStateDeltaChapter(delta, authoritativeChapterNumber);
    return buildRuntimeStateArtifacts({
      bookDir,
      delta: safeDelta,
      language,
      allowReapply,
    });
  }

  private async resolveRuntimeStateArtifactsForOutput(
    bookDir: string,
    output: WriteChapterOutput,
    language: "zh" | "en",
  ): Promise<RuntimeStateArtifacts | null> {
    if (!output.runtimeStateDelta) return null;
    const safeDelta = this.normalizeRuntimeStateDeltaChapter(
      output.runtimeStateDelta,
      output.chapterNumber,
    );
    if (
      safeDelta === output.runtimeStateDelta
      && output.runtimeStateSnapshot
      && output.updatedChapterSummaries
      && output.updatedState
      && output.updatedHooks
    ) {
      return {
        snapshot: output.runtimeStateSnapshot,
        resolvedDelta: safeDelta,
        currentStateMarkdown: output.updatedState,
        hooksMarkdown: output.updatedHooks,
        chapterSummariesMarkdown: output.updatedChapterSummaries,
      };
    }

    return buildRuntimeStateArtifacts({
      bookDir,
      delta: safeDelta,
      language,
    });
  }

  private async appendChapterSummary(
    storyDir: string,
    summary: string,
    language: "zh" | "en",
  ): Promise<void> {
    const summaryPath = join(storyDir, "chapter_summaries.md");
    let existing = "";
    try {
      existing = await readFile(summaryPath, "utf-8");
    } catch {
      // File doesn't exist yet — start with header
      existing = language === "en"
        ? "# Chapter Summaries\n\n| Chapter | Title | Characters | Key Events | State Changes | Hook Activity | Mood | Chapter Type |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n"
        : "# 章节摘要\n\n| 章节 | 标题 | 出场人物 | 关键事件 | 状态变化 | 伏笔动态 | 情绪基调 | 章节类型 |\n|------|------|----------|----------|----------|----------|----------|----------|\n";
    }

    // Extract only the data row(s) from the summary (skip header lines)
    const dataRows = summary
      .split("\n")
      .filter((line) =>
        line.startsWith("|")
        && !line.startsWith("| 章节")
        && !line.startsWith("| Chapter")
        && !line.startsWith("|--")
        && !line.startsWith("| ---"),
      )
      .join("\n");

    if (dataRows) {
      // Deduplicate: remove existing rows with the same chapter number before appending
      const newChapterNums = new Set(
        dataRows.split("\n")
          .map((line) => line.split("|")[1]?.trim())
          .filter((ch) => ch && /^\d+$/.test(ch)),
      );
      const deduped = existing
        .split("\n")
        .filter((line) => {
          if (!line.startsWith("|")) return true;
          const chNum = line.split("|")[1]?.trim();
          return !chNum || !newChapterNums.has(chNum);
        })
        .join("\n");
      await writeFile(summaryPath, `${deduped.trimEnd()}\n${dataRows}\n`, "utf-8");
    }
  }

  private buildStyleFingerprint(styleProfileRaw: string): string | undefined {
    if (!styleProfileRaw || styleProfileRaw === "(文件尚未创建)") return undefined;
    try {
      const profile = JSON.parse(styleProfileRaw);
      const lines: string[] = [];
      if (profile.avgSentenceLength) lines.push(`- 平均句长：${profile.avgSentenceLength}字`);
      if (profile.sentenceLengthStdDev) lines.push(`- 句长标准差：${profile.sentenceLengthStdDev}`);
      if (profile.avgParagraphLength) lines.push(`- 平均段落长度：${profile.avgParagraphLength}字`);
      if (profile.paragraphLengthRange) lines.push(`- 段落长度范围：${profile.paragraphLengthRange.min}-${profile.paragraphLengthRange.max}字`);
      if (profile.vocabularyDiversity) lines.push(`- 词汇多样性(TTR)：${profile.vocabularyDiversity}`);
      if (profile.topPatterns?.length > 0) lines.push(`- 高频句式：${profile.topPatterns.join("、")}`);
      if (profile.rhetoricalFeatures?.length > 0) lines.push(`- 修辞特征：${profile.rhetoricalFeatures.join("、")}`);
      return lines.length > 0 ? lines.join("\n") : undefined;
    } catch {
      return undefined;
    }
  }


  /**
   * Extract dialogue fingerprints from recent chapters.
   * For each character with multiple dialogue lines, compute speaking style markers.
   */
  private extractDialogueFingerprints(recentChapters: string, _storyBible: string): string {
    if (!recentChapters) return "";

    // Match dialogue patterns:
    // Chinese: "speaker说道：" or dialogue in ""「」
    // English: "dialogue," speaker said. or "dialogue."
    const dialogueRegex = /(?:(.{1,6})(?:说道|道|喝道|冷声道|笑道|怒道|低声道|大声道|喝骂道|冷笑道|沉声道|喊道|叫道|问道|答道)\s*[：:]\s*["""「]([^"""」]+)["""」])|["""「]([^"""」]{2,})["""」]|"([^"]{2,})"/g;

    const characterDialogues = new Map<string, string[]>();
    let match: RegExpExecArray | null;

    while ((match = dialogueRegex.exec(recentChapters)) !== null) {
      const speaker = match[1]?.trim();
      const line = match[2] ?? match[3] ?? "";
      if (speaker && line.length > 1) {
        const existing = characterDialogues.get(speaker) ?? [];
        characterDialogues.set(speaker, [...existing, line]);
      }
    }

    // Only include characters with >=2 dialogue lines
    const fingerprints: string[] = [];
    for (const [character, lines] of characterDialogues) {
      if (lines.length < 2) continue;

      const avgLen = Math.round(lines.reduce((sum, l) => sum + l.length, 0) / lines.length);
      const isShort = avgLen < 15;

      // Find frequent words/phrases (2+ occurrences)
      const wordCounts = new Map<string, number>();
      for (const line of lines) {
        // Extract 2-3 char segments as "words"
        for (let i = 0; i < line.length - 1; i++) {
          const bigram = line.slice(i, i + 2);
          wordCounts.set(bigram, (wordCounts.get(bigram) ?? 0) + 1);
        }
      }
      const frequentWords = [...wordCounts.entries()]
        .filter(([, count]) => count >= 2)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([w]) => `「${w}」`);

      // Detect style markers
      const markers: string[] = [];
      if (isShort) markers.push("短句为主");
      else markers.push("长句为主");

      const questionCount = lines.filter((l) => l.includes("？") || l.includes("?")).length;
      if (questionCount > lines.length * 0.3) markers.push("反问多");

      if (frequentWords.length > 0) markers.push(`常用${frequentWords.join("")}`);

      fingerprints.push(`${character}：${markers.join("，")}`);
    }

    return fingerprints.length > 0 ? fingerprints.join("；") : "";
  }

  /**
   * Find relevant chapter summaries based on volume outline context.
   * Extracts character names and hook IDs from the current volume's outline,
   * then searches chapter summaries for matching entries.
   */
  private findRelevantSummaries(
    chapterSummaries: string,
    volumeOutline: string,
    chapterNumber: number,
  ): string {
    if (!chapterSummaries || chapterSummaries === "(文件尚未创建)") return "";
    if (!volumeOutline || volumeOutline === "(文件尚未创建)") return "";

    // Extract character names from volume outline (Chinese name patterns)
    const nameRegex = /[\u4e00-\u9fff]{2,4}(?=[，、。：]|$)/g;
    const outlineNames = new Set<string>();
    let nameMatch: RegExpExecArray | null;
    while ((nameMatch = nameRegex.exec(volumeOutline)) !== null) {
      outlineNames.add(nameMatch[0]);
    }

    // Extract hook IDs from volume outline
    const hookRegex = /H\d{2,}/g;
    const hookIds = new Set<string>();
    let hookMatch: RegExpExecArray | null;
    while ((hookMatch = hookRegex.exec(volumeOutline)) !== null) {
      hookIds.add(hookMatch[0]);
    }

    if (outlineNames.size === 0 && hookIds.size === 0) return "";

    // Search chapter summaries for matching rows
    const rows = chapterSummaries.split("\n").filter((line) =>
      line.startsWith("|") && !line.startsWith("| 章节") && !line.startsWith("|--") && !line.startsWith("| -"),
    );

    const matchedRows = rows.filter((row) => {
      for (const name of outlineNames) {
        if (row.includes(name)) return true;
      }
      for (const hookId of hookIds) {
        if (row.includes(hookId)) return true;
      }
      return false;
    });

    // Skip only the last chapter (its full text is already in context via loadRecentChapters)
    const filteredRows = matchedRows.filter((row) => {
      const chNumMatch = row.match(/\|\s*(\d+)\s*\|/);
      if (!chNumMatch) return true;
      const num = parseInt(chNumMatch[1]!, 10);
      return num < chapterNumber - 1;
    });

    return filteredRows.length > 0 ? filteredRows.join("\n") : "";
  }

  private buildFastChapterSummaryRow(params: {
    readonly chapterNumber: number;
    readonly title: string;
    readonly content: string;
    readonly language: "zh" | "en";
  }): string {
    const plain = params.content
      .replace(/\s+/g, params.language === "en" ? " " : "")
      .trim();
    const excerpt = plain.slice(0, params.language === "en" ? 180 : 90);
    const safe = (value: string) => value.replace(/\|/g, "｜").replace(/\r?\n/g, " ").trim();
    const quickNote = params.language === "en"
      ? "quick write; settlement deferred"
      : "快速写作；状态结算延后";
    return `| ${params.chapterNumber} | ${safe(params.title)} | 待结算 | ${safe(excerpt)} | ${quickNote} | 待结算 | 待结算 | quick |`;
  }

  private sanitizeFilename(title: string): string {
    return title
      .replace(/[/\\?%*:|"<>]/g, "")
      .replace(/\s+/g, "_")
      .slice(0, 50);
  }
}
