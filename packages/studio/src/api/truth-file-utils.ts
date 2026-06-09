import { isAbsolute, relative, resolve } from "node:path";

// Flat-file whitelist: legacy story root files plus Studio editor targets.
const TRUTH_FLAT_FILES = [
  "author_intent.md", "current_focus.md",
  "story_bible.md", "book_rules.md", "volume_outline.md", "current_state.md",
  "particle_ledger.md", "pending_hooks.md", "chapter_summaries.md",
  "subplot_board.md", "emotional_arcs.md", "character_matrix.md",
  "style_guide.md", "parent_canon.md", "fanfic_canon.md",
] as const;

// Authoritative Phase 5 paths under story/.
const TRUTH_OUTLINE_FILES = [
  "outline/story_frame.md",
  "outline/volume_map.md",
  "outline/节奏原则.md",
  "outline/rhythm_principles.md",
] as const;

export const LEGACY_SHIM_FILES: ReadonlySet<string> = new Set(["story_bible.md", "book_rules.md"]);

export function resolveTruthFilePath(bookDir: string, file: string): string | null {
  if (!file || file.includes("\0") || isAbsolute(file) || file.includes("..")) {
    return null;
  }

  const allowed =
    TRUTH_FLAT_FILES.includes(file as (typeof TRUTH_FLAT_FILES)[number])
    || TRUTH_OUTLINE_FILES.includes(file as (typeof TRUTH_OUTLINE_FILES)[number])
    || /^roles\/(主要角色|次要角色|major|minor)\/[^/]+\.md$/.test(file);

  if (!allowed) return null;

  const storyDir = resolve(bookDir, "story");
  const resolved = resolve(storyDir, file);
  const relativePath = relative(storyDir, resolved);
  if (relativePath === "" || relativePath.startsWith("..") || isAbsolute(relativePath)) {
    return null;
  }
  return resolved;
}
