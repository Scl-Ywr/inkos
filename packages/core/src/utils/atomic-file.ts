import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import {
  copyFile,
  mkdir,
  open,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
import { dirname } from "node:path";

function temporaryPath(path: string): string {
  return `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export async function atomicWriteFile(
  path: string,
  data: string | Uint8Array,
  encoding: BufferEncoding = "utf-8",
  createBackup = true,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = temporaryPath(path);
  try {
    const handle = await open(temp, "wx");
    try {
      await handle.writeFile(data, typeof data === "string" ? { encoding } : undefined);
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (createBackup) {
      await copyFile(path, `${path}.bak`).catch(() => undefined);
    }
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

export function atomicWriteFileSync(
  path: string,
  data: string | Uint8Array,
  encoding: BufferEncoding = "utf-8",
  createBackup = true,
): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = temporaryPath(path);
  try {
    writeFileSync(temp, data, typeof data === "string" ? { encoding, flag: "wx" } : { flag: "wx" });
    if (createBackup) {
      try {
        copyFileSync(path, `${path}.bak`);
      } catch {
        // The first write has no previous version to preserve.
      }
    }
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

export function corruptBackupPath(path: string): string {
  return `${path}.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}`;
}

export async function readJsonWithBackup<T>(
  path: string,
  parse: (value: unknown) => T,
): Promise<T> {
  try {
    return parse(JSON.parse(await readFile(path, "utf-8")));
  } catch (primaryError) {
    const backupPath = `${path}.bak`;
    try {
      const recovered = parse(JSON.parse(await readFile(backupPath, "utf-8")));
      await copyFile(path, corruptBackupPath(path)).catch(() => undefined);
      await atomicWriteFile(path, `${JSON.stringify(recovered, null, 2)}\n`, "utf-8", false);
      return recovered;
    } catch {
      throw primaryError;
    }
  }
}

export function readJsonWithBackupSync<T>(
  path: string,
  parse: (value: unknown) => T,
): T {
  try {
    return parse(JSON.parse(readFileSync(path, "utf-8")));
  } catch (primaryError) {
    const backupPath = `${path}.bak`;
    try {
      const recovered = parse(JSON.parse(readFileSync(backupPath, "utf-8")));
      try {
        copyFileSync(path, corruptBackupPath(path));
      } catch {
        // Preserve the original parse error if the damaged file cannot be copied.
      }
      atomicWriteFileSync(path, `${JSON.stringify(recovered, null, 2)}\n`, "utf-8", false);
      return recovered;
    } catch {
      throw primaryError;
    }
  }
}
