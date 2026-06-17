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
  Globe, 
  FolderPlus,
  BookOpen,
  Map,
  History,
  Zap,
  Info
} from "lucide-react";

interface WorldSetting {
  id: string;
  key: string;
  value: string;
  notes: string;
}

interface WorldCategory {
  id: string;
  name: string;
  description: string;
  settings: WorldSetting[];
}

interface WorldSettingsData {
  categories: WorldCategory[];
}

interface Nav {
  toBookSettings: (id: string) => void;
}

export function WorldSettingsPage({ bookId, nav, theme: _theme, t: _t }: {
  bookId: string;
  nav: Nav;
  theme: Theme;
  t: TFunction;
}) {
  const [data, setData] = useState<WorldSettingsData>({ categories: [] });
  const [loading, setLoading] = useState(true);
  const [showAddCategory, setShowAddCategory] = useState(false);
  const [showAddSetting, setShowAddSetting] = useState<string | null>(null);
  const [newCategory, setNewCategory] = useState({ name: "", description: "" });
  const [newSetting, setNewSetting] = useState({ key: "", value: "", notes: "" });
  const [editingSetting, setEditingSetting] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [editNotes, setEditNotes] = useState("");

  const fetchData = useCallback(async () => {
    try {
      setLoading(true);
      const result = await fetchJson<WorldSettingsData>(`/books/${bookId}/world-settings`);
      setData(result);
    } catch (error) {
      console.error("Failed to fetch world settings:", error);
      setData({ categories: [] });
    } finally {
      setLoading(false);
    }
  }, [bookId]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleAddCategory = async () => {
    if (!newCategory.name) return;
    try {
      const result = await postApi(`/books/${bookId}/world-settings/category`, newCategory);
      setData(result as WorldSettingsData);
      setNewCategory({ name: "", description: "" });
      setShowAddCategory(false);
    } catch (error) {
      console.error("Failed to add category:", error);
    }
  };

  const handleAddSetting = async (categoryId: string) => {
    if (!newSetting.key) return;
    try {
      const result = await postApi(`/books/${bookId}/world-settings/setting`, {
        categoryId,
        ...newSetting,
      });
      setData(result as WorldSettingsData);
      setNewSetting({ key: "", value: "", notes: "" });
      setShowAddSetting(null);
    } catch (error) {
      console.error("Failed to add setting:", error);
    }
  };

  const handleUpdateSetting = async (settingId: string) => {
    try {
      const result = await putApi(`/books/${bookId}/world-settings/setting/${settingId}`, {
        value: editValue,
        notes: editNotes,
      });
      setData(result as WorldSettingsData);
      setEditingSetting(null);
    } catch (error) {
      console.error("Failed to update setting:", error);
    }
  };

  const handleDeleteSetting = async (settingId: string) => {
    try {
      const result = await deleteApi(`/books/${bookId}/world-settings/setting/${settingId}`);
      setData(result as WorldSettingsData);
    } catch (error) {
      console.error("Failed to delete setting:", error);
    }
  };

  const startEditing = (setting: WorldSetting) => {
    setEditingSetting(setting.id);
    setEditValue(setting.value);
    setEditNotes(setting.notes);
  };

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center py-32 space-y-4">
        <div className="w-10 h-10 border-3 border-primary/20 border-t-primary rounded-full animate-spin" />
        <span className="text-sm font-medium text-muted-foreground animate-pulse">正在构建世界基石...</span>
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
        <span className="text-foreground">世界观设定</span>
      </nav>

      {/* Hero Section */}
      <section className="glass-panel relative overflow-hidden rounded-[2.5rem] p-6 sm:p-10 shadow-3d">
        <div className="relative z-10 flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
          <div className="space-y-4">
            <div className="flex items-center gap-2.5 text-sm font-bold text-primary">
              <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/15 shadow-inner">
                <Globe size={16} />
              </div>
              <span>WORLD BUILDING</span>
            </div>
            <h1 className="text-4xl font-serif font-bold tracking-tight text-foreground sm:text-5xl">
              世界观设定
            </h1>
            <p className="max-w-2xl text-base leading-relaxed text-muted-foreground">
              构建宏大而严谨的故事背景。从地理风貌到文明历史，从力量体系到社会法则，在这里记录下你的奇思妙想，确保故事的连贯性与深度。
            </p>
          </div>
          <button
            onClick={() => setShowAddCategory(true)}
            className="inline-flex h-12 shrink-0 items-center justify-center gap-2 rounded-2xl bg-primary px-6 text-sm font-bold text-primary-foreground shadow-lg shadow-primary/20 transition-all hover:scale-[1.02] active:scale-[0.98]"
          >
            <FolderPlus size={18} />
            创建分类
          </button>
        </div>
        
        {/* Decor */}
        <div className="absolute -right-16 -bottom-16 h-64 w-64 rounded-full bg-primary/5 blur-3xl opacity-60" />
      </section>

      {/* Categories */}
      {data.categories.length === 0 ? (
        <div className="paper-sheet flex flex-col items-center justify-center rounded-[3rem] py-24 text-center">
          <div className="relative mb-6 h-20 w-20">
             <Globe size={80} className="text-muted/30" />
             <Plus size={24} className="absolute -right-2 -top-2 text-primary animate-bounce" />
          </div>
          <h3 className="text-xl font-bold text-foreground">荒芜之地</h3>
          <p className="mt-2 max-w-xs text-sm text-muted-foreground leading-relaxed">
            这个世界目前还是一片空白。点击“创建分类”开始你的创世之旅。
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-8">
          {data.categories.map((category) => (
            <div
              key={category.id}
              className="paper-sheet group overflow-hidden rounded-[2.5rem] transition-all hover:shadow-3d"
            >
              {/* Category Header */}
              <div className="flex flex-col gap-4 border-b border-border/40 bg-muted/10 p-6 sm:flex-row sm:items-center sm:justify-between sm:px-8">
                <div className="space-y-1">
                  <h3 className="text-2xl font-serif font-bold text-foreground flex items-center gap-2">
                    {category.name === "地理环境" ? <Map size={20} className="text-primary" /> : 
                     category.name === "历史背景" ? <History size={20} className="text-primary" /> :
                     category.name === "力量体系" ? <Zap size={20} className="text-primary" /> :
                     <BookOpen size={20} className="text-primary" />}
                    {category.name}
                  </h3>
                  {category.description && (
                    <p className="text-sm text-muted-foreground/80">{category.description}</p>
                  )}
                </div>
                <button
                  onClick={() => setShowAddSetting(category.id)}
                  className="soft-pill inline-flex h-10 items-center gap-2 rounded-full px-4 text-xs font-bold text-foreground transition-all hover:border-primary/40 active:scale-95"
                >
                  <Plus size={14} className="text-primary" />
                  新增条目
                </button>
              </div>

              {/* Settings List */}
              <div className="divide-y divide-border/30">
                {category.settings.length === 0 ? (
                  <div className="p-12 text-center text-sm text-muted-foreground/60 italic">
                    该分类下暂无具体设定，快去填充细节吧。
                  </div>
                ) : (
                  category.settings.map((setting) => (
                    <div key={setting.id} className="p-6 sm:px-8 transition-colors hover:bg-muted/5">
                      {editingSetting === setting.id ? (
                        // Edit mode
                        <div className="space-y-4 animate-in fade-in slide-in-from-top-2 duration-200">
                          <div className="flex items-center gap-2 text-sm font-bold text-primary">
                             <Edit2 size={12} />
                             正在编辑：{setting.key}
                          </div>
                          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                            <div className="space-y-1.5">
                               <label className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/70 ml-1">设定值</label>
                               <input
                                 type="text"
                                 autoFocus
                                 value={editValue}
                                 onChange={(e) => setEditValue(e.target.value)}
                                 className="h-11 w-full rounded-xl border border-border/50 bg-background/60 px-4 text-sm font-medium outline-none focus:border-primary/50 focus:ring-4 focus:ring-primary/5"
                                 placeholder="具体的设定内容..."
                               />
                            </div>
                            <div className="space-y-1.5">
                               <label className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/70 ml-1">补充说明 (可选)</label>
                               <input
                                 type="text"
                                 value={editNotes}
                                 onChange={(e) => setEditNotes(e.target.value)}
                                 className="h-11 w-full rounded-xl border border-border/50 bg-background/60 px-4 text-sm font-medium outline-none focus:border-primary/50 focus:ring-4 focus:ring-primary/5"
                                 placeholder="更多细节或备注..."
                               />
                            </div>
                          </div>
                          <div className="flex justify-end gap-2 pt-2">
                            <button
                              onClick={() => setEditingSetting(null)}
                              className="soft-pill flex h-10 px-4 items-center justify-center rounded-xl text-sm font-bold text-muted-foreground"
                            >
                              取消
                            </button>
                            <button
                              onClick={() => handleUpdateSetting(setting.id)}
                              className="flex h-10 px-6 items-center justify-center rounded-xl bg-primary text-sm font-bold text-primary-foreground shadow-lg shadow-primary/20"
                            >
                              <Check size={16} className="mr-1.5" />
                              完成
                            </button>
                          </div>
                        </div>
                      ) : (
                        // View mode
                        <div className="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
                          <div className="min-w-0 flex-1 space-y-2">
                            <div className="flex flex-wrap items-baseline gap-2">
                              <span className="text-sm font-bold tracking-tight text-foreground/70 uppercase">
                                {setting.key}
                              </span>
                              <div className="h-1.5 w-1.5 rounded-full bg-border/60" />
                              <span className="text-base font-medium text-foreground leading-relaxed">
                                {setting.value || <span className="text-muted-foreground/40 italic">暂无具体设定</span>}
                              </span>
                            </div>
                            {setting.notes && (
                              <div className="flex items-start gap-2 rounded-2xl bg-secondary/30 p-3">
                                <Info size={14} className="mt-0.5 shrink-0 text-primary/60" />
                                <p className="text-xs leading-relaxed text-muted-foreground">
                                  {setting.notes}
                                </p>
                              </div>
                            )}
                          </div>
                          <div className="flex shrink-0 items-center gap-2 sm:self-start">
                            <button
                              onClick={() => startEditing(setting)}
                              className="flex h-9 w-9 items-center justify-center rounded-xl bg-secondary/80 text-muted-foreground transition-all hover:bg-secondary hover:text-foreground hover:scale-105"
                              title="编辑"
                            >
                              <Edit2 size={14} />
                            </button>
                            <button
                              onClick={() => handleDeleteSetting(setting.id)}
                              className="flex h-9 w-9 items-center justify-center rounded-xl border border-destructive/20 bg-destructive/5 text-destructive transition-all hover:bg-destructive/10 hover:scale-105"
                              title="删除"
                            >
                              <Trash2 size={14} />
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  ))
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Add Category Modal */}
      {showAddCategory && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-background/80 p-4 backdrop-blur-xl fade-in"
          onClick={() => setShowAddCategory(false)}
        >
          <div className="glass-panel w-full max-w-md overflow-hidden rounded-[2.5rem] shadow-3d" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b border-border/40 px-8 py-6">
              <h2 className="text-2xl font-bold text-foreground">创建设定分类</h2>
              <button onClick={() => setShowAddCategory(false)} className="soft-pill flex h-10 w-10 items-center justify-center rounded-full text-muted-foreground">
                <X size={18} />
              </button>
            </div>
            
            <div className="p-8 space-y-6">
              <div className="space-y-2">
                <label className="text-xs font-bold uppercase tracking-widest text-muted-foreground ml-1">分类名称</label>
                <input
                  type="text"
                  autoFocus
                  value={newCategory.name}
                  onChange={(e) => setNewCategory({ ...newCategory, name: e.target.value })}
                  placeholder="例如：力量等级、都城市貌、远古传说"
                  className="h-12 w-full rounded-2xl border border-border/50 bg-background/50 px-4 text-sm font-medium outline-none focus:border-primary/50 focus:ring-4 focus:ring-primary/5 transition-all"
                />
              </div>
              <div className="space-y-2">
                <label className="text-xs font-bold uppercase tracking-widest text-muted-foreground ml-1">分类描述</label>
                <textarea
                  value={newCategory.description}
                  onChange={(e) => setNewCategory({ ...newCategory, description: e.target.value })}
                  rows={3}
                  className="w-full resize-none rounded-2xl border border-border/50 bg-background/50 p-4 text-sm font-medium leading-relaxed outline-none focus:border-primary/50 transition-all"
                  placeholder="简述该分类主要包含哪些方面的设定..."
                />
              </div>
            </div>
            
            <div className="flex gap-3 border-t border-border/40 bg-muted/20 px-8 py-6">
              <button
                onClick={() => setShowAddCategory(false)}
                className="soft-pill flex-1 h-12 rounded-2xl font-bold text-foreground"
              >
                取消
              </button>
              <button
                onClick={handleAddCategory}
                disabled={!newCategory.name}
                className="flex-1 h-12 rounded-2xl bg-primary font-bold text-primary-foreground shadow-lg shadow-primary/20 disabled:opacity-50 transition-all"
              >
                确认创建
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Add Setting Modal */}
      {showAddSetting && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-background/80 p-4 backdrop-blur-xl fade-in"
          onClick={() => setShowAddSetting(null)}
        >
          <div className="glass-panel w-full max-w-md overflow-hidden rounded-[2.5rem] shadow-3d" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b border-border/40 px-8 py-6">
              <h2 className="text-2xl font-bold text-foreground">新增设定条目</h2>
              <button onClick={() => setShowAddSetting(null)} className="soft-pill flex h-10 w-10 items-center justify-center rounded-full text-muted-foreground">
                <X size={18} />
              </button>
            </div>

            <div className="p-8 space-y-6">
              <div className="space-y-2">
                <label className="text-xs font-bold uppercase tracking-widest text-muted-foreground ml-1">条目名称</label>
                <input
                  type="text"
                  autoFocus
                  value={newSetting.key}
                  onChange={(e) => setNewSetting({ ...newSetting, key: e.target.value })}
                  placeholder="例如：筑基期、长安城、太古契约"
                  className="h-12 w-full rounded-2xl border border-border/50 bg-background/50 px-4 text-sm font-medium outline-none focus:border-primary/50 focus:ring-4 focus:ring-primary/5 transition-all"
                />
              </div>
              <div className="space-y-2">
                <label className="text-xs font-bold uppercase tracking-widest text-muted-foreground ml-1">设定值</label>
                <input
                  type="text"
                  value={newSetting.value}
                  onChange={(e) => setNewSetting({ ...newSetting, value: e.target.value })}
                  className="h-12 w-full rounded-2xl border border-border/50 bg-background/50 px-4 text-sm font-medium outline-none focus:border-primary/50 transition-all"
                  placeholder="具体的设定内容..."
                />
              </div>
              <div className="space-y-2">
                <label className="text-xs font-bold uppercase tracking-widest text-muted-foreground ml-1">备注说明</label>
                <textarea
                  value={newSetting.notes}
                  onChange={(e) => setNewSetting({ ...newSetting, notes: e.target.value })}
                  rows={2}
                  className="w-full resize-none rounded-2xl border border-border/50 bg-background/50 p-4 text-sm font-medium leading-relaxed outline-none focus:border-primary/50 transition-all"
                  placeholder="更多细节补充..."
                />
              </div>
            </div>

            <div className="flex gap-3 border-t border-border/40 bg-muted/20 px-8 py-6">
              <button
                onClick={() => setShowAddSetting(null)}
                className="soft-pill flex-1 h-12 rounded-2xl font-bold text-foreground"
              >
                取消
              </button>
              <button
                onClick={() => handleAddSetting(showAddSetting)}
                disabled={!newSetting.key}
                className="flex-1 h-12 rounded-2xl bg-primary font-bold text-primary-foreground shadow-lg shadow-primary/20 disabled:opacity-50 transition-all"
              >
                确认添加
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
