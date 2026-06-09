import { useApi } from "../hooks/use-api";
import type { Theme } from "../hooks/use-theme";
import type { TFunction } from "../hooks/use-i18n";
import { useColors } from "../hooks/use-colors";
import { BarChart3, BookOpen, FileText } from "lucide-react";
import type { ReactNode } from "react";

interface AnalyticsData {
  readonly bookId: string;
  readonly totalChapters: number;
  readonly totalWords: number;
  readonly avgWordsPerChapter: number;
  readonly statusDistribution: Record<string, number>;
}

interface Nav {
  toBook: (id: string) => void;
  toDashboard: () => void;
}

export function Analytics({ bookId, nav, theme, t }: { bookId: string; nav: Nav; theme: Theme; t: TFunction }) {
  const c = useColors(theme);
  const { data, loading, error } = useApi<AnalyticsData>(`/books/${bookId}/analytics`);

  if (loading) return <div className={c.muted}>{t("common.loading")}</div>;
  if (error) return <div className="text-red-400">{t("common.error")}: {error}</div>;
  if (!data) return null;

  const statuses = Object.entries(data.statusDistribution);
  const totalFromDist = statuses.reduce((sum, [, count]) => sum + count, 0);
  const totalWords = formatWordCount(data.totalWords);
  const avgWords = formatWordCount(data.avgWordsPerChapter);

  return (
    <div className="space-y-5">
      <div className={`flex min-w-0 items-center gap-2 text-sm ${c.muted}`}>
        <button onClick={nav.toDashboard} className={c.link}>{t("bread.books")}</button>
        <span>/</span>
        <button onClick={() => nav.toBook(bookId)} className={`${c.link} min-w-0 truncate`}>{bookId}</button>
        <span>/</span>
        <span className={c.subtle}>{t("analytics.title")}</span>
      </div>

      <div className="space-y-2">
        <h1 className="text-[2.6rem] font-semibold leading-none tracking-normal sm:text-5xl">
          {t("analytics.title")}
        </h1>
        <p className={`text-sm ${c.muted}`}>章节体量、审阅状态与整体进度。</p>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard
          className="col-span-2"
          icon={<FileText size={18} />}
          label="总字数"
          value={totalWords.value}
          unit={totalWords.unit}
          hint={`${data.totalWords.toLocaleString()} 字`}
          c={c}
        />
        <StatCard
          icon={<BookOpen size={18} />}
          label="总章数"
          value={data.totalChapters.toLocaleString()}
          unit="章"
          c={c}
        />
        <StatCard
          icon={<BarChart3 size={18} />}
          label="平均字数"
          value={avgWords.value}
          unit={`${avgWords.unit}/章`}
          hint={`${data.avgWordsPerChapter.toLocaleString()} 字/章`}
          c={c}
        />
      </div>

      {statuses.length > 0 && (
        <section className={`rounded-3xl border ${c.cardStatic} p-4 sm:p-5`}>
          <div className="mb-4 flex items-end justify-between gap-3">
            <div>
              <h2 className="text-xl font-semibold sm:text-2xl">{t("analytics.statusDist")}</h2>
              <p className={`mt-1 text-xs ${c.muted}`}>共 {totalFromDist.toLocaleString()} 章进入统计。</p>
            </div>
          </div>
          <div className="space-y-3">
            {statuses
              .sort(([, a], [, b]) => b - a)
              .map(([status, count]) => {
                const percent = totalFromDist > 0 ? Math.round((count / totalFromDist) * 100) : 0;
                return (
                  <div key={status} className={`rounded-2xl ${c.btnSecondary} p-3`}>
                    <div className="mb-2 flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium">{translateAnalyticsStatus(status)}</div>
                        <div className={`mt-0.5 text-xs ${c.muted}`}>{status}</div>
                      </div>
                      <div className="shrink-0 text-right">
                        <div className="text-lg font-semibold tabular-nums">{count}</div>
                        <div className={`text-xs ${c.muted}`}>{percent}%</div>
                      </div>
                    </div>
                    <div className="h-2 overflow-hidden rounded-full bg-black/10 dark:bg-white/10">
                      <div
                        className="h-full rounded-full bg-rose-400 transition-all dark:bg-rose-300/80"
                        style={{ width: `${percent}%` }}
                      />
                    </div>
                  </div>
                );
              })}
          </div>
        </section>
      )}
    </div>
  );
}

function StatCard({
  label,
  value,
  unit,
  hint,
  icon,
  className = "",
  c,
}: {
  label: string;
  value: string;
  unit?: string;
  hint?: string;
  icon: ReactNode;
  className?: string;
  c: ReturnType<typeof useColors>;
}) {
  return (
    <div className={`rounded-3xl border ${c.cardStatic} p-4 ${className}`}>
      <div className={`mb-4 flex items-center gap-2 text-sm ${c.muted}`}>
        <span className="grid h-8 w-8 place-items-center rounded-full bg-rose-400/15 text-rose-300">
          {icon}
        </span>
        <span>{label}</span>
      </div>
      <div className="flex min-w-0 items-end gap-1.5">
        <span className="min-w-0 text-4xl font-semibold leading-none tabular-nums tracking-normal sm:text-5xl">
          {value}
        </span>
        {unit && <span className={`pb-1 text-sm font-medium ${c.muted}`}>{unit}</span>}
      </div>
      {hint && <div className={`mt-2 text-xs ${c.muted}`}>{hint}</div>}
    </div>
  );
}

function formatWordCount(value: number): { value: string; unit: string } {
  if (value >= 10000) {
    const wan = value / 10000;
    const formatted = wan >= 100 ? wan.toFixed(0) : wan.toFixed(2).replace(/\.?0+$/u, "");
    return { value: formatted, unit: "万字" };
  }
  return { value: value.toLocaleString(), unit: "字" };
}

function translateAnalyticsStatus(status: string): string {
  const map: Record<string, string> = {
    "ready-for-review": "待复核",
    approved: "已通过",
    drafted: "草稿",
    "needs-revision": "需修订",
    imported: "已导入",
    "audit-failed": "审计未通过",
  };
  return map[status] ?? status;
}
