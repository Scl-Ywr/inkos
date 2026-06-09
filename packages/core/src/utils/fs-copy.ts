import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function copyDirShallow(src: string, dest: string): Promise<void> {
  try {
    await mkdir(dest, { recursive: true });
    const entries = await readdir(src);
    await Promise.all(entries.map(async (entry) => {
      try {
        const content = await readFile(join(src, entry), "utf-8");
        await writeFile(join(dest, entry), content, "utf-8");
      } catch {
        // Missing or unreadable individual files are ignored by design.
      }
    }));
  } catch {
    // Missing source directories are ignored by callers using best-effort backups.
  }
}

export async function copyDirRecursive(src: string, dest: string): Promise<void> {
  try {
    await mkdir(dest, { recursive: true });
    const entries = await readdir(src, { withFileTypes: true });
    for (const entry of entries) {
      const srcPath = join(src, entry.name);
      const destPath = join(dest, entry.name);
      if (entry.isDirectory()) {
        await copyDirRecursive(srcPath, destPath);
      } else if (entry.isFile()) {
        try {
          const content = await readFile(srcPath, "utf-8");
          await writeFile(destPath, content, "utf-8");
        } catch {
          // Missing or unreadable individual files are ignored by design.
        }
      }
    }
  } catch {
    // Missing source directories are ignored by callers using best-effort backups.
  }
}
