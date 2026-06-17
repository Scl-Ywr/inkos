import { useState, useRef } from "react";
import {
  Images,
  Loader2,
  Pencil,
  Settings,
  Square,
  Sparkles,
  ChevronLeft,
  Image as ImageIcon,
  Zap,
  Info,
  AlertTriangle,
  Check,
  RefreshCw,
} from "lucide-react";
import { postApi, useApi } from "../hooks/use-api";
import { buildApiUrl } from "../lib/api-url";
import { useCompositionInput } from "../hooks/use-composition-input";

interface CoverConfigResponse {
  configured: boolean;
  service: string | null;
  model: string | null;
}

interface GeneratedImageItem {
  readonly id: string;
  readonly source: "play" | "project";
  readonly kind: "scene" | "actor" | "item" | "cover" | "short" | "wallpaper" | "other";
  readonly status: "ready" | "failed";
  readonly title: string;
  readonly subtitle?: string;
  readonly url?: string;
  readonly error?: string;
  readonly updatedAt?: string;
  readonly path?: string;
}

const SIZE_OPTIONS = [
  { value: "1024x1024", label: "1:1", desc: "方形" },
  { value: "1024x1536", label: "2:3", desc: "竖版" },
  { value: "1536x1024", label: "3:2", desc: "横版" },
] as const;

interface ImageGenNav {
  toImages: () => void;
  toServices: () => void;
  toDashboard?: () => void;
}

export function ImageGenPage({ nav }: { readonly nav: ImageGenNav }) {
  const { data: coverConfig, loading: configLoading } = useApi<CoverConfigResponse>("/cover/config");
  const configured = coverConfig?.configured ?? false;

  const [title, setTitle] = useState("");
  const [size, setSize] = useState<string>("1024x1024");
  const [generating, setGenerating] = useState(false);
  const [generatedItem, setGeneratedItem] = useState<GeneratedImageItem | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  // 使用 compositionInput hook 解决 Android IME 吞字问题
  const promptInput = useCompositionInput({
    defaultValue: "",
    onValueChange: () => {},
  });
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleGenerate = async () => {
    const trimmed = promptInput.value.trim();
    if (!trimmed || generating) return;

    setGenerating(true);
    setError(null);
    setGeneratedItem(null);
    setPreviewError(null);

    try {
      const result = await postApi<{ item: GeneratedImageItem }>("/images/generate", {
        prompt: trimmed,
        title: title.trim() || undefined,
        size,
      });
      setGeneratedItem(result.item);
      promptInput.setValue("");
      setTitle("");
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setError(message);
    } finally {
      setGenerating(false);
    }
  };

  if (configLoading) {
    return (
      <div className="flex flex-col items-center justify-center py-32 space-y-4">
        <div className="w-10 h-10 border-3 border-primary/20 border-t-primary rounded-full animate-spin" />
        <span className="text-sm font-medium text-muted-foreground animate-pulse">正在唤醒 AI 画师...</span>
      </div>
    );
  }

  if (!configured) {
    return (
      <div className="space-y-8 fade-in">
        <header className="flex items-center gap-3">
           <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/15 text-primary">
              <ImageIcon size={20} />
           </div>
           <div>
              <h1 className="text-2xl font-bold text-foreground">图片生成</h1>
              <p className="text-sm text-muted-foreground">让想象变为现实。</p>
           </div>
        </header>

        <div className="paper-sheet flex min-h-[400px] flex-col items-center justify-center rounded-[3rem] p-10 text-center">
          <div className="relative mb-8 h-24 w-24">
             <Settings size={96} className="text-muted/30 animate-spin-slow" />
             <div className="absolute inset-0 flex items-center justify-center text-primary">
                <Zap size={32} />
             </div>
          </div>
          <h2 className="text-2xl font-serif font-bold text-foreground">请先配置 AI 画师</h2>
          <p className="mt-4 max-w-sm text-base leading-relaxed text-muted-foreground">
            你需要先在“服务配置”中关联一个具备图像生成能力的 API。
          </p>
          <button
            type="button"
            onClick={nav.toServices}
            className="mt-8 inline-flex h-12 items-center gap-2 rounded-2xl bg-primary px-8 text-sm font-bold text-primary-foreground shadow-lg shadow-primary/20 transition-all hover:scale-105 active:scale-95"
          >
            <Settings size={18} />
            前往配置中心
          </button>
        </div>
      </div>
    );
  }

  const imageUrl = generatedItem?.url ? buildApiUrl(generatedItem.url) ?? generatedItem.url : undefined;

  return (
    <div className="space-y-8 fade-in pb-20">
      {/* Navigation & Header */}
      <nav className="flex items-center gap-2 text-[13px] font-medium text-muted-foreground">
        <button onClick={nav.toDashboard} className="flex items-center gap-1.5 transition-colors hover:text-primary">
          <ChevronLeft size={14} />
          <span>首页</span>
        </button>
        <span className="text-border/60">/</span>
        <span className="text-foreground">AI 画师</span>
      </nav>

      {/* Hero Section */}
      <section className="glass-panel relative overflow-hidden rounded-[2.5rem] p-6 sm:p-10 shadow-3d">
        <div className="relative z-10 flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
          <div className="space-y-4">
            <div className="flex items-center gap-2.5 text-sm font-bold text-primary">
              <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/15 shadow-inner">
                <Sparkles size={16} />
              </div>
              <span>IMAGINATION ENGINE</span>
            </div>
            <h1 className="text-4xl font-serif font-bold tracking-tight text-foreground sm:text-5xl">
              AI 创作实验室
            </h1>
            <p className="max-w-2xl text-base leading-relaxed text-muted-foreground">
              为你的故事插上视觉的翅膀。无论是精美的封面、生动的场景，还是独特的角色立绘，在这里只需笔尖跳跃，即可具象而生。
            </p>
          </div>
          
          <div className="flex shrink-0 gap-3">
             <button
               onClick={nav.toImages}
               className="soft-pill inline-flex h-12 items-center justify-center gap-2 rounded-2xl px-6 text-sm font-bold text-foreground transition-all hover:border-primary/40"
             >
               <Images size={18} />
               前往图片库
             </button>
          </div>
        </div>
        
        {/* Decor */}
        <div className="absolute -right-16 -bottom-16 h-64 w-64 rounded-full bg-primary/5 blur-3xl opacity-60" />
      </section>

      <div className="grid grid-cols-1 gap-8 lg:grid-cols-5">
        {/* Editor Area */}
        <div className="lg:col-span-3 space-y-6">
           <div className="paper-sheet rounded-[2.5rem] p-6 sm:p-8 space-y-6 shadow-3d">
              <div className="space-y-2">
                <label className="text-xs font-bold uppercase tracking-widest text-muted-foreground ml-1">创意提示词 (Prompt)</label>
                <textarea
                  ref={textareaRef}
                  onChange={promptInput.handleChange}
                  onInput={promptInput.handleInput}
                  onCompositionStart={promptInput.handleCompositionStart}
                  onCompositionEnd={promptInput.handleCompositionEnd}
                  placeholder="描述你想生成的画面细节，例如：阳光洒在林间空地，一个穿着红色斗篷的女孩背对着镜头，远处是古老的塔楼..."
                  rows={6}
                  className="w-full resize-none rounded-2xl border border-border/50 bg-background/50 p-5 text-base font-medium leading-relaxed text-foreground outline-none focus:border-primary/50 focus:ring-4 focus:ring-primary/5 transition-all placeholder:text-muted-foreground/40"
                />
                <p className="text-[10px] text-muted-foreground/60 flex items-center gap-1.5 mt-1 ml-1">
                   <Info size={12} />
                   提示：使用英文提示词通常能获得更高质量且符合预期的生成结果。
                </p>
              </div>

              <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
                 <div className="space-y-2">
                    <label className="text-xs font-bold uppercase tracking-widest text-muted-foreground ml-1">图片标题</label>
                    <input
                      type="text"
                      value={title}
                      onChange={(e) => setTitle(e.target.value)}
                      placeholder="为这张作品命名"
                      className="h-12 w-full rounded-2xl border border-border/50 bg-background/50 px-5 text-sm font-medium outline-none focus:border-primary/50 transition-all"
                    />
                 </div>
                 <div className="space-y-2">
                    <label className="text-xs font-bold uppercase tracking-widest text-muted-foreground ml-1">输出比例</label>
                    <div className="flex gap-2">
                      {SIZE_OPTIONS.map((opt) => (
                        <button
                          key={opt.value}
                          type="button"
                          onClick={() => setSize(opt.value)}
                          className={`flex-1 flex flex-col items-center justify-center h-12 rounded-xl border transition-all ${
                            size === opt.value 
                              ? "bg-primary/10 border-primary/50 text-primary shadow-sm" 
                              : "bg-background/50 border-border/50 text-muted-foreground hover:bg-muted/50 hover:text-foreground"
                          }`}
                        >
                          <span className="text-xs font-bold">{opt.label}</span>
                          <span className="text-[9px] opacity-60 uppercase">{opt.desc}</span>
                        </button>
                      ))}
                    </div>
                 </div>
              </div>

              <div className="pt-4">
                 <button
                   type="button"
                   onClick={() => void handleGenerate()}
                   disabled={!promptInput.value.trim() || generating}
                   className="relative w-full h-14 overflow-hidden rounded-2xl bg-primary font-bold text-primary-foreground shadow-lg shadow-primary/20 transition-all hover:scale-[1.01] active:scale-[0.98] disabled:opacity-50"
                 >
                   <div className="relative z-10 flex items-center justify-center gap-2">
                      {generating ? (
                        <>
                          <Loader2 size={20} className="animate-spin" />
                          <span>正在描绘画卷...</span>
                        </>
                      ) : (
                        <>
                          <Pencil size={20} />
                          <span>立即生成图片</span>
                        </>
                      )}
                   </div>
                   
                   {/* Animated shine effect */}
                   {!generating && (
                     <div className="absolute inset-0 -translate-x-full animate-shimmer bg-gradient-to-r from-transparent via-white/10 to-transparent" />
                   )}
                 </button>
              </div>
           </div>

           {error && (
             <div className="glass-panel border-l-4 border-l-destructive rounded-2xl p-5 flex items-start gap-3 animate-in fade-in slide-in-from-top-2">
                <AlertTriangle size={20} className="text-destructive shrink-0 mt-0.5" />
                <div className="space-y-2">
                   <div className="text-sm font-bold text-destructive">生成失败</div>
                   <p className="text-xs leading-relaxed text-muted-foreground">{error}</p>
                   {error.includes("apiKey") && (
                     <button onClick={nav.toServices} className="text-[10px] font-bold uppercase tracking-widest text-primary hover:underline">
                        修正 API 配置 →
                     </button>
                   )}
                </div>
             </div>
           )}
        </div>

        {/* Results / Preview Area */}
        <div className="lg:col-span-2">
           <div className="paper-sheet h-full min-h-[400px] rounded-[2.5rem] flex flex-col overflow-hidden shadow-3d border border-border/30">
              <div className="border-b border-border/30 bg-muted/10 px-8 py-5 flex items-center justify-between">
                 <h2 className="text-sm font-bold uppercase tracking-widest text-foreground">实时预览</h2>
                 {generatedItem && (
                    <span className="flex items-center gap-1 text-[10px] font-bold text-emerald-500 bg-emerald-500/10 px-2 py-0.5 rounded-full">
                       <Check size={10} strokeWidth={4} />
                       READY
                    </span>
                 )}
              </div>

              <div className="flex-1 flex flex-col items-center justify-center p-8">
                 {generating ? (
                    <div className="flex flex-col items-center gap-6 animate-pulse">
                       <div className="h-64 w-64 rounded-[2rem] bg-muted/50 border-2 border-dashed border-border flex items-center justify-center">
                          <Zap size={48} className="text-muted/20" />
                       </div>
                       <p className="text-xs font-medium text-muted-foreground">正在接收来自 AI 的光影与色彩...</p>
                    </div>
                 ) : generatedItem && imageUrl ? (
                    <div className="w-full space-y-6 animate-in zoom-in-95 fade-in duration-500">
                       <div className="relative group aspect-square sm:aspect-auto sm:max-h-[60vh] overflow-hidden rounded-[2rem] shadow-2xl ring-1 ring-border/50">
                          {previewError ? (
                            <div className="flex h-full min-h-[200px] flex-col items-center justify-center gap-3 text-destructive">
                              <AlertTriangle size={32} />
                              <p className="text-sm font-medium">图片加载失败</p>
                              <p className="text-xs text-muted-foreground">{previewError}</p>
                            </div>
                          ) : (
                            <img
                              src={imageUrl}
                              alt={generatedItem.title}
                              className="w-full h-full object-contain bg-muted/20"
                              loading="lazy"
                              decoding="async"
                              onError={() => setPreviewError("图片文件可能已损坏或过大")}
                            />
                          )}
                          <div className="absolute inset-0 bg-gradient-to-t from-black/40 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
                       </div>
                       
                       <div className="space-y-4">
                          <div className="space-y-1">
                             <h3 className="text-xl font-bold text-foreground">{generatedItem.title}</h3>
                             <p className="text-xs text-muted-foreground line-clamp-2">{generatedItem.subtitle}</p>
                          </div>
                          
                          <div className="flex gap-2">
                             <button
                               onClick={() => { setGeneratedItem(null); setPreviewError(null); }}
                               className="soft-pill flex-1 flex h-11 items-center justify-center gap-2 rounded-xl text-sm font-bold text-foreground transition-all active:scale-95"
                             >
                               <RefreshCw size={16} />
                               重置
                             </button>
                             <button
                               onClick={nav.toImages}
                               className="flex-1 flex h-11 items-center justify-center gap-2 rounded-xl bg-primary/10 text-primary border border-primary/20 text-sm font-bold transition-all hover:bg-primary/20 active:scale-95"
                             >
                               <Images size={16} />
                               进入库
                             </button>
                          </div>
                       </div>
                    </div>
                 ) : (
                    <div className="flex flex-col items-center gap-6">
                       <div className="h-64 w-64 rounded-[2rem] bg-muted/30 border-2 border-dashed border-border/60 flex items-center justify-center opacity-40">
                          <ImageIcon size={64} className="text-muted" />
                       </div>
                       <div className="max-w-[200px] text-center space-y-2">
                          <p className="text-sm font-bold text-muted-foreground">此处将显现你的杰作</p>
                          <p className="text-xs text-muted-foreground/60">在左侧输入创意并点击生成，让 AI 赋予故事色彩。</p>
                       </div>
                    </div>
                 )}
              </div>
           </div>
        </div>
      </div>
    </div>
  );
}
