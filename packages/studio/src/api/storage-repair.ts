import { installPresetSceneTemplates } from "@actalk/inkos-core";
import { copyFile, mkdir, readFile, readdir, rename, rm, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import {
  clearTopLevelLlmMirror,
  isCustomServiceId,
  normalizeServiceConfig,
  serviceConfigKey,
  syncTopLevelLlmMirror,
} from "./service-config-utils.js";
export async function ensureProjectStorageSkeleton(root: string): Promise<void> {
  const projectDirs = [
    root,
    join(root, ".inkos"),
    join(root, ".inkos", "sessions"),
    join(root, "books"),
    join(root, "genres"),
    join(root, "radar"),
    join(root, "covers"),
    join(root, "shorts"),
    join(root, "exports"),
    join(root, "logs"),
  ];
  await Promise.all(projectDirs.map((dir) => mkdir(dir, { recursive: true })));
  await cleanupProjectProbesAndPlaceholders(root, projectDirs);
  await repairJsonFile(join(root, ".inkos", "secrets.json"), {
    services: {},
  });
  await repairJsonFile(join(root, "manifest.json"), {
    schemaVersion: 1,
    books: [],
    updatedAt: new Date().toISOString(),
  });
  await repairJsonFile(join(root, "inkos-db.json"), {
    schemaVersion: 1,
    books: [],
    sessions: [],
    updatedAt: new Date().toISOString(),
  });
  await repairProjectResourceIndex(root);
  await syncBuiltinGenresToProject(root);
  await installPresetSceneTemplates(root);
}

async function cleanupProjectProbesAndPlaceholders(root: string, dirs: string[]): Promise<void> {
  await Promise.all([
    removeIfExists(join(root, ".inkos-write-test")),
    removeIfExists(join(root, ".inkos-probe.tmp")),
    removeIfExists(join(root, ".inkos", ".write-test")),
    ...dirs
      .filter((dir) => dir !== root)
      .flatMap((dir) => [
        removeIfExists(join(dir, "_keep.txt")),
        removeIfExists(join(dir, ".keep")),
      ]),
  ]);
}

async function removeIfExists(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch {
    // Missing files and platform-specific delete restrictions are harmless here.
  }
}

export interface StorageRepairEntry {
  readonly action: string;
  readonly path: string;
  readonly detail?: string;
}

interface DiscoveredBookIndexEntry {
  readonly id: string;
  readonly title: string;
  readonly genre?: unknown;
  readonly status?: unknown;
  readonly language?: unknown;
  readonly updatedAt?: unknown;
}

export async function repairProjectResourceIndex(root: string): Promise<StorageRepairEntry[]> {
  const repaired: StorageRepairEntry[] = [];
  const booksDir = join(root, "books");
  const bookDirs = await readdir(booksDir, { withFileTypes: true }).catch(() => []);
  const books: DiscoveredBookIndexEntry[] = [];

  for (const entry of bookDirs) {
    if (!entry.isDirectory()) continue;
    const bookDir = join(booksDir, entry.name);
    const bookJson = join(bookDir, "book.json");
    const bookConfig = await readJsonRecord(bookJson);
    if (!bookConfig) continue;

    const now = new Date().toISOString();
    const id = safeString(bookConfig.id) || entry.name;
    const title = safeString(bookConfig.title) || id;
    const repairedConfig = {
      ...bookConfig,
      id,
      title,
      genre: safeString(bookConfig.genre) || "other",
      platform: safeString(bookConfig.platform) || "qidian",
      language: bookConfig.language === "en" ? "en" : "zh",
      status: safeString(bookConfig.status) || "outlining",
      targetChapters: safePositiveInteger(bookConfig.targetChapters, 200),
      chapterWordCount: safePositiveInteger(bookConfig.chapterWordCount, 3000),
      createdAt: safeString(bookConfig.createdAt) || now,
      updatedAt: now,
    };
    await writeFile(bookJson, JSON.stringify(repairedConfig, null, 2), "utf-8");
    repaired.push({ action: "repair-book-config", path: relative(root, bookJson).replace(/\\/g, "/") });

    await repairBookResourceLayout(root, bookDir, repaired);
    books.push({
      id,
      title,
      genre: repairedConfig.genre,
      status: repairedConfig.status,
      language: repairedConfig.language,
      updatedAt: repairedConfig.updatedAt,
    });
  }

  const now = new Date().toISOString();
  const previousDb = await readJsonRecord(join(root, "inkos-db.json"));
  await writeFile(join(root, "manifest.json"), JSON.stringify({
    schemaVersion: 1,
    books,
    updatedAt: now,
  }, null, 2), "utf-8");
  await writeFile(join(root, "inkos-db.json"), JSON.stringify({
    schemaVersion: 1,
    books,
    sessions: Array.isArray(previousDb?.sessions) ? previousDb.sessions : [],
    updatedAt: now,
  }, null, 2), "utf-8");
  repaired.push({ action: "sync-root-index", path: "manifest.json", detail: `${books.length} books` });
  repaired.push({ action: "sync-root-index", path: "inkos-db.json", detail: `${books.length} books` });

  return repaired;
}

export async function repairBookResourceLayout(root: string, bookDir: string, repaired: StorageRepairEntry[]): Promise<void> {
  const storyDir = join(bookDir, "story");
  const chaptersDir = join(bookDir, "chapters");
  await Promise.all([
    mkdir(chaptersDir, { recursive: true }),
    mkdir(join(storyDir, "drafts"), { recursive: true }),
    mkdir(join(storyDir, "outline"), { recursive: true }),
    mkdir(join(storyDir, "roles", "主要角色"), { recursive: true }),
    mkdir(join(storyDir, "roles", "次要角色"), { recursive: true }),
    mkdir(join(storyDir, "runtime"), { recursive: true }),
    mkdir(join(storyDir, "snapshots"), { recursive: true }),
    mkdir(join(storyDir, "state"), { recursive: true }),
  ]);

  await ensureTextFile(join(chaptersDir, "index.json"), "[]\n", repaired, root);
  await ensureTextFile(join(storyDir, "author_intent.md"), "# 创作意图\n\n待补充。\n", repaired, root);
  await ensureTextFile(join(storyDir, "current_focus.md"), "# 当前焦点\n\n待补充。\n", repaired, root);
  await ensureTextFile(join(storyDir, "current_state.md"), "# 状态卡\n\n- 当前暂无状态记录。\n", repaired, root);
  await ensureTextFile(join(storyDir, "pending_hooks.md"), [
    "# 伏笔池",
    "",
    "| hook_id | start_chapter | type | status | last_advanced_chapter | expected_payoff | payoff_timing | notes |",
    "| --- | ---: | --- | --- | ---: | --- | --- | --- |",
    "",
  ].join("\n"), repaired, root);
  await ensureTextFile(join(storyDir, "particle_ledger.md"), "# 资源账本\n\n待补充。\n", repaired, root);
  await ensureTextFile(join(storyDir, "chapter_summaries.md"), "# 章节摘要\n\n| chapter | title | summary |\n| ---: | --- | --- |\n", repaired, root);
  await ensureTextFile(join(storyDir, "subplot_board.md"), "# 支线进度\n\n待补充。\n", repaired, root);
  await ensureTextFile(join(storyDir, "emotional_arcs.md"), "# 感情线\n\n待补充。\n", repaired, root);
  await ensureTextFile(join(storyDir, "style_guide.md"), "# 文风指南\n\n待补充。\n", repaired, root);
  await ensureTextFile(join(storyDir, "outline", "story_frame.md"), "# 世界观设定\n\n待补充。\n", repaired, root);
  await ensureTextFile(join(storyDir, "outline", "volume_map.md"), "# 卷纲规划\n\n待补充。\n", repaired, root);

  await mergeLegacyRoleDir(root, storyDir, "major", "主要角色", repaired);
  await mergeLegacyRoleDir(root, storyDir, "minor", "次要角色", repaired);
  await cleanupKnownKeepFiles(root, bookDir, repaired);

  await writeFile(join(storyDir, "story_bible.md"), [
    "# 世界观设定索引",
    "",
    "当前版本的权威设定位于：",
    "",
    "- outline/story_frame.md",
    "- outline/volume_map.md",
    "- roles/主要角色/",
    "- roles/次要角色/",
    "",
  ].join("\n"), "utf-8");
  await writeAggregatedBookRules(root, storyDir, repaired);
  await writeAggregatedCharacterMatrix(root, storyDir, repaired);
}

async function writeAggregatedBookRules(
  root: string,
  storyDir: string,
  repaired: StorageRepairEntry[],
): Promise<void> {
  const storyFramePath = join(storyDir, "outline", "story_frame.md");
  const storyFrame = await readFile(storyFramePath, "utf-8").catch(() => "");
  const extracted = extractNarrativeRules(storyFrame);
  const content = [
    "# 叙事规则",
    "",
    extracted || "当前暂无独立叙事规则。请在世界观设定中补充叙事约束、节奏规则、视角限制和禁用句式。",
    "",
    "---",
    "",
    "来源：outline/story_frame.md",
    "",
  ].join("\n");
  const target = join(storyDir, "book_rules.md");
  await writeFile(target, content, "utf-8");
  repaired.push({ action: "sync-foundation-file", path: relative(root, target).replace(/\\/g, "/") });
}

function extractNarrativeRules(markdown: string): string {
  if (!markdown.trim()) return "";
  const sections = markdown.split(/^##\s+/m);
  const matched = sections
    .filter((section) => /叙事|规则|节奏|结构|禁用|约束|视角|打脸|高潮|伏笔|narrative|rule|pace|rhythm/iu.test(section.slice(0, 80)))
    .map((section) => `## ${section.trim()}`)
    .filter((section) => section.length > 8);
  if (matched.length > 0) return matched.join("\n\n").trim();

  const yamlMatch = markdown.match(/^---\s*\n([\s\S]*?)\n---/u);
  if (yamlMatch?.[1]) {
    const yaml = yamlMatch[1]
      .split(/\r?\n/u)
      .filter((line) => /rule|narrative|pace|rhythm|forbid|constraint|叙事|规则|节奏|禁用|约束/iu.test(line))
      .join("\n")
      .trim();
    if (yaml) return ["## 结构化规则摘录", "", "```yaml", yaml, "```"].join("\n");
  }

  return markdown
    .split(/\r?\n/u)
    .filter((line) => /叙事|规则|节奏|结构|禁用|约束|视角|伏笔|高潮/iu.test(line))
    .slice(0, 40)
    .join("\n")
    .trim();
}

async function writeAggregatedCharacterMatrix(
  root: string,
  storyDir: string,
  repaired: StorageRepairEntry[],
): Promise<void> {
  const roleFiles = await listRoleMarkdownFiles(storyDir);
  const sections: string[] = ["# 角色矩阵", ""];
  if (roleFiles.length === 0) {
    sections.push("当前暂无角色档案。角色工具写入后会在这里汇总为角色矩阵。", "");
  } else {
    for (const roleFile of roleFiles) {
      const content = await readFile(join(storyDir, roleFile), "utf-8").catch(() => "");
      const card = summarizeRoleCard(roleFile, content);
      sections.push(`## ${card.name}`, "");
      sections.push(`- **定位**: ${card.tier}`);
      if (card.relation) sections.push(`- **关系**: ${card.relation}`);
      if (card.tags) sections.push(`- **标签**: ${card.tags}`);
      if (card.current) sections.push(`- **当前**: ${card.current}`);
      if (card.summary) sections.push(`- **摘要**: ${card.summary}`);
      sections.push(`- **文件**: ${roleFile.replace(/\\/g, "/")}`, "");
    }
  }
  const target = join(storyDir, "character_matrix.md");
  await writeFile(target, sections.join("\n"), "utf-8");
  repaired.push({ action: "sync-foundation-file", path: relative(root, target).replace(/\\/g, "/") });
}

async function listRoleMarkdownFiles(storyDir: string): Promise<string[]> {
  const roots = [
    join("roles", "主要角色"),
    join("roles", "次要角色"),
    join("roles", "major"),
    join("roles", "minor"),
  ];
  const files: string[] = [];
  for (const relDir of roots) {
    const absDir = join(storyDir, relDir);
    const entries = await readdir(absDir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".md") || entry.name.startsWith("_keep") || entry.name.startsWith(".keep")) continue;
      files.push(join(relDir, entry.name).replace(/\\/g, "/"));
    }
  }
  return [...new Set(files)].sort((a, b) => a.localeCompare(b, "zh-Hans-CN"));
}

function summarizeRoleCard(file: string, content: string): {
  readonly name: string;
  readonly tier: string;
  readonly relation: string;
  readonly tags: string;
  readonly current: string;
  readonly summary: string;
} {
  const fileName = file.split("/").at(-1)?.replace(/\.md$/u, "") ?? file;
  const name = content.match(/^#\s+(.+)$/m)?.[1]?.trim() || fileName;
  const tier = /主要角色|major/iu.test(file) ? "主要角色" : "次要角色";
  const relation = firstMarkdownValue(content, ["与主角关系", "人物关系", "关系", "Relationship", "Relations"]);
  const tags = firstMarkdownValue(content, ["核心标签", "标签", "personalityLock", "Tags"]);
  const current = firstMarkdownValue(content, ["当前现状", "当前", "Current", "Current_State"]);
  const summary = firstMarkdownValue(content, ["一句话定位", "定位", "摘要", "Summary"]) || plainMarkdownPreview(content);
  return {
    name,
    tier,
    relation: relation.replace(/\s+/g, " ").slice(0, 120),
    tags: tags.replace(/\s+/g, " ").slice(0, 120),
    current: current.replace(/\s+/g, " ").slice(0, 140),
    summary: summary.replace(/\s+/g, " ").slice(0, 160),
  };
}

function firstMarkdownValue(markdown: string, keys: ReadonlyArray<string>): string {
  for (const key of keys) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const line = markdown.match(new RegExp(`^${escaped}\\s*[:：]\\s*(.+)$`, "imu"))?.[1]?.trim();
    if (line) return line;
    const section = markdown.match(new RegExp(`(?:^|\\r?\\n)##\\s*${escaped}[^\\n]*\\n([\\s\\S]*?)(?=\\r?\\n##\\s+|$)`, "iu"))?.[1]?.trim();
    if (section) return section;
  }
  return "";
}

function plainMarkdownPreview(markdown: string): string {
  return markdown
    .replace(/^---[\s\S]*?---/m, "")
    .replace(/^#+\s+/gm, "")
    .replace(/[*_`>#-]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

export function shouldRefreshDerivedFoundationFile(file: string): boolean {
  if (file === "book_rules.md" || file === "character_matrix.md" || file === "story_bible.md") {
    return false;
  }
  return file.startsWith("outline/")
    || file.startsWith("roles/")
    || [
      "current_state.md",
      "pending_hooks.md",
      "particle_ledger.md",
      "chapter_summaries.md",
      "subplot_board.md",
      "emotional_arcs.md",
      "style_guide.md",
      "author_intent.md",
      "current_focus.md",
    ].includes(file);
}

async function mergeLegacyRoleDir(
  root: string,
  storyDir: string,
  legacyName: string,
  chineseName: string,
  repaired: StorageRepairEntry[],
): Promise<void> {
  const legacyDir = join(storyDir, "roles", legacyName);
  const targetDir = join(storyDir, "roles", chineseName);
  const files = await readdir(legacyDir).catch(() => null);
  if (!files) return;

  await mkdir(targetDir, { recursive: true });
  for (const file of files) {
    if (!file.endsWith(".md") || file.startsWith("_keep") || file.startsWith(".keep")) continue;
    const source = join(legacyDir, file);
    const target = join(targetDir, file);
    const [sourceText, targetText] = await Promise.all([
      readFile(source, "utf-8").catch(() => ""),
      readFile(target, "utf-8").catch(() => ""),
    ]);
    if (sourceText.length > targetText.length) {
      await writeFile(target, sourceText, "utf-8");
      repaired.push({ action: "merge-role-file", path: relative(root, target).replace(/\\/g, "/") });
    }
  }

  const archiveDir = join(root, ".inkos", "legacy-roles", relative(root, storyDir).replace(/[\\/]+/g, "_"), `${legacyName}-${Date.now()}`);
  try {
    await mkdir(dirname(archiveDir), { recursive: true });
    await rename(legacyDir, archiveDir);
    repaired.push({ action: "archive-legacy-role-dir", path: relative(root, archiveDir).replace(/\\/g, "/") });
  } catch {
    await rm(legacyDir, { recursive: true, force: true }).catch(() => undefined);
    repaired.push({ action: "remove-legacy-role-dir", path: relative(root, legacyDir).replace(/\\/g, "/") });
  }
}

async function cleanupKnownKeepFiles(root: string, bookDir: string, repaired: StorageRepairEntry[]): Promise<void> {
  const dirs = [
    join(bookDir, "chapters"),
    join(bookDir, "story", "drafts"),
    join(bookDir, "story", "outline"),
    join(bookDir, "story", "roles", "主要角色"),
    join(bookDir, "story", "roles", "次要角色"),
    join(bookDir, "story", "runtime"),
    join(bookDir, "story", "snapshots"),
    join(bookDir, "story", "state"),
  ];
  for (const dir of dirs) {
    for (const file of ["_keep.txt", ".keep"]) {
      const target = join(dir, file);
      await unlink(target)
        .then(() => repaired.push({ action: "remove-placeholder", path: relative(root, target).replace(/\\/g, "/") }))
        .catch(() => undefined);
    }
  }
}

async function ensureTextFile(path: string, content: string, repaired: StorageRepairEntry[], root: string): Promise<void> {
  try {
    const existing = await readFile(path, "utf-8");
    if (existing.trim()) return;
  } catch {
    // create below
  }
  await writeFile(path, content, "utf-8");
  repaired.push({ action: "ensure-file", path: relative(root, path).replace(/\\/g, "/") });
}

async function readJsonRecord(path: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf-8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

async function readJsonRecordForRepair(
  root: string,
  path: string,
  repaired: StorageRepairEntry[],
): Promise<Record<string, unknown> | null> {
  let raw = "";
  try {
    raw = await readFile(path, "utf-8");
  } catch {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    if (raw.trim()) {
      await backupRepairedFile(root, path, raw, repaired, "non-object-json");
    }
  } catch {
    if (raw.trim()) {
      await backupRepairedFile(root, path, raw, repaired, "invalid-json");
    }
  }
  return null;
}

async function backupRepairedFile(
  root: string,
  path: string,
  content: string,
  repaired: StorageRepairEntry[],
  reason: string,
): Promise<void> {
  const backupDir = join(root, ".inkos", "repair-backups");
  await mkdir(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const target = join(backupDir, `${basename(path)}.${reason}.${stamp}.bak`);
  await writeFile(target, content, "utf-8");
  repaired.push({
    action: "backup-incompatible-file",
    path: relative(root, target).replace(/\\/g, "/"),
    detail: relative(root, path).replace(/\\/g, "/"),
  });
}

function safeString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function safePositiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

async function repairJsonFile(
  path: string,
  fallback: Record<string, unknown>,
  options?: {
    readonly root?: string;
    readonly repaired?: StorageRepairEntry[];
  },
): Promise<void> {
  try {
    const raw = await readFile(path, "utf-8");
    if (raw.trim()) {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return;
      }
      if (options?.root && options.repaired) {
        await backupRepairedFile(options.root, path, raw, options.repaired, "non-object-json");
      } else {
        const backupPath = `${path}.non-object-${Date.now()}.bak`;
        await writeFile(backupPath, raw, "utf-8");
      }
    }
  } catch {
    try {
      const existing = await readFile(path, "utf-8");
      if (existing.trim() && options?.root && options.repaired) {
        await backupRepairedFile(options.root, path, existing, options.repaired, "invalid-json");
      } else if (existing.trim()) {
        const backupPath = `${path}.invalid-${Date.now()}.bak`;
        await writeFile(backupPath, existing, "utf-8");
      }
    } catch {
      // No readable existing file to back up.
    }
  }
  await writeFile(path, JSON.stringify(fallback, null, 2), "utf-8");
}

export function buildDefaultStudioProjectConfig(existing?: Record<string, unknown>): Record<string, unknown> {
  const existingLlm = existing?.llm && typeof existing.llm === "object"
    ? existing.llm as Record<string, unknown>
    : {};
  const existingCover = existingLlm.cover && typeof existingLlm.cover === "object"
    ? existingLlm.cover as Record<string, unknown>
    : {};
  const service = typeof existingLlm.service === "string" && existingLlm.service.trim()
    ? existingLlm.service.trim()
    : "apihub";
  const defaultModel = typeof existingLlm.defaultModel === "string" && existingLlm.defaultModel.trim()
    ? existingLlm.defaultModel.trim()
    : typeof existingLlm.model === "string" && existingLlm.model.trim()
      ? existingLlm.model.trim()
      : "agnes-2.0-flash";

  return {
    ...existing,
    name: typeof existing?.name === "string" && existing.name.trim()
      ? existing.name
      : "InkOS Studio",
    version: "0.1.0",
    language: existing?.language === "en" ? "en" : "zh",
    llm: {
      ...existingLlm,
      configSource: "studio",
      service,
      provider: typeof existingLlm.provider === "string"
        && ["openai", "anthropic", "custom"].includes(existingLlm.provider)
        ? existingLlm.provider
        : service === "anthropic"
          ? "anthropic"
          : service === "custom"
            ? "custom"
            : "openai",
      defaultModel,
      model: defaultModel,
      services: normalizeServiceConfig(existingLlm.services),
      cover: {
        ...existingCover,
        service: typeof existingCover.service === "string" && existingCover.service.trim()
          ? existingCover.service
          : "kkaiapi",
        model: typeof existingCover.model === "string" && existingCover.model.trim()
          ? existingCover.model
          : "gpt-image-2",
      },
    },
  };
}

export async function repairStudioStartupCompatibility(root: string): Promise<StorageRepairEntry[]> {
  const repaired: StorageRepairEntry[] = [];
  await Promise.all([
    mkdir(root, { recursive: true }),
    mkdir(join(root, ".inkos"), { recursive: true }),
    mkdir(join(root, "books"), { recursive: true }),
  ]);
  await repairJsonFile(join(root, ".inkos", "secrets.json"), { services: {} }, { root, repaired });
  await repairJsonFile(join(root, "manifest.json"), {
    schemaVersion: 1,
    books: [],
    updatedAt: new Date().toISOString(),
  }, { root, repaired });
  await repairJsonFile(join(root, "inkos-db.json"), {
    schemaVersion: 1,
    books: [],
    sessions: [],
    updatedAt: new Date().toISOString(),
  }, { root, repaired });

  const configPath = join(root, "inkos.json");
  const raw = await readJsonRecordForRepair(root, configPath, repaired);
  const nextConfig = buildDefaultStudioProjectConfig(raw ?? undefined);
  const llm = nextConfig.llm as Record<string, unknown>;
  const services = normalizeServiceConfig(llm.services);
  llm.services = services;

  const selectedService = typeof llm.service === "string" ? llm.service.trim() : "";
  if (selectedService) {
    const selectedStillConfigured = isCustomServiceId(selectedService)
      ? services.some((entry) => serviceConfigKey(entry) === selectedService)
      : true;
    if (!selectedStillConfigured) {
      clearTopLevelLlmMirror(llm);
      repaired.push({
        action: "clear-missing-selected-service",
        path: "inkos.json",
        detail: selectedService,
      });
    } else {
      syncTopLevelLlmMirror(llm);
    }
  }

  const serialized = JSON.stringify(nextConfig, null, 2);
  const existing = await readFile(configPath, "utf-8").catch(() => "");
  if (existing.trim() !== serialized.trim()) {
    await writeFile(configPath, serialized, "utf-8");
    repaired.push({ action: "repair-project-config", path: "inkos.json" });
  }

  const resourceRepairs = await repairProjectResourceIndex(root);
  repaired.push(...resourceRepairs);
  return repaired;
}

async function syncBuiltinGenresToProject(root: string): Promise<void> {
  const builtinGenresDir = process.env.INKOS_BUILTIN_GENRES_DIR;
  if (!builtinGenresDir) {
    return;
  }
  const projectGenresDir = join(root, "genres");
  await mkdir(projectGenresDir, { recursive: true });
  let files: string[];
  try {
    files = await readdir(builtinGenresDir);
  } catch {
    return;
  }
  await Promise.all(files
    .filter((file) => file.endsWith(".md"))
    .map(async (file) => {
      const target = join(projectGenresDir, file);
      await copyFile(join(builtinGenresDir, file), target);
    }));
}
