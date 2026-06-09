import { readdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const studioRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRoot = resolve(studioRoot, "../..");
const resRoot = resolve(studioRoot, "android/app/src/main/res");
const keepPng = /mipmap|ic_launcher/i;
const localCwebp = process.platform === "win32"
  ? resolve(workspaceRoot, "node_modules/.pnpm/node_modules/.bin/cwebp.CMD")
  : resolve(workspaceRoot, "node_modules/.pnpm/node_modules/.bin/cwebp");

async function main() {
  const encoder = await resolveEncoder();
  const images = await listImages(resRoot);
  let converted = 0;
  for (const file of images) {
    if (keepPng.test(file)) continue;
    const out = file.replace(/\.(png|jpe?g)$/i, ".webp");
    await run(encoder.command, encoder.args(file, out));
    await rm(file);
    converted += 1;
  }
  console.log(`[inkos-android] converted ${converted} Android resource image(s) to WebP via ${encoder.name}.`);
}

async function listImages(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const results = [];
  for (const entry of entries) {
    const file = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...await listImages(file));
    } else if (/\.(png|jpe?g)$/i.test(entry.name)) {
      results.push(file);
    }
  }
  return results;
}

async function resolveEncoder() {
  try {
    await run(localCwebp, ["-version"]);
    return {
      name: "cwebp",
      command: localCwebp,
      args: (input, output) => ["-quiet", "-q", "82", input, "-o", output],
    };
  } catch {
    // Fall through to a globally installed cwebp.
  }

  try {
    await run("cwebp", ["-version"]);
    return {
      name: "cwebp",
      command: "cwebp",
      args: (input, output) => ["-quiet", "-q", "82", input, "-o", output],
    };
  } catch {
    // Fall through to ffmpeg, which is available in many Android build environments.
  }

  try {
    await run("ffmpeg", ["-hide_banner", "-version"]);
    return {
      name: "ffmpeg/libwebp",
      command: "ffmpeg",
      args: (input, output) => [
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        input,
        "-frames:v",
        "1",
        "-c:v",
        "libwebp",
        "-quality",
        "82",
        output,
      ],
    };
  } catch {
    throw new Error("Missing WebP encoder. Install cwebp or ffmpeg with libwebp, then rerun pnpm --filter @actalk/inkos-studio run android:webp.");
  }
}

function run(command, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: "ignore" });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${command} ${args.join(" ")} exited with ${code}`));
    });
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
