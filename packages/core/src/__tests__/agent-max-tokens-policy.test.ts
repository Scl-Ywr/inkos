import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Utility agents (architect, planner, polisher) should NOT hard-code maxTokens —
 * they rely on modelCard defaults / provider fallback.
 *
 * Creative / heavy-output agents (writer, reviser, length-normalizer) set explicit
 * per-call maxTokens to protect against the lowered unknown-model fallback.
 */
const UTILITY_AGENT_FILES = [
  "../agents/architect.ts",
  "../agents/planner.ts",
  "../agents/polisher.ts",
] as const;

const WRITING_AGENT_FILES = [
  "../agents/writer.ts",
  "../agents/reviser.ts",
  "../agents/length-normalizer.ts",
] as const;

describe("creative agent maxTokens policy", () => {
  it("utility agents let modelCard defaults own generation output budgets", async () => {
    const testDir = dirname(fileURLToPath(import.meta.url));
    const offenders: string[] = [];

    for (const relativePath of UTILITY_AGENT_FILES) {
      const source = await readFile(join(testDir, relativePath), "utf-8");
      if (/\bmaxTokens\s*:/.test(source)) {
        offenders.push(relativePath);
      }
    }

    expect(offenders).toEqual([]);
  });

  it("writing agents set explicit maxTokens to guard against unknown-model fallback", async () => {
    const testDir = dirname(fileURLToPath(import.meta.url));
    const missing: string[] = [];

    for (const relativePath of WRITING_AGENT_FILES) {
      const source = await readFile(join(testDir, relativePath), "utf-8");
      if (!/\bmaxTokens\s*:/.test(source)) {
        missing.push(relativePath);
      }
    }

    expect(missing).toEqual([]);
  });
});
