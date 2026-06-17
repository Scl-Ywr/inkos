import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ArrowLeft, CircleDot, Focus, Loader2, Network, Search, SlidersHorizontal, X } from "lucide-react";
import { fetchJson } from "../../hooks/use-api";
import { cn } from "../../lib/utils";
import { roleFromPath } from "../../lib/truth-display";
import { useChatStore } from "../../store/chat";

interface PlayEntity {
  readonly id: string;
  readonly type: string;
  readonly label: string;
  readonly summary?: string;
  readonly status?: string;
}

interface PlayEdge {
  readonly id: string;
  readonly fromId: string;
  readonly type: string;
  readonly toId: string;
  readonly validUntilEventId?: string | null;
  readonly strength?: number | null;
  readonly value?: {
    readonly role?: string;
    readonly summary?: string;
  };
}

interface PlayGraph {
  readonly entities: ReadonlyArray<PlayEntity>;
  readonly edges: ReadonlyArray<PlayEdge>;
}

interface TruthFileContent {
  readonly name: string;
  readonly content: string;
}

interface PlayRunResponse {
  readonly title?: string;
  readonly graph?: PlayGraph;
}

export interface RelationshipGraphNode {
  readonly id: string;
  readonly label: string;
  readonly type: string;
  readonly summary?: string;
  readonly status?: string;
  readonly degree: number;
  readonly x: number;
  readonly y: number;
}

export interface RelationshipGraphEdge {
  readonly id: string;
  readonly fromId: string;
  readonly toId: string;
  readonly type: string;
  readonly strength?: number;
  readonly summary?: string;
}

export interface RelationshipGraphModel {
  readonly nodes: ReadonlyArray<RelationshipGraphNode>;
  readonly edges: ReadonlyArray<RelationshipGraphEdge>;
  readonly hiddenEdges: number;
  readonly typeCounts: ReadonlyArray<{ readonly type: string; readonly count: number }>;
}

interface DisplayRelationshipGraphNode extends RelationshipGraphNode {
  readonly displayX: number;
  readonly displayY: number;
  readonly connected: boolean;
  readonly selected: boolean;
}

const W = 640;
const H = 480;
const CX = W / 2;
const CY = H / 2;
const RELATION_ROLE_TYPES = new Set(["relation", "relationship", "support", "supports", "opposes", "threatens"]);
const ROLE_RUNTIME_START = "<!-- INKOS:ROLE_RUNTIME_STATE_START -->";
const ROLE_RUNTIME_END = "<!-- INKOS:ROLE_RUNTIME_STATE_END -->";
const RELATION_LINE_PATTERN = /关系|敌对|冲突|盟友|同盟|对手|怀疑|信任|背叛|合作|支持|反对|亲属|家庭|亲情|父|母|兄|弟|姐|妹|情感|爱恋|恋人|情侣|暧昧|前任|朋友|relationship|alliance|ally|enemy|trust|doubt|family|romance|lover|partner|supports?|opposes?/i;

const ACCENT_BY_TYPE: Record<string, string> = {
  actor: "#d66f75",
  location: "#10b981",
  item: "#f59e0b",
  clue: "#d946ef",
  evidence: "#f43f5e",
};

interface RelationshipVisual {
  readonly key: string;
  readonly label: string;
  readonly color: string;
  readonly softColor: string;
}

const RELATIONSHIP_VISUALS: ReadonlyArray<RelationshipVisual & { readonly pattern: RegExp }> = [
  { key: "hostile", label: "敌对 / 冲突", color: "#ef4444", softColor: "#ef444422", pattern: /敌|冲突|威胁|对手|压制|反对|背叛|怀疑|敌我|enemy|hostile|threat|oppose/i },
  { key: "family", label: "亲属 / 家庭", color: "#f97316", softColor: "#f9731622", pattern: /家庭|亲情|父|母|兄|弟|姐|妹|亲属|家人|夫妻|母女|母子|父女|父子|family|parent|sibling/i },
  { key: "romance", label: "情感 / 爱恋", color: "#ec4899", softColor: "#ec489922", pattern: /情感|爱恋|恋|爱|暧昧|伴侣|前任|婚|情侣|恋人|男友|女友|romance|lover|partner/i },
  { key: "alliance", label: "盟友 / 合作", color: "#22c55e", softColor: "#22c55e22", pattern: /盟|合作|支持|朋友|保护|同伴|信任|搭档|共谋|ally|alliance|support|friend|trust/i },
  { key: "authority", label: "职场 / 权力", color: "#eab308", softColor: "#eab30822", pattern: /上下级|上司|下属|老板|经理|局长|领导|雇佣|职场|权力|boss|manager|authority/i },
  { key: "clue", label: "线索 / 利益", color: "#8b5cf6", softColor: "#8b5cf622", pattern: /线索|秘密|利益|情报|证据|clue|secret|evidence/i },
];

const DEFAULT_RELATIONSHIP_VISUAL: RelationshipVisual = {
  key: "neutral",
  label: "一般关系",
  color: "#38bdf8",
  softColor: "#38bdf822",
};

export function relationshipVisual(type: string, summary?: string): RelationshipVisual {
  const haystack = `${type} ${summary ?? ""}`;
  return RELATIONSHIP_VISUALS.find((item) => item.pattern.test(haystack)) ?? DEFAULT_RELATIONSHIP_VISUAL;
}

function edgePath(
  from: Pick<DisplayRelationshipGraphNode, "displayX" | "displayY">,
  to: Pick<DisplayRelationshipGraphNode, "displayX" | "displayY">,
  index: number,
): string {
  const dx = to.displayX - from.displayX;
  const dy = to.displayY - from.displayY;
  const length = Math.max(1, Math.hypot(dx, dy));
  const curve = ((index % 5) - 2) * 7;
  const controlX = (from.displayX + to.displayX) / 2 + (-dy / length) * curve;
  const controlY = (from.displayY + to.displayY) / 2 + (dx / length) * curve;
  return `M ${from.displayX} ${from.displayY} Q ${controlX} ${controlY} ${to.displayX} ${to.displayY}`;
}

function edgeLabelPosition(
  from: Pick<DisplayRelationshipGraphNode, "displayX" | "displayY">,
  to: Pick<DisplayRelationshipGraphNode, "displayX" | "displayY">,
  index: number,
): { x: number; y: number } {
  const dx = to.displayX - from.displayX;
  const dy = to.displayY - from.displayY;
  const length = Math.max(1, Math.hypot(dx, dy));
  const curve = ((index % 5) - 2) * 7;
  return {
    x: (from.displayX + to.displayX) / 2 + (-dy / length) * curve,
    y: (from.displayY + to.displayY) / 2 + (dx / length) * curve - 8,
  };
}

function buildFocusedDisplayNodes(
  nodes: ReadonlyArray<RelationshipGraphNode>,
  edges: ReadonlyArray<RelationshipGraphEdge>,
  focused: RelationshipGraphNode | null,
): ReadonlyArray<DisplayRelationshipGraphNode> {
  if (!focused) {
    return nodes.map((node) => ({
      ...node,
      displayX: node.x,
      displayY: node.y,
      connected: true,
      selected: false,
    }));
  }

  const neighborIds = new Set<string>();
  for (const edge of edges) {
    if (edge.fromId === focused.id) neighborIds.add(edge.toId);
    if (edge.toId === focused.id) neighborIds.add(edge.fromId);
  }
  const neighborNodes = nodes
    .filter((node) => neighborIds.has(node.id))
    .sort((a, b) => b.degree - a.degree || a.label.localeCompare(b.label));
  const neighborIndex = new Map(neighborNodes.map((node, index) => [node.id, index]));
  const orbitCount = Math.max(1, neighborNodes.length);
  const rx = orbitCount <= 4 ? 210 : 235;
  const ry = orbitCount <= 4 ? 142 : 164;

  return nodes.map((node) => {
    if (node.id === focused.id) {
      return { ...node, displayX: CX, displayY: CY, connected: true, selected: true };
    }
    const index = neighborIndex.get(node.id);
    if (index !== undefined) {
      const angle = -Math.PI / 2 + (2 * Math.PI * index) / orbitCount;
      return {
        ...node,
        displayX: CX + rx * Math.cos(angle),
        displayY: CY + ry * Math.sin(angle),
        connected: true,
        selected: false,
      };
    }
    return {
      ...node,
      displayX: CX + (node.x - CX) * 0.72,
      displayY: CY + (node.y - CY) * 0.72,
      connected: false,
      selected: false,
    };
  });
}

function bookActorId(name: string): string {
  return `book-actor:${name.trim().toLowerCase()}`;
}

function cleanRelationMember(value: string): string {
  return value
    .replace(/^[#>*\-\d.\s]+/, "")
    .replace(/(?:三角|四角|多角)(?:关系)?$/, "")
    .replace(/[：:。；;，,]+$/, "")
    .trim();
}

function relationTypeFromLine(line: string, fallback = "关系"): string {
  const prefix = line.match(/^([^：:（）()]{2,18}(?:关系|同盟|冲突|合作|敌对|信任|怀疑|家庭|亲属|亲情|情感|爱恋))/)?.[1];
  if (prefix) return prefix.trim();
  const verb = line.match(/(敌对|冲突|同盟|盟友|合作|支持|反对|怀疑|信任|背叛|威胁|保护|雇佣|亲属|家庭|亲情|朋友|恋人|情感|爱恋|情侣|暧昧|前任)/)?.[1];
  return verb ?? fallback;
}

function addBookEdge(
  entities: Map<string, PlayEntity>,
  edges: Map<string, PlayEdge>,
  fromName: string,
  toName: string,
  type: string,
  summary?: string,
): void {
  const from = cleanRelationMember(fromName);
  const to = cleanRelationMember(toName);
  if (!from || !to || from === to) return;
  const fromId = bookActorId(from);
  const toId = bookActorId(to);
  if (!entities.has(fromId)) entities.set(fromId, { id: fromId, type: "actor", label: from });
  if (!entities.has(toId)) entities.set(toId, { id: toId, type: "actor", label: to });
  const normalizedType = type.trim() || "关系";
  const edgeId = `book-edge:${fromId}:${normalizedType}:${toId}`;
  if (!edges.has(edgeId)) {
    edges.set(edgeId, {
      id: edgeId,
      fromId,
      toId,
      type: normalizedType,
      strength: 1.6,
      value: { role: "relationship", summary },
    } as PlayEdge);
  }
}

function parseFocusRelationshipLines(
  content: string,
  entities: Map<string, PlayEntity>,
  edges: Map<string, PlayEdge>,
  knownRoleNames: ReadonlyArray<string> = [],
): void {
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.replace(/^\s*[-*]\s*/, "").trim();
    if (!line) continue;
    const group = line.match(/^([^：:（(]{1,32}?关系[^：:（(]*)\s*(?:[：:]|[（(])\s*([^）)]+)[）)]?/);
    if (group) {
      const relationType = cleanRelationMember(group[1]) || "关系";
      const knownMembers = knownRoleNames.filter((name) => group[2].includes(name));
      const members = knownMembers.length >= 2
        ? knownMembers
        : group[2]
          .split(/\s*(?:-|—|–|→|↔|、|,|，|\/|和|与|及)\s*/)
          .map(cleanRelationMember)
          .filter(Boolean);
      for (let index = 0; index < members.length - 1; index += 1) {
        addBookEdge(entities, edges, members[index], members[index + 1], relationType, line);
      }
      continue;
    }

    if (!RELATION_LINE_PATTERN.test(line)) continue;
    const mentioned = knownRoleNames.filter((name) => line.includes(name));
    if (mentioned.length < 2) continue;
    for (let index = 0; index < mentioned.length - 1; index += 1) {
      addBookEdge(entities, edges, mentioned[index], mentioned[index + 1], relationTypeFromLine(line), line);
    }
  }
}

function splitMarkdownTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function parseRoleRelationshipTableRows(
  roleName: string,
  content: string,
  knownRoleNames: ReadonlyArray<string>,
  entities: Map<string, PlayEntity>,
  edges: Map<string, PlayEdge>,
): void {
  const knownTargets = knownRoleNames.filter((name) => name !== roleName);
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith("|") || /^[-|\s:]+$/.test(line)) continue;
    const cells = splitMarkdownTableRow(line);
    if (cells.length < 2) continue;
    if (cells.some((cell) => /^(角色|人物|对象|关系|态度|备注)$/i.test(cell))) continue;
    const target = knownTargets.find((name) => cells.some((cell) => cell === name || cell.includes(name)));
    if (!target) continue;
    const relationCell = cells.find((cell) =>
      cell !== target
      && cell !== roleName
      && !/^(态度|备注|说明)$/i.test(cell)
      && (RELATION_LINE_PATTERN.test(cell) || cell.length <= 18)
    );
    const relationType = relationTypeFromLine(relationCell ?? line, cleanRelationMember(relationCell ?? "") || "关系");
    addBookEdge(entities, edges, roleName, target, relationType, line);
  }
}

function runtimeBlock(content: string): string {
  const start = content.indexOf(ROLE_RUNTIME_START);
  const end = content.indexOf(ROLE_RUNTIME_END);
  return start >= 0 && end > start
    ? content.slice(start + ROLE_RUNTIME_START.length, end)
    : content;
}

export function buildTruthRelationshipGraph(
  files: ReadonlyArray<TruthFileContent>,
): PlayGraph {
  const entities = new Map<string, PlayEntity>();
  const edges = new Map<string, PlayEdge>();
  const roles = files
    .map((file) => ({ file, role: roleFromPath(file.name) }))
    .filter((item): item is { file: TruthFileContent; role: NonNullable<ReturnType<typeof roleFromPath>> } => item.role !== null);

  for (const { role } of roles) {
    entities.set(bookActorId(role.name), {
      id: bookActorId(role.name),
      type: "actor",
      label: role.name,
      status: role.tier === "major" ? "主要角色" : "次要角色",
    });
  }

  const knownRoleNames = roles.map(({ role }) => role.name);
  for (const { file, role } of roles) {
    parseRoleRelationshipTableRows(role.name, file.content, knownRoleNames, entities, edges);
    const lines = runtimeBlock(file.content)
      .split(/\r?\n/)
      .map((line) => line.replace(/^\s*[-*]\s*/, "").trim())
      .filter((line) => line && RELATION_LINE_PATTERN.test(line));
    for (const line of lines) {
      const targets = knownRoleNames.filter((name) => name !== role.name && line.includes(name));
      for (const target of targets) {
        addBookEdge(entities, edges, role.name, target, relationTypeFromLine(line), line);
      }
    }
  }

  for (const file of files.filter((item) => item.name === "current_focus.md")) {
    parseFocusRelationshipLines(file.content, entities, edges, knownRoleNames);
  }

  return { entities: [...entities.values()], edges: [...edges.values()] };
}

export function mergeRelationshipGraphs(
  primary: PlayGraph | null | undefined,
  secondary: PlayGraph | null | undefined,
): PlayGraph {
  const entities = new Map<string, PlayEntity>();
  const edges = new Map<string, PlayEdge>();
  const actorIdByLabel = new Map<string, string>();

  for (const graph of [primary, secondary]) {
    if (!graph) continue;
    const remappedIds = new Map<string, string>();
    for (const entity of graph.entities) {
      const labelKey = entity.label.trim().toLowerCase();
      const existingActorId = entity.type === "actor" ? actorIdByLabel.get(labelKey) : undefined;
      const id = existingActorId ?? entity.id;
      remappedIds.set(entity.id, id);
      if (!entities.has(id)) entities.set(id, { ...entity, id });
      if (entity.type === "actor") actorIdByLabel.set(labelKey, id);
    }
    for (const edge of graph.edges) {
      const fromId = remappedIds.get(edge.fromId) ?? edge.fromId;
      const toId = remappedIds.get(edge.toId) ?? edge.toId;
      const id = `${edge.id}:${fromId}:${toId}`;
      if (!edges.has(id)) edges.set(id, { ...edge, id, fromId, toId });
    }
  }

  return { entities: [...entities.values()], edges: [...edges.values()] };
}

function edgeIsVisible(edge: PlayEdge): boolean {
  return edge.validUntilEventId == null && edge.fromId !== edge.toId;
}

function edgeHasRelationRole(edge: PlayEdge): boolean {
  if (RELATION_ROLE_TYPES.has(edge.type.toLowerCase())) return true;
  const value = (edge as { value?: unknown }).value;
  if (!value || typeof value !== "object") return false;
  const role = String((value as Record<string, unknown>).role ?? "").toLowerCase();
  return RELATION_ROLE_TYPES.has(role);
}

function textMatchesQuery(values: ReadonlyArray<string | null | undefined>, normalizedQuery: string): boolean {
  if (!normalizedQuery) return true;
  return values.join(" ").toLowerCase().includes(normalizedQuery);
}

function entityMatchesQuery(entity: PlayEntity, normalizedQuery: string): boolean {
  return textMatchesQuery([entity.label, entity.type, entity.summary, entity.status], normalizedQuery);
}

function edgeMatchesQuery(edge: PlayEdge, normalizedQuery: string): boolean {
  if (!normalizedQuery) return true;
  return textMatchesQuery([
    edge.type,
    edge.value?.role,
    edge.value?.summary,
  ], normalizedQuery);
}

export function buildRelationshipGraphModel(
  graph: PlayGraph | null | undefined,
  options: {
    readonly query?: string;
    readonly type?: string;
    readonly relationsOnly?: boolean;
    readonly includeDisconnected?: boolean;
  } = {},
): RelationshipGraphModel {
  if (!graph) return { nodes: [], edges: [], hiddenEdges: 0, typeCounts: [] };

  const query = options.query?.trim() ?? "";
  const normalizedQuery = query.toLowerCase();
  const typeFilter = options.type?.trim() ?? "";
  const visibleEdges = graph.edges.filter(edgeIsVisible);
  const candidateEdges = options.relationsOnly ? visibleEdges.filter(edgeHasRelationRole) : visibleEdges;
  const connectedIds = new Set(candidateEdges.flatMap((edge) => [edge.fromId, edge.toId]));
  const queryMatchedIds = new Set<string>();
  if (normalizedQuery) {
    for (const entity of graph.entities) {
      if (entityMatchesQuery(entity, normalizedQuery)) queryMatchedIds.add(entity.id);
    }
    for (const edge of candidateEdges) {
      if (edgeMatchesQuery(edge, normalizedQuery)) {
        queryMatchedIds.add(edge.fromId);
        queryMatchedIds.add(edge.toId);
      }
    }
  }
  const includedEntities = graph.entities.filter((entity) =>
    (options.includeDisconnected || connectedIds.has(entity.id))
    && (!typeFilter || entity.type === typeFilter)
    && (!normalizedQuery || queryMatchedIds.has(entity.id))
  );
  const includedIds = new Set(includedEntities.map((entity) => entity.id));
  const edges = candidateEdges
    .filter((edge) => includedIds.has(edge.fromId) && includedIds.has(edge.toId))
    .map((edge) => ({
      id: edge.id,
      fromId: edge.fromId,
      toId: edge.toId,
      type: edge.type,
      strength: typeof edge.strength === "number" ? edge.strength : undefined,
      summary: edge.value?.summary,
    }));

  const degree = new Map<string, number>();
  for (const edge of edges) {
    degree.set(edge.fromId, (degree.get(edge.fromId) ?? 0) + 1);
    degree.set(edge.toId, (degree.get(edge.toId) ?? 0) + 1);
  }

  const orderedEntities = [...includedEntities].sort((a, b) =>
    (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0) || a.label.localeCompare(b.label),
  );
  const radiusX = Math.min(250, Math.max(190, 118 + orderedEntities.length * 13));
  const radiusY = Math.min(170, Math.max(128, 86 + orderedEntities.length * 8));
  const nodes = orderedEntities.map((entity, index) => {
    const angle = -Math.PI / 2 + (2 * Math.PI * index) / Math.max(1, orderedEntities.length);
    const nodeDegree = degree.get(entity.id) ?? 0;
    const hubPull = Math.min(18, nodeDegree * 1.5);
    return {
      id: entity.id,
      label: entity.label,
      type: entity.type,
      summary: entity.summary,
      status: entity.status,
      degree: nodeDegree,
      x: CX + (radiusX - hubPull) * Math.cos(angle),
      y: CY + (radiusY - hubPull * 0.6) * Math.sin(angle),
    };
  });

  const typeCounter = new Map<string, number>();
  for (const entity of graph.entities) {
    if (options.includeDisconnected || connectedIds.has(entity.id)) {
      typeCounter.set(entity.type, (typeCounter.get(entity.type) ?? 0) + 1);
    }
  }
  const typeCounts = [...typeCounter.entries()]
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));

  return { nodes, edges, hiddenEdges: candidateEdges.length - edges.length, typeCounts };
}

function truncate(value: string, max = 14): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}...`;
}

function cleanRelationshipDetail(value: string | null | undefined): string {
  return (value ?? "")
    .replace(/^[#>*\-\d.\s]+/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function formatRelationshipStrength(strength: number | undefined): string | null {
  if (typeof strength !== "number" || !Number.isFinite(strength)) return null;
  if (strength >= 2.4) return "强关联";
  if (strength >= 1.5) return "中等关联";
  if (strength > 0) return "弱关联";
  return null;
}

function relationshipDetailText(input: {
  readonly selected: RelationshipGraphNode;
  readonly other: RelationshipGraphNode | null;
  readonly edge: RelationshipGraphEdge;
  readonly outgoing: boolean;
}): string {
  const summary = cleanRelationshipDetail(input.edge.summary);
  if (summary) return summary;
  const otherLabel = input.other?.label ?? (input.outgoing ? input.edge.toId : input.edge.fromId);
  const direction = input.outgoing
    ? `${input.selected.label} 对 ${otherLabel}`
    : `${otherLabel} 对 ${input.selected.label}`;
  const otherContext = cleanRelationshipDetail(input.other?.summary || input.other?.status);
  return otherContext
    ? `${direction} 的关系被记录为「${input.edge.type}」。对方当前状态：${otherContext}`
    : `${direction} 的关系被记录为「${input.edge.type}」，后续章节结算或互动推进后会继续补全细节。`;
}

function NodeBadge({ type, count, selected, onClick }: {
  readonly type: string;
  readonly count: number;
  readonly selected: boolean;
  readonly onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex items-center gap-1.5 rounded-md border px-2 py-1 text-[12px] leading-4 transition-colors",
        selected ? "border-primary/50 bg-primary/10 text-primary" : "border-border/30 bg-secondary/30 text-muted-foreground hover:text-foreground",
      )}
    >
      <CircleDot size={10} />
      <span>{type}</span>
      <span className="text-muted-foreground/70">{count}</span>
    </button>
  );
}

export function RelationshipGraph(props: {
  readonly source: "book" | "play";
  readonly bookId?: string | null;
  readonly sessionId: string | null;
  readonly onClose: () => void;
}) {
  const [run, setRun] = useState<PlayRunResponse | null>(null);
  const [truthGraph, setTruthGraph] = useState<PlayGraph | null>(null);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [type, setType] = useState("");
  const [relationsOnly, setRelationsOnly] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [playRefreshTick, setPlayRefreshTick] = useState(0);
  const bookDataVersion = useChatStore((state) => state.bookDataVersion);

  useEffect(() => {
    if (props.source !== "play") return;
    const timer = window.setInterval(() => setPlayRefreshTick((value) => value + 1), 2000);
    return () => window.clearInterval(timer);
  }, [props.source]);

  useEffect(() => {
    let cancelled = false;
    if ((props.source === "play" && !run) || (props.source === "book" && !truthGraph)) {
      setLoading(true);
    }
    const runRequest = props.source === "play" && props.sessionId
      ? fetchJson<PlayRunResponse>(`/play/runs/${encodeURIComponent(props.sessionId)}/main`).catch(() => null)
      : Promise.resolve(null);
    const truthRequest = props.source === "book" && props.bookId
      ? fetchJson<{ files: ReadonlyArray<{ name: string }> }>(`/books/${props.bookId}/truth`)
      .then(async ({ files }) => {
        const names = files
          .map((file) => file.name)
          .filter((name) => name === "current_focus.md" || roleFromPath(name) !== null);
        const contents = await Promise.all(names.map(async (name) => {
          const detail = await fetchJson<{ content: string | null }>(
            `/books/${props.bookId!}/truth/${name}`,
          ).catch(() => ({ content: null }));
          return { name, content: detail.content ?? "" };
        }));
        return buildTruthRelationshipGraph(contents);
      })
      .catch(() => null)
      : Promise.resolve(null);

    Promise.all([runRequest, truthRequest])
      .then(([runData, bookGraph]) => {
        if (cancelled) return;
        setRun(runData);
        setTruthGraph(bookGraph);
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [bookDataVersion, playRefreshTick, props.bookId, props.sessionId, props.source]);

  const graph = useMemo(
    () => props.source === "book"
      ? mergeRelationshipGraphs(null, truthGraph)
      : mergeRelationshipGraphs(run?.graph, null),
    [props.source, run?.graph, truthGraph],
  );
  const model = useMemo(
    () => buildRelationshipGraphModel(graph, {
      query,
      type,
      relationsOnly,
      includeDisconnected: props.source === "book",
    }),
    [graph, props.source, query, type, relationsOnly],
  );
  const nodeById = useMemo(() => new Map(model.nodes.map((node) => [node.id, node])), [model.nodes]);
  const focused = selectedId ? nodeById.get(selectedId) ?? null : null;
  const selected = focused;
  const selectedNeighborIds = useMemo(() => {
    if (!focused) return new Set<string>();
    return new Set(model.edges.flatMap((edge) => {
      if (edge.fromId === focused.id) return [edge.toId];
      if (edge.toId === focused.id) return [edge.fromId];
      return [];
    }));
  }, [focused, model.edges]);
  const selectedRelations = useMemo(() => {
    if (!focused) return [];
    return model.edges
      .filter((edge) => edge.fromId === focused.id || edge.toId === focused.id)
      .map((edge) => {
        const outgoing = edge.fromId === focused.id;
        const otherId = outgoing ? edge.toId : edge.fromId;
        return {
          edge,
          outgoing,
          other: nodeById.get(otherId) ?? null,
          visual: relationshipVisual(edge.type, edge.summary),
        };
      })
      .sort((a, b) =>
        (b.other?.degree ?? 0) - (a.other?.degree ?? 0)
        || (a.other?.label ?? "").localeCompare(b.other?.label ?? ""),
      );
  }, [focused, model.edges, nodeById]);
  const displayNodes = useMemo(
    () => buildFocusedDisplayNodes(model.nodes, model.edges, focused),
    [focused, model.edges, model.nodes],
  );
  const displayNodeById = useMemo(() => new Map(displayNodes.map((node) => [node.id, node])), [displayNodes]);

  useEffect(() => {
    if (selectedId && !nodeById.has(selectedId)) setSelectedId(null);
  }, [nodeById, selectedId]);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <motion.div
        initial={{ opacity: 0, y: -6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.24, ease: "easeOut" }}
        className="flex shrink-0 items-center gap-2 border-b border-border/20 px-3 py-3"
      >
        <button
          onClick={props.onClose}
          className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary/60 hover:text-foreground"
          aria-label="返回"
        >
          <ArrowLeft size={14} />
        </button>
        <Network size={15} className="text-primary" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[15px] font-medium leading-5">关系图谱</p>
          <p className="truncate text-[12px] leading-4 text-muted-foreground/70">
            {props.source === "book"
              ? "当前书籍角色关系"
              : run?.title || "当前互动世界"}
          </p>
        </div>
      </motion.div>

      <motion.div
        initial={{ opacity: 0, y: -4 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.24, delay: 0.04, ease: "easeOut" }}
        className="flex shrink-0 flex-col gap-2 border-b border-border/20 px-3 py-2.5"
      >
        <div className="flex min-h-11 items-center gap-2 rounded-xl border border-border/40 bg-secondary/25 px-3 transition-colors focus-within:border-primary/50 focus-within:bg-background/70">
          <Search size={15} className="shrink-0 text-muted-foreground" />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索角色、地点、线索"
            className="h-10 min-h-10 min-w-0 flex-1 appearance-none bg-transparent text-[14px] outline-none placeholder:text-muted-foreground/50"
          />
          {query ? (
            <button
              type="button"
              onClick={() => setQuery("")}
              className="flex h-8 w-8 min-h-8 min-w-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
              aria-label="清除搜索"
            >
              <X size={14} />
            </button>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-1.5">
          <NodeBadge type="全部" count={model.typeCounts.reduce((sum, item) => sum + item.count, 0)} selected={!type} onClick={() => setType("")} />
          {model.typeCounts.map((item) => (
            <NodeBadge key={item.type} type={item.type} count={item.count} selected={type === item.type} onClick={() => setType(item.type)} />
          ))}
          <button
            onClick={() => setRelationsOnly((value) => !value)}
            className={cn(
              "ml-auto flex items-center gap-1.5 rounded-md border px-2 py-1 text-[12px] leading-4 transition-colors",
              relationsOnly ? "border-primary/50 bg-primary/10 text-primary" : "border-border/30 bg-secondary/30 text-muted-foreground hover:text-foreground",
            )}
          >
            <SlidersHorizontal size={11} />
            只看关系
          </button>
        </div>
      </motion.div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex h-48 items-center justify-center">
            <Loader2 size={17} className="animate-spin text-muted-foreground" />
          </div>
        ) : model.nodes.length === 0 ? (
          <div className="px-4 py-8 text-[14px] leading-6 text-muted-foreground/70">
            {props.source === "book"
              ? "尚未识别到书籍角色关系。章节结算或 current_focus.md 中的关系组生成后会自动显示。"
              : "尚未记录到互动关系。继续推进世界，角色、地点、物品和线索之间的连接会自动出现。"}
          </div>
        ) : (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3, ease: "easeOut" }}
            className="space-y-3 p-3"
          >
            <div className="flex items-center gap-2 rounded-lg border border-border/25 bg-secondary/20 px-3 py-2">
              <div className="flex min-w-0 flex-1 items-center gap-2 text-[12px] text-muted-foreground">
                <Network size={13} className="shrink-0 text-primary" />
                <span>{model.nodes.length} 个节点</span>
                <span className="text-border">·</span>
                <span>{model.edges.length} 条关系</span>
              </div>
              {selectedId ? (
                <button
                  onClick={() => setSelectedId(null)}
                  className="flex h-7 items-center gap-1.5 rounded-md px-2 text-[12px] text-muted-foreground transition-colors hover:bg-secondary/70 hover:text-foreground"
                  title="显示全部关系"
                >
                  <Focus size={12} />
                  全部
                </button>
              ) : null}
            </div>
            <div className="flex flex-wrap gap-x-3 gap-y-1.5 px-1 pb-0.5 text-[11px] text-muted-foreground">
              {[...RELATIONSHIP_VISUALS, DEFAULT_RELATIONSHIP_VISUAL].map((visual) => (
                <span key={visual.key} className="inline-flex shrink-0 items-center gap-1.5">
                  <span className="h-2 w-2 rounded-full" style={{ backgroundColor: visual.color }} />
                  {visual.label}
                </span>
              ))}
            </div>

            <div className="relative overflow-hidden rounded-[2.2rem] border border-border/25 bg-[radial-gradient(circle_at_50%_40%,hsl(var(--primary)/0.07),transparent_48%),linear-gradient(180deg,hsl(var(--background)/0.65),hsl(var(--secondary)/0.15))] shadow-soft backdrop-blur-md">
              <div className="pointer-events-none absolute inset-x-0 top-0 z-10 h-20 bg-gradient-to-b from-background/45 to-transparent" />
              <svg viewBox={`0 0 ${W} ${H}`} className="block w-full aspect-[4/3] sm:aspect-[1.15]" role="img" aria-label="关系图谱">
                <defs>
                  <pattern id="relationship-grid" width="40" height="40" patternUnits="userSpaceOnUse">
                    <path d="M 40 0 L 0 0 0 40" fill="none" className="stroke-border/12" strokeWidth="0.5" />
                    <circle cx="0" cy="0" r="0.8" className="fill-border/15" />
                  </pattern>
                  <filter id="node-glow-selected" x="-60%" y="-60%" width="220%" height="220%">
                    <feGaussianBlur stdDeviation="15" result="blur" />
                    <feComposite in="SourceGraphic" in2="blur" operator="over" />
                  </filter>
                  <marker id="relationship-arrow" markerWidth="8" markerHeight="8" refX="19" refY="4" orient="auto">
                    <path d="M0,0 L8,4 L0,8 Z" fill="context-stroke" opacity="0.75" />
                  </marker>
                </defs>
                <rect width={W} height={H} fill="url(#relationship-grid)" />
                
                {/* Orbital Guides */}
                <motion.circle
                  cx={CX}
                  cy={CY}
                  r={focused ? 116 : 188}
                  initial={false}
                  animate={{ r: focused ? 116 : 188, opacity: focused ? 0.28 : 0.14 }}
                  transition={{ type: "spring", stiffness: 85, damping: 22 }}
                  className="fill-none stroke-primary/35"
                  strokeWidth="0.5"
                  strokeDasharray="4 10"
                />
                
                {/* Edges */}
                {model.edges.map((edge, index) => {
                  const from = displayNodeById.get(edge.fromId);
                  const to = displayNodeById.get(edge.toId);
                  if (!from || !to) return null;
                  const edgeSelected = !focused || edge.fromId === focused.id || edge.toId === focused.id;
                  const visual = relationshipVisual(edge.type, edge.summary);
                  const path = edgePath(from, to, index);
                  const label = edgeLabelPosition(from, to, index);
                  const showLabel = edgeSelected && (Boolean(focused) || model.edges.length <= 6);
                  return (
                    <motion.g
                      key={edge.id}
                      initial={{ opacity: 0 }}
                      animate={{ opacity: edgeSelected ? 1 : 0.04 }}
                      transition={{ duration: 0.3, delay: Math.min(index * 0.015, 0.2) }}
                    >
                      <motion.path
                        initial={false}
                        animate={{ d: path }}
                        transition={{ type: "spring", stiffness: 110, damping: 26 }}
                        stroke={edgeSelected ? visual.color : "currentColor"}
                        className={edgeSelected ? undefined : "text-muted-foreground/20"}
                        strokeWidth={edgeSelected ? Math.max(2.2, Math.min(4.5, (edge.strength ?? 1.6) * 1.6)) : 1}
                        strokeDasharray={visual.key === "hostile" ? "6 4" : undefined}
                        strokeLinecap="round"
                        fill="none"
                        markerEnd="url(#relationship-arrow)"
                      />
                      {showLabel ? (
                        <motion.g
                          initial={false}
                          animate={{ x: label.x, y: label.y }}
                          transition={{ type: "spring", stiffness: 110, damping: 26 }}
                          className="pointer-events-none"
                        >
                          <rect
                            x={-Math.max(30, truncate(edge.type, 10).length * 5 + 10)}
                            y={-11}
                            width={Math.max(60, truncate(edge.type, 10).length * 10 + 20)}
                            height="22"
                            rx="11"
                            className="fill-background/95 stroke-border/30 shadow-sm"
                          />
                          <text textAnchor="middle" y="4" fontSize="11" fontWeight={750} fill={visual.color} className="tracking-tight">
                            {truncate(edge.type, 10)}
                          </text>
                        </motion.g>
                      ) : null}
                    </motion.g>
                  );
                })}

                {/* Nodes */}
                {displayNodes.map((node, index) => {
                  const selectedNode = node.selected;
                  const connectedNode = node.connected || selectedNeighborIds.has(node.id);
                  const accent = ACCENT_BY_TYPE[node.type] ?? "#64748b";
                  const label = truncate(node.label, selectedNode ? 22 : 18);
                  const nodeWidth = selectedNode ? Math.max(188, label.length * 17 + 64) : Math.max(136, label.length * 15 + 54);
                  const nodeHeight = selectedNode ? 84 : 56;
                  
                  return (
                    <motion.g
                      key={node.id}
                      initial={{ opacity: 0, scale: 0.8, x: node.displayX, y: node.displayY }}
                      animate={{
                        opacity: connectedNode ? 1 : 0.18,
                        scale: selectedNode ? 1.08 : 1,
                        x: node.displayX,
                        y: node.displayY,
                      }}
                      transition={{
                        opacity: { duration: 0.2 },
                        scale: { type: "spring", stiffness: 450, damping: 28, delay: selectedId ? 0 : Math.min(index * 0.03, 0.25) },
                        x: { type: "spring", stiffness: 140, damping: 24 },
                        y: { type: "spring", stiffness: 140, damping: 24 },
                      }}
                      className="cursor-pointer outline-none"
                      onClick={() => setSelectedId(selectedNode ? null : node.id)}
                    >
                      {selectedNode && (
                        <circle r="65" fill={accent} opacity="0.12" filter="url(#node-glow-selected)" />
                      )}
                      
                      <rect
                        x={-nodeWidth / 2}
                        y={-nodeHeight / 2}
                        width={nodeWidth}
                        height={nodeHeight}
                        rx={selectedNode ? 26 : 18}
                        className="transition-colors duration-300 shadow-lg"
                        style={{
                          fill: selectedNode ? "var(--background)" : "color-mix(in srgb, var(--background) 96%, transparent)",
                          stroke: accent,
                          strokeWidth: selectedNode ? 2.8 : 1.6,
                        }}
                      />
                      
                      {/* Node Content */}
                      <g className="pointer-events-none text-foreground">
                        <text 
                          y={selectedNode ? -8 : -6} 
                          textAnchor="middle" 
                          fontSize={selectedNode ? "22" : "17"} 
                          fontWeight={850} 
                          className="fill-current tracking-tight"
                        >
                          {label}
                        </text>
                        <rect
                          x={-30}
                          y={selectedNode ? 18 : 14}
                          width="60"
                          height="18"
                          rx="9"
                          fill={accent}
                          opacity={selectedNode ? 0.28 : 0.16}
                        />
                        <text 
                          y={selectedNode ? 31 : 27} 
                          textAnchor="middle" 
                          fontSize="10" 
                          fontWeight={800} 
                          fill={accent}
                          className="uppercase tracking-[0.14em]"
                        >
                          {node.type}
                        </text>
                      </g>
                    </motion.g>
                  );
                })}
              </svg>
            </div>

            {model.hiddenEdges > 0 ? (
              <p className="text-[12px] leading-5 text-muted-foreground/70">已按当前筛选隐藏 {model.hiddenEdges} 条连接。</p>
            ) : null}
            <AnimatePresence mode="wait">
            {selected ? (
              <motion.div
                key={selected.id}
                initial={{ opacity: 0, y: 8, scale: 0.985 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -5 }}
                transition={{ duration: 0.2, ease: "easeOut" }}
                className="border-t border-border/30 pt-3"
              >
                <div className="flex items-center justify-between gap-2">
                  <h3 className="min-w-0 truncate text-[15px] font-semibold leading-6">{selected.label}</h3>
                  <span className="shrink-0 rounded-md bg-background px-2 py-0.5 text-[12px] text-muted-foreground">{selected.type}</span>
                </div>
                {selected.status ? <p className="mt-1 text-[13px] leading-5 text-muted-foreground">{selected.status}</p> : null}
                {selected.summary ? <p className="mt-1 text-[13px] leading-5 text-muted-foreground/80">{selected.summary}</p> : null}
                <div className="mt-3 space-y-2">
                  {selectedRelations.map(({ edge, outgoing, other, visual }) => {
                    const otherLabel = other?.label ?? (outgoing ? edge.toId : edge.fromId);
                    const directionLabel = outgoing
                      ? `${selected.label} -> ${otherLabel}`
                      : `${otherLabel} -> ${selected.label}`;
                    const detail = relationshipDetailText({ selected, other, edge, outgoing });
                    const strengthLabel = formatRelationshipStrength(edge.strength);
                    const otherBrief = cleanRelationshipDetail(other?.summary || other?.status);
                    return (
                      <button
                        key={edge.id}
                        type="button"
                        onClick={() => other && setSelectedId(other.id)}
                        className="block w-full rounded-lg border border-border/25 border-l-2 bg-secondary/20 px-3 py-3 text-left transition-colors hover:bg-secondary/40"
                        style={{ borderLeftColor: visual.color }}
                      >
                        <div className="flex items-start gap-2">
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-[13px] font-semibold text-foreground">{otherLabel}</p>
                            <p className="mt-0.5 truncate text-[11px] text-muted-foreground/70">{directionLabel}</p>
                          </div>
                          <span
                            className="shrink-0 rounded-md px-1.5 py-0.5 text-[11px] font-medium"
                            style={{ color: visual.color, backgroundColor: visual.softColor }}
                          >
                            {edge.type}
                          </span>
                        </div>
                        <p className="mt-2 text-[12px] leading-5 text-muted-foreground">
                          {detail}
                        </p>
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          <span className="rounded-md bg-background/70 px-1.5 py-0.5 text-[11px] text-muted-foreground">
                            {outgoing ? "主动关系" : "反向关系"}
                          </span>
                          {strengthLabel ? (
                            <span className="rounded-md bg-background/70 px-1.5 py-0.5 text-[11px] text-muted-foreground">
                              {strengthLabel}
                            </span>
                          ) : null}
                          {other?.status ? (
                            <span className="rounded-md bg-background/70 px-1.5 py-0.5 text-[11px] text-muted-foreground">
                              {other.status}
                            </span>
                          ) : null}
                        </div>
                        {otherBrief && detail !== otherBrief ? (
                          <p className="mt-2 text-[11px] leading-5 text-muted-foreground/65">
                            对方简介：{otherBrief}
                          </p>
                        ) : null}
                      </button>
                    );
                  })}
                  {selectedRelations.length === 0 ? (
                    <p className="py-3 text-[12px] text-muted-foreground/70">暂未记录该角色与其他角色的关系。</p>
                  ) : null}
                </div>
              </motion.div>
            ) : (
              <motion.div
                key="relationship-selection-hint"
                initial={{ opacity: 0, y: 5 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -5 }}
                className="flex items-center gap-2 border-t border-border/30 px-1 pt-3 text-[12px] leading-5 text-muted-foreground/75"
              >
                <Focus size={13} className="shrink-0 text-primary" />
                点击图中的角色，查看其他角色相对于它的关系与简介。
              </motion.div>
            )}
            </AnimatePresence>
          </motion.div>
        )}
      </div>
    </div>
  );
}
