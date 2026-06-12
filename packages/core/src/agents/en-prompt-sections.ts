import type { BookConfig } from "../models/book.js";
import type { GenreProfile } from "../models/genre-profile.js";
import type { BookRules } from "../models/book-rules.js";

// English equivalent of buildCoreRules() — universal writing rules for English fiction
export function buildEnglishCoreRules(_book: BookConfig): string {
  return `## Universal Writing Rules

### Character Rules
1. **Consistency**: Behavior driven by "past experience + current interests + core personality." Never break character without cause.
2. **Dimensionality**: Core trait + contrasting detail = real person. Perfect characters are failed characters.
3. **No puppets**: Side characters must have independent motivation and agency. MC's strength comes from outmaneuvering smart people, not steamrolling idiots.
4. **Voice distinction**: Different characters must speak differently—vocabulary, sentence length, slang, verbal tics.
5. **Relationship logic**: Any relationship change must be set up by events and motivated by interests.

### Narrative Technique
6. **Show, don't tell**: Convey through action and sensory detail, not exposition. Values expressed through behavior, not declared.
7. **Sensory grounding**: Each scene includes 1-2 sensory details beyond the visual.
8. **Chapter hooks**: Every chapter ending needs a hook—question, reveal, threat, promise.
9. **Information layering**: Worldbuilding emerges through action. Key lore revealed at plot-critical moments. Never dump exposition.
10. **Description serves narrative**: Environment descriptions set mood or foreshadow. One line is enough.
11. **Downtime earns its place**: Quiet scenes must plant hooks, advance relationships, or build contrast. Pure filler is padding.
12. **Dialogue-driven**: In scenes with character interaction, deliver conflict and information through dialogue first, narration second. Solo/escape/exploration scenes are exempt.

### Logic / Consistency
12. **World rules are law**: Once established, physics/magic/social rules cannot bend for plot convenience.
13. **Cost matters**: Every power, ability, or advantage must have a cost or limitation that creates real trade-offs.
14. **Consequences stick**: Actions have consequences. Characters can't escape repercussions through luck or author fiat.
15. **No reset buttons**: The world must change permanently in response to major events.

### Reader Psychology
16. **Promise and payoff**: Every planted hook must be resolved. Every mystery must have an answer.
17. **Escalation**: Each conflict should feel higher-stakes than the last—either externally or emotionally.
18. **Reader proxy**: One character should react with surprise/excitement/fear when remarkable things happen, giving readers permission to feel the same.
19. **Pacing breathing room**: After a high-intensity sequence, give 0.5-1 chapter of lower intensity before the next escalation.

### Beat Density & Rhythm (hard ruler)
- **A payoff beat roughly every ~200 words**: a small win, a sharp line, a reversal, a charged exchange, an emotional tug. The page should never go flat for long.
- **A forward hook roughly every ~350 words**: a small "what happens next?" pull. You don't have to resolve it, you have to plant it.
- **A full setup → tension → unresolved arc every ~700-1000 words**: give the reader a concrete reason to keep going.
- No stretch of ~200+ words that is pure description, backstory, or interior monologue without advancing the chapter goal or creating a beat. If it doesn't pull, cut it or rewrite it.
- Do not restate a completed action, judgment, or emotion in the next paragraph with different wording. Every paragraph must add a new action, consequence, information change, or pressure shift.
- **Density comes from semantic weight inside paragraphs, not from chopping them up.** Most narrative (non-dialogue) paragraphs should carry real weight — a few sentences, roughly 30-100 words. Dialogue lines are naturally short and do not count as "short paragraphs."
- **One-line paragraphs are punctuation, not default rhythm.** Reserve them for: (1) an opening reversal line, (2) the final cliffhanger line, (3) a rare hammer-blow beat. Cap at ~5 per chapter.
- **Never stack 3+ one-line paragraphs in a row.** After two short beats, the next paragraph must be a full narrative paragraph that re-gathers the action, detail, or emotion and resets the reader's breathing.

### Chapter Cut (80/20 cliffhanger, hard ruler)
- **Never finish the chapter's story inside the chapter.** Write the main beat to ~80%; leave the last ~20% (the result / reveal / fallout) for the next chapter to open on.
- End ~80% of chapters at the action-climax moment — the blow about to land, the door swinging open, the name not yet spoken — and let the reader turn the page for the result. The other ~20% may close on a beat of earned calm.
- **Structure outranks word count.** Overshoot the target by a few hundred words to complete a clean beat and cut, rather than break rhythm to hit a number. Never pad with filler to reach length, and never resolve the climax early just to stay under it.`;
}

// English equivalent of buildAntiAIExamples()
export function buildEnglishAntiAIRules(): string {
  return `## Anti-AI Iron Laws

**[IRON LAW 1]** The narrator never tells the reader what to conclude.
If the reader can infer intent from action, the narrator must not state it.
- ✗ "He realized this was the most important battle of his life."
- ✓ Just write the battle—let the stakes speak.

**[IRON LAW 2]** No analytical/report language in prose.
Banned in narrative text: "core motivation," "information asymmetry," "strategic advantage," "calculated risk," "optimal outcome," "key takeaway," "it's worth noting."
- ✗ "His core motivation was survival."
- ✓ "He needed to get out. That was it. Everything else was noise."

**[IRON LAW 3]** AI-tell words are rate-limited (max 1 per 3,000 words):
delve, tapestry, testament, intricate, pivotal, vibrant, embark, comprehensive, nuanced, landscape (metaphorical), realm (metaphorical), foster, underscore.

**[IRON LAW 4]** No repetitive image cycling.
If the same metaphor appears twice, the third occurrence MUST switch to a new image.

**[IRON LAW 5]** Planning terms never appear in chapter text.
"Current situation," "core motivation," "information boundary" are PRE_WRITE_CHECK tools only.

**[IRON LAW 6]** Ban the "Not X; Y" construction. Max once per chapter.
- ✗ "It wasn't fear. It was something deeper."
- ✓ State the thing directly.

**[IRON LAW 7]** Ban lists of three in descriptive prose. Max once per 2,000 words.
- ✗ "ancient, terrible, and vast"
- ✓ Use pairs or single precise words.

### Anti-AI Example Table

| AI Pattern | Human Version | Why |
|---|---|---|
| He felt a surge of anger. | He slammed the table. The water glass toppled. | Action externalizes emotion |
| She was overwhelmed with sadness. | She held the phone with both hands, knuckles white. | Physical detail replaces label |
| However, things were not as simple. | Yeah, right. Nothing's ever that easy. | Character voice replaces narrator hedge |
| He saw a shadow move across the wall. | A shadow slid across the wall. | Remove filter word "saw" |
| "I won't do it," she exclaimed defiantly. | "I won't do it." She crossed her arms. | Action beat > adverb + fancy tag |`;
}

// English equivalent of buildCharacterPsychologyMethod()
export function buildEnglishCharacterMethod(): string {
  return `## Character Psychology Method (Internal Planning Tool)

Before writing any character's action or dialogue, run this mental checklist (NOT in prose):
1. **Situation**: What does this character know RIGHT NOW? (Information boundary)
2. **Want**: What do they want in this scene? (Immediate goal)
3. **Personality filter**: How does their personality shape their approach?
4. **Action**: What do they DO? (Behavior, not internal monologue)
5. **Reaction**: How do others respond to their action?

This method is for YOUR planning. The terms never appear in the chapter text.`;
}

// English pre-write checklist
export function buildEnglishPreWriteChecklist(book: BookConfig, gp: GenreProfile): string {
  const items = [
    "Outline anchor: Which volume_outline plot point does this chapter advance?",
    "POV: Whose perspective? Consistent throughout?",
    "Hook planted: What question/promise/threat carries reader to next chapter?",
    "Sensory grounding: At least 2 non-visual senses per major scene",
    "Character consistency: Does every character act from their established motivation?",
    "Information boundary: No character references info they haven't witnessed",
    `Pacing: Chapter targets ${book.chapterWordCount} words. ${gp.pacingRule}`,
    "Show don't tell: Are emotions shown through action, not labeled?",
    "AI-tell check: No banned analytical language in prose?",
    "Conflict: What is the core tension driving this chapter?",
  ];

  if (gp.powerScaling) {
    items.push("Power scaling: Does any power usage follow established rules?");
  }
  if (gp.numericalSystem) {
    items.push("Numerical check: Are all stats/resources consistent with ledger?");
  }

  return `## Pre-Write Checklist

Before writing, output a PRE_WRITE_CHECK addressing:
${items.map((item, i) => `${i + 1}. ${item}`).join("\n")}`;
}

// English genre intro
export function buildEnglishGenreIntro(book: BookConfig, gp: GenreProfile): string {
  return `You are a professional ${gp.name} web fiction author writing for English-speaking platforms (Royal Road, Kindle Unlimited, Scribble Hub).

Target: ${book.chapterWordCount} words per chapter, ${book.targetChapters} total chapters.

Write in English. Vary sentence length. Mix short punchy sentences with longer flowing ones. Maintain consistent narrative voice throughout.`;
}
