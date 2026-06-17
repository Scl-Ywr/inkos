/**
 * Post-write rule-based validator.
 *
 * Deterministic, zero-LLM-cost checks that run after every chapter generation.
 * Catches violations that prompt-only rules cannot guarantee.
 */

import { analyzeChapterCadence } from "../utils/chapter-cadence.js";
import type { BookRules } from "../models/book-rules.js";
import type { GenreProfile } from "../models/genre-profile.js";

export interface PostWriteViolation {
  readonly rule: string;
  readonly severity: "error" | "warning";
  readonly description: string;
  readonly suggestion: string;
}

export function normalizePostWriteSurface(
  content: string,
  languageOverride?: "zh" | "en",
): string {
  let normalized = stripPostWriteMetaLines(content);
  if (languageOverride !== "en") {
    normalized = normalized.replace(/——+/g, "，");
  }
  normalized = removeRepeatedParagraphs(normalized, languageOverride ?? "zh");
  return normalized.trimEnd();
}

export function removeRepeatedParagraphs(
  content: string,
  language: "zh" | "en" = "zh",
): string {
  const blocks = content.split(/(\r?\n\s*\r?\n)/);
  const seen = new Set<string>();
  const output: string[] = [];

  for (let index = 0; index < blocks.length; index += 2) {
    const paragraph = blocks[index] ?? "";
    const separator = blocks[index + 1] ?? "";
    const comparable = normalizeRepeatUnit(paragraph, language);
    const substantial = comparable.length >= (language === "en" ? 120 : 45);
    if (substantial && seen.has(comparable)) continue;
    if (substantial) seen.add(comparable);
    output.push(paragraph, separator);
  }

  return output.join("").replace(/(?:\r?\n\s*){3,}/g, "\n\n");
}

function stripPostWriteMetaLines(content: string): string {
  const lines = content.split(/\r?\n/);
  const filtered = lines.filter((line) =>
    !/^\s*\[(?:polisher|writer|reviser|reviewer)-note\]\s*/i.test(line)
    && !/^\s*\[(?:润色|写作|修订|审稿)备注\]\s*/.test(line)
  );
  return filtered.join("\n");
}

interface ParagraphShape {
  readonly paragraphs: ReadonlyArray<string>;
  readonly shortThreshold: number;
  readonly shortParagraphs: ReadonlyArray<string>;
  readonly shortRatio: number;
  readonly averageLength: number;
  readonly maxConsecutiveShort: number;
}

// --- Marker word lists ---

/** AI转折/惊讶标记词 */
const SURPRISE_MARKERS = ["仿佛", "忽然", "竟然", "猛地", "猛然", "不禁", "宛如"];

/** 元叙事/编剧旁白模式 */
const META_NARRATION_PATTERNS = [
  /到这里[，,]?算是/,
  /接下来[，,]?(?:就是|将会|即将)/,
  /(?:后面|之后)[，,]?(?:会|将|还会)/,
  /(?:故事|剧情)(?:发展)?到了/,
  /读者[，,]?(?:可能|应该|也许)/,
  /我们[，,]?(?:可以|不妨|来看)/,
];

/** 分析报告式术语（禁止出现在正文中） */
const REPORT_TERMS = [
  "核心动机", "信息边界", "信息落差", "核心风险", "利益最大化",
  "当前处境", "行为约束", "性格过滤", "情绪外化", "锚定效应",
  "沉没成本", "认知共鸣",
];

/** 作者说教词 */
const SERMON_WORDS = ["显然", "毋庸置疑", "不言而喻", "众所周知", "不难看出"];

/** 全场震惊类集体反应 */
const COLLECTIVE_SHOCK_PATTERNS = [
  /(?:全场|众人|所有人|在场的人)[，,]?(?:都|全|齐齐|纷纷)?(?:震惊|惊呆|倒吸凉气|目瞪口呆|哗然|惊呼)/,
  /(?:全场|一片)[，,]?(?:寂静|哗然|沸腾|震动)/,
];

// --- Validator ---

export function validatePostWrite(
  content: string,
  genreProfile: GenreProfile,
  bookRules: BookRules | null,
  languageOverride?: "zh" | "en",
): ReadonlyArray<PostWriteViolation> {
  const violations: PostWriteViolation[] = [];

  // Skip Chinese-specific rules for English content
  const isEnglish = (languageOverride ?? genreProfile.language) === "en";
  if (isEnglish) {
    // For English, only run book-specific prohibitions and paragraph length check
    return validatePostWriteEnglish(content, genreProfile, bookRules);
  }

  // 1. 硬性禁令: "不是…而是…" 句式
  if (/不是[^，。！？\n]{0,30}[，,]?\s*而是/.test(content)) {
    violations.push({
      rule: "禁止句式",
      severity: "error",
      description: "出现了「不是……而是……」句式",
      suggestion: "改用直述句",
    });
  }

  // 2. 硬性禁令: 破折号
  if (content.includes("——")) {
    violations.push({
      rule: "禁止破折号",
      severity: "error",
      description: "出现了破折号「——」",
      suggestion: "用逗号或句号断句",
    });
  }

  // 3. 转折/惊讶标记词密度 ≤ 1次/3000字
  const markerCounts: Record<string, number> = {};
  let totalMarkerCount = 0;
  for (const word of SURPRISE_MARKERS) {
    const matches = content.match(new RegExp(word, "g"));
    const count = matches?.length ?? 0;
    if (count > 0) {
      markerCounts[word] = count;
      totalMarkerCount += count;
    }
  }
  const markerLimit = Math.max(1, Math.floor(content.length / 3000));
  if (totalMarkerCount > markerLimit) {
    const detail = Object.entries(markerCounts)
      .map(([w, c]) => `"${w}"×${c}`)
      .join("、");
    violations.push({
      rule: "转折词密度",
      severity: "warning",
      description: `转折/惊讶标记词共${totalMarkerCount}次（上限${markerLimit}次/${content.length}字），明细：${detail}`,
      suggestion: "改用具体动作或感官描写传递突然性",
    });
  }

  // 4. 高疲劳词检查（从 genreProfile 读取，单章每词 ≤ 1次）
  const fatigueWords = bookRules?.fatigueWordsOverride && bookRules.fatigueWordsOverride.length > 0
    ? bookRules.fatigueWordsOverride
    : genreProfile.fatigueWords;
  for (const word of fatigueWords) {
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const matches = content.match(new RegExp(escaped, "g"));
    const count = matches?.length ?? 0;
    if (count > 1) {
      violations.push({
        rule: "高疲劳词",
        severity: "warning",
        description: `高疲劳词"${word}"出现${count}次（上限1次/章）`,
        suggestion: `替换多余的"${word}"为同义但不同形式的表达`,
      });
    }
  }

  // 4b. 禁用词检查（bannedWords — 绝对禁止出现）
  if (bookRules?.bannedWords) {
    for (const word of bookRules.bannedWords) {
      const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const matches = content.match(new RegExp(escaped, "g"));
      if (matches && matches.length > 0) {
        violations.push({
          rule: "禁用词",
          severity: "error",
          description: `禁用词"${word}"出现${matches.length}次`,
          suggestion: `删除或替换"${word}"`,
        });
      }
    }
  }

  // 4c. 优先词替换建议（preferredWords — 建议替换）
  if (bookRules?.preferredWords) {
    for (const { avoid, prefer } of bookRules.preferredWords) {
      const escaped = avoid.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const matches = content.match(new RegExp(escaped, "g"));
      if (matches && matches.length > 0) {
        violations.push({
          rule: "优先词替换",
          severity: "warning",
          description: `"${avoid}"出现${matches.length}次，建议替换为"${prefer}"`,
          suggestion: `将"${avoid}"替换为"${prefer}"`,
        });
      }
    }
  }

  // 5. 元叙事检查（编剧旁白）
  for (const pattern of META_NARRATION_PATTERNS) {
    const match = content.match(pattern);
    if (match) {
      violations.push({
        rule: "元叙事",
        severity: "warning",
        description: `出现编剧旁白式表述："${match[0]}"`,
        suggestion: "删除元叙事，让剧情自然展开",
      });
      break; // 报一次即可
    }
  }

  // 6. 分析报告式术语
  const foundTerms: string[] = [];
  for (const term of REPORT_TERMS) {
    if (content.includes(term)) {
      foundTerms.push(term);
    }
  }
  if (foundTerms.length > 0) {
    violations.push({
      rule: "报告术语",
      severity: "error",
      description: `正文中出现分析报告术语：${foundTerms.map(t => `"${t}"`).join("、")}`,
      suggestion: "这些术语只能用于 PRE_WRITE_CHECK 内部推理，正文中用口语化表达替代",
    });
  }

  // 7. 正文中的章节号指称（如"第33章"、"chapter 33"）
  const chapterRefPattern = /(?:第\s*\d+\s*章|[Cc]hapter\s+\d+)/g;
  const chapterRefs = content.match(chapterRefPattern);
  if (chapterRefs && chapterRefs.length > 0) {
    const unique = [...new Set(chapterRefs)];
    violations.push({
      rule: isEnglish ? "chapter-number-reference" : "章节号指称",
      severity: "error",
      description: isEnglish
        ? `Chapter text contains explicit chapter number references: ${unique.map(r => `"${r}"`).join(", ")}. Characters do not know they are in a numbered chapter.`
        : `正文中出现了章节号指称：${unique.map(r => `"${r}"`).join("、")}。角色不知道自己在第几章。`,
      suggestion: isEnglish
        ? "Replace with natural references: 'that night', 'when the warehouse burned', 'the incident at the dock'"
        : '改成自然表达："那天晚上"、"仓库出事那次"、"码头上的事"',
    });
  }

  // 8. 作者说教词
  const foundSermons: string[] = [];
  for (const word of SERMON_WORDS) {
    if (content.includes(word)) {
      foundSermons.push(word);
    }
  }
  if (foundSermons.length > 0) {
    violations.push({
      rule: "作者说教",
      severity: "warning",
      description: `出现说教词：${foundSermons.map(w => `"${w}"`).join("、")}`,
      suggestion: "删除说教词，让读者自己从情节中判断",
    });
  }

  // 8. 全场震惊类集体反应
  for (const pattern of COLLECTIVE_SHOCK_PATTERNS) {
    const match = content.match(pattern);
    if (match) {
      violations.push({
        rule: "集体反应",
        severity: "warning",
        description: `出现集体反应套话："${match[0]}"`,
        suggestion: "改写成1-2个具体角色的身体反应",
      });
      break;
    }
  }

  // 9. 连续"了"字检查（3句以上连续含"了"）
  const sentences = content
    .split(/[。！？]/)
    .map(s => s.trim())
    .filter(s => s.length > 2);

  let consecutiveLe = 0;
  let maxConsecutiveLe = 0;
  for (const sentence of sentences) {
    if (sentence.includes("了")) {
      consecutiveLe++;
      maxConsecutiveLe = Math.max(maxConsecutiveLe, consecutiveLe);
    } else {
      consecutiveLe = 0;
    }
  }
  if (maxConsecutiveLe >= 6) {
    violations.push({
      rule: "连续了字",
      severity: "warning",
      description: `检测到${maxConsecutiveLe}句连续包含"了"字，节奏拖沓`,
      suggestion: "保留最有力的一个「了」，其余改为无「了」句式",
    });
  }

  // 10. 段落长度检查（手机阅读适配：50-250字/段为宜）
  const paragraphs = content
    .split(/\n\s*\n/)
    .map(p => p.trim())
    .filter(p => p.length > 0);

  const longParagraphs = paragraphs.filter(p => p.length > 300);
  if (longParagraphs.length >= 2) {
    violations.push({
      rule: "段落过长",
      severity: "warning",
      description: `${longParagraphs.length}个段落超过300字，不适合手机阅读`,
      suggestion: "长段落拆分为3-5行的短段落，在动作切换或情绪节点处断开",
    });
  }

  violations.push(...detectInChapterRepetition(content, "zh"));
  violations.push(...detectParagraphShapeWarnings(content, "zh"));

  // 11. Book-level prohibitions
  // Short prohibitions (2-30 chars): exact substring match
  // Long prohibitions (>30 chars): skip — these are conceptual rules for prompt-level enforcement only
  if (bookRules?.prohibitions) {
    for (const prohibition of bookRules.prohibitions) {
      if (prohibition.length >= 2 && prohibition.length <= 30 && content.includes(prohibition)) {
        violations.push({
          rule: "本书禁忌",
          severity: "error",
          description: `出现了本书禁忌内容："${prohibition}"`,
          suggestion: "删除或改写该内容",
        });
      }
    }
  }

  // 12. Narrative-person adherence (#290). A first-person book must read as first
  // person. The clearest deterministic signal of third-person drift is a chapter
  // that barely uses 我 yet repeatedly narrates the protagonist by name. Thresholds
  // are conservative so genuine first-person prose (many 我) never trips.
  const personViolation = detectNarrativePersonDrift(content, bookRules);
  if (personViolation) violations.push(personViolation);

  // 13. Punctuation anomalies
  // 13a. Repeated punctuation (3+ same marks in a row like ！！！ 。。。)
  const repeatedPunct = content.match(/([！？。…])\1{2,}/g);
  if (repeatedPunct) {
    for (const match of repeatedPunct) {
      violations.push({
        rule: "标点异常",
        severity: "warning",
        description: `连续重复标点「${match.slice(0, 6)}」`,
        suggestion: "单个标点即可表达语气",
      });
    }
  }
  // 13b. Half-width commas/periods in Chinese text
  const halfWidthPunct = content.match(/[，。；：！？][^a-zA-Z0-9]*[,;]/g);
  if (halfWidthPunct && halfWidthPunct.length > 2) {
    violations.push({
      rule: "标点异常",
      severity: "warning",
      description: `中文段落内出现半角标点（${halfWidthPunct.length}处）`,
      suggestion: "统一使用全角标点",
    });
  }
  // 13c. Mismatched quotation marks
  const leftQuotes = (content.match(/["“「]/g) ?? []).length;
  const rightQuotes = (content.match(/["”」]/g) ?? []).length;
  if (Math.abs(leftQuotes - rightQuotes) > 1) {
    violations.push({
      rule: "标点异常",
      severity: "warning",
      description: `引号不成对（左${leftQuotes}个，右${rightQuotes}个）`,
      suggestion: "检查引号是否配对",
    });
  }

  // 14. Collocation errors (common Chinese mistakes)
  for (const [wrong, correct] of COLLOCATION_ERRORS) {
    if (content.includes(wrong)) {
      violations.push({
        rule: "搭配错误",
        severity: "warning",
        description: `可能的搭配错误：「${wrong}」→「${correct}」`,
        suggestion: `改为「${correct}」`,
      });
    }
  }

  // 15. Sentence-skeleton repetition (structural repetition even with different words)
  const lang = languageOverride ?? genreProfile.language;
  const skeletonViolations = detectSentenceSkeletonRepetition(content, lang);
  violations.push(...skeletonViolations);

  return violations;
}

function detectSentenceSkeletonRepetition(
  content: string,
  language: "zh" | "en",
): ReadonlyArray<PostWriteViolation> {
  const violations: PostWriteViolation[] = [];
  // Split into sentences; filter out short ones (dialogue, interjections)
  const minLen = language === "en" ? 50 : 20;
  const sentences = content
    .split(language === "en" ? /(?<=[.!?])\s+/ : /[。！？!?；；]/)
    .map((s) => s.trim())
    .filter((s) => s.length >= minLen);

  const skeletons = sentences.map(extractSentenceSkeleton);
  // Compare consecutive pairs within a window of 3
  const windowSize = 3;
  for (let i = 0; i < skeletons.length; i += 1) {
    for (let j = i + 1; j <= Math.min(i + windowSize, skeletons.length - 1); j += 1) {
      const sim = skeletonSimilarity(skeletons[i]!, skeletons[j]!);
      if (sim >= 0.7) {
        violations.push({
          rule: "句式重复",
          severity: "warning",
          description: language === "en"
            ? `Nearby sentences share the same structural skeleton (${Math.round(sim * 100)}% overlap)`
            : `相邻句式骨架高度相似（${Math.round(sim * 100)}%重合）："${sentences[i]!.slice(0, 25)}…" vs "${sentences[j]!.slice(0, 25)}…"`,
          suggestion: language === "en"
            ? "Restructure one sentence with a different subject-verb order or clause arrangement."
            : "改写其中一句的句式结构——换主语、变换从句顺序或用不同连接词。",
        });
        // Only report once per pair
        return violations;
      }
    }
  }
  return violations;
}

type SkeletonToken = "S" | "V" | "O" | "M" | "C" | "X";

function extractSentenceSkeleton(sentence: string): ReadonlyArray<SkeletonToken> {
  if (/^[一-鿿]/.test(sentence)) {
    return extractChineseSkeleton(sentence);
  }
  return extractEnglishSkeleton(sentence);
}

function extractChineseSkeleton(sentence: string): SkeletonToken[] {
  const tokens: SkeletonToken[] = [];
  // Pattern-based extraction for Chinese: identify subject-like, verb-like, modifier positions
  const segments = sentence.split(/[,，、：:；;]/);
  for (const seg of segments) {
    const trimmed = seg.trim();
    if (!trimmed) continue;
    // Subject-like: starts with name/pronounnoun
    if (/^[他她它我你您]/.test(trimmed) || /^[A-Z一-鿿]{1,4}(?:道|说|想|看|笑|叫|叹|怒)/.test(trimmed)) {
      tokens.push("S");
    }
    // Verb-like: action/movement/state words
    else if (/(?:了|着|过|起来|下去|出来|进来|回去|起来|下来|上去)(?:$|[，。！？，；])/.test(trimmed)
      || /^(?:便|就|却|又|也|再|还|才|已|正|在|将|被|把|向|从|到|对|跟|和)/.test(trimmed)) {
      tokens.push("V");
    }
    // Modifier-like: starts with adverb patterns
    else if (/^(?:忽然|突然|猛然|渐渐|慢慢|悄悄|默默|终于|果然|竟然|居然|似乎|好像|仿佛|犹如)/.test(trimmed)) {
      tokens.push("M");
    }
    // Complement-like: result/direction
    else if (/(?:得|地|极|透|死|坏|光|完|尽)/.test(trimmed)) {
      tokens.push("C");
    }
    else {
      tokens.push("X");
    }
  }
  return tokens;
}

function extractEnglishSkeleton(sentence: string): SkeletonToken[] {
  const words = sentence.split(/\s+/).filter(w => w.length > 0);
  const tokens: SkeletonToken[] = [];
  let prevTag: SkeletonToken | null = null;
  for (const word of words) {
    const w = word.toLowerCase().replace(/[^a-z']/g, "");
    if (!w) continue;
    let tag: SkeletonToken;
    if (/^(he|she|it|they|we|i|you|this|that|these|those|the|a|an)$/.test(w)) {
      tag = "S";
    } else if (/^(is|are|was|were|be|been|being|have|has|had|do|does|did|will|would|shall|should|can|could|may|might|must)$/.test(w)) {
      tag = "V";
    } else if (/^(quickly|slowly|suddenly|carefully|quietly|gently|finally|then|now|just|still|already|soon|almost|nearly|gradually|silently)$/i.test(w)) {
      tag = "M";
    } else if (/^(but|however|although|though|while|when|after|before|because|since|if|unless|until|once|as|so|and|or|nor|yet)$/i.test(w)) {
      tag = "C";
    } else {
      tag = "X";
    }
    // Compress consecutive same tags
    if (tag !== prevTag) {
      tokens.push(tag);
      prevTag = tag;
    }
  }
  return tokens;
}

function skeletonSimilarity(a: ReadonlyArray<SkeletonToken>, b: ReadonlyArray<SkeletonToken>): number {
  if (a.length === 0 || b.length === 0) return 0;
  // Compressed skeleton comparison using edit distance
  const la = a.join("");
  const lb = b.join("");
  const dist = levenshteinDistance(la, lb);
  const maxLen = Math.max(la.length, lb.length);
  return maxLen === 0 ? 1 : 1 - dist / maxLen;
}

function levenshteinDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => i);
  for (let j = 1; j <= n; j += 1) {
    let prev = dp[0]!;
    dp[0] = j;
    for (let i = 1; i <= m; i += 1) {
      const temp = dp[i]!;
      dp[i] = a[i - 1] === b[j - 1]
        ? prev
        : 1 + Math.min(prev, dp[i]!, dp[i - 1]!);
      prev = temp;
    }
  }
  return dp[m]!;
}

function detectNarrativePersonDrift(
  content: string,
  bookRules: BookRules | null,
): PostWriteViolation | null {
  if (bookRules?.narrativePerson !== "first") return null;
  const innerStateSlip = detectFirstPersonInnerStateSlip(content);
  if (innerStateSlip) {
    return {
      rule: "叙事人称",
      severity: "error",
      description: `本书设定为第一人称，但出现了第三人称内感叙述："${innerStateSlip}"`,
      suggestion: "把这类主观感受、意识、脑内活动改回「我」的内心视角；不要切到第三人称或全知视角。",
    };
  }

  const name = bookRules.protagonist?.name?.trim();
  if (!name) return null;
  const woCount = content.split("我").length - 1;
  const nameCount = content.split(name).length - 1;
  // Long chapter, almost no 我, protagonist repeatedly named → third-person prose.
  if (content.length >= 800 && woCount < 12 && nameCount >= 6 && nameCount > woCount) {
    return {
      rule: "叙事人称",
      severity: "error",
      description: `本书设定为第一人称，但本章几乎不用「我」（${woCount} 次）却反复以「${name}」第三人称叙述（${nameCount} 次）`,
      suggestion: "改用第一人称（主角内心视角）重写本章叙事",
    };
  }
  return null;
}

function detectFirstPersonInnerStateSlip(content: string): string | null {
  const sentences = content
    .split(/(?<=[。！？!?])|\n+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);

  for (const sentence of sentences) {
    if (!/^[他她]/.test(sentence)) continue;
    if (/^[他她][^。！？!?]{0,18}(?:觉得|感到|意识到|明白|想起|脑子里|心里|太阳穴)/.test(sentence)) {
      return sentence.length > 40 ? `${sentence.slice(0, 39)}…` : sentence;
    }
  }
  return null;
}

/**
 * Cross-chapter repetition check.
 * Detects phrases from the current chapter that also appeared in recent chapters.
 */
export function detectCrossChapterRepetition(
  currentContent: string,
  recentChaptersContent: string,
  language: "zh" | "en" = "zh",
): ReadonlyArray<PostWriteViolation> {
  if (!recentChaptersContent || recentChaptersContent.length < 100) return [];

  const violations: PostWriteViolation[] = [];
  const isEnglish = language === "en";

  if (isEnglish) {
    // Extract 3-word phrases from current chapter
    const words = currentContent.toLowerCase().replace(/[^\w\s']/g, "").split(/\s+/).filter(w => w.length > 2);
    const phraseCounts = new Map<string, number>();
    for (let i = 0; i < words.length - 2; i++) {
      const phrase = `${words[i]} ${words[i + 1]} ${words[i + 2]}`;
      phraseCounts.set(phrase, (phraseCounts.get(phrase) ?? 0) + 1);
    }
    // Check which repeated phrases (2+ in current) also appear in recent chapters
    const recentLower = recentChaptersContent.toLowerCase();
    const crossRepeats: string[] = [];
    for (const [phrase, count] of phraseCounts) {
      if (count >= 2 && recentLower.includes(phrase)) {
        crossRepeats.push(`"${phrase}" (×${count})`);
      }
    }
    if (crossRepeats.length >= 1) {
      violations.push({
        rule: "Cross-chapter repetition",
        severity: "error",
        description: `${crossRepeats.length} repeated phrases also found in recent chapters: ${crossRepeats.slice(0, 8).join(", ")}`,
        suggestion: "Vary action verbs and descriptive phrases to avoid cross-chapter repetition",
      });
    }
  } else {
    // Chinese: 6-char ngrams
    const chars = currentContent.replace(/[\s\n\r]/g, "");
    const phraseCounts = new Map<string, number>();
    for (let i = 0; i < chars.length - 5; i++) {
      const phrase = chars.slice(i, i + 6);
      if (/^[\u4e00-\u9fff]{6}$/.test(phrase)) {
        phraseCounts.set(phrase, (phraseCounts.get(phrase) ?? 0) + 1);
      }
    }
    const recentClean = recentChaptersContent.replace(/[\s\n\r]/g, "");
    const crossRepeats: string[] = [];
    for (const [phrase, count] of phraseCounts) {
      if (count >= 2 && recentClean.includes(phrase)) {
        crossRepeats.push(`"${phrase}"(×${count})`);
      }
    }
    if (crossRepeats.length >= 1) {
      violations.push({
        rule: "跨章重复",
        severity: "error",
        description: `${crossRepeats.length}个重复短语在近期章节中也出现过：${crossRepeats.slice(0, 8).join("、")}`,
        suggestion: "变换动作描写和场景用语，避免跨章节机械重复",
      });
    }
  }

  return violations;
}

export function detectParagraphLengthDrift(
  currentContent: string,
  recentChaptersContent: string,
  language: "zh" | "en" = "zh",
): ReadonlyArray<PostWriteViolation> {
  if (!recentChaptersContent || recentChaptersContent.trim().length === 0) return [];

  const current = analyzeParagraphShape(currentContent, language);
  const recent = analyzeParagraphShape(recentChaptersContent, language);

  if (current.paragraphs.length < 4 || recent.paragraphs.length < 4) return [];
  if (recent.averageLength <= 0 || current.averageLength <= 0) return [];

  const shrinkRatio = current.averageLength / recent.averageLength;
  const shortRatioDelta = current.shortRatio - recent.shortRatio;

  if (shrinkRatio >= 0.6 || current.shortRatio < 0.5 || shortRatioDelta < 0.25) {
    return [];
  }

  const dropPercent = Math.round((1 - shrinkRatio) * 100);

  return [
    language === "en"
      ? {
          rule: "Paragraph density drift",
          severity: "warning",
          description: `Average paragraph length dropped from ${Math.round(recent.averageLength)} to ${Math.round(current.averageLength)} characters (${dropPercent}% shorter) compared with recent chapters.`,
          suggestion: "Let action, observation, and reaction share paragraphs more often instead of cutting every beat into a single short line.",
        }
      : {
          rule: "段落密度漂移",
          severity: "warning",
          description: `当前章平均段长从近期章节的${Math.round(recent.averageLength)}字降到${Math.round(current.averageLength)}字，缩短了${dropPercent}%。`,
          suggestion: "不要把每个动作都切成单独短句；适当把动作、观察和反应并入同一段，恢复段落层次。",
        },
  ];
}

/** English-specific post-write validation rules. */
function validatePostWriteEnglish(
  content: string,
  genreProfile: GenreProfile,
  bookRules: BookRules | null,
): ReadonlyArray<PostWriteViolation> {
  const violations: PostWriteViolation[] = [];

  // 1. AI-tell word density (from en-prompt-sections IRON LAW 3)
  const aiTellWords = ["delve", "tapestry", "testament", "intricate", "pivotal", "vibrant", "embark", "comprehensive", "nuanced"];
  for (const word of aiTellWords) {
    const regex = new RegExp(`\\b${word}\\b`, "gi");
    const matches = content.match(regex);
    if (matches && matches.length > Math.ceil(content.length / 3000)) {
      violations.push({
        rule: "AI-tell word density",
        severity: "warning",
        description: `"${word}" appears ${matches.length} times (limit: 1 per 3000 chars)`,
        suggestion: `Replace with a more specific word`,
      });
    }
  }

  // 2. Paragraph overflow (same rule applies to English)
  const paragraphs = content.split(/\n\s*\n/).filter((p) => p.trim().length > 0);
  const longParagraphs = paragraphs.filter((p) => p.length > 500);
  if (longParagraphs.length >= 2) {
    violations.push({
      rule: "Paragraph length",
      severity: "warning",
      description: `${longParagraphs.length} paragraphs exceed 500 characters`,
      suggestion: "Break into shorter paragraphs for readability",
    });
  }

  violations.push(...detectParagraphShapeWarnings(content, "en"));
  violations.push(...detectInChapterRepetition(content, "en"));

  // 2.5. Multi-character scene with almost no direct exchange
  const quotedLines = content.match(/"[^"]+"/g) ?? [];
  const englishNames = [...new Set(
    (content.match(/\b[A-Z][a-z]{2,}\b/g) ?? [])
      .filter((name) => !ENGLISH_NAME_STOP_WORDS.has(name)),
  )];
  if (englishNames.length >= 2 && quotedLines.length < 2 && content.length >= 120) {
    violations.push({
      rule: "Dialogue pressure",
      severity: "warning",
      description: `Multi-character scene appears to rely on narration with almost no direct exchange (${englishNames.slice(0, 3).join(", ")}).`,
      suggestion: "Add at least one resistance-bearing exchange so characters push back, withhold, or pressure each other directly.",
    });
  }

  // 3. Book-specific prohibitions
  if (bookRules?.prohibitions) {
    for (const prohibition of bookRules.prohibitions) {
      if (prohibition.length >= 2 && prohibition.length <= 50 && content.toLowerCase().includes(prohibition.toLowerCase())) {
        violations.push({
          rule: "Book prohibition",
          severity: "error",
          description: `Found banned content: "${prohibition}"`,
          suggestion: "Remove or rewrite this content",
        });
      }
    }
  }

  // 4. Genre fatigue words
  const fatigueWords = bookRules?.fatigueWordsOverride && bookRules.fatigueWordsOverride.length > 0
    ? bookRules.fatigueWordsOverride
    : genreProfile.fatigueWords;
  for (const word of fatigueWords) {
    const regex = new RegExp(`\\b${word}\\b`, "gi");
    const matches = content.match(regex);
    if (matches && matches.length > 1) {
      violations.push({
        rule: "Fatigue word",
        severity: "warning",
        description: `"${word}" appears ${matches.length} times (max 1 per chapter)`,
        suggestion: "Vary the vocabulary",
      });
    }
  }

  return violations;
}

function appendParagraphShapeWarnings(
  violations: PostWriteViolation[],
  content: string,
  language: "zh" | "en",
): void {
  const shape = analyzeParagraphShape(content, language);
  if (shape.paragraphs.length < 4) return;

  if (shape.shortParagraphs.length >= 4 && shape.shortRatio >= 0.6) {
    violations.push(
      language === "en"
        ? {
            rule: "Paragraph fragmentation",
            severity: "warning",
            description: `${shape.shortParagraphs.length} of ${shape.paragraphs.length} paragraphs are shorter than ${shape.shortThreshold} characters.`,
            suggestion: "Merge adjacent action, observation, and reaction beats so the chapter does not collapse into one-line paragraphs.",
          }
        : {
            rule: "段落过碎",
            severity: "warning",
            description: `${shape.paragraphs.length}个段落里有${shape.shortParagraphs.length}个不足${shape.shortThreshold}字，段落被切得过碎。`,
            suggestion: "把相邻的动作、观察、反应适当并段，不要每句话都单独起段。",
          },
    );
  }

  if (shape.maxConsecutiveShort >= 3) {
    violations.push(
      language === "en"
        ? {
            rule: "Consecutive short paragraphs",
            severity: "warning",
            description: `${shape.maxConsecutiveShort} short paragraphs appear back to back.`,
            suggestion: "Break the one-beat-per-paragraph rhythm by folding connected beats into fuller paragraphs.",
          }
        : {
            rule: "连续短段",
            severity: "warning",
            description: `连续出现${shape.maxConsecutiveShort}个不足${shape.shortThreshold}字的短段，容易形成短句堆砌。`,
            suggestion: "把连续的碎动作重新编组，至少让一个段落承载完整的动作链或情绪推进。",
          },
    );
  }
}

export function detectParagraphShapeWarnings(
  content: string,
  language: "zh" | "en" = "zh",
): ReadonlyArray<PostWriteViolation> {
  const violations: PostWriteViolation[] = [];
  appendParagraphShapeWarnings(violations, content, language);
  return violations;
}

export function detectInChapterRepetition(
  content: string,
  language: "zh" | "en" = "zh",
): ReadonlyArray<PostWriteViolation> {
  const paragraphs = extractParagraphs(content)
    .map((paragraph) => normalizeRepeatUnit(paragraph, language))
    .filter((paragraph) => paragraph.length >= (language === "en" ? 90 : 35));
  const violations: PostWriteViolation[] = [];

  const exactCounts = new Map<string, number>();
  for (const paragraph of paragraphs) {
    exactCounts.set(paragraph, (exactCounts.get(paragraph) ?? 0) + 1);
  }

  const exactDuplicate = [...exactCounts.entries()]
    .find(([paragraph, count]) => count >= 2 && paragraph.length >= (language === "en" ? 120 : 45));
  if (exactDuplicate) {
    violations.push(
      language === "en"
        ? {
            rule: "In-chapter repetition",
            severity: "warning",
            description: `A substantial paragraph repeats inside the same chapter (${exactDuplicate[0].slice(0, 80)}...).`,
            suggestion: "Delete the repeated paragraph or replace it with a new beat that changes action, information, or emotion.",
          }
        : {
            rule: "章内重复",
            severity: "warning",
            description: `同一章内出现大段重复段落：“${exactDuplicate[0].slice(0, 36)}……”`,
            suggestion: "删除重复段落，或改成推进动作、信息或情绪变化的新段落。",
          },
    );
  }

  const nearDuplicate = findNearDuplicateParagraphs(paragraphs, language);
  if (nearDuplicate) {
    violations.push(
      language === "en"
        ? {
            rule: "Near-duplicate paragraphs",
            severity: "warning",
            description: `Two nearby paragraphs are highly similar (${nearDuplicate.percent}% overlap): "${nearDuplicate.preview}".`,
            suggestion: "Keep one paragraph as the beat anchor; rewrite the other so it adds new action, conflict, or information instead of restating the same moment.",
          }
        : {
            rule: "相邻段落复读",
            severity: "warning",
            description: `相邻段落高度相似（重合约${nearDuplicate.percent}%）：“${nearDuplicate.preview}”`,
            suggestion: "保留一个段落作为情绪或动作锚点，另一个必须改成新的动作、冲突或信息，不要换词复述同一件事。",
          },
    );
  }

  const sentenceRepeat = detectRepeatedSentence(content, language);
  if (sentenceRepeat) {
    violations.push(
      language === "en"
        ? {
            rule: "Repeated sentence",
            severity: "warning",
            description: `The same sentence appears repeatedly: "${sentenceRepeat}".`,
            suggestion: "Use the sentence once, then advance the scene with a concrete consequence.",
          }
        : {
            rule: "句子复读",
            severity: "warning",
            description: `同一句或高度相同的长句重复出现：“${sentenceRepeat}”`,
            suggestion: "同一句只保留一次，后续改写为具体后果或新动作。",
          },
    );
  }

  return violations;
}

function normalizeRepeatUnit(text: string, language: "zh" | "en"): string {
  const normalized = text
    .replace(/[`*_>#-]/g, "")
    .replace(/\s+/g, language === "en" ? " " : "")
    .trim();
  return language === "en" ? normalized.toLowerCase() : normalized;
}

function findNearDuplicateParagraphs(
  paragraphs: ReadonlyArray<string>,
  language: "zh" | "en",
): { readonly preview: string; readonly percent: number } | null {
  const windowSize = 3;
  for (let left = 0; left < paragraphs.length; left += 1) {
    for (let right = left + 1; right <= Math.min(left + windowSize, paragraphs.length - 1); right += 1) {
      const first = paragraphs[left]!;
      const second = paragraphs[right]!;
      const shorter = Math.min(first.length, second.length);
      const longer = Math.max(first.length, second.length);
      if (shorter < (language === "en" ? 90 : 35)) continue;
      if (shorter / longer < 0.55) continue;

      const firstShingles = language === "en" ? wordShingles(first, 4) : charShingles(first, 6);
      const secondShingles = language === "en" ? wordShingles(second, 4) : charShingles(second, 6);
      const similarity = Math.max(
        jaccard(firstShingles, secondShingles),
        overlapCoefficient(firstShingles, secondShingles),
      );
      if (similarity >= 0.65) {
        return {
          preview: `${first.slice(0, language === "en" ? 80 : 36)}...`,
          percent: Math.round(similarity * 100),
        };
      }
    }
  }
  return null;
}

function detectRepeatedSentence(content: string, language: "zh" | "en"): string | null {
  const sentences = content
    .split(language === "en" ? /(?<=[.!?])\s+/ : /[。！？!?；;]/)
    .map((sentence) => normalizeRepeatUnit(sentence, language))
    .filter((sentence) => sentence.length >= (language === "en" ? 70 : 28));
  const counts = new Map<string, number>();
  for (const sentence of sentences) {
    counts.set(sentence, (counts.get(sentence) ?? 0) + 1);
  }
  const repeated = [...counts.entries()].find(([, count]) => count >= 2);
  if (!repeated) return null;
  return repeated[0].slice(0, language === "en" ? 90 : 42);
}

function charShingles(text: string, size: number): ReadonlySet<string> {
  const shingles = new Set<string>();
  for (let index = 0; index <= text.length - size; index += 1) {
    const shingle = text.slice(index, index + size);
    if (/^[\u4e00-\u9fff\d，。！？、：；“”‘’]+$/.test(shingle)) {
      shingles.add(shingle);
    }
  }
  return shingles;
}

function wordShingles(text: string, size: number): ReadonlySet<string> {
  const words = text
    .toLowerCase()
    .replace(/[^\w\s']/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 1);
  const shingles = new Set<string>();
  for (let index = 0; index <= words.length - size; index += 1) {
    shingles.add(words.slice(index, index + size).join(" "));
  }
  return shingles;
}

function jaccard(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const item of left) {
    if (right.has(item)) intersection += 1;
  }
  return intersection / (left.size + right.size - intersection);
}

function overlapCoefficient(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const item of left) {
    if (right.has(item)) intersection += 1;
  }
  return intersection / Math.min(left.size, right.size);
}

function isDialogueParagraph(paragraph: string): boolean {
  const trimmed = paragraph.trim();
  return /^[""「『'《]/.test(trimmed) || /^[""]/.test(trimmed) || /^——/.test(trimmed);
}

function analyzeParagraphShape(content: string, language: "zh" | "en"): ParagraphShape {
  const paragraphs = extractParagraphs(content);
  // Exclude dialogue lines from short paragraph counting — dialogue is naturally short
  const narrativeParagraphs = paragraphs.filter((p) => !isDialogueParagraph(p));
  const shortThreshold = language === "en" ? 120 : 35;
  const shortParagraphs = narrativeParagraphs.filter((paragraph) => paragraph.length < shortThreshold);
  const averageLength = paragraphs.length > 0
    ? paragraphs.reduce((sum, paragraph) => sum + paragraph.length, 0) / paragraphs.length
    : 0;

  let maxConsecutiveShort = 0;
  let currentConsecutive = 0;
  for (const paragraph of narrativeParagraphs) {
    if (paragraph.length < shortThreshold) {
      currentConsecutive++;
      maxConsecutiveShort = Math.max(maxConsecutiveShort, currentConsecutive);
    } else {
      currentConsecutive = 0;
    }
  }

  return {
    paragraphs,
    shortThreshold,
    shortParagraphs,
    shortRatio: narrativeParagraphs.length > 0 ? shortParagraphs.length / narrativeParagraphs.length : 0,
    averageLength,
    maxConsecutiveShort,
  };
}

function extractParagraphs(content: string): string[] {
  return content
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0)
    .filter((paragraph) => paragraph !== "---")
    .filter((paragraph) => !paragraph.startsWith("#"));
}

const ENGLISH_NAME_STOP_WORDS = new Set([
  "The",
  "And",
  "But",
  "When",
  "While",
  "After",
  "Before",
  "Even",
  "Then",
  "They",
]);

const CHINESE_TITLE_STOP_WORDS = new Set([
  "这次",
  "正文",
  "标题",
  "重复",
  "不同",
  "完全",
  "只是",
  "碰巧",
  "没有",
  "回头",
]);

const CHINESE_TITLE_STOP_CHARS = new Set(["的", "了", "着", "一", "只", "从", "在", "和", "与", "把", "被", "有", "没", "里", "又", "才"]);

/**
 * Detect duplicate or near-duplicate chapter titles.
 * Compares the new title against existing chapter titles from index.
 */
export function detectDuplicateTitle(
  newTitle: string,
  existingTitles: ReadonlyArray<string>,
): ReadonlyArray<PostWriteViolation> {
  if (!newTitle.trim()) return [];

  const normalized = newTitle.trim().toLowerCase();
  const violations: PostWriteViolation[] = [];

  for (const existing of existingTitles) {
    const existingNorm = existing.trim().toLowerCase();
    if (!existingNorm) continue;

    // Exact match
    if (normalized === existingNorm) {
      violations.push({
        rule: "duplicate-title",
        severity: "warning",
        description: `章节标题"${newTitle}"与已有章节标题完全相同`,
        suggestion: "更换一个不同的章节标题",
      });
      break;
    }

    // Near-duplicate: one is substring of the other, or only differs by punctuation/numbers
    const stripPunct = (s: string) => s.replace(/[^\p{L}\p{N}]/gu, "");
    if (stripPunct(normalized) === stripPunct(existingNorm)) {
      violations.push({
        rule: "near-duplicate-title",
        severity: "warning",
        description: `章节标题"${newTitle}"与已有标题"${existing}"高度相似`,
        suggestion: "避免使用相似的章节标题",
      });
      break;
    }
  }

  return violations;
}

export function resolveDuplicateTitle(
  newTitle: string,
  existingTitles: ReadonlyArray<string>,
  language: "zh" | "en" = "zh",
  options?: {
    readonly content?: string;
  },
): {
  readonly title: string;
  readonly issues: ReadonlyArray<PostWriteViolation>;
} {
  const trimmed = newTitle.trim();
  if (!trimmed) {
    return { title: newTitle, issues: [] };
  }

  const duplicateIssues = detectDuplicateTitle(trimmed, existingTitles);
  if (duplicateIssues.length > 0) {
    const regenerated = regenerateDuplicateTitle(trimmed, existingTitles, language, options?.content);
    if (regenerated && detectDuplicateTitle(regenerated, existingTitles).length === 0) {
      return { title: regenerated, issues: duplicateIssues };
    }

    let counter = 2;
    while (counter < 100) {
      const candidate = language === "en"
        ? `${trimmed} (${counter})`
        : `${trimmed}（${counter}）`;
      if (detectDuplicateTitle(candidate, existingTitles).length === 0) {
        return { title: candidate, issues: duplicateIssues };
      }
      counter++;
    }

    return { title: trimmed, issues: duplicateIssues };
  }

  const collapseIssues = detectTitleCollapse(trimmed, existingTitles, language);
  if (collapseIssues.length === 0) {
    return { title: trimmed, issues: [] };
  }

  const regenerated = regenerateCollapsedTitle(trimmed, existingTitles, language, options?.content);
  if (
    regenerated
    && detectDuplicateTitle(regenerated, existingTitles).length === 0
    && detectTitleCollapse(regenerated, existingTitles, language).length === 0
  ) {
    return { title: regenerated, issues: collapseIssues };
  }

  return { title: trimmed, issues: collapseIssues };
}

function detectTitleCollapse(
  newTitle: string,
  existingTitles: ReadonlyArray<string>,
  language: "zh" | "en",
): ReadonlyArray<PostWriteViolation> {
  const recentTitles = existingTitles
    .map((title) => title.trim())
    .filter(Boolean)
    .slice(-3);
  if (recentTitles.length < 3) {
    return [];
  }

  const cadence = analyzeChapterCadence({
    language,
    rows: [...recentTitles, newTitle].map((title, index) => ({
      chapter: index + 1,
      title,
      mood: "",
      chapterType: "",
    })),
  });
  const titlePressure = cadence.titlePressure;
  if (!titlePressure || titlePressure.pressure !== "high") {
    return [];
  }
  if (!newTitle.includes(titlePressure.repeatedToken)) {
    return [];
  }

  return [
    language === "en"
      ? {
          rule: "title-collapse",
          severity: "warning",
          description: `Chapter title "${newTitle}" keeps leaning on the recent "${titlePressure.repeatedToken}" title shell.`,
          suggestion: "Rename the chapter around a new image, action, consequence, or character focus.",
        }
      : {
          rule: "title-collapse",
          severity: "warning",
          description: `章节标题"${newTitle}"仍在沿用近期围绕“${titlePressure.repeatedToken}”的命名壳。`,
          suggestion: "换一个新的意象、动作、后果或人物焦点来命名。",
        },
  ];
}

function regenerateDuplicateTitle(
  baseTitle: string,
  existingTitles: ReadonlyArray<string>,
  language: "zh" | "en",
  content?: string,
): string | undefined {
  if (!content || !content.trim()) {
    return undefined;
  }

  const qualifier = language === "en"
    ? extractEnglishTitleQualifier(baseTitle, existingTitles, content)
    : extractChineseTitleQualifier(baseTitle, existingTitles, content);
  if (!qualifier) {
    return undefined;
  }

  return language === "en"
    ? `${baseTitle}: ${qualifier}`
    : `${baseTitle}：${qualifier}`;
}

function regenerateCollapsedTitle(
  baseTitle: string,
  existingTitles: ReadonlyArray<string>,
  language: "zh" | "en",
  content?: string,
): string | undefined {
  if (!content || !content.trim()) {
    return undefined;
  }

  const fresh = language === "en"
    ? extractEnglishTitleQualifier(baseTitle, existingTitles, content)
    : extractChineseTitleQualifier(baseTitle, existingTitles, content);
  if (!fresh) {
    return undefined;
  }

  return fresh === baseTitle ? undefined : fresh;
}

function extractEnglishTitleQualifier(
  baseTitle: string,
  existingTitles: ReadonlyArray<string>,
  content: string,
): string | undefined {
  const blocked = new Set(extractEnglishTitleTerms([baseTitle, ...existingTitles].join(" ")));
  const words = (content.match(/[A-Za-z]{4,}/g) ?? [])
    .map((word) => word.toLowerCase())
    .filter((word) => !ENGLISH_NAME_STOP_WORDS.has(capitalize(word)))
    .filter((word) => !blocked.has(word));
  const first = words[0];
  if (!first) {
    return undefined;
  }

  const second = words.find((word) => word !== first && !blocked.has(word));
  return second
    ? `${capitalize(first)} ${capitalize(second)}`
    : capitalize(first);
}

// --- Common Chinese collocation errors ---
const COLLOCATION_ERRORS: ReadonlyArray<readonly [string, string]> = [
  ["提高改善", "提高或改善"],
  ["解决改善", "解决或改善"],
  ["增加提高", "增加或提高"],
  ["降低减少", "降低或减少"],
  ["大约左右", "大约或左右"],
  ["几乎全部", "几乎或全部"],
  ["互相彼此", "互相或彼此"],
  ["十分极其", "十分或极其"],
  ["非常极其", "非常或极其"],
  ["突然忽然", "突然或忽然"],
  ["突然猛然", "突然或猛然"],
  ["马上立刻", "马上或立刻"],
  ["也许可能", "也许或可能"],
  ["热热烈烈", "热烈"],
  ["光靠依靠", "光靠或依靠"],
  ["冒着顶着", "冒着或顶着"],
];

function extractChineseTitleQualifier(
  baseTitle: string,
  existingTitles: ReadonlyArray<string>,
  content: string,
): string | undefined {
  const blocked = new Set(extractChineseTitleTerms([baseTitle, ...existingTitles].join("")));
  const segments = content.match(/[\u4e00-\u9fff]+/g) ?? [];

  for (const segment of segments) {
    for (let start = 0; start < segment.length; start += 1) {
      for (let size = 2; size <= 4; size += 1) {
        const candidate = segment.slice(start, start + size).trim();
        if (candidate.length < 2) continue;
        if (CHINESE_TITLE_STOP_WORDS.has(candidate)) continue;
        if ([...candidate].some((char) => CHINESE_TITLE_STOP_CHARS.has(char))) continue;
        if (blocked.has(candidate)) continue;
        return candidate;
      }
    }
  }

  return undefined;
}

function extractEnglishTitleTerms(text: string): string[] {
  return [...new Set((text.match(/[A-Za-z]{4,}/g) ?? []).map((word) => word.toLowerCase()))];
}

function extractChineseTitleTerms(text: string): string[] {
  const terms = new Set<string>();
  const segments = text.match(/[\u4e00-\u9fff]+/g) ?? [];

  for (const segment of segments) {
    for (let start = 0; start < segment.length; start += 1) {
      for (let size = 2; size <= 4; size += 1) {
        const candidate = segment.slice(start, start + size).trim();
        if (candidate.length < 2) continue;
        if ([...candidate].some((char) => CHINESE_TITLE_STOP_CHARS.has(char))) continue;
        terms.add(candidate);
      }
    }
  }

  return [...terms];
}

function capitalize(word: string): string {
  return word.length === 0 ? word : `${word[0]!.toUpperCase()}${word.slice(1)}`;
}
