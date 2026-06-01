import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const studioRoot = resolve(__dirname, "..");
const projectRoot = resolve(studioRoot, "../..");
const tsxBin = require.resolve("tsx/cli");

const child = spawn(
  process.execPath,
  [tsxBin, "watch", "src/api/index.ts"],
  {
    cwd: studioRoot,
    env: {
      ...process.env,
      INKOS_STUDIO_PORT: "4569",
      INKOS_PROJECT_ROOT: projectRoot,
    },
    stdio: "inherit",
  },
);

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
