import { useState, useEffect, useCallback, useMemo } from "react";
import { useApi, fetchJson, postApi, putApi, deleteApi } from "../hooks/use-api";
import type { Theme } from "../hooks/use-theme";
import type { TFunction } from "../hooks/use-i18n";
import { AnimatePresence, motion } from "motion/react";
import { 
  ChevronLeft, 
  Plus, 
  Trash2, 
  Edit2, 
  Check, 
  X, 
  Network, 
  User, 
  Users,
  ArrowRightLeft, 
  Flag,
  LayoutGrid,
  Share2,
  Focus
} from "lucide-react";

interface CharacterNode {
  id: string;
  name: string;
  role: "protagonist" | "supporting" | "antagonist" | "minor";
  description: string;
  group: string;
}

interface CharacterEdge {
  id: string;
  source: string;
  target: string;
  relation: string;
  type: "friendly" | "hostile" | "family" | "romantic" | "business";
}

interface CharacterGraphData {
  nodes: CharacterNode[];
  edges: CharacterEdge[];
  groups: string[];
}

interface Nav {
  toBookSettings: (id: string) => void;
}

const ROLE_INFO: Record<string, { label: string; color: string; bg: string }> = {
  protagonist: { label: "主角", color: "text-primary", bg: "bg-primary/10" },
  supporting: { label: "配角", color: "text-blue-500", bg: "bg-blue-500/10" },
  antagonist: { label: "反派", color: "text-red-500", bg: "bg-red-500/10" },
  minor: { label: "龙套", color: "text-muted-foreground", bg: "bg-muted" },
};

const ACCENT_BY_ROLE: Record<string, string> = {
  protagonist: "#d66f75",
  supporting: "#3b82f6",
  antagonist: "#ef4444",
  minor: "#94a3b8",
};

const RELATION_TYPES = {
  friendly: { label: "友好", color: "text-emerald-500", bg: "bg-emerald-500/10" },
  hostile: { label: "敌对", color: "text-red-500", bg: "bg-red-500/10" },
  family: { label: "亲属", color: "text-amber-500", bg: "bg-amber-500/10" },
  romantic: { label: "恋情", color: "text-pink-500", bg: "bg-pink-500/10" },
  business: { label: "利益", color: "text-blue-500", bg: "bg-blue-500/10" },
};

export function CharacterGraphPage({ bookId, nav, theme: _theme, t: _t }: {
  bookId: string;
  nav: Nav;
  theme: Theme;
  t: TFunction;
}) {
  const [data, setData] = useState<CharacterGraphData>({ nodes: [], edges: [], groups: [] });
  const [loading, setLoading] = useState(true);
  const [viewMode, setViewMode] = useState<"list" | "graph">("list");

  // Node State
  const [showAddNode, setShowAddNode] = useState(false);
  const [showEditNode, setShowEditNode] = useState<string | null>(null);
  const [nodeForm, setNodeForm] = useState({ name: "", role: "protagonist" as "protagonist" | "supporting" | "antagonist" | "minor", description: "", group: "" });

  // Edge State
  const [showAddEdge, setShowAddEdge] = useState(false);
  const [edgeForm, setEdgeForm] = useState({ source: "", target: "", relation: "", type: "friendly" as const });

  // Graph Selection & Layout calculations
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  useEffect(() => {
    if (selectedNodeId && !data.nodes.some(n => n.id === selectedNodeId)) {
      setSelectedNodeId(null);
    }
  }, [data.nodes, selectedNodeId]);

  const degrees = useMemo(() => {
    const degs = new Map<string, number>();
    for (const edge of data.edges) {
      degs.set(edge.source, (degs.get(edge.source) ?? 0) + 1);
      degs.set(edge.target, (degs.get(edge.target) ?? 0) + 1);
    }
    return degs;
  }, [data.edges]);

  const orderedNodes = useMemo(() => {
    return [...data.nodes].sort((a, b) => (degrees.get(b.id) ?? 0) - (degrees.get(a.id) ?? 0));
  }, [data.nodes, degrees]);

  const W = 800;
  const H = 600;
  const CX = W / 2;
  const CY = H / 2;

  const graphNodes = useMemo(() => {
    const radiusX = Math.min(280, Math.max(180, 100 + orderedNodes.length * 15));
    const radiusY = Math.min(200, Math.max(130, 70 + orderedNodes.length * 10));
    
    return orderedNodes.map((node, index) => {
      const angle = -Math.PI / 2 + (2 * Math.PI * index) / Math.max(1, orderedNodes.length);
      const deg = degrees.get(node.id) ?? 0;
      const hubPull = Math.min(30, deg * 3);
      
      return {
        ...node,
        deg,
        x: CX + (radiusX - hubPull) * Math.cos(angle),
        y: CY + (radiusY - hubPull * 0.72) * Math.sin(angle),
      };
    });
  }, [orderedNodes, degrees]);

  const graphNodesMap = useMemo(() => new Map(graphNodes.map(n => [n.id, n])), [graphNodes]);

  const selectedNeighborIds = useMemo(() => {
    const set = new Set<string>();
    if (!selectedNodeId) return set;
    for (const edge of data.edges) {
      if (edge.source === selectedNodeId) set.add(edge.target);
      if (edge.target === selectedNodeId) set.add(edge.source);
    }
    return set;
  }, [selectedNodeId, data.edges]);

  const fetchData = useCallback(async () => {
    try {
      setLoading(true);
      const result = await fetchJson<CharacterGraphData>(`/books/${bookId}/characters`);
      setData(result);
    } catch (error) {
      console.error("Failed to fetch character graph:", error);
      // Fallback to empty data on error
      setData({ nodes: [], edges: [], groups: [] });
    } finally {
      setLoading(false);
    }
  }, [bookId]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleAddNode = async () => {
    if (!nodeForm.name) return;
    try {
      const result = await postApi(`/books/${bookId}/characters/node`, nodeForm);
      setData(result as CharacterGraphData);
      setNodeForm({ name: "", role: "protagonist", description: "", group: "" });
      setShowAddNode(false);
    } catch (error) {
      console.error("Failed to add character:", error);
    }
  };

  const handleUpdateNode = async (nodeId: string) => {
    try {
      const result = await putApi(`/books/${bookId}/characters/node/${nodeId}`, nodeForm);
      setData(result as CharacterGraphData);
      setShowEditNode(null);
    } catch (error) {
      console.error("Failed to update character:", error);
    }
  };

  const handleDeleteNode = async (nodeId: string) => {
    try {
      const result = await deleteApi(`/books/${bookId}/characters/node/${nodeId}`);
      setData(result as CharacterGraphData);
    } catch (error) {
      console.error("Failed to delete character:", error);
    }
  };

  const handleAddEdge = async () => {
    if (!edgeForm.source || !edgeForm.target || !edgeForm.relation) return;
    try {
      const result = await postApi(`/books/${bookId}/characters/edge`, edgeForm);
      setData(result as CharacterGraphData);
      setEdgeForm({ source: "", target: "", relation: "", type: "friendly" });
      setShowAddEdge(false);
    } catch (error) {
      console.error("Failed to add relation:", error);
    }
  };

  const handleDeleteEdge = async (edgeId: string) => {
    try {
      const result = await deleteApi(`/books/${bookId}/characters/edge/${edgeId}`);
      setData(result as CharacterGraphData);
    } catch (error) {
      console.error("Failed to delete relation:", error);
    }
  };

  const startEditingNode = (node: CharacterNode) => {
    setShowEditNode(node.id);
    setNodeForm({ name: node.name, role: node.role, description: node.description, group: node.group });
  };

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center py-32 space-y-4">
        <div className="w-10 h-10 border-3 border-primary/20 border-t-primary rounded-full animate-spin" />
        <span className="text-sm font-medium text-muted-foreground animate-pulse">正在梳理人物关系...</span>
      </div>
    );
  }

  return (
    <div className="space-y-8 fade-in">
      {/* Navigation */}
      <nav className="flex items-center gap-2 text-[13px] font-medium text-muted-foreground">
        <button onClick={() => nav.toBookSettings(bookId)} className="flex items-center gap-1.5 transition-colors hover:text-primary">
          <ChevronLeft size={14} />
          <span>书籍设置</span>
        </button>
        <span className="text-border/60">/</span>
        <span className="text-foreground">人物志 & 关系网</span>
      </nav>

      {/* Hero Section */}
      <section className="glass-panel relative overflow-hidden rounded-[2.5rem] p-6 sm:p-10">
        <div className="relative z-10 flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
          <div className="space-y-4">
            <div className="flex items-center gap-2.5 text-sm font-bold text-primary">
              <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/15 shadow-inner">
                <Users size={16} />
              </div>
              <span>CHARACTERS</span>
            </div>
            <h1 className="text-4xl font-serif font-bold tracking-tight text-foreground sm:text-5xl">
              人物志 & 关系网
            </h1>
            <p className="max-w-2xl text-base leading-relaxed text-muted-foreground">
              管理你故事中的每一个灵魂。定义他们的角色地位，编织错综复杂的人际关系，确保角色动机与冲突逻辑自洽。
            </p>
          </div>

          <div className="flex flex-wrap gap-3">
            <div className="soft-pill flex p-1">
              <button
                onClick={() => setViewMode("list")}
                className={`flex h-10 items-center gap-2 rounded-full px-5 text-sm font-bold transition-all ${
                  viewMode === "list" ? "bg-card text-primary shadow-sm" : "text-muted-foreground hover:text-foreground"
                }`}
              >
                <LayoutGrid size={16} />
                列表视图
              </button>
              <button
                onClick={() => setViewMode("graph")}
                className={`flex h-10 items-center gap-2 rounded-full px-5 text-sm font-bold transition-all ${
                  viewMode === "graph" ? "bg-card text-primary shadow-sm" : "text-muted-foreground hover:text-foreground"
                }`}
              >
                <Share2 size={16} />
                图谱视图
              </button>
            </div>
            <button
              onClick={() => setShowAddNode(true)}
              className="inline-flex h-12 items-center justify-center gap-2 rounded-2xl bg-primary px-6 text-sm font-bold text-primary-foreground shadow-lg shadow-primary/20 transition-all hover:scale-[1.02] active:scale-[0.98]"
            >
              <Plus size={18} />
              新增角色
            </button>
          </div>
        </div>

        {/* Decorative elements */}
        <div className="absolute -right-20 -top-20 h-64 w-64 rounded-full bg-primary/5 blur-3xl" />
        <div className="absolute -bottom-20 -left-20 h-64 w-64 rounded-full bg-accent/5 blur-3xl" />
      </section>

      {viewMode === "list" ? (
        <div className="grid grid-cols-1 gap-8 lg:grid-cols-3">
          {/* Character List */}
          <div className="lg:col-span-2 space-y-6">
            <h2 className="flex items-center gap-2 text-xl font-bold text-foreground">
              <User size={20} className="text-primary" />
              角色成员 ({data.nodes.length})
            </h2>
            
            {data.nodes.length === 0 ? (
              <div className="paper-sheet flex flex-col items-center justify-center rounded-[2rem] p-16 text-center">
                <div className="flex h-16 w-16 items-center justify-center rounded-full bg-muted/50 text-muted-foreground mb-4">
                  <User size={32} />
                </div>
                <h3 className="text-lg font-bold text-foreground">虚位以待</h3>
                <p className="mt-2 text-sm text-muted-foreground max-w-xs">
                  你的故事舞台上还没有任何演员。点击右上方“新增角色”开始你的创作。
                </p>
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                {data.nodes.map((node) => (
                  <div key={node.id} className="paper-sheet group relative flex flex-col rounded-3xl p-5 transition-all hover:-translate-y-1">
                    <div className="flex items-start justify-between">
                      <div className="space-y-1">
                        <div className="flex items-center gap-2">
                          <h3 className="text-lg font-bold text-foreground">{node.name}</h3>
                          <span className={`rounded-full px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider ${ROLE_INFO[node.role].bg} ${ROLE_INFO[node.role].color}`}>
                            {ROLE_INFO[node.role].label}
                          </span>
                        </div>
                        {node.group && (
                          <div className="text-xs font-medium text-muted-foreground/70 flex items-center gap-1">
                            <Flag size={10} />
                            {node.group}
                          </div>
                        )}
                      </div>
                      <div className="flex gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                        <button
                          onClick={() => startEditingNode(node)}
                          className="flex h-8 w-8 items-center justify-center rounded-xl bg-secondary/80 text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors"
                        >
                          <Edit2 size={14} />
                        </button>
                        <button
                          onClick={() => handleDeleteNode(node.id)}
                          className="flex h-8 w-8 items-center justify-center rounded-xl bg-destructive/10 text-destructive hover:bg-destructive/20 transition-colors"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </div>
                    
                    <p className="mt-4 text-sm leading-relaxed text-muted-foreground line-clamp-3">
                      {node.description || "暂无描述..."}
                    </p>
                    
                    <div className="mt-5 flex items-center justify-between border-t border-border/40 pt-4">
                      <div className="flex -space-x-2">
                        {/* Placeholder for related character avatars */}
                        {[1, 2, 3].map((i) => (
                          <div key={i} className="h-7 w-7 rounded-full border-2 border-card bg-muted flex items-center justify-center text-[10px] font-bold text-muted-foreground">
                            {i}
                          </div>
                        ))}
                      </div>
                      <button className="text-[11px] font-bold text-primary hover:underline">
                        详细档案 →
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Relations Section */}
          <div className="space-y-6">
            <div className="flex items-center justify-between">
              <h2 className="flex items-center gap-2 text-xl font-bold text-foreground">
                <ArrowRightLeft size={20} className="text-primary" />
                关系纽带
              </h2>
              <button
                onClick={() => setShowAddEdge(true)}
                className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/10 text-primary hover:bg-primary/20 transition-colors"
              >
                <Plus size={16} />
              </button>
            </div>

            <div className="paper-sheet divide-y divide-border/40 overflow-hidden rounded-[2rem]">
              {data.edges.length === 0 ? (
                <div className="p-10 text-center">
                  <p className="text-sm text-muted-foreground">还没有建立任何人物关系。</p>
                </div>
              ) : (
                data.edges.map((edge) => {
                  const source = data.nodes.find(n => n.id === edge.source);
                  const target = data.nodes.find(n => n.id === edge.target);
                  return (
                    <div key={edge.id} className="group relative p-5 transition-colors hover:bg-muted/30">
                      <div className="flex items-center justify-between gap-3">
                        <div className="flex min-w-0 flex-1 items-center gap-3">
                          <div className="truncate font-bold text-foreground">{source?.name || "未知"}</div>
                          <div className="flex shrink-0 flex-col items-center">
                            <div className={`rounded-full px-3 py-1 text-[11px] font-bold ${RELATION_TYPES[edge.type].bg} ${RELATION_TYPES[edge.type].color}`}>
                              {edge.relation}
                            </div>
                            <div className="h-px w-8 bg-border/60" />
                          </div>
                          <div className="truncate font-bold text-foreground">{target?.name || "未知"}</div>
                        </div>
                        <button
                          onClick={() => handleDeleteEdge(edge.id)}
                          className="opacity-0 group-hover:opacity-100 p-1.5 rounded-lg text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition-all"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>
      ) : (
        /* Graph View Actual Implementation */
        <div className="grid grid-cols-1 gap-8 lg:grid-cols-4">
          {/* SVG Canvas Area */}
          <div className="lg:col-span-3 relative glass-panel overflow-hidden rounded-[2.5rem] border border-border/25 bg-[radial-gradient(circle_at_50%_40%,hsl(var(--primary)/0.05),transparent_50%),linear-gradient(180deg,hsl(var(--background)/0.5),hsl(var(--secondary)/0.1))] shadow-soft backdrop-blur-md">
            <svg
              viewBox={`0 0 ${W} ${H}`}
              className="block w-full aspect-[4/3] focus:outline-none"
              role="img"
              aria-label="人物关系网"
              onClick={() => setSelectedNodeId(null)}
            >
              <defs>
                <pattern id="graph-grid" width="40" height="40" patternUnits="userSpaceOnUse">
                  <path d="M 40 0 L 0 0 0 40" fill="none" className="stroke-border/10" strokeWidth="0.5" />
                  <circle cx="0" cy="0" r="0.8" className="fill-border/15" />
                </pattern>
                <filter id="node-glow" x="-50%" y="-50%" width="200%" height="200%">
                  <feGaussianBlur stdDeviation="8" result="blur" />
                  <feComposite in="SourceGraphic" in2="blur" operator="over" />
                </filter>
                <marker id="relation-arrow" markerWidth="8" markerHeight="8" refX="19" refY="4" orient="auto">
                  <path d="M0,0 L8,4 L0,8 Z" fill="context-stroke" opacity="0.8" />
                </marker>
              </defs>
              <rect width={W} height={H} fill="url(#graph-grid)" />

              {/* Orbit Guide */}
              <circle
                cx={CX}
                cy={CY}
                r={Math.min(280, Math.max(180, 100 + orderedNodes.length * 15))}
                className="fill-none stroke-primary/15"
                strokeWidth="0.5"
                strokeDasharray="4 8"
              />

              {/* Edges / Relationship lines */}
              {data.edges.map((edge, index) => {
                const fromNode = graphNodesMap.get(edge.source);
                const toNode = graphNodesMap.get(edge.target);
                if (!fromNode || !toNode) return null;

                const isHighlighted = !selectedNodeId || edge.source === selectedNodeId || edge.target === selectedNodeId;
                const strokeColor = RELATION_TYPES[edge.type]?.color === "text-emerald-500" ? "#10b981" :
                                    RELATION_TYPES[edge.type]?.color === "text-red-500" ? "#ef4444" :
                                    RELATION_TYPES[edge.type]?.color === "text-amber-500" ? "#f59e0b" :
                                    RELATION_TYPES[edge.type]?.color === "text-pink-500" ? "#ec4899" :
                                    "#3b82f6";

                // Shorten path endpoints to avoid overlapping text
                const dx = toNode.x - fromNode.x;
                const dy = toNode.y - fromNode.y;
                const dist = Math.hypot(dx, dy) || 1;
                
                // Adjust target endpoint to boundary of capsule (roughly 75px width, 22px height)
                const targetOffset = 52;
                const sourceOffset = 52;
                const shortenedFrom = {
                  x: fromNode.x + (dx / dist) * sourceOffset,
                  y: fromNode.y + (dy / dist) * sourceOffset,
                };
                const shortenedTo = {
                  x: toNode.x - (dx / dist) * targetOffset,
                  y: toNode.y - (dy / dist) * targetOffset,
                };

                const curve = ((index % 3) - 1) * 20;
                const midX = (shortenedFrom.x + shortenedTo.x) / 2 + (-dy / dist) * curve;
                const midY = (shortenedFrom.y + shortenedTo.y) / 2 + (dx / dist) * curve;

                const pathD = `M ${shortenedFrom.x} ${shortenedFrom.y} Q ${midX} ${midY} ${shortenedTo.x} ${shortenedTo.y}`;

                return (
                  <g key={edge.id} className="transition-opacity duration-300" style={{ opacity: isHighlighted ? 1 : 0.08 }}>
                    <path
                      d={pathD}
                      stroke={strokeColor}
                      strokeWidth={isHighlighted ? 2 : 1}
                      strokeDasharray={edge.type === "hostile" ? "5 4" : undefined}
                      fill="none"
                      markerEnd="url(#relation-arrow)"
                      className="transition-all duration-300"
                    />
                    {/* Relationship label */}
                    <g transform={`translate(${midX}, ${midY})`}>
                      <rect
                        x="-22"
                        y="-10"
                        width="44"
                        height="20"
                        rx="10"
                        className="fill-background/95 stroke-border/30 shadow-sm"
                      />
                      <text
                        textAnchor="middle"
                        y="4"
                        fontSize="10"
                        fontWeight="bold"
                        fill={strokeColor}
                        className="tracking-tight animate-fade-in"
                      >
                        {edge.relation}
                      </text>
                    </g>
                  </g>
                );
              })}

              {/* Nodes / Character Capsules */}
              {graphNodes.map((node) => {
                const isSelected = selectedNodeId === node.id;
                const isNeighbor = selectedNeighborIds.has(node.id);
                const isDimmed = selectedNodeId && !isSelected && !isNeighbor;
                const accent = ACCENT_BY_ROLE[node.role] || "#94a3b8";
                
                const capsuleWidth = Math.max(120, node.name.length * 15 + 40);
                const capsuleHeight = 44;

                return (
                  <g
                    key={node.id}
                    className="cursor-pointer transition-opacity duration-300 select-none"
                    style={{ opacity: isDimmed ? 0.25 : 1 }}
                    transform={`translate(${node.x}, ${node.y})`}
                    onClick={(e) => {
                      e.stopPropagation();
                      setSelectedNodeId(isSelected ? null : node.id);
                    }}
                  >
                    {isSelected && (
                      <rect
                        x={-capsuleWidth / 2}
                        y={-capsuleHeight / 2}
                        width={capsuleWidth}
                        height={capsuleHeight}
                        rx="22"
                        fill={accent}
                        opacity="0.18"
                        filter="url(#node-glow)"
                      />
                    )}
                    <rect
                      x={-capsuleWidth / 2}
                      y={-capsuleHeight / 2}
                      width={capsuleWidth}
                      height={capsuleHeight}
                      rx="22"
                      className="fill-background/90 stroke-border/50 hover:stroke-foreground/50 transition-colors duration-200"
                      style={{
                        stroke: isSelected ? accent : undefined,
                        strokeWidth: isSelected ? 2.5 : 1.2
                      }}
                    />
                    <text
                      textAnchor="middle"
                      y="-4"
                      fontSize="14"
                      fontWeight="bold"
                      className="fill-foreground font-sans"
                    >
                      {node.name}
                    </text>
                    <text
                      textAnchor="middle"
                      y="14"
                      fontSize="9"
                      fontWeight="bold"
                      className="uppercase tracking-[0.12em]"
                      style={{ fill: accent }}
                    >
                      {ROLE_INFO[node.role]?.label || "角色"}
                    </text>
                  </g>
                );
              })}
            </svg>
          </div>

          {/* Right Sidebar Detail / Action Card */}
          <div className="lg:col-span-1 space-y-6">
            {selectedNodeId && graphNodesMap.has(selectedNodeId) ? (
              (() => {
                const node = graphNodesMap.get(selectedNodeId)!;
                const nodeRelations = data.edges.filter(
                  (edge) => edge.source === node.id || edge.target === node.id
                );

                return (
                  <div className="glass-panel rounded-[2.5rem] p-6 space-y-6 shadow-3d fade-in">
                    <div className="flex items-start justify-between">
                      <div className="space-y-1">
                        <h3 className="text-2xl font-bold text-foreground">{node.name}</h3>
                        <span className={`inline-block rounded-full px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider ${ROLE_INFO[node.role].bg} ${ROLE_INFO[node.role].color}`}>
                          {ROLE_INFO[node.role].label}
                        </span>
                      </div>
                      <div className="flex gap-1">
                        <button
                          onClick={() => startEditingNode(node)}
                          className="flex h-8 w-8 items-center justify-center rounded-xl bg-secondary/80 text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors"
                        >
                          <Edit2 size={14} />
                        </button>
                        <button
                          onClick={() => {
                            handleDeleteNode(node.id);
                            setSelectedNodeId(null);
                          }}
                          className="flex h-8 w-8 items-center justify-center rounded-xl bg-destructive/10 text-destructive hover:bg-destructive/20 transition-colors"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </div>

                    {node.group && (
                      <div className="space-y-1.5">
                        <div className="text-xs font-bold uppercase tracking-wider text-muted-foreground">所属阵营 / 团体</div>
                        <div className="text-sm font-medium text-foreground bg-secondary/30 rounded-xl px-3 py-2 flex items-center gap-2">
                          <Flag size={14} className="text-primary" />
                          {node.group}
                        </div>
                      </div>
                    )}

                    <div className="space-y-1.5">
                      <div className="text-xs font-bold uppercase tracking-wider text-muted-foreground">人设描述</div>
                      <p className="text-sm leading-relaxed text-muted-foreground bg-secondary/20 rounded-2xl p-4 min-h-[80px]">
                        {node.description || "暂无描述信息。"}
                      </p>
                    </div>

                    <div className="space-y-3">
                      <div className="flex items-center justify-between">
                        <div className="text-xs font-bold uppercase tracking-wider text-muted-foreground">人际关系 ({nodeRelations.length})</div>
                        <button
                          onClick={() => {
                            setEdgeForm((prev) => ({ ...prev, source: node.id }));
                            setShowAddEdge(true);
                          }}
                          className="text-[11px] font-bold text-primary hover:underline flex items-center gap-1"
                        >
                          <Plus size={10} />
                          新增关系
                        </button>
                      </div>

                      {nodeRelations.length === 0 ? (
                        <div className="text-xs text-muted-foreground text-center py-4 bg-secondary/10 rounded-2xl">
                          暂无人物关系。
                        </div>
                      ) : (
                        <div className="space-y-2 max-h-[220px] overflow-y-auto pr-1">
                          {nodeRelations.map((edge) => {
                            const isSource = edge.source === node.id;
                            const otherId = isSource ? edge.target : edge.source;
                            const otherNode = graphNodesMap.get(otherId);
                            const relInfo = RELATION_TYPES[edge.type];

                            return (
                              <div key={edge.id} className="flex items-center justify-between gap-2 bg-secondary/35 hover:bg-secondary/50 rounded-xl p-3 text-xs transition-colors">
                                <div className="flex items-center gap-1.5 min-w-0">
                                  <span className="font-bold text-foreground truncate max-w-[60px]">
                                    {isSource ? "对 " : "被 "}
                                  </span>
                                  <span className="font-bold text-primary truncate max-w-[70px]">
                                    {otherNode?.name || "未知"}
                                  </span>
                                  <span className={`shrink-0 rounded px-1.5 py-0.5 text-[9px] font-bold ${relInfo?.bg} ${relInfo?.color}`}>
                                    {edge.relation}
                                  </span>
                                </div>
                                <button
                                  onClick={() => handleDeleteEdge(edge.id)}
                                  className="p-1 rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition-all"
                                >
                                  <Trash2 size={11} />
                                </button>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })()
            ) : (
              <div className="glass-panel flex h-[350px] flex-col items-center justify-center rounded-[2.5rem] p-6 text-center text-muted-foreground">
                <Focus size={32} className="text-muted-foreground/30 mb-3 animate-pulse" />
                <h4 className="text-sm font-bold text-foreground">关系探索</h4>
                <p className="text-xs mt-2 leading-relaxed max-w-[200px]">
                  点击图谱中的角色节点，可深入查看人设档案、人际交往明细，并进行快速编辑或新增关联。
                </p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Add/Edit Node Modal */}
      {(showAddNode || showEditNode) && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-background/80 p-4 backdrop-blur-xl fade-in" onClick={() => { setShowAddNode(false); setShowEditNode(null); }}>
          <div className="glass-panel w-full max-w-xl overflow-hidden rounded-[2.5rem] shadow-3d" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b border-border/40 px-8 py-6">
              <h2 className="text-2xl font-bold text-foreground">{showAddNode ? "新增角色档案" : "编辑角色档案"}</h2>
              <button onClick={() => { setShowAddNode(false); setShowEditNode(null); }} className="soft-pill flex h-10 w-10 items-center justify-center rounded-full text-muted-foreground hover:text-foreground">
                <X size={18} />
              </button>
            </div>
            
            <div className="max-h-[70dvh] overflow-y-auto p-8 space-y-6">
              <div className="grid grid-cols-2 gap-6">
                <div className="space-y-2">
                  <label className="text-xs font-bold uppercase tracking-wider text-muted-foreground ml-1">角色姓名</label>
                  <input
                    type="text"
                    value={nodeForm.name}
                    onChange={e => setNodeForm({ ...nodeForm, name: e.target.value })}
                    className="h-12 w-full rounded-2xl border border-border/50 bg-background/50 px-4 text-sm font-medium outline-none focus:border-primary/50 focus:ring-4 focus:ring-primary/5 transition-all"
                    placeholder="例如：林惊羽"
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-xs font-bold uppercase tracking-wider text-muted-foreground ml-1">角色地位</label>
                  <select
                    value={nodeForm.role}
                    onChange={e => setNodeForm({ ...nodeForm, role: e.target.value as any })}
                    className="h-12 w-full rounded-2xl border border-border/50 bg-background/50 px-4 text-sm font-medium outline-none focus:border-primary/50 transition-all appearance-none cursor-pointer"
                  >
                    {Object.entries(ROLE_INFO).map(([val, info]) => (
                      <option key={val} value={val}>{info.label}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="space-y-2">
                <label className="text-xs font-bold uppercase tracking-wider text-muted-foreground ml-1">所属阵营 / 团体</label>
                <input
                  type="text"
                  value={nodeForm.group}
                  onChange={e => setNodeForm({ ...nodeForm, group: e.target.value })}
                  className="h-12 w-full rounded-2xl border border-border/50 bg-background/50 px-4 text-sm font-medium outline-none focus:border-primary/50 transition-all"
                  placeholder="例如：青云门、草庙村"
                />
              </div>

              <div className="space-y-2">
                <label className="text-xs font-bold uppercase tracking-wider text-muted-foreground ml-1">人设描述</label>
                <textarea
                  value={nodeForm.description}
                  onChange={e => setNodeForm({ ...nodeForm, description: e.target.value })}
                  rows={4}
                  className="w-full resize-none rounded-2xl border border-border/50 bg-background/50 p-4 text-sm font-medium leading-relaxed outline-none focus:border-primary/50 transition-all"
                  placeholder="描写角色的性格特征、外貌、核心追求等..."
                />
              </div>
            </div>

            <div className="flex gap-3 border-t border-border/40 bg-muted/20 px-8 py-6">
              <button 
                onClick={() => { setShowAddNode(false); setShowEditNode(null); }}
                className="soft-pill flex-1 h-12 rounded-2xl font-bold text-foreground"
              >
                取消
              </button>
              <button 
                onClick={showAddNode ? handleAddNode : () => handleUpdateNode(showEditNode!)}
                disabled={!nodeForm.name}
                className="flex-1 h-12 rounded-2xl bg-primary font-bold text-primary-foreground shadow-lg shadow-primary/20 disabled:opacity-50 transition-all"
              >
                {showAddNode ? "确认创建" : "保存修改"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Add Edge Modal */}
      {showAddEdge && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-background/80 p-4 backdrop-blur-xl fade-in" onClick={() => setShowAddEdge(false)}>
          <div className="glass-panel w-full max-w-md overflow-hidden rounded-[2.5rem] shadow-3d" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b border-border/40 px-8 py-6">
              <h2 className="text-2xl font-bold text-foreground">建立关系纽带</h2>
              <button onClick={() => setShowAddEdge(false)} className="soft-pill flex h-10 w-10 items-center justify-center rounded-full text-muted-foreground hover:text-foreground">
                <X size={18} />
              </button>
            </div>

            <div className="p-8 space-y-6">
               <div className="space-y-2">
                 <label className="text-xs font-bold uppercase tracking-wider text-muted-foreground ml-1">源角色</label>
                 <select
                   value={edgeForm.source}
                   onChange={e => setEdgeForm({ ...edgeForm, source: e.target.value })}
                   className="h-12 w-full rounded-2xl border border-border/50 bg-background/50 px-4 text-sm font-medium outline-none focus:border-primary/50 appearance-none cursor-pointer"
                 >
                   <option value="">选择角色...</option>
                   {data.nodes.map(node => (
                     <option key={node.id} value={node.id} disabled={node.id === edgeForm.target}>{node.name}</option>
                   ))}
                 </select>
               </div>

               <div className="flex justify-center py-2">
                 <div className="h-10 w-10 flex items-center justify-center rounded-full bg-secondary text-primary shadow-inner rotate-90">
                    <ArrowRightLeft size={18} />
                 </div>
               </div>

               <div className="space-y-2">
                 <label className="text-xs font-bold uppercase tracking-wider text-muted-foreground ml-1">目标角色</label>
                 <select
                   value={edgeForm.target}
                   onChange={e => setEdgeForm({ ...edgeForm, target: e.target.value })}
                   className="h-12 w-full rounded-2xl border border-border/50 bg-background/50 px-4 text-sm font-medium outline-none focus:border-primary/50 appearance-none cursor-pointer"
                 >
                   <option value="">选择角色...</option>
                   {data.nodes.map(node => (
                     <option key={node.id} value={node.id} disabled={node.id === edgeForm.source}>{node.name}</option>
                   ))}
                 </select>
               </div>

               <div className="grid grid-cols-2 gap-4 pt-2">
                 <div className="space-y-2">
                   <label className="text-xs font-bold uppercase tracking-wider text-muted-foreground ml-1">关系描述</label>
                   <input
                     type="text"
                     value={edgeForm.relation}
                     onChange={e => setEdgeForm({ ...edgeForm, relation: e.target.value })}
                     className="h-12 w-full rounded-2xl border border-border/50 bg-background/50 px-4 text-sm font-medium outline-none focus:border-primary/50"
                     placeholder="例如：生死之交"
                   />
                 </div>
                 <div className="space-y-2">
                   <label className="text-xs font-bold uppercase tracking-wider text-muted-foreground ml-1">关系性质</label>
                   <select
                     value={edgeForm.type}
                     onChange={e => setEdgeForm({ ...edgeForm, type: e.target.value as any })}
                     className="h-12 w-full rounded-2xl border border-border/50 bg-background/50 px-4 text-sm font-medium outline-none focus:border-primary/50 appearance-none cursor-pointer"
                   >
                     {Object.entries(RELATION_TYPES).map(([val, info]) => (
                       <option key={val} value={val}>{info.label}</option>
                     ))}
                   </select>
                 </div>
               </div>
            </div>

            <div className="flex gap-3 border-t border-border/40 bg-muted/20 px-8 py-6">
              <button 
                onClick={() => setShowAddEdge(false)}
                className="soft-pill flex-1 h-12 rounded-2xl font-bold text-foreground"
              >
                取消
              </button>
              <button 
                onClick={handleAddEdge}
                disabled={!edgeForm.source || !edgeForm.target || !edgeForm.relation}
                className="flex-1 h-12 rounded-2xl bg-primary font-bold text-primary-foreground shadow-lg shadow-primary/20 disabled:opacity-50 transition-all"
              >
                建立连接
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
