import { Buffer } from "node:buffer";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AgentContext } from "../agents/base.js";
import {
  SHORT_FICTION_DEFAULT_CHAPTERS,
  SHORT_FICTION_DEFAULT_CHARS_PER_CHAPTER,
  SHORT_FICTION_MAX_CHAPTERS,
  SHORT_FICTION_MAX_CHARS_PER_CHAPTER,
  SHORT_FICTION_MIN_CHAPTERS,
  SHORT_FICTION_MIN_CHARS_PER_CHAPTER,
  ShortFictionDraftReviewerAgent,
  ShortFictionDraftReviserAgent,
  ShortFictionOutlineAgent,
  ShortFictionOutlineReviewerAgent,
  ShortFictionOutlineReviserAgent,
  ShortFictionPackagingAgent,
  ShortFictionWriterAgent,
  findEmptyShortFictionChapters,
  renderShortFictionDraftMarkdown,
  validateShortFictionDraftForFinal,
  type ShortFictionBatchDraft,
  type ShortFictionReference,
  type ShortFictionSalesPackage,
} from "../agents/short-fiction.js";
import { coverSecretKey, resolveCoverProviderPreset, type CoverProviderPreset } from "../llm/cover-providers.js";
import { loadSecrets } from "../llm/secrets.js";
import { safeChildPath } from "../utils/path-safety.js";

const SHORT_FICTION_DRAFT_COMPLETION_ATTEMPTS = 3;

export interface ShortFictionRunRuntimes {
  readonly planner: AgentContext;
  readonly outlineReview: AgentContext;
  readonly writer: AgentContext;
  readonly draftReview: AgentContext;
  readonly revise: AgentContext;
  readonly package: AgentContext;
}

export interface ShortFictionRunOptions {
  readonly projectRoot: string;
  readonly direction: string;
  readonly runtimes: ShortFictionRunRuntimes;
  readonly reference?: ShortFictionReference;
  readonly storyId?: string;
  readonly outDir?: string;
  readonly chapterCount?: number;
  readonly charsPerChapter?: number;
  readonly cover?: boolean;
  readonly coverBaseUrl?: string;
  readonly coverEndpoint?: string;
  readonly coverModel?: string;
  readonly coverSize?: string;
  readonly coverApiKeyEnv?: string;
  readonly onProgress?: (message: string) => void;
}

export interface ShortFictionRunResult {
  readonly storyId: string;
  readonly outlinePath: string;
  readonly outlineReviewPath: string;
  readonly draftReviewPath: string;
  readonly finalMarkdownPath: string;
  readonly finalJsonPath: string;
  readonly salesPackagePath: string;
  readonly coverPromptPath: string;
  readonly coverImagePath?: string;
  readonly coverError?: string;
}

export interface ShortFictionCoverOptions {
  readonly projectRoot: string;
  readonly title: string;
  readonly intro?: string;
  readonly sellingPoints?: string | ReadonlyArray<string>;
  readonly coverPrompt?: string;
  readonly promptMode?: CoverPromptMode;
  readonly outputDir?: string;
  readonly coverBaseUrl?: string;
  readonly coverEndpoint?: string;
  readonly coverModel?: string;
  readonly coverSize?: string;
  readonly coverApiKeyEnv?: string;
}

export interface ShortFictionCoverResult {
  readonly title: string;
  readonly outputDir: string;
  readonly coverPromptPath: string;
  readonly coverImagePath: string;
}

type CoverPromptMode = "short" | "generic";

export async function runShortFictionProduction(
  options: ShortFictionRunOptions,
): Promise<ShortFictionRunResult> {
  const root = options.projectRoot;
  const outDir = normalizeOutputDir(options.outDir ?? "shorts");
  const providedStoryId = options.storyId ? safeSegment(options.storyId) : undefined;

  // A stable storyId lets a re-run resume from disk instead of redoing finished
  // work — a transient failure in a late stage used to throw the whole short
  // away (orphaning outline/drafts). If it already finished, return it as-is.
  if (
    providedStoryId
    && await projectFileExists(root, join(outDir, providedStoryId, "final", "full.md"))
    && !await isFailedShortRun(root, join(outDir, providedStoryId, "status.json"))
  ) {
    return buildShortRunResult(providedStoryId, join(outDir, providedStoryId), { coverError: "already-complete" });
  }

  try {
    return await produceShort(options, root, outDir, providedStoryId);
  } catch (error) {
    // Mark the partial output as failed so drafts can't masquerade as a short.
    if (providedStoryId) {
      await writeJson(root, join(outDir, providedStoryId, "status.json"), {
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      }).catch(() => undefined);
    }
    throw error;
  }
}

async function produceShort(
  options: ShortFictionRunOptions,
  root: string,
  outDir: string,
  providedStoryId: string | undefined,
): Promise<ShortFictionRunResult> {
  const chapterCount = boundedInteger(
    options.chapterCount,
    SHORT_FICTION_DEFAULT_CHAPTERS,
    "chapterCount",
    SHORT_FICTION_MIN_CHAPTERS,
    SHORT_FICTION_MAX_CHAPTERS,
  );
  const charsPerChapter = boundedInteger(
    options.charsPerChapter,
    SHORT_FICTION_DEFAULT_CHARS_PER_CHAPTER,
    "charsPerChapter",
    SHORT_FICTION_MIN_CHARS_PER_CHAPTER,
    SHORT_FICTION_MAX_CHARS_PER_CHAPTER,
  );

  // Resume the (3-stage) outline from disk if v002 already exists for this id —
  // the writer + everything downstream only need the outline markdown.
  const resumedOutline = providedStoryId
    ? await tryReadProjectText(root, join(outDir, providedStoryId, "outline", "v002.md"))
    : undefined;

  let outlineMarkdown: string;
  let storyId: string;
  let baseDir: string;
  if (providedStoryId && resumedOutline?.trim()) {
    storyId = providedStoryId;
    baseDir = join(outDir, storyId);
    outlineMarkdown = resumedOutline;
    options.onProgress?.("Resuming from existing outline (skipping outline stages)...");
  } else {
    options.onProgress?.("Creating short fiction outline...");
    const outlineAgent = new ShortFictionOutlineAgent(options.runtimes.planner);
    const outlineV1 = await outlineAgent.createOutline({
      direction: options.direction,
      chapterCount,
      charsPerChapter,
      reference: options.reference,
    });

    storyId = providedStoryId ?? safeSegment(slugify(outlineV1.storyTitle || options.direction));
    baseDir = join(outDir, storyId);
    await writeText(root, join(baseDir, "outline", "v001.md"), outlineV1.rawContent);

    options.onProgress?.("Reviewing outline...");
    const outlineReviewer = new ShortFictionOutlineReviewerAgent(options.runtimes.outlineReview);
    const outlineReview = await outlineReviewer.reviewOutline({
      direction: options.direction,
      outline: outlineV1,
      reference: options.reference,
    });
    await writeText(root, join(baseDir, "reviews", "outline-v001.md"), outlineReview);

    options.onProgress?.("Revising outline once...");
    const outlineReviser = new ShortFictionOutlineReviserAgent(options.runtimes.planner);
    const outlineV2 = await outlineReviser.reviseOutline({
      direction: options.direction,
      outline: outlineV1,
      review: outlineReview,
      reference: options.reference,
      chapterCount,
      charsPerChapter,
    });
    await writeText(root, join(baseDir, "outline", "v002.md"), outlineV2.rawContent);
    outlineMarkdown = outlineV2.rawContent;
  }

  let finalDraft: ShortFictionBatchDraft;
  let revisionWarning: string | undefined;
  let salesPackage: ShortFictionSalesPackage;
  try {
    options.onProgress?.("Writing full short fiction draft...");
    const writer = new ShortFictionWriterAgent(options.runtimes.writer);
    let draftV1 = await writer.writeDraft({
      direction: options.direction,
      outlineMarkdown,
      chapterCount,
      charsPerChapter,
    });
    let missingFromDraft = findEmptyShortFictionChapters(draftV1);
    if (missingFromDraft.length > 0) {
      await writeDraftArtifacts(root, baseDir, "v001-partial", draftV1);
      for (let attempt = 1; missingFromDraft.length > 0 && attempt <= SHORT_FICTION_DRAFT_COMPLETION_ATTEMPTS; attempt += 1) {
        options.onProgress?.(`Completing missing short fiction chapters: ${missingFromDraft.join(", ")}...`);
        draftV1 = await writer.continueDraft({
          direction: options.direction,
          outlineMarkdown,
          chapterCount,
          charsPerChapter,
          draft: draftV1,
        });
        missingFromDraft = findEmptyShortFictionChapters(draftV1);
        if (missingFromDraft.length > 0) {
          await writeDraftArtifacts(root, baseDir, "v001-partial", draftV1);
        }
      }
    }
    validateShortFictionDraftForFinal(draftV1, { expectedChapters: chapterCount });
    await writeDraftArtifacts(root, baseDir, "v001", draftV1);

    options.onProgress?.("Reviewing full draft...");
    const draftReviewer = new ShortFictionDraftReviewerAgent(options.runtimes.draftReview);
    const draftReview = await draftReviewer.reviewDraft({
      direction: options.direction,
      outlineMarkdown,
      draft: draftV1,
      chapterCount,
      charsPerChapter,
    });
    await writeText(root, join(baseDir, "reviews", "draft-v001.md"), draftReview);

    finalDraft = draftV1;
    options.onProgress?.("Revising full draft once...");
    const reviser = new ShortFictionDraftReviserAgent(options.runtimes.revise);
    try {
      const draftV2 = await reviser.reviseDraft({
        direction: options.direction,
        outlineMarkdown,
        draft: draftV1,
        review: draftReview,
        chapterCount,
        charsPerChapter,
      });
      validateShortFictionDraftForFinal(draftV2, { expectedChapters: chapterCount });
      await writeDraftArtifacts(root, baseDir, "v002", draftV2);
      finalDraft = draftV2;
    } catch (error) {
      revisionWarning = error instanceof Error ? error.message : String(error);
      await writeText(root, join(baseDir, "reviews", "draft-v002-warning.md"), [
        "# 第二轮改稿未采用",
        "",
        "系统没有用不完整或解析失败的改稿覆盖完整首稿。",
        "",
        "## 原因",
        "",
        revisionWarning,
      ].join("\n"));
    }

    await writeFinalArtifacts(root, baseDir, finalDraft);

    options.onProgress?.("Generating synopsis and cover prompt...");
    const packager = new ShortFictionPackagingAgent(options.runtimes.package);
    salesPackage = await packager.generatePackage({
      direction: options.direction,
      outlineMarkdown,
      draft: finalDraft,
    });
    await writePackageArtifacts(root, baseDir, salesPackage);
  } catch (error) {
    await writeShortRunStatus(root, baseDir, {
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    }).catch(() => undefined);
    throw error;
  }

  const coverArtifacts: { readonly coverImagePath?: string; readonly coverError?: string } = options.cover === false
    ? { coverError: "disabled" }
    : await generateCoverArtifact({
        root,
        baseDir,
        salesPackage,
        coverBaseUrl: options.coverBaseUrl,
        coverEndpoint: options.coverEndpoint,
        coverModel: options.coverModel,
        coverSize: options.coverSize,
        coverApiKeyEnv: options.coverApiKeyEnv,
      }).catch((error: unknown) => ({ coverError: String(error) }));

  if (revisionWarning) {
    await writeShortRunStatus(root, baseDir, {
      status: "complete",
      warning: `revision skipped: ${revisionWarning}`,
    }).catch(() => undefined);
  }

  return buildShortRunResult(storyId, baseDir, coverArtifacts);
}

function buildShortRunResult(
  storyId: string,
  baseDir: string,
  coverArtifacts: { readonly coverImagePath?: string; readonly coverError?: string },
): ShortFictionRunResult {
  return {
    storyId,
    outlinePath: projectPath(join(baseDir, "outline", "v002.md")),
    outlineReviewPath: projectPath(join(baseDir, "reviews", "outline-v001.md")),
    draftReviewPath: projectPath(join(baseDir, "reviews", "draft-v001.md")),
    finalMarkdownPath: projectPath(join(baseDir, "final", "full.md")),
    finalJsonPath: projectPath(join(baseDir, "final", "short-story.json")),
    salesPackagePath: projectPath(join(baseDir, "final", "sales-package.md")),
    coverPromptPath: projectPath(join(baseDir, "final", "cover-prompt.md")),
    coverImagePath: coverArtifacts.coverImagePath,
    coverError: coverArtifacts.coverError,
  };
}

async function projectFileExists(root: string, path: string): Promise<boolean> {
  try {
    await access(safeChildPath(root, path));
    return true;
  } catch {
    return false;
  }
}

async function isFailedShortRun(root: string, path: string): Promise<boolean> {
  const raw = await tryReadProjectText(root, path);
  if (!raw) return false;
  try {
    const parsed = JSON.parse(raw) as { status?: unknown };
    return parsed.status === "failed";
  } catch {
    return false;
  }
}

async function tryReadProjectText(root: string, path: string): Promise<string | undefined> {
  try {
    return await readFile(safeChildPath(root, path), "utf-8");
  } catch {
    return undefined;
  }
}

export async function generateShortFictionCover(
  options: ShortFictionCoverOptions,
): Promise<ShortFictionCoverResult> {
  const title = options.title.trim();
  if (!title) {
    throw new Error("title is required for cover generation.");
  }

  const outputDir = normalizeOutputDir(options.outputDir ?? join("covers", safeSegment(title)));
  const salesPackage: ShortFictionSalesPackage = {
    title,
    intro: options.intro?.trim() ?? "",
    sellingPoints: normalizeSellingPoints(options.sellingPoints),
    coverPrompt: options.coverPrompt?.trim() ?? "",
    rawContent: "",
  };
  const promptPath = join(outputDir, "cover-prompt.md");
  const imagePrompt = buildCoverImagePrompt(salesPackage, options.promptMode ?? "generic");
  await writeText(options.projectRoot, promptPath, imagePrompt);

  const artifact = await generateCoverImageArtifact({
    root: options.projectRoot,
    outputDir,
    salesPackage,
    promptMode: options.promptMode ?? "generic",
    coverBaseUrl: options.coverBaseUrl,
    coverEndpoint: options.coverEndpoint,
    coverModel: options.coverModel,
    coverSize: options.coverSize,
    coverApiKeyEnv: options.coverApiKeyEnv,
  });

  return {
    title,
    outputDir: projectPath(outputDir),
    coverPromptPath: projectPath(promptPath),
    coverImagePath: artifact.coverImagePath,
  };
}

async function writeDraftArtifacts(
  root: string,
  baseDir: string,
  version: string,
  draft: ShortFictionBatchDraft,
): Promise<void> {
  const draftDir = join(baseDir, "drafts", version);
  await writeText(root, join(draftDir, "full.md"), renderShortFictionDraftMarkdown(draft));
  await writeJson(root, join(draftDir, "draft.json"), draft);
  await Promise.all(draft.chapters.map((chapter) =>
    writeText(root, join(draftDir, "chapters", `${String(chapter.number).padStart(4, "0")}.md`), [
      `# 第${chapter.number}章 ${chapter.title}`,
      "",
      chapter.content,
    ].join("\n")),
  ));
}

async function writeFinalArtifacts(root: string, baseDir: string, draft: ShortFictionBatchDraft): Promise<void> {
  const finalDir = join(baseDir, "final");
  const markdown = renderShortFictionDraftMarkdown(draft);
  await writeText(root, join(finalDir, "full.md"), markdown);
  await writeText(root, join(finalDir, `${safeFileName(draft.storyTitle)}.md`), markdown);
  await writeJson(root, join(finalDir, "short-story.json"), draft);
  await Promise.all(draft.chapters.map((chapter) =>
    writeText(root, join(finalDir, "chapters", `${String(chapter.number).padStart(4, "0")}.md`), [
      `# 第${chapter.number}章 ${chapter.title}`,
      "",
      chapter.content,
    ].join("\n")),
  ));
}

async function writePackageArtifacts(root: string, baseDir: string, salesPackage: ShortFictionSalesPackage): Promise<void> {
  const finalDir = join(baseDir, "final");
  await writeJson(root, join(finalDir, "sales-package.json"), salesPackage);
  await writeText(root, join(finalDir, "sales-package.md"), [
    `# ${salesPackage.title}`,
    "",
    "## 简介",
    "",
    salesPackage.intro,
    "",
    "## 卖点",
    "",
    ...salesPackage.sellingPoints.map((point) => `- ${point}`),
    "",
    "## 封面提示词",
    "",
    salesPackage.coverPrompt,
  ].join("\n"));
  await writeText(root, join(finalDir, "cover-prompt.md"), salesPackage.coverPrompt || "(empty)");
}

async function writeShortRunStatus(
  root: string,
  baseDir: string,
  value: Record<string, unknown>,
): Promise<void> {
  await writeJson(root, join(baseDir, "status.json"), {
    ...value,
    updatedAt: new Date().toISOString(),
  });
}

async function generateCoverArtifact(input: {
  readonly root: string;
  readonly baseDir: string;
  readonly salesPackage: ShortFictionSalesPackage;
  readonly coverBaseUrl?: string;
  readonly coverEndpoint?: string;
  readonly coverModel?: string;
  readonly coverSize?: string;
  readonly coverApiKeyEnv?: string;
}): Promise<{ readonly coverImagePath: string }> {
  return generateCoverImageArtifact({
    ...input,
    outputDir: join(input.baseDir, "final"),
  });
}

async function generateCoverImageArtifact(input: {
  readonly root: string;
  readonly outputDir: string;
  readonly salesPackage: ShortFictionSalesPackage;
  readonly promptMode?: CoverPromptMode;
  readonly coverBaseUrl?: string;
  readonly coverEndpoint?: string;
  readonly coverModel?: string;
  readonly coverSize?: string;
  readonly coverApiKeyEnv?: string;
}): Promise<{ readonly coverImagePath: string }> {
  const request = await resolveCoverGenerationRequest({
    root: input.root,
    coverBaseUrl: input.coverBaseUrl,
    coverEndpoint: input.coverEndpoint,
    coverModel: input.coverModel,
    coverApiKeyEnv: input.coverApiKeyEnv,
  });
  const size = input.coverSize || process.env.INKOS_COVER_SIZE || "1024x1536";
  const { buffer, extension } = await generateImageFromPrompt(request, buildCoverImagePrompt(input.salesPackage, input.promptMode ?? "short"), size);
  const coverPath = join(input.outputDir, extension === "jpg" ? "cover.jpg" : "cover.png");
  await writeBinary(input.root, coverPath, buffer);
  return { coverImagePath: projectPath(coverPath) };
}

/**
 * Generate one image from a free-text prompt via whichever image API the cover
 * config resolves to (gemini / images / responses). Shared by cover generation
 * and the interactive-world (Play) illustration feature so both go through the
 * same provider plumbing.
 */
export async function generateImageFromPrompt(
  request: ShortFictionCoverRequest,
  prompt: string,
  size: string,
): Promise<{ readonly buffer: Buffer; readonly extension: "png" | "jpg" }> {
  if (request.api === "gemini") {
    const payload = await generateGeminiCover(request, prompt);
    return { buffer: Buffer.from(payload.base64, "base64"), extension: payload.extension };
  }
  if (request.api === "images") {
    return generateImagesCover(request, prompt, size);
  }

  const endpoint = resolveImageApiEndpoint(request.baseUrl, request.endpoint, "responses");
  const sendRequest = (requestSize: string) => fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${request.apiKey}`,
    },
    body: JSON.stringify({
      model: request.model,
      input: prompt,
      tools: [{ type: "image_generation", size: requestSize }],
    }),
  });
  let response = await sendRequest(size);
  let text = await response.text();
  if (!response.ok && shouldRetryImageSize(response.status, size)) {
    response = await sendRequest("1024x1024");
    text = await response.text();
  }
  if (!response.ok) {
    throw new Error(`image generation failed: HTTP ${response.status} ${text.slice(0, 500)}`);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch (error) {
    throw new Error(`image generation returned non-JSON response: ${String(error)}`);
  }

  const imageBase64 = extractResponsesImageBase64(payload);
  if (!imageBase64) {
    throw new Error("image generation response did not include image_generation_call result.");
  }
  return { buffer: Buffer.from(imageBase64, "base64"), extension: "png" };
}

export interface ShortFictionCoverRequest {
  readonly api: CoverProviderPreset["api"];
  readonly baseUrl: string;
  readonly endpoint?: string;
  readonly model: string;
  readonly apiKey: string;
}

export async function resolveCoverGenerationRequest(input: {
  readonly root: string;
  readonly coverBaseUrl?: string;
  readonly coverEndpoint?: string;
  readonly coverModel?: string;
  readonly coverApiKeyEnv?: string;
}): Promise<ShortFictionCoverRequest> {
  if (input.coverEndpoint || input.coverBaseUrl || process.env.INKOS_COVER_ENDPOINT || process.env.INKOS_COVER_BASE_URL) {
    const endpoint = resolveCoverEndpoint(input.coverEndpoint, input.coverBaseUrl);
    const baseUrl = input.coverBaseUrl || process.env.INKOS_COVER_BASE_URL || endpoint
      .replace(/\/responses\/?$/u, "")
      .replace(/\/images\/generations\/?$/u, "");
    return {
      api: endpoint.includes("/responses") ? "responses" : "images",
      baseUrl,
      endpoint,
      model: input.coverModel || process.env.INKOS_COVER_MODEL || "gpt-image-2",
      apiKey: resolveCoverApiKey(input.coverApiKeyEnv || "INKOS_COVER_API_KEY"),
    };
  }

  const projectCover = await readProjectCoverConfig(input.root);
  if (!projectCover) {
    throw new Error("cover endpoint is required. Configure cover generation in Studio or set INKOS_COVER_BASE_URL.");
  }

  const preset = resolveCoverProviderPreset(projectCover.service);
  if (!preset && projectCover.service.startsWith("custom:") && projectCover.baseUrl) {
    const apiKey = await resolveProjectCoverApiKey(input.root, projectCover.service);
    if (!apiKey) {
      throw new Error(`Cover API key is required. Configure a cover key for ${projectCover.label ?? projectCover.service}.`);
    }
    return {
      api: projectCover.api ?? "images",
      baseUrl: projectCover.baseUrl,
      model: input.coverModel || projectCover.model || "gpt-image-2",
      apiKey,
    };
  }
  if (!preset) {
    throw new Error(`Unsupported cover service: ${projectCover.service}`);
  }
  const apiKey = await resolveProjectCoverApiKey(input.root, projectCover.service);
  if (!apiKey) {
    throw new Error(`Cover API key is required. Configure a cover key for ${preset.label}.`);
  }

  return {
    api: preset.api,
    baseUrl: preset.baseUrl,
    model: input.coverModel || projectCover.model || preset.defaultModel,
    apiKey,
  };
}

async function readProjectCoverConfig(root: string): Promise<{
  readonly service: string;
  readonly model?: string;
  readonly label?: string;
  readonly baseUrl?: string;
  readonly api?: "responses" | "images" | "gemini";
} | undefined> {
  try {
    const raw = await readFile(join(root, "inkos.json"), "utf-8");
    const parsed = JSON.parse(raw) as {
      llm?: {
        cover?: {
          service?: unknown;
          model?: unknown;
          label?: unknown;
          baseUrl?: unknown;
          api?: unknown;
        };
      };
    };
    const service = typeof parsed.llm?.cover?.service === "string" ? parsed.llm.cover.service : "";
    if (!service) return undefined;
    return {
      service,
      ...(typeof parsed.llm?.cover?.model === "string" && parsed.llm.cover.model.trim()
        ? { model: parsed.llm.cover.model.trim() }
        : {}),
      ...(typeof parsed.llm?.cover?.label === "string" && parsed.llm.cover.label.trim()
        ? { label: parsed.llm.cover.label.trim() }
        : {}),
      ...(typeof parsed.llm?.cover?.baseUrl === "string" && parsed.llm.cover.baseUrl.trim()
        ? { baseUrl: parsed.llm.cover.baseUrl.trim() }
        : {}),
      ...(parsed.llm?.cover?.api === "responses" || parsed.llm?.cover?.api === "images" || parsed.llm?.cover?.api === "gemini"
        ? { api: parsed.llm.cover.api }
        : {}),
    };
  } catch {
    return undefined;
  }
}

async function resolveProjectCoverApiKey(root: string, service: string): Promise<string> {
  const secrets = await loadSecrets(root);
  return secrets.services[coverSecretKey(service)]?.apiKey
    || secrets.services[service]?.apiKey
    || process.env[`${service.replace(/[^a-zA-Z0-9]/g, "_").toUpperCase()}_API_KEY`]
    || "";
}

async function generateImagesCover(
  request: ShortFictionCoverRequest,
  prompt: string,
  size: string,
): Promise<{ readonly buffer: Buffer; readonly extension: "png" | "jpg" }> {
  const endpoint = resolveImageApiEndpoint(request.baseUrl, request.endpoint, "images");
  const sendRequest = (requestSize: string) => fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${request.apiKey}`,
    },
    body: JSON.stringify({
      model: request.model,
      prompt,
      n: 1,
      size: requestSize,
    }),
  });
  let response = await sendRequest(size);
  let text = await response.text();
  if (!response.ok && shouldRetryImageSize(response.status, size)) {
    response = await sendRequest("1024x1024");
    text = await response.text();
  }
  if (!response.ok) {
    throw new Error(`cover generation failed: HTTP ${response.status} ${text.slice(0, 500)}`);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch (error) {
    throw new Error(`cover generation returned non-JSON response: ${String(error)}`);
  }

  const image = extractImagesGenerationImage(payload);
  if (image?.base64) {
    return {
      buffer: Buffer.from(image.base64, "base64"),
      extension: image.extension,
    };
  }
  if (image?.url) {
    return downloadGeneratedCoverImage(image.url, request.apiKey);
  }
  throw new Error("cover generation response did not include image URL or base64 data.");
}

function resolveImageApiEndpoint(
  baseUrl: string,
  endpoint: string | undefined,
  api: "images" | "responses",
): string {
  if (endpoint) return endpoint;
  const normalized = baseUrl.replace(/\/+$/u, "");
  const suffix = api === "images" ? "/images/generations" : "/responses";
  return normalized.endsWith(suffix) ? normalized : `${normalized}${suffix}`;
}

function shouldRetryImageSize(status: number, size: string): boolean {
  return size !== "1024x1024" && (status === 400 || status === 422);
}

export function extractImagesGenerationImage(payload: unknown): (
  | { readonly base64: string; readonly extension: "png" | "jpg"; readonly url?: undefined }
  | { readonly url: string; readonly base64?: undefined; readonly extension?: undefined }
) | undefined {
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data)) return undefined;

  for (const item of data) {
    const record = item as { b64_json?: unknown; url?: unknown };
    if (typeof record.b64_json === "string" && record.b64_json.trim()) {
      return { base64: record.b64_json.trim(), extension: "png" };
    }
    if (typeof record.url === "string" && record.url.trim()) {
      return { url: record.url.trim() };
    }
  }

  return undefined;
}

async function downloadGeneratedCoverImage(
  url: string,
  apiKey: string,
): Promise<{ readonly buffer: Buffer; readonly extension: "png" | "jpg" }> {
  const response = await fetch(url);
  const fallbackResponse = response.status === 401 || response.status === 403
    ? await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } })
    : response;
  if (!fallbackResponse.ok) {
    const text = await fallbackResponse.text();
    throw new Error(`cover image download failed: HTTP ${fallbackResponse.status} ${text.slice(0, 300)}`);
  }
  const contentType = fallbackResponse.headers.get("content-type") ?? "";
  const buffer = Buffer.from(await fallbackResponse.arrayBuffer());
  return {
    buffer,
    extension: coverImageExtension(contentType, url),
  };
}

function coverImageExtension(contentType: string, url: string): "png" | "jpg" {
  const normalized = `${contentType} ${url}`.toLowerCase();
  return normalized.includes("jpeg") || normalized.includes(".jpg") || normalized.includes(".jpeg") ? "jpg" : "png";
}

async function generateGeminiCover(
  request: ShortFictionCoverRequest,
  prompt: string,
): Promise<{ readonly base64: string; readonly extension: "png" | "jpg" }> {
  const endpoint = `${request.baseUrl.replace(/\/+$/u, "")}/models/${encodeURIComponent(request.model)}:generateContent?key=${encodeURIComponent(request.apiKey)}`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { responseModalities: ["IMAGE", "TEXT"] },
    }),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`cover generation failed: HTTP ${response.status} ${text.slice(0, 500)}`);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch (error) {
    throw new Error(`cover generation returned non-JSON response: ${String(error)}`);
  }

  const image = extractGeminiImageBase64(payload);
  if (!image) {
    throw new Error("cover generation response did not include Gemini inline image data.");
  }
  return image;
}

export function extractResponsesImageBase64(payload: unknown): string | undefined {
  const output = (payload as { output?: unknown }).output;
  if (!Array.isArray(output)) return undefined;

  for (const item of output) {
    const record = item as { type?: unknown; result?: unknown; content?: unknown };
    if (record.type === "image_generation_call" && typeof record.result === "string" && record.result.trim()) {
      return record.result.trim();
    }
    if (Array.isArray(record.content)) {
      for (const contentItem of record.content) {
        const contentRecord = contentItem as { result?: unknown; image_base64?: unknown };
        if (typeof contentRecord.result === "string" && contentRecord.result.trim()) return contentRecord.result.trim();
        if (typeof contentRecord.image_base64 === "string" && contentRecord.image_base64.trim()) return contentRecord.image_base64.trim();
      }
    }
  }

  return undefined;
}

export function extractGeminiImageBase64(payload: unknown): { readonly base64: string; readonly extension: "png" | "jpg" } | undefined {
  const candidates = (payload as { candidates?: unknown }).candidates;
  if (!Array.isArray(candidates)) return undefined;

  for (const candidate of candidates) {
    const parts = (candidate as { content?: { parts?: unknown } }).content?.parts;
    if (!Array.isArray(parts)) continue;
    for (const part of parts) {
      const inlineData = (part as { inlineData?: unknown; inline_data?: unknown }).inlineData
        ?? (part as { inlineData?: unknown; inline_data?: unknown }).inline_data;
      const record = inlineData as { data?: unknown; mimeType?: unknown; mime_type?: unknown } | undefined;
      if (typeof record?.data !== "string" || !record.data.trim()) continue;
      const mimeType = String(record.mimeType ?? record.mime_type ?? "image/png").toLowerCase();
      return {
        base64: record.data.trim(),
        extension: mimeType.includes("jpeg") || mimeType.includes("jpg") ? "jpg" : "png",
      };
    }
  }

  return undefined;
}

export function resolveCoverApiKey(apiKeyEnv: string): string {
  const apiKey = process.env[apiKeyEnv];
  if (!apiKey) {
    throw new Error(`Cover API key is required. Set ${apiKeyEnv} or pass coverApiKeyEnv.`);
  }
  return apiKey;
}

function resolveCoverEndpoint(coverEndpoint?: string, coverBaseUrl?: string): string {
  const endpoint = coverEndpoint || process.env.INKOS_COVER_ENDPOINT;
  if (endpoint) return endpoint;
  const baseUrl = coverBaseUrl || process.env.INKOS_COVER_BASE_URL;
  if (!baseUrl) {
    throw new Error("cover endpoint is required. Set INKOS_COVER_BASE_URL or disable cover generation.");
  }
  return `${baseUrl.replace(/\/+$/u, "")}/images/generations`;
}

function buildCoverImagePrompt(salesPackage: ShortFictionSalesPackage, mode: CoverPromptMode): string {
  const base = [
    `标题：${salesPackage.title}`,
    salesPackage.intro ? `简介：${salesPackage.intro}` : "",
    salesPackage.sellingPoints.length > 0 ? `卖点：${salesPackage.sellingPoints.join("；")}` : "",
    salesPackage.coverPrompt ? `用户视觉要求：${salesPackage.coverPrompt}` : "",
  ].filter(Boolean);

  if (mode === "generic") {
    return [
      "按用户给出的标题、简介、卖点和视觉要求生成封面图。",
      ...base,
    ].join("\n");
  }

  return [
    "为中文短篇小说生成手机端竖版书封，3:4竖图。",
    ...base.map((line) => line.replace(/^标题：/u, "主标题：").replace(/^用户视觉要求：/u, "包装提示：")),
    "",
    "封面方向：平台短篇书封，不是电影海报。标题字要成为主视觉，预留两到四行大字排版区；人物近景或半身，表情有冷笑、震惊、崩溃、压迫或反杀感；道具少而大，一眼能看出冲突。",
    "颜色高对比、高饱和，适合手机列表缩略图。避免写实会议摄影、横版视频缩略图、杂志大片、小清新细字和长段文字。",
    "如果模型文字不稳定，优先生成明确标题留白/字块/排版空间，不要把大量乱码文字铺满画面。",
  ].filter(Boolean).join("\n");
}

function normalizeSellingPoints(value: string | ReadonlyArray<string> | undefined): ReadonlyArray<string> {
  if (typeof value === "string" || value === undefined) {
    return (value ?? "")
      .split(/[;；\n]/u)
      .map((point: string) => point.trim())
      .filter(Boolean);
  }
  return value.map((point) => point.trim()).filter(Boolean);
}

async function writeBinary(root: string, path: string, value: Buffer): Promise<void> {
  const resolved = safeChildPath(root, path);
  await mkdir(dirname(resolved), { recursive: true });
  await writeFile(resolved, value);
}

async function writeJson(root: string, path: string, value: unknown): Promise<void> {
  await writeText(root, path, JSON.stringify(value, null, 2));
}

async function writeText(root: string, path: string, value: string): Promise<void> {
  const resolved = safeChildPath(root, path);
  await mkdir(dirname(resolved), { recursive: true });
  await writeFile(resolved, `${value.trimEnd()}\n`, "utf-8");
}

function normalizeOutputDir(value: string): string {
  const trimmed = value.trim() || "shorts";
  const normalized = projectPath(trimmed).replace(/^\/+/u, "").replace(/\/+$/u, "") || "shorts";
  safeChildPath("/", normalized);
  return normalized;
}

function projectPath(value: string): string {
  return value.replace(/\\/gu, "/");
}

function boundedInteger(value: number | undefined, fallback: number, name: string, min: number, max: number): number {
  const parsed = value ?? fallback;
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  }
  return parsed;
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || `short-${Date.now()}`;
}

function safeSegment(value: string): string {
  const cleaned = value
    .replace(/[\\/:\0*?"<>|]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  if (!cleaned || cleaned === "." || cleaned === "..") return `short-${Date.now()}`;
  return cleaned;
}

function safeFileName(value: string): string {
  const cleaned = value
    .replace(/[\\/:\0*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return cleaned || "short-fiction";
}
