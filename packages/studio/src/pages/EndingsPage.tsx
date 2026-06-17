import { useState, useEffect, useCallback } from "react";
import { useApi, fetchJson, postApi, putApi, deleteApi } from "../hooks/use-api";
import type { Theme } from "../hooks/use-theme";
import type { TFunction } from "../hooks/use-i18n";
import { 
  ChevronLeft, 
  Plus, 
  Trash2, 
  Edit2, 
  Check, 
  X, 
  Flag, 
  Star, 
  AlertCircle, 
  Circle,
  Trophy,
  Target
} from "lucide-react";

interface Ending {
  id: string;
  name: string;
  description: string;
  type: "good" | "bad" | "neutral" | "hidden";
  chapters: number[];
  createdAt: string;
}

interface EndingsData {
  endings: Ending[];
  activeEnding: string | null;
}

interface Nav {
  toBookSettings: (id: string) => void;
}

const ENDING_TYPE_INFO: Record<string, { label: string; icon: any; color: string; bg: string }> = {
  good: { label: "结局 A: 归于圆满", icon: Star, color: "text-emerald-500", bg: "bg-emerald-500/10" },
  bad: { label: "结局 B: 抱憾终天", icon: AlertCircle, color: "text-red-500", bg: "bg-red-500/10" },
  neutral: { label: "结局 C: 随风而逝", icon: Circle, color: "text-gray-500", bg: "bg-gray-500/10" },
  hidden: { label: "隐藏结局: 命运之锁", icon: Trophy, color: "text-purple-500", bg: "bg-purple-500/10" },
};

export function EndingsPage({ bookId, nav, theme: _theme, t: _t }: {
  bookId: string;
  nav: Nav;
  theme: Theme;
  t: TFunction;
}) {
  const [data, setData] = useState<EndingsData>({ endings: [], activeEnding: null });
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [editingEnding, setEditingEnding] = useState<string | null>(null);
  const [newEnding, setNewEnding] = useState({ 
    name: "", 
    description: "", 
    type: "good" as "good" | "bad" | "neutral" | "hidden"
  });

  const fetchData = useCallback(async () => {
    try {
      setLoading(true);
      const result = await fetchJson<EndingsData>(`/books/${bookId}/endings`);
      setData(result);
    } catch (error) {
      console.error("Failed to fetch endings:", error);
      setData({ endings: [], activeEnding: null });
    } finally {
      setLoading(false);
    }
  }, [bookId]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleAdd = async () => {
    if (!newEnding.name) return;
    try {
      const result = await postApi(`/books/${bookId}/endings`, newEnding);
      setData(result as EndingsData);
      setNewEnding({ name: "", description: "", type: "good" });
      setShowAdd(false);
    } catch (error) {
      console.error("Failed to add ending:", error);
    }
  };

  const handleUpdate = async (id: string, updates: Partial<Ending>) => {
    try {
      const result = await putApi(`/books/${bookId}/endings/${id}`, updates);
      setData(result as EndingsData);
      setEditingEnding(null);
    } catch (error) {
      console.error("Failed to update ending:", error);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      const result = await deleteApi(`/books/${bookId}/endings/${id}`);
      setData(result as EndingsData);
    } catch (error) {
      console.error("Failed to delete ending:", error);
    }
  };

  const handleSetActive = async (id: string) => {
    try {
      const result = await postApi(`/books/${bookId}/endings/${id}/activate`);
      setData(result as EndingsData);
    } catch (error) {
      console.error("Failed to set active ending:", error);
    }
  };

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center py-32 space-y-4">
        <div className="w-10 h-10 border-3 border-primary/20 border-t-primary rounded-full animate-spin" />
        <span className="text-sm font-medium text-muted-foreground animate-pulse">正在预演命运之终...</span>
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
        <span className="text-foreground">结局演练</span>
      </nav>

      {/* Hero Section */}
      <section className="glass-panel relative overflow-hidden rounded-[2.5rem] p-6 sm:p-10 shadow-3d">
        <div className="relative z-10 flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
          <div className="space-y-4">
            <div className="flex items-center gap-2.5 text-sm font-bold text-primary">
              <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/15 shadow-inner">
                <Flag size={16} />
              </div>
              <span>FATE & ENDINGS</span>
            </div>
            <h1 className="text-4xl font-serif font-bold tracking-tight text-foreground sm:text-5xl">
              结局演练
            </h1>
            <p className="max-w-2xl text-base leading-relaxed text-muted-foreground">
              故事不应只有一个终点。在这里设计多种可能的结局，预演不同路径下的命运走向，让每一个抉择都重若千钧。
            </p>
          </div>
          <button
            onClick={() => setShowAdd(true)}
            className="inline-flex h-12 shrink-0 items-center justify-center gap-2 rounded-2xl bg-primary px-6 text-sm font-bold text-primary-foreground shadow-lg shadow-primary/20 transition-all hover:scale-[1.02] active:scale-[0.98]"
          >
            <Plus size={18} />
            新增结局
          </button>
        </div>
        
        {/* Decor */}
        <div className="absolute -right-16 -top-16 h-64 w-64 rounded-full bg-primary/5 blur-3xl opacity-60" />
      </section>

      {/* Endings List */}
      <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
        {data.endings.length === 0 ? (
          <div className="paper-sheet col-span-full flex flex-col items-center justify-center rounded-[3rem] py-24 text-center">
             <div className="relative mb-6 h-20 w-20 flex items-center justify-center rounded-full bg-muted/50 text-muted-foreground">
                <Target size={40} />
             </div>
             <h3 className="text-xl font-bold text-foreground">未定的终章</h3>
             <p className="mt-2 max-w-xs text-sm text-muted-foreground leading-relaxed">
               所有的故事都还在进行中。点击“新增结局”为你的角色勾勒一个可能的归宿。
             </p>
          </div>
        ) : (
          data.endings.map((ending) => {
            const typeInfo = ENDING_TYPE_INFO[ending.type];
            const Icon = typeInfo.icon;
            const isActive = data.activeEnding === ending.id;

            return (
              <div
                key={ending.id}
                className={`paper-sheet relative flex flex-col rounded-[2.5rem] p-7 transition-all hover:-translate-y-1 ${
                  isActive ? "ring-2 ring-primary shadow-3d" : ""
                }`}
              >
                <div className="flex items-start justify-between">
                  <div className={`flex h-12 w-12 items-center justify-center rounded-2xl ${typeInfo.bg} ${typeInfo.color}`}>
                    <Icon size={24} />
                  </div>
                  <div className="flex gap-1">
                     <button
                       onClick={() => handleSetActive(ending.id)}
                       className={`flex h-9 px-3 items-center gap-1.5 rounded-xl text-[11px] font-bold transition-all ${
                         isActive 
                           ? "bg-primary text-primary-foreground" 
                           : "bg-secondary text-muted-foreground hover:bg-secondary hover:text-foreground"
                       }`}
                     >
                       {isActive ? "当前演练中" : "设为目标"}
                     </button>
                  </div>
                </div>

                <div className="mt-6 space-y-3">
                   <div className="flex items-center justify-between">
                     <h3 className="text-xl font-bold text-foreground line-clamp-1">{ending.name}</h3>
                   </div>
                   <div className={`text-[10px] font-bold uppercase tracking-widest ${typeInfo.color}`}>
                     {typeInfo.label}
                   </div>
                   <p className="text-sm leading-relaxed text-muted-foreground line-clamp-4 min-h-[5rem]">
                     {ending.description || "暂无结局描述..."}
                   </p>
                </div>

                <div className="mt-8 flex items-center justify-between border-t border-border/40 pt-5">
                   <div className="flex gap-2">
                      <button
                        onClick={() => {
                          setEditingEnding(ending.id);
                          setNewEnding({ name: ending.name, description: ending.description, type: ending.type });
                        }}
                        className="flex h-8 w-8 items-center justify-center rounded-lg bg-secondary/50 text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors"
                      >
                        <Edit2 size={14} />
                      </button>
                      <button
                        onClick={() => handleDelete(ending.id)}
                        className="flex h-8 w-8 items-center justify-center rounded-lg bg-destructive/10 text-destructive hover:bg-destructive/20 transition-colors"
                      >
                        <Trash2 size={14} />
                      </button>
                   </div>
                   <div className="text-[10px] font-bold text-muted-foreground/60 uppercase">
                     {new Date(ending.createdAt).toLocaleDateString()}
                   </div>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Add/Edit Modal */}
      {(showAdd || editingEnding) && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-background/80 p-4 backdrop-blur-xl fade-in" onClick={() => { setShowAdd(false); setEditingEnding(null); }}>
          <div className="glass-panel w-full max-w-xl overflow-hidden rounded-[2.5rem] shadow-3d" onClick={e => e.stopPropagation()}>
             <div className="flex items-center justify-between border-b border-border/40 px-8 py-6">
                <h2 className="text-2xl font-bold text-foreground">{showAdd ? "规划新的命运" : "修正命运轨迹"}</h2>
                <button onClick={() => { setShowAdd(false); setEditingEnding(null); }} className="soft-pill flex h-10 w-10 items-center justify-center rounded-full text-muted-foreground">
                  <X size={18} />
                </button>
             </div>

             <div className="p-8 space-y-6">
                <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
                   <div className="space-y-2">
                      <label className="text-xs font-bold uppercase tracking-widest text-muted-foreground ml-1">结局名称</label>
                      <input
                        type="text"
                        autoFocus
                        value={newEnding.name}
                        onChange={e => setNewEnding({ ...newEnding, name: e.target.value })}
                        className="h-12 w-full rounded-2xl border border-border/50 bg-background/50 px-4 text-sm font-medium outline-none focus:border-primary/50 focus:ring-4 focus:ring-primary/5 transition-all"
                        placeholder="例如：英雄迟暮"
                      />
                   </div>
                   <div className="space-y-2">
                      <label className="text-xs font-bold uppercase tracking-widest text-muted-foreground ml-1">结局类型</label>
                      <select
                        value={newEnding.type}
                        onChange={e => setNewEnding({ ...newEnding, type: e.target.value as any })}
                        className="h-12 w-full rounded-2xl border border-border/50 bg-background/50 px-4 text-sm font-medium outline-none focus:border-primary/50 appearance-none cursor-pointer"
                      >
                         {Object.entries(ENDING_TYPE_INFO).map(([val, info]) => (
                           <option key={val} value={val}>{info.label.split(": ")[1]}</option>
                         ))}
                      </select>
                   </div>
                </div>

                <div className="space-y-2">
                   <label className="text-xs font-bold uppercase tracking-widest text-muted-foreground ml-1">命运终章描述</label>
                   <textarea
                     value={newEnding.description}
                     onChange={e => setNewEnding({ ...newEnding, description: e.target.value })}
                     rows={5}
                     className="w-full resize-none rounded-2xl border border-border/50 bg-background/50 p-4 text-sm font-medium leading-relaxed outline-none focus:border-primary/50 transition-all"
                     placeholder="描写结局的场景、氛围以及各个人物的最终归宿..."
                   />
                </div>
             </div>

             <div className="flex gap-3 border-t border-border/40 bg-muted/20 px-8 py-6">
                <button
                  onClick={() => { setShowAdd(false); setEditingEnding(null); }}
                  className="soft-pill flex-1 h-12 rounded-2xl font-bold text-foreground"
                >
                  放弃
                </button>
                <button
                  onClick={showAdd ? handleAdd : () => handleUpdate(editingEnding!, newEnding)}
                  disabled={!newEnding.name}
                  className="flex-1 h-12 rounded-2xl bg-primary font-bold text-primary-foreground shadow-lg shadow-primary/20 disabled:opacity-50 transition-all"
                >
                  {showAdd ? "定下命运" : "保存命运"}
                </button>
             </div>
          </div>
        </div>
      )}
    </div>
  );
}
