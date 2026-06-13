import { describe, expect, it } from "vitest";
import { parseSettlementOutput } from "../agents/settler-parser.js";
import type { GenreProfile } from "../models/genre-profile.js";

function genreProfile(numericalSystem: boolean): GenreProfile {
  return {
    numericalSystem,
  } as GenreProfile;
}

describe("parseSettlementOutput", () => {
  it("rejects responses that contain neither a delta nor complete legacy truth files", () => {
    expect(() =>
      parseSettlementOutput(
        "=== POST_SETTLEMENT ===\nObserved the chapter but omitted the truth files.",
        genreProfile(false),
      ),
    ).toThrow(/legacy settlement output is incomplete/i);
  });

  it("keeps legacy numerical output compatible when only the ledger is omitted", () => {
    const result = parseSettlementOutput([
      "=== UPDATED_STATE ===",
      "# Current State",
      "=== UPDATED_HOOKS ===",
      "# Hooks",
    ].join("\n"), genreProfile(true));

    expect(result.updatedLedger).toBe("(账本未更新)");
  });

  it("parses complete legacy output", () => {
    const result = parseSettlementOutput([
      "=== UPDATED_STATE ===",
      "# Current State",
      "=== UPDATED_HOOKS ===",
      "# Hooks",
      "=== CHAPTER_SUMMARY ===",
      "| 21 | A discovery |",
    ].join("\n"), genreProfile(false));

    expect(result.updatedState).toBe("# Current State");
    expect(result.updatedHooks).toBe("# Hooks");
    expect(result.chapterSummary).toContain("A discovery");
  });
});
