import { useState, useEffect, useCallback } from "react";
import { Clipboard, X, Plus, Copy, Trash2, Search } from "lucide-react";
import type { Theme } from "../../hooks/use-theme";

interface ClipboardEntry {
  readonly id: string;
  readonly text: string;
  readonly label: string;
  readonly category: string;
  readonly createdAt: string;
}

interface ClipboardPanelProps {
  readonly bookId: string;
  readonly theme: Theme;
  readonly onInsert?: (text: string) => void;
  readonly onClose: () => void;
}

export function ClipboardPanel({ bookId, onInsert, onClose }: ClipboardPanelProps) {
  const [entries, setEntries] = useState<ClipboardEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [newText, setNewText] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [newCategory, setNewCategory] = useState("general");
  const [searchQuery, setSearchQuery] = useState("");
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const fetchEntries = useCallback(async () => {
    try {
      setLoading(true);
      const response = await fetch(`/api/v1/books/${bookId}/clipboard`);
      if (response.ok) {
        const data = await response.json();
        setEntries(data);
      }
    } catch (error) {
      console.error("Failed to fetch clipboard entries:", error);
    } finally {
      setLoading(false);
    }
  }, [bookId]);

  useEffect(() => {
    fetchEntries();
  }, [fetchEntries]);

  const handleAdd = async () => {
    if (!newText.trim()) return;
    try {
      const response = await fetch(`/api/v1/books/${bookId}/clipboard`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: newText, label: newLabel, category: newCategory }),
      });
      if (response.ok) {
        const data = await response.json();
        setEntries(data);
        setNewText("");
        setNewLabel("");
        setNewCategory("general");
      }
    } catch (error) {
      console.error("Failed to add clipboard entry:", error);
    }
  };

  const handleDelete = async (entryId: string) => {
    try {
      const response = await fetch(`/api/v1/books/${bookId}/clipboard/${entryId}`, {
        method: "DELETE",
      });
      if (response.ok) {
        const data = await response.json();
        setEntries(data);
      }
    } catch (error) {
      console.error("Failed to delete clipboard entry:", error);
    }
  };

  const handleCopy = async (entry: ClipboardEntry) => {
    try {
      await navigator.clipboard.writeText(entry.text);
      setCopiedId(entry.id);
      setTimeout(() => setCopiedId(null), 2000);
    } catch (error) {
      console.error("Failed to copy to clipboard:", error);
    }
  };

  const filteredEntries = entries.filter((entry) => {
    if (!searchQuery) return true;
    const query = searchQuery.toLowerCase();
    return (
      entry.text.toLowerCase().includes(query) ||
      entry.label.toLowerCase().includes(query) ||
      entry.category.toLowerCase().includes(query)
    );
  });

  const categories = [...new Set(entries.map((e) => e.category))];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-2xl max-h-[80vh] rounded-2xl border border-border bg-card text-card-foreground shadow-2xl overflow-hidden flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-border">
          <div className="flex items-center gap-2">
            <Clipboard size={20} className="text-primary" />
            <h2 className="text-lg font-bold text-foreground">
              素材剪贴板
            </h2>
            <span className="text-xs px-2 py-0.5 rounded-full bg-muted text-muted-foreground">
              {entries.length}/50
            </span>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-lg hover:bg-black/10 dark:hover:bg-white/10 transition-colors"
          >
            <X size={20} className="text-muted-foreground" />
          </button>
        </div>

        {/* Add New Entry */}
        <div className="p-4 border-b border-border">
          <div className="flex gap-2 mb-2">
            <input
              type="text"
              placeholder="标签（可选）"
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
              className="flex-1 px-3 py-2 text-sm rounded-lg border border-border bg-background text-foreground outline-none focus:ring-2 focus:ring-primary/20"
            />
            <select
              value={newCategory}
              onChange={(e) => setNewCategory(e.target.value)}
              className="px-3 py-2 text-sm rounded-lg border border-border bg-background text-foreground outline-none focus:ring-2 focus:ring-primary/20"
            >
              <option value="general">通用</option>
              <option value="dialogue">对话</option>
              <option value="description">描写</option>
              <option value="plot">剧情</option>
              <option value="character">角色</option>
            </select>
          </div>
          <div className="flex gap-2">
            <textarea
              placeholder="粘贴素材文本..."
              value={newText}
              onChange={(e) => setNewText(e.target.value)}
              rows={2}
              className="flex-1 px-3 py-2 text-sm rounded-lg border border-border bg-background text-foreground outline-none focus:ring-2 focus:ring-primary/20 resize-none"
            />
            <button
              onClick={handleAdd}
              disabled={!newText.trim()}
              className="px-4 py-2 rounded-lg bg-primary text-primary-foreground font-medium text-sm transition-colors disabled:opacity-50 flex items-center justify-center"
            >
              <Plus size={16} />
            </button>
          </div>
        </div>

        {/* Search */}
        <div className="px-4 py-2">
          <div className="relative">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <input
              type="text"
              placeholder="搜索素材..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-10 pr-4 py-2 text-sm rounded-lg border border-border bg-background text-foreground outline-none focus:ring-2 focus:ring-primary/20"
            />
          </div>
          {categories.length > 1 && (
            <div className="flex gap-2 mt-2 flex-wrap">
              <button
                onClick={() => setSearchQuery("")}
                className={`px-2 py-1 text-xs rounded-full transition-colors ${
                  !searchQuery ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"
                }`}
              >
                全部
              </button>
              {categories.map((cat) => (
                <button
                  key={cat}
                  onClick={() => setSearchQuery(cat)}
                  className={`px-2 py-1 text-xs rounded-full transition-colors ${
                    searchQuery === cat ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"
                  }`}
                >
                  {cat}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Entries List */}
        <div className="flex-1 overflow-y-auto p-4 space-y-2">
          {loading ? (
            <div className="text-center py-8 text-muted-foreground">
              加载中...
            </div>
          ) : filteredEntries.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              {searchQuery ? "没有匹配的素材" : "暂无素材，点击上方添加"}
            </div>
          ) : (
            filteredEntries.map((entry) => (
              <div
                key={entry.id}
                className="p-3 rounded-lg border border-border bg-background group hover:shadow-md transition-shadow"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-xs px-2 py-0.5 rounded-full bg-primary/10 text-primary">
                        {entry.category}
                      </span>
                      <span className="text-xs font-medium text-foreground">
                        {entry.label}
                      </span>
                    </div>
                    <p className="text-sm text-foreground line-clamp-3">
                      {entry.text}
                    </p>
                  </div>
                  <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    {onInsert && (
                      <button
                        onClick={() => onInsert(entry.text)}
                        className="p-1.5 rounded-lg hover:bg-black/10 dark:hover:bg-white/10 transition-colors"
                        title="插入到章节"
                      >
                        <Copy size={14} className="text-primary" />
                      </button>
                    )}
                    <button
                      onClick={() => handleCopy(entry)}
                      className="p-1.5 rounded-lg hover:bg-black/10 dark:hover:bg-white/10 transition-colors"
                      title="复制到系统剪贴板"
                    >
                      {copiedId === entry.id ? (
                        <span className="text-xs text-primary">已复制</span>
                      ) : (
                        <Clipboard size={14} className="text-muted-foreground" />
                      )}
                    </button>
                    <button
                      onClick={() => handleDelete(entry.id)}
                      className="p-1.5 rounded-lg hover:bg-red-100 dark:hover:bg-red-900/20 transition-colors"
                      title="删除"
                    >
                      <Trash2 size={14} className="text-red-500" />
                    </button>
                  </div>
                </div>
              </div>
            ))
          )}
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-border">
          <p className="text-xs text-center text-muted-foreground">
            素材将保存在当前书籍目录中，最多保留 50 条
          </p>
        </div>
      </div>
    </div>
  );
}
