import { useEffect, useState } from "react";
import type { Theme } from "../hooks/use-theme";
import type { TFunction } from "../hooks/use-i18n";
import { useColors } from "../hooks/use-colors";
import { fetchJson } from "../hooks/use-api";
import { TrendingUp, Loader2, Target, Clock, AlertCircle, ChevronRight, BarChart3, Sparkles } from "lucide-react";

interface Recommendation {
  readonly confidence: number;
  readonly platform: string;
  readonly genre: string;
  readonly concept: string;
  readonly reasoning: string;
  readonly benchmarkTitles: ReadonlyArray<string>;
}

interface RadarResult {
  readonly marketSummary: string;
  readonly recommendations: ReadonlyArray<Recommendation>;
}

interface RadarHistoryItem {
  readonly file: string;
  readonly timestamp: string;
  readonly summaryPreview: string;
  readonly result: RadarResult;
}

interface Nav { toDashboard: () => void }

export function RadarView({ nav, theme, t }: { nav: Nav; theme: Theme; t: TFunction }) {
  const c = useColors(theme);
  const [result, setResult] = useState<RadarResult | null>(null);
  const [history, setHistory] = useState<ReadonlyArray<RadarHistoryItem>>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const loadHistory = async () => {
    try {
      const data = await fetchJson<{ items: ReadonlyArray<RadarHistoryItem> }>("/radar/history");
      setHistory(data.items ?? []);
    } catch {
      setHistory([]);
    }
  };

  useEffect(() => {
    void loadHistory();
  }, []);

  const handleScan = async () => {
    setLoading(true);
    setError("");
    setResult(null);
    try {
      const data = await fetchJson<RadarResult>("/radar/scan", { method: "POST" });
      setResult(data);
      await loadHistory();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    setLoading(false);
  };

  return (
    <div className="space-y-10 pb-20">
      <div className="flex flex-col gap-6 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-1">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <button onClick={nav.toDashboard} className={c.link}>{t("bread.home")}</button>
            <ChevronRight size={12} className="text-muted-foreground/40" />
            <span>{t("nav.radar")}</span>
          </div>
          <h1 className="font-serif text-4xl flex items-center gap-4 tracking-tight">
            <TrendingUp size={32} className="text-primary" />
            {t("radar.title")}
          </h1>
          <p className="text-muted-foreground max-w-xl text-sm leading-relaxed">
            扫描全网热门榜单、题材走势与核心爽点，为您提供及时的创作建议。
          </p>
        </div>

        <button
          onClick={handleScan}
          disabled={loading}
          className={`h-12 px-6 text-sm font-semibold rounded-2xl shadow-lg shadow-primary/20 ${c.btnPrimary} disabled:opacity-30 flex items-center gap-2.5 transition-all hover:scale-[1.02] active:scale-[0.98]`}
        >
          {loading ? <Loader2 size={18} className="animate-spin" /> : <Target size={18} />}
          {loading ? t("radar.scanning") : t("radar.scan")}
        </button>
      </div>

      {error && (
        <div className="bg-destructive/10 border border-destructive/20 text-destructive px-5 py-4 rounded-2xl text-sm flex items-center gap-3 fade-in">
          <AlertCircle size={18} />
          {error}
        </div>
      )}

      {result && (
        <div className="space-y-8 fade-in">
          <section className="glass-panel rounded-[2.5rem] p-6 sm:p-8 space-y-4">
            <div className="flex items-center gap-3 text-primary">
              <Sparkles size={20} />
              <h3 className="text-sm font-bold uppercase tracking-widest">{t("radar.summary")}</h3>
            </div>
            <div className="text-base leading-8 whitespace-pre-wrap text-foreground/90 font-serif">
              {result.marketSummary}
            </div>
          </section>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {result.recommendations.map((rec, i) => (
              <div key={i} className="glass-panel rounded-[2rem] p-6 space-y-5 hover:border-primary/40 transition-all duration-300">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2.5">
                    <div className="p-2 rounded-xl bg-primary/10 text-primary">
                      <BarChart3 size={18} />
                    </div>
                    <span className="text-xs font-bold uppercase tracking-widest text-muted-foreground">
                      {rec.platform} · {rec.genre}
                    </span>
                  </div>
                  <span className={`text-[11px] font-bold px-2.5 py-1 rounded-full ${
                    rec.confidence >= 0.7 ? "bg-emerald-500/10 text-emerald-600 border border-emerald-500/20" :
                    rec.confidence >= 0.4 ? "bg-amber-500/10 text-amber-600 border border-amber-500/20" :
                    "bg-muted text-muted-foreground"
                  }`}>
                    {(rec.confidence * 100).toFixed(0)}% 置信度
                  </span>
                </div>
                <div className="space-y-3">
                  <h4 className="text-lg font-bold text-foreground leading-snug">{rec.concept}</h4>
                  <p className="text-sm text-muted-foreground leading-relaxed">{rec.reasoning}</p>
                </div>
                {rec.benchmarkTitles.length > 0 && (
                  <div className="pt-2">
                    <div className="text-[10px] uppercase font-bold text-muted-foreground/60 mb-2 tracking-wider">参考作品</div>
                    <div className="flex gap-2 flex-wrap">
                      {rec.benchmarkTitles.map((bt) => (
                        <span key={bt} className="px-3 py-1.5 text-[11px] font-medium bg-secondary/60 text-secondary-foreground rounded-xl border border-border/40">
                          {bt}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {history.length > 0 && (
        <section className="space-y-4">
          <div className="flex items-center gap-3 px-2">
            <Clock size={18} className="text-muted-foreground" />
            <h3 className="text-sm font-bold uppercase tracking-widest text-muted-foreground">
              {t("radar.history")}
            </h3>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {history.slice(0, 12).map((item) => (
              <button
                key={item.file}
                onClick={() => setResult(item.result)}
                className="group w-full glass-panel rounded-2xl px-4 py-4 text-left transition-all hover:bg-card/80 active:scale-[0.98]"
              >
                <div className="flex items-center justify-between mb-2">
                  <span className="text-[11px] font-bold text-primary/60">
                    {new Date(item.timestamp).toLocaleDateString([], { month: "short", day: "numeric" })}
                  </span>
                  <span className="text-[10px] tabular-nums text-muted-foreground/40">
                    {new Date(item.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                  </span>
                </div>
                <div className="font-semibold text-sm text-foreground line-clamp-1 group-hover:text-primary transition-colors">
                  {item.result.recommendations[0]?.concept || "无题材建议"}
                </div>
                <div className="mt-1 line-clamp-2 text-xs text-muted-foreground/70 leading-5">
                  {item.summaryPreview || item.file}
                </div>
              </button>
            ))}
          </div>
        </section>
      )}

      {!result && !loading && !error && (
        <div className="glass-panel border-dashed rounded-[2.5rem] py-24 text-center space-y-4">
          <div className="mx-auto w-16 h-16 rounded-full bg-secondary/50 flex items-center justify-center text-muted-foreground/40">
            <TrendingUp size={32} />
          </div>
          <p className="text-muted-foreground text-sm italic max-w-xs mx-auto">
            {t("radar.emptyHint")}
          </p>
        </div>
      )}
    </div>
  );
}
