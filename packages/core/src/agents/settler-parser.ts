import type { GenreProfile } from "../models/genre-profile.js";

export interface SettlementOutput {
  readonly postSettlement: string;
  readonly updatedState: string;
  readonly updatedLedger: string;
  readonly updatedHooks: string;
  readonly chapterSummary: string;
  readonly updatedSubplots: string;
  readonly updatedEmotionalArcs: string;
  readonly updatedCharacterMatrix: string;
}

export function parseSettlementOutput(
  content: string,
  genreProfile: GenreProfile,
): SettlementOutput {
  const extract = (tag: string): string => {
    const regex = new RegExp(
      `=== ${tag} ===\\s*([\\s\\S]*?)(?==== [A-Z_]+ ===|$)`,
    );
    const match = content.match(regex);
    return match?.[1]?.trim() ?? "";
  };

  const updatedState = extract("UPDATED_STATE");
  const updatedLedger = extract("UPDATED_LEDGER");
  const updatedHooks = extract("UPDATED_HOOKS");
  if (!updatedState || !updatedHooks) {
    throw new Error(
      "legacy settlement output is incomplete: expected UPDATED_STATE and UPDATED_HOOKS",
    );
  }

  return {
    postSettlement: extract("POST_SETTLEMENT"),
    updatedState,
    updatedLedger: genreProfile.numericalSystem
      ? (updatedLedger || "(账本未更新)")
      : "",
    updatedHooks,
    chapterSummary: extract("CHAPTER_SUMMARY"),
    updatedSubplots: extract("UPDATED_SUBPLOTS"),
    updatedEmotionalArcs: extract("UPDATED_EMOTIONAL_ARCS"),
    updatedCharacterMatrix: extract("UPDATED_CHARACTER_MATRIX"),
  };
}
