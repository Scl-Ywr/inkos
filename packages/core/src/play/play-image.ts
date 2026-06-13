/**
 * Interactive-world (Play) illustration: turn world-graph entities and key
 * moments into images. Reuses the same image-provider plumbing as cover
 * generation (resolveCoverGenerationRequest + generateImageFromPrompt) so a
 * single cover-API configuration drives both.
 *
 * Images and their status live in a per-run sidecar (run/images/) decoupled
 * from the event log — generation is async and is not part of game state.
 */
import { Buffer } from "node:buffer";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  generateImageFromPrompt,
  resolveCoverGenerationRequest,
} from "../pipeline/short-fiction-runner.js";

/** Per-type task framing only; visual style must come from the world / visual contract. */
const SHOT_BY_TYPE: Record<string, string> = {
  actor: "为这个角色生成配图",
  location: "为这个地点生成配图",
  item: "为这件物品生成配图",
  evidence: "为这件证物生成配图",
  clue: "为这条线索生成配图",
  claim: "为这个主张生成配图",
  proof_chain: "为这条证据链生成配图",
  organization: "为这个组织生成配图",
};

function clamp(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

export interface PlayImageWorldContext {
  readonly premise?: string;
  readonly worldContract?: string;
  readonly visualContract?: string;
}

type PlayImageWorldInput = string | PlayImageWorldContext | undefined;

function renderImageWorldContext(input: PlayImageWorldInput): string {
  if (!input) return "";
  if (typeof input === "string") {
    const premise = input.trim();
    return premise ? `世界设定（决定时代、场景与整体美术风格，必须贴合）：${clamp(premise, 600)}` : "";
  }
  const premise = input.premise?.trim();
  const worldContract = input.worldContract?.trim();
  const visualContract = input.visualContract?.trim();
  return [
    premise ? `世界设定（决定时代、场景与整体美术风格，必须贴合）：${clamp(premise, 600)}` : "",
    worldContract ? `世界契约（只遵守用户定义的规则，不要自行发明 RPG/数值/等级系统）：${clamp(worldContract, 700)}` : "",
    visualContract ? `视觉契约（图片必须按这条表达语义）：${clamp(visualContract, 700)}` : "",
  ].filter(Boolean).join("\n");
}

/**
 * Build a style-consistent image prompt for a world entity. The world premise
 * anchors era / setting / art style so every illustration in one run looks like
 * it belongs to the same world.
 */
export function buildPlayEntityImagePrompt(
  entity: { readonly type: string; readonly label: string; readonly summary?: string },
  worldPremise?: PlayImageWorldInput,
): string {
  const worldContext = renderImageWorldContext(worldPremise);
  const subject = SHOT_BY_TYPE[entity.type] ?? "为这个对象生成配图";
  const summary = entity.summary?.trim();
  return [
    worldContext,
    subject,
    `对象：${entity.label}`,
    summary ? `细节：${clamp(summary, 400)}` : "",
  ].filter(Boolean).join("\n");
}

/** Build a wide illustration prompt for the current moment from its scene prose. */
export function buildPlaySceneImagePrompt(sceneText: string, worldPremise?: PlayImageWorldInput): string {
  const worldContext = renderImageWorldContext(worldPremise);
  return [
    worldContext,
    "为下面这一刻生成配图，捕捉当下的动作、氛围与情绪：",
    clamp(sceneText, 900),
  ].filter(Boolean).join("\n");
}

export type PlayImageStatus = "ready" | "failed";

export interface PlayImageEntry {
  readonly status: PlayImageStatus;
  readonly file?: string;
  readonly error?: string;
}

export type PlayImageManifest = Record<string, PlayImageEntry>;
const DEFAULT_PLAY_IMAGE_LIMIT = process.env.INKOS_ANDROID === "1" ? 40 : 200;

function playImageLimit(): number {
  const value = Number(process.env.INKOS_PLAY_MAX_IMAGES);
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_PLAY_IMAGE_LIMIT;
}

function manifestPath(runDir: string): string {
  return join(runDir, "images", "manifest.json");
}

export async function readPlayImageManifest(runDir: string): Promise<PlayImageManifest> {
  try {
    const raw = await readFile(manifestPath(runDir), "utf-8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as PlayImageManifest) : {};
  } catch {
    return {};
  }
}

export async function writePlayImageManifest(runDir: string, manifest: PlayImageManifest): Promise<void> {
  await mkdir(join(runDir, "images"), { recursive: true });
  await writeFile(manifestPath(runDir), JSON.stringify(manifest, null, 2), "utf-8");
}

/** Immutably set one manifest entry and persist it. Returns the new manifest. */
export async function setPlayImageEntry(
  runDir: string,
  key: string,
  entry: PlayImageEntry,
): Promise<PlayImageManifest> {
  const current = await readPlayImageManifest(runDir);
  const withoutCurrentKey = { ...current };
  delete withoutCurrentKey[key];
  const entries = Object.entries({ ...withoutCurrentKey, [key]: entry });
  const removed = entries.slice(0, Math.max(0, entries.length - playImageLimit()));
  const kept = entries.slice(-playImageLimit());
  const next = Object.fromEntries(kept) as PlayImageManifest;
  await Promise.all(removed.map(([, oldEntry]) => oldEntry.file
    ? rm(join(runDir, "images", oldEntry.file), { force: true })
    : Promise.resolve()));
  await writePlayImageManifest(runDir, next);
  return next;
}

export async function deletePlayImageEntry(runDir: string, key: string): Promise<PlayImageManifest> {
  const current = await readPlayImageManifest(runDir);
  const entry = current[key];
  if (!entry) return current;

  const next = { ...current };
  delete next[key];
  if (entry.file && !entry.file.includes("/") && !entry.file.includes("\\") && !entry.file.includes("\0")) {
    await rm(join(runDir, "images", entry.file), { force: true });
  }
  await writePlayImageManifest(runDir, next);
  return next;
}

/**
 * Per-run auto-illustration toggles. Default all-off: nothing is generated
 * until the user opts in (and the cover API is configured).
 */
export interface PlayImageSettings {
  readonly actors: boolean;
  readonly moments: boolean;
  readonly inventory: boolean;
}

export const DEFAULT_PLAY_IMAGE_SETTINGS: PlayImageSettings = {
  actors: false,
  moments: false,
  inventory: false,
};

function settingsPath(runDir: string): string {
  return join(runDir, "images", "settings.json");
}

export async function readPlayImageSettings(runDir: string): Promise<PlayImageSettings> {
  try {
    const raw = JSON.parse(await readFile(settingsPath(runDir), "utf-8"));
    return {
      actors: Boolean(raw?.actors),
      moments: Boolean(raw?.moments),
      inventory: Boolean(raw?.inventory),
    };
  } catch {
    return DEFAULT_PLAY_IMAGE_SETTINGS;
  }
}

export async function writePlayImageSettings(runDir: string, settings: PlayImageSettings): Promise<void> {
  await mkdir(join(runDir, "images"), { recursive: true });
  await writeFile(settingsPath(runDir), JSON.stringify(settings, null, 2), "utf-8");
}

/** Filesystem-safe leaf name derived from an entity id / scene key. */
export function playImageFileName(key: string, extension: "png" | "jpg"): string {
  const safe = key.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80) || "image";
  return `${safe}.${extension}`;
}

/**
 * Generate one image for a Play key (entity id or scene key), write it under
 * run/images/, and record the result in the manifest. Never throws on a
 * generation failure — it records {status:"failed"} so the caller/UI can
 * surface it and retry. Throws only if cover generation is not configured.
 */
export async function generatePlayImage(input: {
  readonly root: string;
  readonly runDir: string;
  readonly key: string;
  readonly prompt: string;
  readonly size?: string;
}): Promise<PlayImageEntry> {
  // Resolution failure (no cover API configured) is a real misconfiguration —
  // let it surface so the endpoint can return a clear "configure first".
  const request = await resolveCoverGenerationRequest({ root: input.root });
  try {
    const { buffer, extension } = await generateImageFromPrompt(
      request,
      input.prompt,
      input.size ?? "1024x1024",
    );
    const file = playImageFileName(input.key, extension);
    await mkdir(join(input.runDir, "images"), { recursive: true });
    await writeFile(join(input.runDir, "images", file), buffer);
    const entry: PlayImageEntry = { status: "ready", file };
    await setPlayImageEntry(input.runDir, input.key, entry);
    return entry;
  } catch (error) {
    const entry: PlayImageEntry = {
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    };
    await setPlayImageEntry(input.runDir, input.key, entry);
    return entry;
  }
}
