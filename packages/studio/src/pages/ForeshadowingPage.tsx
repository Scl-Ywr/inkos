import { useState, useEffect, useCallback } from "react";
import { useApi, fetchJson, postApi, deleteApi } from "../hooks/use-api";
import type { Theme } from "../hooks/use-theme";
import type { TFunction } from "../hooks/use-i18n";
import { 
  ChevronLeft, 
  Plus, 
  Trash2, 
  RefreshCw, 
  Eye, 
  EyeOff, 
  AlertCircle, 
  CheckCircle, 
  Circle,
  Sparkles,
  X,
  Target
} from "lucide-react";

interface ForeshadowItem {
  id: string;
  type: "planted" | "resolved" | "clue";
  content: string;
  plantedChapter: number;
  resolvedChapter: number | null;
  strength: "strong" | "medium" | "weak";
  importance: "high" | "medium" | "low";
}

interface ForeshadowData {
  items: ForeshadowItem[];
  summary?: string;
}

interface Nav {
  toBookSettings: (id: string) => void;
}

const TYPE_LABELS: Record<string, { label: string; icon: any; color: string; bg: string }> = {
  planted: { label: "已埋设", icon: Eye, color: "text-amber-500", bg: "bg-amber-500/10" },
  resolved: { label: "已回收", icon: CheckCircle, color: "text-emerald-500", bg: "bg-emerald-500/10" },
  clue: { label: "线索", icon: Circle, color: "text-blue-500", bg: "bg-blue-500/10" },
};

const STRENGTH_LABELS: Record<string, string> = {
  strong: "强",
  medium: "中",
  weak: "弱",
};

const IMPORTANCE_LABELS: Record<string, string> = {
  high: "高",
  medium: "中",
  low: "低",
};

export function ForeshadowingPage({ bookId, nav, theme: _theme, t: _t }: {
  bookId: string;
  nav: Nav;
  theme: Theme;
  t: TFunction;
}) {
  const [data, setData] = useState<ForeshadowData>({ items: [] });
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [newItem, setNewItem] = useState({ content: "", plantedChapter: 0, importance: "medium" });
  const [filterType, setFilterType] = useState<string | null>(null);
  const [filterImportance, setFilterImportance] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    try {
      setLoading(true);
      const result = await fetchJson<ForeshadowData>(`/books/${bookId}/foreshadowing`);
      setData(result);
    } catch (error) {
      console.error("Failed to fetch foreshadowing:", error);
      setData({ items: [] });
    } finally {
      setLoading(false);
    }
  }, [bookId]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleScan = async () => {
    setScanning(true);
    try {
      const result = await postApi(`/books/${bookId}/foreshadowing/scan`);
      setData(result as ForeshadowData);
    } catch (error) {
      console.error("Failed to scan foreshadowing:", error);
    } finally {
      setScanning(false);
    }
  };

  const handleAdd = async () => {
    if (!newItem.content) return;
    try {
      const result = await postApi(`/books/${bookId}/foreshadowing`, {
        type: "planted",
        content: newItem.content,
        plantedChapter: newItem.plantedChapter,
        importance: newItem.importance,
      });
      setData(result as ForeshadowData);
      setNewItem({ content: "", plantedChapter: 0, importance: "medium" });
      setShowAdd(false);
    } catch (error) {
      console.error("Failed to add foreshadowing:", error);
    }
  };

  const handleDelete = async (itemId: string) => {
    try {
      const result = await deleteApi(`/books/${bookId}/foreshadowing/${itemId}`);
      setData(result as ForeshadowData);
    } catch (error) {
      console.error("Failed to delete foreshadowing:", error);
    }
  };

  const filteredItems = data.items.filter((item) => {
    if (filterType && item.type !== filterType) return false;
    if (filterImportance && item.importance !== filterImportance) return false;
    return true;
  });

  const stats = {
    total: data.items.length,
    planted: data.items.filter((i) => i.type === "planted").length,
    resolved: data.items.filter((i) => i.type === "resolved").length,
    clues: data.items.filter((i) => i.type === "clue").length,
  };

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center py-32 space-y-4">
        <div className="w-10 h-10 border-3 border-primary/20 border-t-primary rounded-full animate-spin" />
        <span className="text-sm font-medium text-muted-foreground animate-pulse">正在编织草蛇灰线...</span>
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
        <span className="text-foreground">伏笔追踪</span>
      </nav>

      {/* Hero Section */}
      <section className="glass-panel relative overflow-hidden rounded-[2.5rem] p-6 sm:p-10 shadow-3d">
        <div className="relative z-10 flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
          <div className="space-y-4">
            <div className="flex items-center gap-2.5 text-sm font-bold text-primary">
              <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/15 shadow-inner">
                <Target size={16} />
              </div>
              <span>FORESHADOWING</span>
            </div>
            <h1 className="text-4xl font-serif font-bold tracking-tight text-foreground sm:text-5xl">
              伏笔追踪
            </h1>
            <p className="max-w-2xl text-base leading-relaxed text-muted-foreground">
              草蛇灰线，伏脉千里。记录下每一个微小的线索与伏笔，确保它们在最恰当的时机被回收，为读者带来意料之外、情理之中的震撼。
            </p>
          </div>
          
          <div className="flex flex-wrap gap-3">
             <button
               onClick={handleScan}
               disabled={scanning}
               className="inline-flex h-12 items-center justify-center gap-2 rounded-2xl bg-primary px-6 text-sm font-bold text-primary-foreground shadow-lg shadow-primary/20 transition-all hover:scale-[1.02] active:scale-[0.98] disabled:opacity-50"
             >
               <Sparkles size={18} className={scanning ? "animate-spin" : ""} />
               {scanning ? "AI 深度分析中..." : "AI 智能扫描"}
             </button>
             <button
               onClick={() => setShowAdd(true)}
               className="soft-pill inline-flex h-12 items-center justify-center gap-2 rounded-2xl px-6 text-sm font-bold text-foreground transition-all hover:border-primary/40"
             >
               <Plus size={18} />
               手动记录
             </button>
          </div>
        </div>
        
        {/* Decor */}
        <div className="absolute -left-16 -bottom-16 h-64 w-64 rounded-full bg-accent/5 blur-3xl opacity-60" />
      </section>

      {/* Stats Cards */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4 sm:gap-6">
        {[
          { label: "线索总数", value: stats.total, color: "text-foreground", bg: "bg-muted/50" },
          { label: "已埋伏笔", value: stats.planted, color: "text-amber-500", bg: "bg-amber-500/10" },
          { label: "已收伏笔", value: stats.resolved, color: "text-emerald-500", bg: "bg-emerald-500/10" },
          { label: "关键线索", value: stats.clues, color: "text-blue-500", bg: "bg-blue-500/10" }
        ].map((stat, i) => (
          <div key={i} className={`paper-sheet flex flex-col items-center justify-center rounded-3xl p-5 text-center transition-all hover:-translate-y-1`}>
             <div className={`text-3xl font-serif font-bold ${stat.color}`}>{stat.value}</div>
             <div className="mt-1 text-[11px] font-bold uppercase tracking-widest text-muted-foreground/60">{stat.label}</div>
          </div>
        ))}
      </div>

      {/* Main Content Area */}
      <div className="grid grid-cols-1 gap-8 lg:grid-cols-4">
        {/* Sidebar Filters */}
        <aside className="lg:col-span-1 space-y-6">
           <div className="space-y-4">
              <h3 className="text-sm font-bold uppercase tracking-widest text-muted-foreground ml-1">状态筛选</h3>
              <div className="flex flex-col gap-2">
                 <button
                   onClick={() => setFilterType(null)}
                   className={`flex h-10 items-center justify-between rounded-xl px-4 text-sm font-medium transition-all ${
                     !filterType ? "bg-primary/10 text-primary shadow-sm" : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"
                   }`}
                 >
                   全部记录
                   <span className="text-xs opacity-60">{stats.total}</span>
                 </button>
                 {Object.entries(TYPE_LABELS).map(([type, info]) => (
                   <button
                     key={type}
                     onClick={() => setFilterType(filterType === type ? null : type)}
                     className={`flex h-10 items-center justify-between rounded-xl px-4 text-sm font-medium transition-all ${
                       filterType === type ? "bg-primary/10 text-primary shadow-sm" : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"
                     }`}
                   >
                     {info.label}
                     <span className="text-xs opacity-60">
                       {type === "planted" ? stats.planted : type === "resolved" ? stats.resolved : stats.clues}
                     </span>
                   </button>
                 ))}
              </div>
           </div>

           <div className="space-y-4 pt-2">
              <h3 className="text-sm font-bold uppercase tracking-widest text-muted-foreground ml-1">重要程度</h3>
              <div className="flex flex-wrap gap-2">
                 {Object.entries(IMPORTANCE_LABELS).map(([importance, label]) => (
                   <button
                     key={importance}
                     onClick={() => setFilterImportance(filterImportance === importance ? null : importance)}
                     className={`soft-pill h-9 rounded-lg px-3 text-xs font-bold transition-all ${
                       filterImportance === importance ? "border-primary bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"
                     }`}
                   >
                     {label}
                   </button>
                 ))}
              </div>
           </div>
        </aside>

        {/* List Content */}
        <div className="lg:col-span-3 space-y-4">
          {filteredItems.length === 0 ? (
            <div className="paper-sheet flex flex-col items-center justify-center rounded-[3rem] py-20 text-center">
               <Eye size={48} className="text-muted/30 mb-4" />
               <h3 className="text-lg font-bold text-foreground">暂无相关伏笔</h3>
               <p className="mt-2 text-sm text-muted-foreground">没有找到匹配当前筛选条件的记录。</p>
            </div>
          ) : (
            filteredItems.map((item) => {
              const typeInfo = TYPE_LABELS[item.type];
              const Icon = typeInfo.icon;

              return (
                <div
                  key={item.id}
                  className="paper-sheet group relative flex flex-col rounded-3xl p-6 transition-all hover:shadow-3d"
                >
                  <div className="flex items-start gap-4">
                    <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl ${typeInfo.bg} ${typeInfo.color}`}>
                      <Icon size={20} />
                    </div>
                    <div className="flex-1 space-y-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className={`rounded-full px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider ${typeInfo.bg} ${typeInfo.color}`}>
                          {typeInfo.label}
                        </span>
                        <div className="flex items-center gap-1.5 rounded-lg bg-secondary/60 px-2 py-0.5 text-[10px] font-bold text-muted-foreground">
                          第 {item.plantedChapter} 章 埋设
                        </div>
                        <span className={`rounded-lg px-2 py-0.5 text-[10px] font-bold ${
                          item.importance === 'high' ? 'bg-red-500/10 text-red-500' :
                          item.importance === 'medium' ? 'bg-amber-500/10 text-amber-500' :
                          'bg-blue-500/10 text-blue-500'
                        }`}>
                          重要性: {IMPORTANCE_LABELS[item.importance]}
                        </span>
                      </div>
                      <p className="text-base font-medium leading-relaxed text-foreground">
                        {item.content}
                      </p>
                      {item.resolvedChapter && (
                        <div className="inline-flex items-center gap-2 rounded-xl bg-emerald-500/5 px-3 py-1.5 text-xs font-bold text-emerald-600 dark:text-emerald-400">
                          <CheckCircle size={14} />
                          已于第 {item.resolvedChapter} 章回收
                        </div>
                      )}
                    </div>
                    <button
                      onClick={() => handleDelete(item.id)}
                      className="opacity-0 group-hover:opacity-100 p-2 rounded-xl text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition-all"
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                </div>
              );
            })
          )}
          
          {data.summary && (
            <div className="glass-panel mt-8 rounded-[2rem] p-6 border-l-4 border-l-primary">
               <h3 className="flex items-center gap-2 text-sm font-bold text-foreground mb-3">
                 <Sparkles size={16} className="text-primary" />
                 AI 分析总结
               </h3>
               <p className="text-sm leading-relaxed text-muted-foreground italic">
                 {data.summary}
               </p>
            </div>
          )}
        </div>
      </div>

      {/* Add Modal */}
      {showAdd && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-background/80 p-4 backdrop-blur-xl fade-in"
          onClick={() => setShowAdd(false)}
        >
          <div className="glass-panel w-full max-w-md overflow-hidden rounded-[2.5rem] shadow-3d" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b border-border/40 px-8 py-6">
              <h2 className="text-2xl font-bold text-foreground">记录新伏笔</h2>
              <button onClick={() => setShowAdd(false)} className="soft-pill flex h-10 w-10 items-center justify-center rounded-full text-muted-foreground">
                <X size={18} />
              </button>
            </div>

            <div className="p-8 space-y-6">
              <div className="space-y-2">
                <label className="text-xs font-bold uppercase tracking-widest text-muted-foreground ml-1">伏笔内容</label>
                <textarea
                  value={newItem.content}
                  onChange={(e) => setNewItem({ ...newItem, content: e.target.value })}
                  rows={4}
                  autoFocus
                  className="w-full resize-none rounded-2xl border border-border/50 bg-background/50 p-4 text-sm font-medium leading-relaxed outline-none focus:border-primary/50 transition-all"
                  placeholder="描写你埋下的伏笔或提供的线索..."
                />
              </div>
              
              <div className="grid grid-cols-2 gap-6">
                <div className="space-y-2">
                  <label className="text-xs font-bold uppercase tracking-widest text-muted-foreground ml-1">埋设章节</label>
                  <input
                    type="number"
                    value={newItem.plantedChapter || ""}
                    onChange={(e) => setNewItem({ ...newItem, plantedChapter: parseInt(e.target.value, 10) || 0 })}
                    className="h-12 w-full rounded-2xl border border-border/50 bg-background/50 px-4 text-sm font-medium outline-none focus:border-primary/50 transition-all"
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-xs font-bold uppercase tracking-widest text-muted-foreground ml-1">重要程度</label>
                  <select
                    value={newItem.importance}
                    onChange={(e) => setNewItem({ ...newItem, importance: e.target.value })}
                    className="h-12 w-full rounded-2xl border border-border/50 bg-background/50 px-4 text-sm font-medium outline-none focus:border-primary/50 appearance-none cursor-pointer"
                  >
                    {Object.entries(IMPORTANCE_LABELS).map(([value, label]) => (
                      <option key={value} value={value}>{label}</option>
                    ))}
                  </select>
                </div>
              </div>
            </div>

            <div className="flex gap-3 border-t border-border/40 bg-muted/20 px-8 py-6">
              <button
                onClick={() => setShowAdd(false)}
                className="soft-pill flex-1 h-12 rounded-2xl font-bold text-foreground"
              >
                取消
              </button>
              <button
                onClick={handleAdd}
                disabled={!newItem.content}
                className="flex-1 h-12 rounded-2xl bg-primary font-bold text-primary-foreground shadow-lg shadow-primary/20 disabled:opacity-50 transition-all"
              >
                记录伏笔
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
