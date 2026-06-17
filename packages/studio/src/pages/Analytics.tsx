import { useApi } from "../hooks/use-api";
import type { Theme } from "../hooks/use-theme";
import type { TFunction } from "../hooks/use-i18n";
import { useColors } from "../hooks/use-colors";

interface WritingDayStat {
  readonly date: string;
  readonly wordsWritten: number;
  readonly chaptersModified: number;
  readonly chaptersApproved: number;
}

interface AnalyticsData {
  readonly bookId: string;
  readonly totalChapters: number;
  readonly totalWords: number;
  readonly avgWordsPerChapter: number;
  readonly auditPassRate: number;
  readonly topIssueCategories: ReadonlyArray<{ readonly category: string; readonly count: number }>;
  readonly chaptersWithMostIssues: ReadonlyArray<{ readonly chapter: number; readonly issueCount: number }>;
  readonly statusDistribution: Record<string, number>;
  readonly tokenStats?: {
    readonly totalPromptTokens: number;
    readonly totalCompletionTokens: number;
    readonly totalTokens: number;
    readonly avgTokensPerChapter: number;
    readonly recentTrend: ReadonlyArray<{ readonly chapter: number; readonly totalTokens: number }>;
  };
  readonly dailyStats: ReadonlyArray<WritingDayStat>;
  readonly consecutiveWritingDays: number;
  readonly targetProgress: { readonly current: number; readonly target: number; readonly percentage: number };
}

interface Nav {
  toBookSettings: (id: string) => void;
}

export function Analytics({ bookId, nav, theme, t }: { bookId: string; nav: Nav; theme: Theme; t: TFunction }) {
  const c = useColors(theme);
  const { data, loading, error } = useApi<AnalyticsData>(`/books/${bookId}/analytics`);

  if (loading) return <div className={c.muted}>{t("common.loading")}</div>;
  if (error) return <div className="text-red-400">{t("common.error")}: {error}</div>;
  if (!data) return null;

  const statuses = Object.entries(data.statusDistribution);
  const totalFromDist = statuses.reduce((sum, [, count]) => sum + count, 0);
  const maxDailyWords = Math.max(1, ...data.dailyStats.map((d) => d.wordsWritten));

  return (
    <div className="space-y-6">
      <div className={`flex items-center gap-2 text-sm ${c.muted}`}>
        <button onClick={() => nav.toBookSettings(bookId)} className={c.link}>{t("bread.config")}</button>
        <span>/</span>
        <span className={c.subtle}>{t("analytics.title")}</span>
      </div>

      <h1 className="text-2xl font-semibold">{t("analytics.title")}</h1>

      {/* Core stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 sm:gap-4">
        <StatCard label={t("analytics.totalChapters")} value={data.totalChapters.toString()} c={c} />
        <StatCard
          label={t("analytics.totalWords")}
          value={formatChineseWordCount(data.totalWords)}
          exact={`${data.totalWords.toLocaleString()} 字`}
          c={c}
        />
        <StatCard
          label={t("analytics.avgWords")}
          value={formatChineseWordCount(data.avgWordsPerChapter)}
          exact={`${data.avgWordsPerChapter.toLocaleString()} 字`}
          c={c}
        />
        <StatCard
          label="审计通过率"
          value={`${data.auditPassRate}%`}
          c={c}
        />
        <StatCard
          label="连续写作"
          value={`${data.consecutiveWritingDays} 天`}
          c={c}
        />
        {data.tokenStats && (
          <StatCard
            label="总Token"
            value={formatTokenCount(data.tokenStats.totalTokens)}
            c={c}
          />
        )}
      </div>

      {/* Target progress */}
      {data.targetProgress && (
        <div className={`border ${c.cardStatic} rounded-lg p-5`}>
          <div className="flex items-center justify-between mb-3">
            <h2 className={`text-sm font-medium ${c.subtle}`}>目标进度</h2>
            <span className="text-xs text-muted-foreground">
              {formatChineseWordCount(data.targetProgress.current)} / {formatChineseWordCount(data.targetProgress.target)}
            </span>
          </div>
          <div className={`h-3 ${c.btnSecondary} rounded-full overflow-hidden`}>
            <div
              className="h-full bg-primary rounded-full transition-all"
              style={{ width: `${data.targetProgress.percentage}%` }}
            />
          </div>
          <p className="mt-2 text-xs text-right text-muted-foreground">{data.targetProgress.percentage}%</p>
        </div>
      )}

      {/* Daily stats */}
      {data.dailyStats.length > 0 && (
        <div className={`border ${c.cardStatic} rounded-lg p-5`}>
          <h2 className={`text-sm font-medium ${c.subtle} mb-4`}>日码字统计（近30天）</h2>
          <div className="flex items-end gap-1 h-32">
            {data.dailyStats.map((day) => (
              <div key={day.date} className="flex-1 flex flex-col items-center gap-1 min-w-0">
                <div
                  className="w-full bg-primary/70 rounded-t-sm transition-all hover:bg-primary"
                  style={{ height: `${(day.wordsWritten / maxDailyWords) * 100}%`, minHeight: day.wordsWritten > 0 ? "4px" : "0" }}
                  title={`${day.date}: ${day.wordsWritten.toLocaleString()} 字`}
                />
                {data.dailyStats.length <= 15 && (
                  <span className="text-[8px] text-muted-foreground truncate w-full text-center">{day.date.slice(5)}</span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Issue categories */}
      {data.topIssueCategories.length > 0 && (
        <div className={`border ${c.cardStatic} rounded-lg p-5`}>
          <h2 className={`text-sm font-medium ${c.subtle} mb-4`}>问题分类 TOP10</h2>
          <div className="space-y-2">
            {data.topIssueCategories.map(({ category, count }) => (
              <div key={category} className="flex items-center justify-between text-sm">
                <span className={c.subtle}>{category}</span>
                <span className="tabular-nums font-medium">{count}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Status distribution */}
      {statuses.length > 0 && (
        <div className={`border ${c.cardStatic} rounded-lg p-5`}>
          <h2 className={`text-sm font-medium ${c.subtle} mb-4`}>{t("analytics.statusDist")}</h2>
          <div className="space-y-3">
            {statuses.map(([status, count]) => (
              <div key={status}>
                <div className="flex justify-between text-sm mb-1">
                  <span className={c.subtle}>{status}</span>
                  <span className={c.muted}>{count}</span>
                </div>
                <div className={`h-2 ${c.btnSecondary} rounded-full overflow-hidden`}>
                  <div
                    className="h-full bg-zinc-500 rounded-full transition-all"
                    style={{ width: `${totalFromDist > 0 ? (count / totalFromDist) * 100 : 0}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Token trend */}
      {data.tokenStats && data.tokenStats.recentTrend.length > 0 && (
        <div className={`border ${c.cardStatic} rounded-lg p-5`}>
          <h2 className={`text-sm font-medium ${c.subtle} mb-4`}>最近5章 Token 用量</h2>
          <div className="space-y-2">
            {data.tokenStats.recentTrend.map(({ chapter, totalTokens }) => (
              <div key={chapter} className="flex items-center justify-between text-sm">
                <span className={c.subtle}>第{chapter}章</span>
                <span className="tabular-nums font-medium">{totalTokens.toLocaleString()}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function formatChineseWordCount(value: number): string {
  if (value >= 10_000) {
    return `${(value / 10_000).toFixed(value >= 100_000 ? 1 : 2).replace(/\.?0+$/, "")}万字`;
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(1).replace(/\.0$/, "")}千字`;
  }
  return `${value}字`;
}

function formatTokenCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(0)}K`;
  return value.toString();
}

function StatCard({ label, value, exact, c }: {
  label: string;
  value: string;
  exact?: string;
  c: ReturnType<typeof useColors>;
}) {
  return (
    <div className={`min-w-0 border ${c.cardStatic} rounded-lg p-3 sm:p-5`}>
      <div className={`mb-1 text-[11px] leading-4 sm:text-sm ${c.muted}`}>{label}</div>
      <div className="break-words text-base font-semibold tabular-nums sm:text-2xl">{value}</div>
      {exact ? <div className={`mt-1 text-[9px] leading-3 tabular-nums sm:text-[11px] ${c.muted}`}>{exact}</div> : null}
    </div>
  );
}
