import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const studioRoot = resolve(__dirname, "..");
const projectRoot = resolve(studioRoot, "../..");
const tsxBin = require.resolve("tsx/cli");
const viteBin = resolve(dirname(require.resolve("vite/package.json")), "bin/vite.js");

const children = [
  spawn(
    process.execPath,
    [tsxBin, "watch", "--clear-screen=false", "src/api/index.ts"],
    {
      cwd: studioRoot,
      env: {
        ...process.env,
        INKOS_STUDIO_PORT: "4569",
        INKOS_PROJECT_ROOT: projectRoot,
      },
      stdio: "inherit",
    },
  ),
  spawn(
    process.execPath,
    [viteBin, "--host", "127.0.0.1", "--port", "4567"],
    {
      cwd: studioRoot,
      env: {
        ...process.env,
        INKOS_STUDIO_PORT: "4569",
      },
      stdio: "inherit",
    },
  ),
];

let shuttingDown = false;

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (!child.killed) {
      child.kill();
    }
  }
  process.exit(code);
}

for (const child of children) {
  child.on("exit", (code, signal) => {
    if (shuttingDown) return;
    if (signal) {
      shutdown(0);
      return;
    }
    shutdown(code ?? 0);
  });
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
