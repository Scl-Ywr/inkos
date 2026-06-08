import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { copyDirRecursive, copyDirShallow } from "../utils/fs-copy.js";

describe("fs-copy helpers", () => {
  it("copies only top-level files in shallow mode", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-copy-shallow-"));
    const src = join(root, "src");
    const dest = join(root, "dest");
    await mkdir(join(src, "nested"), { recursive: true });
    await writeFile(join(src, "top.md"), "top", "utf-8");
    await writeFile(join(src, "nested", "child.md"), "child", "utf-8");

    await copyDirShallow(src, dest);

    await expect(readFile(join(dest, "top.md"), "utf-8")).resolves.toBe("top");
    await expect(readFile(join(dest, "nested", "child.md"), "utf-8")).rejects.toThrow();
  });

  it("copies nested files in recursive mode and ignores missing sources", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-copy-recursive-"));
    const src = join(root, "src");
    const dest = join(root, "dest");
    await mkdir(join(src, "nested"), { recursive: true });
    await writeFile(join(src, "top.md"), "top", "utf-8");
    await writeFile(join(src, "nested", "child.md"), "child", "utf-8");

    await copyDirRecursive(src, dest);
    await copyDirRecursive(join(root, "missing"), join(root, "ignored"));

    await expect(readFile(join(dest, "top.md"), "utf-8")).resolves.toBe("top");
    await expect(readFile(join(dest, "nested", "child.md"), "utf-8")).resolves.toBe("child");
  });
});
