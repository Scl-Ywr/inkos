import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildPlayEntityImagePrompt,
  buildPlaySceneImagePrompt,
  readPlayImageManifest,
  setPlayImageEntry,
  deletePlayImageEntry,
  playImageFileName,
  readPlayImageSettings,
  writePlayImageSettings,
  DEFAULT_PLAY_IMAGE_SETTINGS,
} from "../play/play-image.js";

describe("play image prompts", () => {
  it("frames an actor as an entity image and anchors it to the world premise without forcing a style", () => {
    const prompt = buildPlayEntityImagePrompt(
      { type: "actor", label: "林深", summary: "急诊科医生，能读濒死者的记忆" },
      "都市超自然：触碰濒死者会读到对方一段记忆，代价是丢失自己的记忆。",
    );
    expect(prompt).toContain("为这个角色生成配图");
    expect(prompt).toContain("林深");
    expect(prompt).toContain("世界设定");
    expect(prompt).toContain("急诊科医生");
    expect(prompt).not.toContain("写实或半写实");
    expect(prompt).not.toContain("不添加文字");
    expect(prompt).not.toContain("水印");
    expect(prompt).not.toContain("拼贴");
  });

  it("frames an item without assuming a neutral-background still", () => {
    const prompt = buildPlayEntityImagePrompt({ type: "item", label: "红线手环" });
    expect(prompt).toContain("为这件物品生成配图");
    expect(prompt).toContain("红线手环");
    expect(prompt).not.toContain("中性背景");
  });

  it("falls back to a generic concept frame for unknown entity types", () => {
    const prompt = buildPlayEntityImagePrompt({ type: "rule", label: "记忆债规则" });
    expect(prompt).toContain("记忆债规则");
    expect(prompt).toContain("为这个对象生成配图");
  });

  it("builds a moment prompt from scene prose without forcing cinematic wide framing", () => {
    const prompt = buildPlaySceneImagePrompt("雨夜，她站在便利店门口，没有抬头。", "情感悬疑");
    expect(prompt).toContain("便利店门口");
    expect(prompt).not.toContain("电影感");
    expect(prompt).not.toContain("横构图");
  });

  it("includes user-defined world and visual contracts without assuming RPG tiers", () => {
    const prompt = buildPlayEntityImagePrompt(
      { type: "item", label: "旧瓷杯", summary: "合租屋餐桌上总被推到玩家座位旁边。" },
      {
        premise: "雨夜合租屋关系本。",
        worldContract: "物件按心动层级表达关系变化，不使用装备、数值或 RPG 稀有度。",
        visualContract: "心动层级通过摆放距离、杯沿磨损、光线和人物反应体现，不要绿蓝紫橙边框。",
      } as any,
    );

    expect(prompt).toContain("世界契约");
    expect(prompt).toContain("心动层级");
    expect(prompt).toContain("视觉契约");
    expect(prompt).toContain("不要绿蓝紫橙边框");
  });

  it("clamps overly long premises/summaries so prompts stay bounded", () => {
    const long = "设".repeat(2000);
    const prompt = buildPlayEntityImagePrompt({ type: "actor", label: "X", summary: long }, long);
    expect(prompt.length).toBeLessThan(1600);
    expect(prompt).toContain("…");
  });
});

describe("play image manifest", () => {
  let runDir: string;
  beforeEach(async () => { runDir = await mkdtemp(join(tmpdir(), "inkos-playimg-")); });
  afterEach(async () => { await rm(runDir, { recursive: true, force: true }); });

  it("returns {} for a run with no manifest yet", async () => {
    expect(await readPlayImageManifest(runDir)).toEqual({});
  });

  it("round-trips an entry and merges without dropping existing keys", async () => {
    await setPlayImageEntry(runDir, "actor-1", { status: "ready", file: "actor-1.png" });
    await setPlayImageEntry(runDir, "item-2", { status: "failed", error: "503" });
    const manifest = await readPlayImageManifest(runDir);
    expect(manifest["actor-1"]).toEqual({ status: "ready", file: "actor-1.png" });
    expect(manifest["item-2"]).toEqual({ status: "failed", error: "503" });
    // persisted to disk as JSON
    const raw = JSON.parse(await readFile(join(runDir, "images", "manifest.json"), "utf-8"));
    expect(Object.keys(raw)).toHaveLength(2);
  });

  it("deletes a manifest entry and its generated file", async () => {
    await setPlayImageEntry(runDir, "actor-1", { status: "ready", file: "actor-1.png" });
    await writeFile(join(runDir, "images", "actor-1.png"), "image");

    await deletePlayImageEntry(runDir, "actor-1");

    expect(await readPlayImageManifest(runDir)).toEqual({});
    await expect(access(join(runDir, "images", "actor-1.png"))).rejects.toThrow();
  });
});

describe("play image settings", () => {
  let runDir: string;
  beforeEach(async () => { runDir = await mkdtemp(join(tmpdir(), "inkos-playset-")); });
  afterEach(async () => { await rm(runDir, { recursive: true, force: true }); });

  it("defaults to all-off when no settings file exists", async () => {
    expect(await readPlayImageSettings(runDir)).toEqual(DEFAULT_PLAY_IMAGE_SETTINGS);
    expect(DEFAULT_PLAY_IMAGE_SETTINGS).toEqual({ actors: false, moments: false, inventory: false });
  });

  it("round-trips toggles and coerces to booleans", async () => {
    await writePlayImageSettings(runDir, { actors: true, moments: false, inventory: true });
    expect(await readPlayImageSettings(runDir)).toEqual({ actors: true, moments: false, inventory: true });
  });
});

describe("playImageFileName", () => {
  it("sanitizes ids into safe leaf names with the right extension", () => {
    expect(playImageFileName("actor-1", "png")).toBe("actor-1.png");
    expect(playImageFileName("scene/turn:3 评论", "jpg")).toBe("scene_turn_3___.jpg");
  });

  it("never produces an empty name", () => {
    expect(playImageFileName("！！！", "png")).toBe("___.png");
  });
});
