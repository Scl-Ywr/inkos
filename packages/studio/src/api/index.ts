import { startStudioServer } from "./server.js";
import { resolve, join, dirname } from "node:path";
import { appendFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

declare const __inkosAndroidBundleDirname: string | undefined;

const __dirname = typeof __inkosAndroidBundleDirname === "string"
  ? __inkosAndroidBundleDirname
  : dirname(fileURLToPath(import.meta.url));

function appendRuntimeLog(message: string, error?: unknown) {
  const logPath = process.env.INKOS_NODE_LOG;
  if (!logPath) {
    return;
  }
  try {
    const detail = error instanceof Error ? `${error.stack ?? error.message}` : error ? String(error) : "";
    appendFileSync(logPath, `[inkos-server] ${new Date().toISOString()} ${message}${detail ? `\n${detail}` : ""}\n`);
  } catch {
    // Keep startup resilient even if Android storage rejects logging.
  }
}

function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function writeStartupLog(level: "info" | "warn" | "error", message: string): void {
  const prefix = "[studio-startup]";
  if (level === "error") {
    console.error(prefix, message);
  } else if (level === "warn") {
    console.warn(prefix, message);
  } else {
    console.info(prefix, message);
  }
}

appendRuntimeLog(`entry loaded argv=${JSON.stringify(process.argv)} cwd=${process.cwd()}`);

process.on("uncaughtException", (error) => {
  appendRuntimeLog("uncaughtException", error);
});

process.on("unhandledRejection", (error) => {
  appendRuntimeLog("unhandledRejection", error);
});

const root = resolve(process.argv[2] ?? process.env.INKOS_PROJECT_ROOT ?? process.cwd());
const port = parseInt(process.env.INKOS_STUDIO_PORT ?? "4567", 10);

// Find studio package root (2 levels up from src/api/)
const studioRoot = resolve(__dirname, "../..");
const distDir = join(studioRoot, "dist");

// Auto-build frontend if dist/ doesn't exist (skip in dev mode — Vite dev server handles frontend)
const isDev = !!process.env.INKOS_DEV;
const isAndroidEmbedded = !!process.env.INKOS_ANDROID;
if (!isDev && !existsSync(join(distDir, "index.html"))) {
  if (isAndroidEmbedded) {
    writeStartupLog("warn", "Embedded Android runtime did not find dist/index.html; API routes will still run.");
  } else {
    writeStartupLog("info", "Building frontend...");
    try {
      execSync("npx vite build", { cwd: studioRoot, stdio: "inherit" });
    } catch {
      writeStartupLog("error", "Failed to build frontend. Run 'cd packages/studio && pnpm build' manually.");
      process.exit(1);
    }
  }
}

appendRuntimeLog(`starting server root=${root} port=${port} staticDir=${distDir}`);

startStudioServer(root, port, { staticDir: distDir }).then(() => {
  appendRuntimeLog(`server listening port=${port}`);
}).catch((e) => {
  appendRuntimeLog("failed to start studio", e);
  writeStartupLog("error", `Failed to start studio: ${formatUnknownError(e)}`);
  process.exit(1);
});
