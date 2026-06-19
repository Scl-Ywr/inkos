import { useState, useEffect, useCallback, useMemo } from "react";
import { useApi, fetchJson, postApi, deleteApi } from "../hooks/use-api";
import { appAlert } from "../lib/app-dialog";
import type { Theme } from "../hooks/use-theme";
import type { TFunction } from "../hooks/use-i18n";
import { StudioSelect } from "../components/StudioSelect";
import { PageHero } from "../components/PageHero";
import { StatCard } from "../components/StatCard";
import { FormModal } from "../components/FormModal";
import {
  ChevronLeft,
  Plus,
  Trash2,
  RefreshCw,
  Eye,
  EyeOff,
  X,
  AlertCircle,
  CheckCircle,
  Circle,
  Sparkles,
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
  const [showScanModal, setShowScanModal] = useState(false);
  const [scanRange, setScanRange] = useState({ start: 1, end: 9999 });

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
      const result = await postApi(`/books/${bookId}/foreshadowing/scan`, {
        chapterRange: { start: scanRange.start, end: scanRange.end }
      });
      setData(result as ForeshadowData);
      setShowScanModal(false);
    } catch (error) {
      await appAlert({ title: "扫描失败", message: `AI 扫描伏笔失败：${error instanceof Error ? error.message : "未知错误"}` });
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
      await appAlert({ title: "操作失败", message: `添加伏笔失败：${error instanceof Error ? error.message : "未知错误"}` });
    }
  };

  const handleDelete = async (itemId: string) => {
    try {
      const result = await deleteApi(`/books/${bookId}/foreshadowing/${itemId}`);
      setData(result as ForeshadowData);
    } catch (error) {
      await appAlert({ title: "操作失败", message: `删除伏笔失败：${error instanceof Error ? error.message : "未知错误"}` });
    }
  };

  const filteredItems = useMemo(() =>
    data.items.filter((item) => {
      if (filterType && item.type !== filterType) return false;
      if (filterImportance && item.importance !== filterImportance) return false;
      return true;
    }),
    [data.items, filterType, filterImportance],
  );

  const stats = useMemo(() => ({
    total: data.items.length,
    planted: data.items.filter((i) => i.type === "planted").length,
    resolved: data.items.filter((i) => i.type === "resolved").length,
    clues: data.items.filter((i) => i.type === "clue").length,
  }), [data.items]);

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
      <PageHero
        label="FORESHADOWING"
        title="伏笔追踪"
        description="草蛇灰线，伏脉千里。记录下每一个微小的线索与伏笔，确保它们在最恰当的时机被回收，为读者带来意料之外、情理之中的震撼。"
      >
        <button
          onClick={() => setShowScanModal(true)}
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
      </PageHero>

      {/* Stats Cards */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4 sm:gap-6">
        <StatCard value={stats.total} label="线索总数" valueClassName="text-foreground" />
        <StatCard value={stats.planted} label="已埋伏笔" valueClassName="text-amber-500" />
        <StatCard value={stats.resolved} label="已收伏笔" valueClassName="text-emerald-500" />
        <StatCard value={stats.clues} label="关键线索" valueClassName="text-blue-500" />
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
                        {item.strength && (
                          <span className={`rounded-lg px-2 py-0.5 text-[10px] font-bold ${
                            item.strength === 'strong' ? 'bg-emerald-500/10 text-emerald-600' :
                            item.strength === 'medium' ? 'bg-amber-500/10 text-amber-600' :
                            'bg-gray-500/10 text-gray-500'
                          }`}>
                            强度: {item.strength === 'strong' ? '强' : item.strength === 'medium' ? '中' : '弱'}
                          </span>
                        )}
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
        <FormModal
          title="记录新伏笔"
          onClose={() => setShowAdd(false)}
          footer={
            <>
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
            </>
          }
        >
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
              <StudioSelect
                value={newItem.importance}
                onValueChange={(v) => setNewItem({ ...newItem, importance: v })}
                options={Object.entries(IMPORTANCE_LABELS).map(([value, label]) => ({ value, label }))}
              />
            </div>
          </div>
        </FormModal>
      )}

      {/* 扫描范围选择模态框 */}
      {showScanModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={() => setShowScanModal(false)} />
          <div className="relative w-full max-w-md rounded-[2rem] bg-background p-8 shadow-2xl">
            <button
              onClick={() => setShowScanModal(false)}
              className="absolute right-4 top-4 flex h-10 w-10 items-center justify-center rounded-full bg-secondary hover:bg-secondary/80 transition-colors"
            >
              <X size={18} />
            </button>

            <h2 className="text-xl font-bold text-foreground mb-6">选择扫描范围</h2>

            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">
                AI 将分析所选章节范围内的伏笔和线索。不同次扫描的章节会按顺序合并显示。
              </p>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <label className="text-xs font-bold uppercase tracking-widest text-muted-foreground ml-1">起始章节</label>
                  <input
                    type="number"
                    min={1}
                    value={scanRange.start}
                    onChange={(e) => setScanRange({ ...scanRange, start: parseInt(e.target.value, 10) || 1 })}
                    className="h-12 w-full rounded-2xl border border-border/50 bg-background/50 px-4 text-sm font-medium outline-none focus:border-primary/50 transition-all"
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-xs font-bold uppercase tracking-widest text-muted-foreground ml-1">结束章节</label>
                  <input
                    type="number"
                    min={1}
                    value={scanRange.end}
                    onChange={(e) => setScanRange({ ...scanRange, end: parseInt(e.target.value, 10) || 9999 })}
                    className="h-12 w-full rounded-2xl border border-border/50 bg-background/50 px-4 text-sm font-medium outline-none focus:border-primary/50 transition-all"
                  />
                </div>
              </div>

              <div className="flex flex-wrap gap-2">
                <button
                  onClick={() => setScanRange({ start: 1, end: 10 })}
                  className="px-3 py-1.5 rounded-full bg-secondary/50 text-xs font-medium hover:bg-secondary transition-colors"
                >
                  1-10章
                </button>
                <button
                  onClick={() => setScanRange({ start: 11, end: 30 })}
                  className="px-3 py-1.5 rounded-full bg-secondary/50 text-xs font-medium hover:bg-secondary transition-colors"
                >
                  11-30章
                </button>
                <button
                  onClick={() => setScanRange({ start: 31, end: 50 })}
                  className="px-3 py-1.5 rounded-full bg-secondary/50 text-xs font-medium hover:bg-secondary transition-colors"
                >
                  31-50章
                </button>
                <button
                  onClick={() => setScanRange({ start: 1, end: 9999 })}
                  className="px-3 py-1.5 rounded-full bg-secondary/50 text-xs font-medium hover:bg-secondary transition-colors"
                >
                  全部章节
                </button>
              </div>
            </div>

            <div className="flex gap-3 mt-6 pt-6 border-t border-border/40">
              <button
                onClick={() => setShowScanModal(false)}
                className="soft-pill flex-1 h-12 rounded-2xl font-bold text-foreground"
              >
                取消
              </button>
              <button
                onClick={handleScan}
                disabled={scanning}
                className="flex-1 h-12 rounded-2xl bg-primary font-bold text-primary-foreground shadow-lg shadow-primary/20 disabled:opacity-50 transition-all"
              >
                {scanning ? "分析中..." : "开始扫描"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
