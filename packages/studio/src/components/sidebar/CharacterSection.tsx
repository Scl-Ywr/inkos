import { useEffect, useState } from "react";
import { Users, ChevronDown } from "lucide-react";
import { useChatStore } from "../../store/chat";
import { fetchJson } from "../../hooks/use-api";
import { SidebarCard } from "./SidebarCard";
import { cn } from "../../lib/utils";

interface CharacterInfo {
  name: string;
  file?: string;
  fields: Record<string, string>;
  tier?: "major" | "minor";
  relevance?: number;
}

const charactersCache = new Map<string, ReadonlyArray<CharacterInfo>>();

export function invalidateCharactersCache(bookId: string): void {
  charactersCache.delete(bookId);
}

interface TruthFile {
  readonly name: string;
}

interface ChapterMeta {
  readonly number: number;
  readonly title?: string;
}

function parseCharacterMatrix(md: string): CharacterInfo[] {
  const characters: CharacterInfo[] = [];
  // Split by ## headings (level 2 only)
  const sections = md.split(/^## /m).slice(1);
  for (const section of sections) {
    const lines = section.split("\n");
    const name = lines[0].trim();
    if (!name) continue;
    const fields: Record<string, string> = {};
    for (let i = 1; i < lines.length; i++) {
      const match = lines[i].match(/^-\s+\*\*(.+?)\*\*:\s*(.+)/);
      if (match) {
        fields[match[1]] = match[2].trim();
      }
    }
    characters.push({ name, fields });
  }
  return characters;
}

function sectionText(md: string, heading: RegExp): string {
  const match = md.match(heading);
  if (!match || match.index === undefined) return "";
  const after = md.slice(match.index + match[0].length);
  const next = after.search(/^##\s/m);
  return (next >= 0 ? after.slice(0, next) : after).trim();
}

function firstMatch(md: string, patterns: RegExp[]): string {
  for (const pattern of patterns) {
    const match = md.match(pattern);
    const value = match?.[1]?.trim();
    if (value) return value;
  }
  return "";
}

function plainPreview(md: string): string {
  return md
    .replace(/^---[\s\S]*?---/m, "")
    .replace(/^#+\s+/gm, "")
    .replace(/[*_`>#-]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 96);
}

function normalizeCharacterName(name: string): string {
  return name.replace(/\s+/g, "").trim();
}

function dedupeCharacters(characters: ReadonlyArray<CharacterInfo>): CharacterInfo[] {
  const byKey = new Map<string, CharacterInfo>();
  for (const char of characters) {
    const key = normalizeCharacterName(char.name);
    if (!key) continue;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, char);
      continue;
    }
    byKey.set(key, {
      ...existing,
      ...char,
      fields: { ...existing.fields, ...char.fields },
      relevance: Math.max(existing.relevance ?? 0, char.relevance ?? 0),
    });
  }
  return [...byKey.values()];
}

function latestSummaryText(md: string, latestChapter: number | null): string {
  if (!latestChapter) return "";
  const candidates = [
    new RegExp(`^\\|\\s*(?:第\\s*)?${latestChapter}\\s*(?:章)?\\s*\\|.*$`, "gm"),
    new RegExp(`^.*(?:第\\s*${latestChapter}\\s*章|Chapter\\s*${latestChapter}).*$`, "gim"),
  ];
  const lines = new Set<string>();
  for (const pattern of candidates) {
    for (const match of md.matchAll(pattern)) {
      if (match[0]?.trim()) lines.add(match[0].trim());
    }
  }
  return [...lines].join("\n");
}

function rankCharactersForCurrentChapter(
  characters: ReadonlyArray<CharacterInfo>,
  chapterText: string,
  summaryText: string,
  stateText: string,
): CharacterInfo[] {
  const primary = `${chapterText}\n${summaryText}`;
  const secondary = stateText;
  const ranked = characters.map((char) => {
    const name = normalizeCharacterName(char.name);
    const primaryHit = name.length > 0 && primary.includes(char.name);
    const secondaryHit = name.length > 0 && secondary.includes(char.name);
    const tierBoost = char.tier === "major" ? 1 : 0;
    const relevance = primaryHit ? 100 + tierBoost : secondaryHit ? 50 + tierBoost : tierBoost;
    return { ...char, relevance };
  });

  const directlyRelevant = ranked
    .filter((char) => (char.relevance ?? 0) >= 50)
    .sort((a, b) => (b.relevance ?? 0) - (a.relevance ?? 0));
  const supporting = ranked
    .filter((char) => !directlyRelevant.some((hit) => normalizeCharacterName(hit.name) === normalizeCharacterName(char.name)))
    .sort((a, b) => {
      const tierDelta = (b.tier === "major" ? 1 : 0) - (a.tier === "major" ? 1 : 0);
      if (tierDelta !== 0) return tierDelta;
      return (b.relevance ?? 0) - (a.relevance ?? 0);
    });
  const minimumVisible = directlyRelevant.length > 0 ? 6 : 4;
  return [...directlyRelevant, ...supporting].slice(0, Math.min(8, Math.max(minimumVisible, directlyRelevant.length)));
}

function parseRoleCard(file: string, content: string): CharacterInfo {
  const parts = file.split("/");
  const tier = parts[1] ?? "";
  const fileName = parts.at(-1)?.replace(/\.md$/, "") ?? file;
  const headingName = content.match(/^#\s+(.+)$/m)?.[1]?.trim();
  const normalizedTier = /主要角色|major/i.test(tier) ? "major" : "minor";
  const role = normalizedTier === "major" ? "主要" : "次要";
  const tags = firstMatch(content, [
    /^核心标签[:：]\s*(.+)$/m,
    /^标签[:：]\s*(.+)$/m,
    /^personalityLock[:：]\s*(.+)$/im,
  ]);
  const relation = firstMatch(content, [
    /^与主角关系[:：]\s*(.+)$/m,
    /^人物关系[:：]\s*(.+)$/m,
    /^关系[:：]\s*(.+)$/m,
    /^Relationship[:：]\s*(.+)$/im,
  ]) || sectionText(content, /^##\s*(?:与主角关系|人物关系|关系|Relationship|Relations)[^\n]*$/im);
  const current = sectionText(content, /^##\s*(?:当前现状|Current[_\s]?State)[^\n]*$/im);
  const arc = sectionText(content, /^##\s*(?:角色弧线|人物弧线|Character[_\s]?Arc)[^\n]*$/im);
  const summary = firstMatch(content, [
    /^一句话定位[:：]\s*(.+)$/m,
    /^定位[:：]\s*(.+)$/m,
  ]) || plainPreview(content);

  return {
    name: headingName || fileName,
    file,
    tier: normalizedTier,
    fields: {
      "定位": role,
      ...(relation ? { "关系": relation.replace(/\s+/g, " ").slice(0, 72) } : {}),
      ...(tags ? { "标签": tags } : {}),
      ...(current ? { "当前": current } : {}),
      ...(arc ? { "弧线": arc } : {}),
      ...(summary ? { "摘要": summary } : {}),
    },
  };
}

const ROLE_COLORS: Record<string, string> = {
  "主角": "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  "主要": "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  "反派": "bg-red-500/15 text-red-600 dark:text-red-400",
  "盟友": "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  "配角": "bg-blue-500/15 text-blue-600 dark:text-blue-400",
  "次要": "bg-blue-500/15 text-blue-600 dark:text-blue-400",
  "提及": "bg-zinc-500/15 text-zinc-600 dark:text-zinc-400",
  "protagonist": "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  "antagonist": "bg-red-500/15 text-red-600 dark:text-red-400",
  "ally": "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  "minor": "bg-blue-500/15 text-blue-600 dark:text-blue-400",
  "mentioned": "bg-zinc-500/15 text-zinc-600 dark:text-zinc-400",
};

function getRoleColor(role: string): string {
  const lower = role.toLowerCase().trim();
  for (const [key, color] of Object.entries(ROLE_COLORS)) {
    if (lower.includes(key)) return color;
  }
  return "bg-zinc-500/15 text-zinc-600 dark:text-zinc-400";
}

function CharacterCard({ char }: { readonly char: CharacterInfo }) {
  const [expanded, setExpanded] = useState(false);
  const role = char.fields["定位"] ?? char.fields["Role"] ?? "";
  const relation = char.fields["关系"] ?? char.fields["Relationship"] ?? "";
  const tags = char.fields["标签"] ?? char.fields["Tags"] ?? "";
  const current = char.fields["当前"] ?? char.fields["Current"] ?? "";

  return (
    <div className="overflow-hidden rounded-2xl bg-rose-500/5 ring-1 ring-rose-500/10">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-2 px-3 py-2.5 text-left"
      >
        <Users size={14} className="shrink-0 text-muted-foreground/60" />
        <span className="flex-1 truncate font-['SimSun','Songti_SC','STSong',serif] text-sm font-medium text-foreground">
          {char.name}
        </span>
        {relation && (
          <span className="max-w-[8rem] truncate rounded-full bg-secondary/60 px-1.5 py-0.5 text-[10px] text-muted-foreground">
            {relation}
          </span>
        )}
        {role && !relation && (
          <span className={cn("text-[10px] px-1.5 py-0.5 rounded-full shrink-0", getRoleColor(role))}>
            {role.split("/")[0].trim()}
          </span>
        )}
        <ChevronDown size={12} className={cn("text-muted-foreground/50 transition-transform shrink-0", expanded && "rotate-180")} />
      </button>
      {expanded && (
        <div className="space-y-1.5 px-3 pb-3">
          {tags && (
            <p className="text-xs text-muted-foreground"><span className="text-muted-foreground/60">标签</span> {tags}</p>
          )}
          {relation && (
            <p className="text-xs text-muted-foreground"><span className="text-muted-foreground/60">关系</span> {relation}</p>
          )}
          {current && (
            <p className="text-xs text-muted-foreground"><span className="text-muted-foreground/60">当前</span> {current}</p>
          )}
          {Object.entries(char.fields)
            .filter(([k]) => !["定位", "Role", "关系", "Relationship", "标签", "Tags", "当前", "Current"].includes(k))
            .map(([key, val]) => (
              <p key={key} className="text-xs text-muted-foreground">
                <span className="text-muted-foreground/60">{key}</span> {val}
              </p>
            ))}
        </div>
      )}
    </div>
  );
}

interface CharacterSectionProps {
  readonly bookId: string;
}

export function CharacterSection({ bookId }: CharacterSectionProps) {
  const [characters, setCharacters] = useState<ReadonlyArray<CharacterInfo>>(
    () => charactersCache.get(bookId) ?? [],
  );
  const bookDataVersion = useChatStore((s) => s.bookDataVersion);

  useEffect(() => {
    let ignore = false;
    const cached = charactersCache.get(bookId);
    if (cached) {
      setCharacters(cached);
    }

    fetchJson<{ files: ReadonlyArray<TruthFile> }>(`/books/${bookId}/truth`)
      .then(async (list) => {
        if (ignore) return;
        const roleFiles = [...new Set(list.files
          .map((file) => file.name)
          .filter((name) => /^roles\/(?:主要角色|次要角色|major|minor)\/[^/]+\.md$/.test(name) && !name.endsWith("/_keep.txt")))];

        let nextCharacters: ReadonlyArray<CharacterInfo>;
        if (roleFiles.length > 0) {
          const cards = await Promise.all(roleFiles.map(async (file) => {
            const data = await fetchJson<{ content: string | null }>(`/books/${bookId}/truth/${file}`);
            return data.content?.trim() ? parseRoleCard(file, data.content) : null;
          }));
          const allCharacters = dedupeCharacters(cards.filter((card): card is CharacterInfo => card !== null));
          const bookData = await fetchJson<{ chapters?: ChapterMeta[]; nextChapter?: number }>(`/books/${bookId}`)
            .catch((): { chapters: ChapterMeta[] } => ({ chapters: [] }));
          const chapters: ChapterMeta[] = bookData.chapters ?? [];
          const latestChapter = chapters.length > 0 ? Math.max(...chapters.map((chapter) => chapter.number)) : null;
          const [chapter, summaries, state] = await Promise.all([
            latestChapter
              ? fetchJson<{ content: string | null }>(`/books/${bookId}/chapters/${latestChapter}`).catch(() => ({ content: "" }))
              : Promise.resolve<{ content: string | null }>({ content: "" }),
            fetchJson<{ content: string | null }>(`/books/${bookId}/truth/chapter_summaries.md`).catch(() => ({ content: "" })),
            fetchJson<{ content: string | null }>(`/books/${bookId}/truth/current_state.md`).catch(() => ({ content: "" })),
          ]);
          nextCharacters = rankCharactersForCurrentChapter(
            allCharacters,
            chapter.content ?? "",
            latestSummaryText(summaries.content ?? "", latestChapter),
            state.content ?? "",
          );
        } else {
          const data = await fetchJson<{ content: string | null }>(`/books/${bookId}/truth/character_matrix.md`);
          nextCharacters = dedupeCharacters(data.content ? parseCharacterMatrix(data.content) : []);
        }
        if (ignore) return;
        charactersCache.set(bookId, nextCharacters);
        setCharacters(nextCharacters);
      })
      .catch(() => {
        if (!ignore && !charactersCache.has(bookId)) {
          setCharacters([]);
        }
      });

    return () => {
      ignore = true;
    };
  }, [bookId, bookDataVersion]);

  if (characters.length === 0) return null;

  return (
    <SidebarCard title="角色" defaultOpen={false} stateKey={`${bookId}:characters`}>
      <div className="space-y-2">
        {characters.map((char) => (
          <CharacterCard key={char.file ?? char.name} char={char} />
        ))}
      </div>
    </SidebarCard>
  );
}
