import { cp, mkdir, copyFile, writeFile, rm, stat, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";

const studioRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const coreRoot = resolve(studioRoot, "../core");
const androidMain = resolve(studioRoot, "android/app/src/main");
const assetsRoot = resolve(androidMain, "assets/inkos-node");
const appRoot = resolve(assetsRoot, "app");
const genresRoot = resolve(assetsRoot, "genres");
const jniArm64 = resolve(androidMain, "jniLibs/arm64-v8a");
const excludedAssetDirs = new Set(["graphify-out", ".codegraph", ".conda-envs", "node_modules"]);

function fromStudio(path) {
  return resolve(studioRoot, path);
}

async function loadEsbuild() {
  try {
    return await import("esbuild");
  } catch {
    // pnpm may keep esbuild as a transitive dependency under .pnpm instead of
    // exposing it to this package. Reuse the already-installed copy from Vite.
  }

  const roots = [studioRoot, resolve(studioRoot, "../..")];
  for (const root of roots) {
    const pnpmStore = resolve(root, "node_modules/.pnpm");
    if (!existsSync(pnpmStore)) continue;

    for (const entry of await readdir(pnpmStore)) {
      if (!entry.startsWith("esbuild@")) continue;
      const candidate = resolve(pnpmStore, entry, "node_modules/esbuild/lib/main.js");
      if (existsSync(candidate)) {
        return await import(pathToFileURL(candidate).href);
      }
    }
  }

  throw new Error("Unable to resolve esbuild. Run pnpm install or add esbuild to @actalk/inkos-studio devDependencies.");
}

await rm(appRoot, { recursive: true, force: true });
await rm(genresRoot, { recursive: true, force: true });
await mkdir(appRoot, { recursive: true });

const esbuild = await loadEsbuild();

await esbuild.build({
  entryPoints: [fromStudio("src/api/index.ts")],
  outfile: resolve(appRoot, "server.cjs"),
  bundle: true,
  platform: "node",
  target: "node24",
  format: "cjs",
  sourcemap: false,
  define: {
    "import.meta.url": "__inkosAndroidImportMetaUrl",
  },
  banner: {
    js: [
      "const { pathToFileURL: __inkosPathToFileURL } = require(\"node:url\");",
      "const __inkosAndroidImportMetaUrl = __inkosPathToFileURL(__filename).href;",
      "globalThis.__inkosAndroidBundleDirname = __dirname;",
    ].join("\n"),
  },
  external: [
    "better-sqlite3",
    "sqlite3",
  ],
});

await writeFile(resolve(appRoot, "package.json"), JSON.stringify({
  type: "module",
  private: true,
  name: "inkos-android-runtime",
}, null, 2));

await cp(resolve(coreRoot, "genres"), genresRoot, {
  recursive: true,
  filter(source) {
    return !source.split(/[\\/]/).some((part) => excludedAssetDirs.has(part));
  },
});

const nodeLib = (process.env.INKOS_ANDROID_NODE_LIB ?? process.env.INKOS_ANDROID_NODE_BIN)?.trim();
const packagedNodeLib = resolve(jniArm64, "libnode.so");
if (nodeLib) {
  const resolvedNode = resolve(nodeLib);
  const nodeStat = await stat(resolvedNode);
  if (!nodeStat.isFile()) {
    throw new Error(`INKOS_ANDROID_NODE_LIB is not a file: ${resolvedNode}`);
  }
  await mkdir(jniArm64, { recursive: true });
  await copyFile(resolvedNode, packagedNodeLib);
  console.log(`[inkos-android] copied nodejs-mobile library to ${packagedNodeLib}`);
} else if (!existsSync(packagedNodeLib)) {
  await mkdir(resolve(assetsRoot, "bin"), { recursive: true });
  await writeFile(resolve(assetsRoot, "bin/README-node-binary.txt"), [
    "Place an Android arm64 nodejs-mobile shared library at:",
    "",
    "  packages/studio/android/app/src/main/jniLibs/arm64-v8a/libnode.so",
    "",
    "or build with:",
    "",
    "  INKOS_ANDROID_NODE_LIB=/absolute/path/to/arm64-v8a/libnode.so pnpm --filter @actalk/inkos-studio run android:apk",
    "",
    "If the binary is absent, the APK falls back to the built-in JS local runtime.",
  ].join("\n"));
  console.warn("[inkos-android] nodejs-mobile libnode.so is missing; APK will include server assets but native Node cannot start.");
} else {
  console.log(`[inkos-android] using packaged nodejs-mobile library at ${packagedNodeLib}`);
}

const runtimeHash = createHash("sha256");
for (const path of [
  resolve(appRoot, "server.cjs"),
  resolve(appRoot, "package.json"),
]) {
  runtimeHash.update(await import("node:fs/promises").then(({ readFile }) => readFile(path)));
}
for (const file of (await readdir(genresRoot)).sort()) {
  runtimeHash.update(file);
  runtimeHash.update(await import("node:fs/promises").then(({ readFile }) =>
    readFile(resolve(genresRoot, file)),
  ));
}
if (existsSync(packagedNodeLib)) {
  const nodeStat = await stat(packagedNodeLib);
  runtimeHash.update("libnode.so");
  runtimeHash.update(String(nodeStat.size));
  runtimeHash.update(await hashFile(packagedNodeLib));
} else {
  runtimeHash.update("libnode.so:missing");
}
await writeFile(resolve(assetsRoot, "runtime-version.txt"), `${runtimeHash.digest("hex")}\n`);

// The Capacitor WebView already packages the frontend assets separately.
// Keeping dist out of the embedded Node payload makes Android startup much
// faster because the Service only has to unpack the backend bundle.

console.log(`[inkos-android] prepared embedded runtime at ${assetsRoot}`);

async function hashFile(path) {
  return createHash("sha256")
    .update(await import("node:fs/promises").then(({ readFile }) => readFile(path)))
    .digest("hex");
}
