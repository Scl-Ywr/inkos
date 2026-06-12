import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const value = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
    args[key] = value;
  }
  return args;
}

function requireArg(args, key) {
  const value = String(args[key] ?? "").trim();
  if (!value) throw new Error(`Missing --${key}`);
  return value;
}

function readGradleVersion(gradleText) {
  const versionCode = Number(gradleText.match(/\bversionCode\s+(\d+)/)?.[1] ?? 0);
  const versionName = gradleText.match(/\bversionName\s+["']([^"']+)["']/)?.[1] ?? "";
  if (!Number.isInteger(versionCode) || versionCode <= 0) {
    throw new Error("Unable to read positive versionCode from Android build.gradle");
  }
  if (!versionName) {
    throw new Error("Unable to read versionName from Android build.gradle");
  }
  return { versionCode, versionName };
}

function encodeReleasePathPart(value) {
  return encodeURIComponent(value).replaceAll("%2F", "/");
}

async function sha256File(path) {
  const bytes = await readFile(path);
  return createHash("sha256").update(bytes).digest("hex");
}

const args = parseArgs(process.argv.slice(2));
const apkPath = resolve(requireArg(args, "apk"));
const outPath = resolve(args.out ?? "dist/android-release/update.json");
const repo = String(args.repo ?? process.env.GITHUB_REPOSITORY ?? "Scl-Ywr/inkos").trim();
const tag = String(args.tag ?? process.env.GITHUB_REF_NAME ?? "").trim();
const channel = String(args.channel ?? "stable").trim() || "stable";
const assetName = String(args["asset-name"] ?? basename(apkPath)).trim();
const minVersionCode = Number(args["min-version-code"] ?? 1);

if (!repo.includes("/")) throw new Error(`Invalid repository: ${repo}`);
if (!tag) throw new Error("Missing release tag. Pass --tag or set GITHUB_REF_NAME.");
if (!Number.isInteger(minVersionCode) || minVersionCode <= 0) {
  throw new Error("--min-version-code must be a positive integer");
}

const gradlePath = resolve("packages/studio/android/app/build.gradle");
const { versionCode, versionName } = readGradleVersion(await readFile(gradlePath, "utf-8"));
const apkStat = await stat(apkPath);
const apkSha256 = await sha256File(apkPath);
const releaseBase = `https://github.com/${repo}/releases/download/${encodeReleasePathPart(tag)}`;
const apkUrl = `${releaseBase}/${encodeReleasePathPart(assetName)}`;
const mirrorPrefixes = [
  "https://ghproxy.net/",
  "https://ghfast.top/",
  "https://gh-proxy.com/",
  "https://githubproxy.cc/",
];
const rawNotes = String(args.notes ?? process.env.RELEASE_NOTES ?? "").trim();
const notes = rawNotes
  ? rawNotes.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  : [`InkOS Studio ${versionName}`];

const manifest = {
  channel,
  versionName,
  versionCode,
  minVersionCode,
  apkUrl,
  apkMirrorUrls: mirrorPrefixes.map((prefix) => `${prefix}${apkUrl}`),
  apkSha256,
  size: apkStat.size,
  notes,
  publishedAt: new Date().toISOString(),
};

await mkdir(dirname(outPath), { recursive: true });
await writeFile(outPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
console.log(JSON.stringify({ outPath, assetName, manifest }, null, 2));
