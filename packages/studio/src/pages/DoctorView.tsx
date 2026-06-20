import { postApi, useApi } from "../hooks/use-api";
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import type { Theme } from "../hooks/use-theme";
import type { TFunction } from "../hooks/use-i18n";
import { useColors } from "../hooks/use-colors";
import { Stethoscope, CheckCircle2, XCircle, Loader2, RefreshCw, Download, ShieldCheck, PackageCheck, DatabaseBackup, Wrench } from "lucide-react";
import { downloadUpdateApk, getInstallPermissionStatus, installDownloadedApk, openInstallPermissionSettings, pingUpdateUrl, pingUpdateUrls, subscribeToDownloadProgress, cancelDownload, type DownloadProgress } from "../lib/android-runtime-plugin";
import { isNativeRuntime } from "../lib/mobile-runtime";
import { appConfirm } from "../lib/app-dialog";

interface DoctorChecks {
  readonly inkosJson: boolean;
  readonly projectEnv: boolean;
  readonly globalEnv: boolean;
  readonly booksDir: boolean;
  readonly llmConnected: boolean;
  readonly bookCount: number;
}

interface RuntimeUpdateManifest {
  readonly channel: string;
  readonly versionName: string;
  readonly versionCode: number;
  readonly minVersionCode: number;
  readonly apkUrl: string;
  readonly apkMirrorUrls?: string[];
  readonly apkSha256: string;
  readonly size: number;
  readonly notes: string[];
  readonly publishedAt: string;
}

interface RuntimeUpdateCheck {
  readonly ok: boolean;
  readonly manifestUrl: string;
  readonly current: {
    readonly versionCode: number;
    readonly versionName: string;
  };
  readonly supported?: boolean;
  readonly available?: boolean;
  readonly update?: RuntimeUpdateManifest;
  readonly error?: string;
}

interface Nav { toDashboard: () => void }

interface StorageRepairResult {
  readonly ok: boolean;
  readonly root: string;
  readonly backupDir: string;
  readonly booksChecked: number;
  readonly worldsRemoved: number;
  readonly removedWorldIds: ReadonlyArray<string>;
}

function CheckRow({ label, ok, detail }: { label: string; ok: boolean; detail?: string }) {
  return (
    <div className="flex items-center gap-3 py-3 border-b border-border/30 last:border-0">
      {ok ? (
        <CheckCircle2 size={18} className="text-emerald-500 shrink-0" />
      ) : (
        <XCircle size={18} className="text-destructive shrink-0" />
      )}
      <span className="text-sm font-medium flex-1">{label}</span>
      {detail && <span className="text-xs text-muted-foreground">{detail}</span>}
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "-";
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function UpdateMeta({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] font-semibold uppercase text-muted-foreground">{label}</div>
      <div className="truncate text-sm font-medium text-foreground">{value}</div>
    </div>
  );
}

interface UpdateDownloadSource {
  readonly id: string;
  readonly label: string;
  readonly url: string;
  readonly primary?: boolean;
}

interface UpdateSourcePing {
  readonly ok: boolean;
  readonly statusCode: number;
  readonly latencyMs: number;
  readonly error?: string;
}

const GITHUB_DOWNLOAD_MIRRORS: ReadonlyArray<{ id: string; label: string; prefix: string }> = [
  { id: "ghproxy-net", label: "ghproxy.net", prefix: "https://ghproxy.net/" },
  { id: "ghfast-top", label: "ghfast.top", prefix: "https://ghfast.top/" },
  { id: "mirror-ghproxy", label: "mirror.ghproxy.com", prefix: "https://mirror.ghproxy.com/" },
  { id: "gh-proxy-com", label: "gh-proxy.com", prefix: "https://gh-proxy.com/" },
  { id: "githubproxy-cc", label: "githubproxy.cc", prefix: "https://githubproxy.cc/" },
  { id: "gh-llkk", label: "gh.llkk.cc", prefix: "https://gh.llkk.cc/" },
  { id: "gh-ddlc", label: "gh.ddlc.top", prefix: "https://gh.ddlc.top/" },
  { id: "ghproxy-cfd", label: "ghproxy.cfd", prefix: "https://ghproxy.cfd/" },
  { id: "gh-proxy-net", label: "gh-proxy.net", prefix: "https://gh-proxy.net/" },
  { id: "ghproxy-1888866", label: "ghproxy.1888866.xyz", prefix: "https://ghproxy.1888866.xyz/" },
];

function buildUpdateDownloadSources(update: RuntimeUpdateManifest | null, t: TFunction): UpdateDownloadSource[] {
  if (!update?.apkUrl) return [];
  const originalUrl = update.apkUrl.trim();
  const sources: UpdateDownloadSource[] = [
    { id: "github", label: t("doctor.updateOfficialSource"), url: originalUrl, primary: true },
  ];
  const pushSource = (source: UpdateDownloadSource) => {
    if (!source.url || sources.some((item) => item.url === source.url)) return;
    sources.push(source);
  };

  for (const [index, url] of (update.apkMirrorUrls ?? []).entries()) {
    pushSource({ id: `manifest-mirror-${index}`, label: `${t("doctor.updateMirrorSource")} ${index + 1}`, url });
  }
  if (/^https:\/\/github\.com\//i.test(originalUrl)) {
    for (const mirror of GITHUB_DOWNLOAD_MIRRORS) {
      pushSource({
        id: mirror.id,
        label: mirror.label,
        url: `${mirror.prefix}${originalUrl}`,
      });
    }
  }
  return sources;
}

function selectFastestSource(
  sources: ReadonlyArray<UpdateDownloadSource>,
  pings: Readonly<Record<string, UpdateSourcePing>>,
): UpdateDownloadSource | null {
  const reachable = sources
    .map((source) => ({ source, ping: pings[source.id] }))
    .filter((item): item is { source: UpdateDownloadSource; ping: UpdateSourcePing } => Boolean(item.ping?.ok));
  reachable.sort((a, b) => a.ping.latencyMs - b.ping.latencyMs);
  return reachable[0]?.source ?? sources[0] ?? null;
}

function UpdatePanel({ theme, t }: { theme: Theme; t: TFunction }) {
  const c = useColors(theme);
  const native = isNativeRuntime();
  const { data, error, loading, refetch } = useApi<RuntimeUpdateCheck>("/runtime/update/check");
  const [downloadedPath, setDownloadedPath] = useState<string | null>(null);
  const [actionStatus, setActionStatus] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [needsPermission, setNeedsPermission] = useState(false);
  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(null);
  const [sourcePings, setSourcePings] = useState<Record<string, UpdateSourcePing>>({});
  const [downloadProgress, setDownloadProgress] = useState<DownloadProgress | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [pingingSources, setPingingSources] = useState(false);
  const update = data?.update ?? null;
  const available = Boolean(data?.available && update);
  const currentLabel = data?.current.versionCode
    ? `${data.current.versionName || "-"} (${data.current.versionCode})`
    : "-";
  const latestLabel = update ? `${update.versionName} (${update.versionCode})` : "-";
  const downloadSources = useMemo(() => buildUpdateDownloadSources(update, t), [t, update]);
  const selectedSource = downloadSources.find((source) => source.id === selectedSourceId)
    ?? selectFastestSource(downloadSources, sourcePings);
  const sourceSignature = downloadSources.map((source) => `${source.id}:${source.url}`).join("|");

  const pingSources = async () => {
    if (!native || downloadSources.length === 0) return;
    setPingingSources(true);
    setActionError(null);
    try {
      const urls = downloadSources.map((s) => s.url);
      const results = await pingUpdateUrls(urls);
      const nextPings: Record<string, UpdateSourcePing> = {};
      downloadSources.forEach((source, i) => {
        nextPings[source.id] = results[i] ?? { ok: false, statusCode: 0, latencyMs: 0, error: "no result" };
      });
      setSourcePings(nextPings);
      const fastest = selectFastestSource(downloadSources, nextPings);
      setSelectedSourceId(fastest?.id ?? null);
    } finally {
      setPingingSources(false);
    }
  };

  useEffect(() => {
    setSourcePings({});
    setDownloadedPath(null);
    setSelectedSourceId(downloadSources[0]?.id ?? null);
    if (!available || !native || downloadSources.length === 0) return;
    let cancelled = false;
    setPingingSources(true);
    setActionError(null);
    const urls = downloadSources.map((s) => s.url);
    pingUpdateUrls(urls).then((results) => {
      if (cancelled) return;
      const nextPings: Record<string, UpdateSourcePing> = {};
      downloadSources.forEach((source, i) => {
        nextPings[source.id] = results[i] ?? { ok: false, statusCode: 0, latencyMs: 0, error: "no result" };
      });
      setSourcePings(nextPings);
      const fastest = selectFastestSource(downloadSources, nextPings);
      setSelectedSourceId(fastest?.id ?? null);
    }).finally(() => {
      if (!cancelled) setPingingSources(false);
    });
    return () => {
      cancelled = true;
    };
  }, [available, native, sourceSignature]);

  const handleDownload = async (source: UpdateDownloadSource | null = selectedSource) => {
    if (!update || !source) return;
    setActionError(null);
    setNeedsPermission(false);
    setDownloading(true);
    setDownloadProgress(null);
    setActionStatus(null);

    const unsubscribe = subscribeToDownloadProgress((progress) => {
      setDownloadProgress(progress);
    });

    try {
      const result = await downloadUpdateApk({
        url: source.url,
        sha256: update.apkSha256,
        fileName: `inkos-studio-${update.versionName}.apk`,
      });
      setDownloadedPath(result.path);
      setDownloadProgress(null);
      setActionStatus(`${source.label}: ${t("doctor.updateDownloaded")}`);
      // Check install permission (non-blocking — don't await)
      getInstallPermissionStatus().then((canInstall) => {
        if (canInstall === false) setNeedsPermission(true);
      });
    } catch (downloadError) {
      setDownloadProgress(null);
      setActionStatus(null);
      const msg = downloadError instanceof Error ? downloadError.message : String(downloadError);
      if (msg.includes("cancelled")) {
        setActionStatus(null);
      } else {
        setActionError(msg);
      }
    } finally {
      unsubscribe();
      setDownloading(false);
    }
  };

  const handleCancelDownload = async () => {
    await cancelDownload();
  };

  const handleInstall = async () => {
    if (!downloadedPath) return;
    setActionError(null);
    try {
      const result = await installDownloadedApk(downloadedPath);
      if (result.needsPermission) {
        setNeedsPermission(true);
        setActionStatus(t("doctor.updateNeedPermission"));
        return;
      }
      setActionStatus(t("doctor.updateInstalling"));
    } catch (installError) {
      setActionError(installError instanceof Error ? installError.message : String(installError));
    }
  };

  const handleOpenPermission = async () => {
    setActionError(null);
    try {
      await openInstallPermissionSettings();
      setActionStatus(t("doctor.updatePermissionOpened"));
    } catch (permissionError) {
      setActionError(permissionError instanceof Error ? permissionError.message : String(permissionError));
    }
  };

  return (
    <div className={`border ${c.cardStatic} rounded-lg p-5`}>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-base font-semibold">
            <PackageCheck size={18} className="text-primary" />
            {t("doctor.updateTitle")}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {available ? t("doctor.updateAvailable") : data?.ok ? t("doctor.updateReady") : t("doctor.updateNoManifest")}
          </p>
        </div>
        <button
          onClick={() => {
            setActionError(null);
            setActionStatus(null);
            void refetch();
          }}
          className={`inline-flex h-9 items-center justify-center gap-2 rounded-md px-3 text-sm font-medium ${c.btnSecondary}`}
        >
          <RefreshCw size={15} className={loading ? "animate-spin" : ""} />
          {t("doctor.updateCheck")}
        </button>
      </div>

      <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <UpdateMeta label={t("doctor.updateCurrent")} value={currentLabel} />
        <UpdateMeta label={t("doctor.updateLatest")} value={latestLabel} />
        <UpdateMeta label={t("doctor.updateChannel")} value={update?.channel ?? "-"} />
        <UpdateMeta label={t("doctor.updateSize")} value={formatBytes(update?.size ?? 0)} />
      </div>

      {update?.notes?.length ? (
        <div className="mt-4 space-y-1 text-sm text-muted-foreground">
          {update.notes.slice(0, 3).map((note) => (
            <div key={note} className="truncate">- {note}</div>
          ))}
        </div>
      ) : null}

      {available && (
        <div className="mt-5">
          <div className="mb-2 flex items-center justify-between gap-3">
            <span className="text-xs font-semibold uppercase text-muted-foreground">{t("doctor.updateSources")}</span>
            <span className="truncate text-xs text-muted-foreground">{t("doctor.updateChecksumHint")}</span>
          </div>
          <div className="mb-3 flex flex-wrap gap-2">
            <button
              disabled={!native || pingingSources}
              onClick={() => void pingSources()}
              className={`inline-flex h-9 items-center justify-center gap-2 rounded-md px-3 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50 ${c.btnSecondary}`}
            >
              <RefreshCw size={15} className={pingingSources ? "animate-spin" : ""} />
              {pingingSources ? t("doctor.updatePinging") : t("doctor.updatePingSources")}
            </button>
            <button
              disabled={!native || !selectedSource || downloading}
              onClick={() => void handleDownload()}
              className={`inline-flex h-9 items-center justify-center gap-2 rounded-md px-3 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50 ${c.btnPrimary}`}
            >
              <Download size={15} />
              {t("doctor.updateDownloadFastest")}
            </button>
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
            {downloadSources.map((source) => (
              <button
                key={source.id}
                disabled={!native || downloading}
                onClick={() => {
                  setSelectedSourceId(source.id);
                  void handleDownload(source);
                }}
                className={`inline-flex h-10 min-w-0 items-center justify-center gap-2 rounded-md border px-3 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50 ${
                  selectedSource?.id === source.id
                    ? "border-primary bg-primary/10 text-primary"
                    : `border-border/60 ${source.primary ? c.btnPrimary : c.btnSecondary}`
                }`}
                title={source.url}
              >
                <Download size={15} className="shrink-0" />
                <span className="min-w-0">
                  <span className="block truncate">{source.label}</span>
                  <span className="block truncate text-[10px] opacity-70">
                    {pingingSources && !sourcePings[source.id]
                      ? t("doctor.updatePinging")
                      : sourcePings[source.id]?.ok
                        ? `${sourcePings[source.id].latencyMs}ms`
                        : sourcePings[source.id]
                          ? t("doctor.updateSourceFailed")
                          : t("doctor.updateNotPinged")}
                  </span>
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="mt-5 flex flex-wrap gap-2">
        <button
          disabled={!native || !downloadedPath}
          onClick={() => void handleInstall()}
          className={`inline-flex h-9 items-center justify-center gap-2 rounded-md px-3 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50 ${c.btnSecondary}`}
        >
          <ShieldCheck size={15} />
          {t("doctor.updateInstall")}
        </button>
        {needsPermission && (
          <button
            onClick={() => void handleOpenPermission()}
            className={`inline-flex h-9 items-center justify-center gap-2 rounded-md px-3 text-sm font-medium ${c.btnSecondary}`}
          >
            <ShieldCheck size={15} />
            {t("doctor.updatePermission")}
          </button>
        )}
      </div>

      {/* Download dialog */}
      {downloading && createPortal(
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm" style={{ animation: "fadeIn 0.2s ease-out" }}>
          <div className="mx-4 w-full max-w-sm rounded-2xl border border-border/40 bg-card p-6 shadow-2xl" style={{ animation: "fadeIn 0.3s ease-out" }}>
            <div className="flex items-center gap-3 mb-5">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/15">
                <Download size={20} className="text-primary animate-pulse" />
              </div>
              <div>
                <h3 className="text-sm font-bold text-foreground">
                  {downloadProgress ? `正在下载 ${downloadProgress.percent}%` : "正在准备下载..."}
                </h3>
                <p className="text-xs text-muted-foreground">
                  {update?.versionName ? `v${update.versionName}` : ""}
                  {selectedSource ? ` · ${selectedSource.label}` : ""}
                </p>
              </div>
            </div>

            {/* Progress bar */}
            <div className="h-2.5 w-full rounded-full bg-muted/60 overflow-hidden mb-4">
              <div
                className="h-full rounded-full bg-gradient-to-r from-primary/60 via-primary to-accent/60 transition-all duration-300"
                style={{ width: `${downloadProgress?.percent ?? 0}%` }}
              >
                <div className="h-full w-full relative overflow-hidden">
                  <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/30 to-transparent" style={{ animation: "splash-shimmer 1.5s ease-in-out infinite" }} />
                </div>
              </div>
            </div>

            {/* Stats */}
            <div className="grid grid-cols-3 gap-3 mb-5">
              <div className="text-center">
                <p className="text-xs text-muted-foreground">已下载</p>
                <p className="text-sm font-semibold tabular-nums">{formatBytes(downloadProgress?.bytesDownloaded ?? 0)}</p>
              </div>
              <div className="text-center">
                <p className="text-xs text-muted-foreground">总大小</p>
                <p className="text-sm font-semibold tabular-nums">{formatBytes(downloadProgress?.totalBytes ?? 0)}</p>
              </div>
              <div className="text-center">
                <p className="text-xs text-muted-foreground">速度</p>
                <p className="text-sm font-semibold tabular-nums">{formatBytes(downloadProgress?.speedBytesPerSec ?? 0)}/s</p>
              </div>
            </div>

            {/* Source URL */}
            {selectedSource && (
              <p className="text-[10px] text-muted-foreground/60 truncate mb-4" title={selectedSource.url}>
                {selectedSource.url}
              </p>
            )}

            <button
              onClick={() => void handleCancelDownload()}
              className="w-full h-10 rounded-xl border border-destructive/30 bg-destructive/5 text-sm font-medium text-destructive hover:bg-destructive/10 transition-colors"
            >
              取消下载
            </button>
          </div>
        </div>,
        document.body,
      )}

      {!native && <p className="mt-3 text-sm text-muted-foreground">{t("doctor.updateUnsupported")}</p>}
      {error && <p className="mt-3 text-sm text-destructive">{error}</p>}
      {data?.error && <p className="mt-3 text-sm text-destructive">{data.error}</p>}
      {actionStatus && <p className="mt-3 text-sm text-emerald-600">{actionStatus}</p>}
      {actionError && <p className="mt-3 text-sm text-destructive">{actionError}</p>}
      <p className="mt-3 truncate text-xs text-muted-foreground">{data?.manifestUrl ?? ""}</p>
    </div>
  );
}

function StorageRepairPanel({ theme, t, onRepaired }: {
  readonly theme: Theme;
  readonly t: TFunction;
  readonly onRepaired: () => void;
}) {
  const c = useColors(theme);
  const [repairing, setRepairing] = useState(false);
  const [result, setResult] = useState<StorageRepairResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleRepair = async () => {
    const confirmed = await appConfirm({
      title: t("doctor.repairConfirmTitle"),
      message: t("doctor.repairConfirmMessage"),
      confirmLabel: t("doctor.repairAction"),
      cancelLabel: t("common.cancel"),
      tone: "danger",
    });
    if (!confirmed) return;

    setRepairing(true);
    setError(null);
    try {
      const repairResult = await postApi<StorageRepairResult>("/runtime/repair");
      setResult(repairResult);
      onRepaired();
    } catch (repairError) {
      setResult(null);
      setError(repairError instanceof Error ? repairError.message : String(repairError));
    } finally {
      setRepairing(false);
    }
  };

  return (
    <div className={`border ${c.cardStatic} rounded-lg p-5`}>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-base font-semibold">
            <DatabaseBackup size={18} className="text-primary" />
            {t("doctor.repairTitle")}
          </h2>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">
            {t("doctor.repairDescription")}
          </p>
        </div>
        <button
          disabled={repairing}
          onClick={() => void handleRepair()}
          className={`inline-flex h-10 shrink-0 items-center justify-center gap-2 rounded-md px-4 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-60 ${c.btnPrimary}`}
        >
          {repairing ? <Loader2 size={16} className="animate-spin" /> : <Wrench size={16} />}
          {repairing ? t("doctor.repairing") : t("doctor.repairAction")}
        </button>
      </div>

      {result ? (
        <div className="mt-4 rounded-lg border border-emerald-500/20 bg-emerald-500/8 px-4 py-3 text-sm text-emerald-700 dark:text-emerald-300">
          <div className="flex items-center gap-2 font-medium">
            <CheckCircle2 size={16} />
            {t("doctor.repairComplete")}
          </div>
          <p className="mt-1 leading-6">
            {t("doctor.repairSummary")
              .replace("{books}", String(result.booksChecked))
              .replace("{worlds}", String(result.worldsRemoved))}
          </p>
          <p className="mt-1 truncate text-xs opacity-70" title={result.backupDir}>
            {t("doctor.repairBackup")}: {result.backupDir}
          </p>
        </div>
      ) : null}
      {error ? <p className="mt-4 text-sm text-destructive">{error}</p> : null}
    </div>
  );
}

export function DoctorView({ nav, theme, t }: { nav: Nav; theme: Theme; t: TFunction }) {
  const c = useColors(theme);
  const { data, refetch } = useApi<DoctorChecks>("/doctor");

  return (
    <div className="space-y-8">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <button onClick={nav.toDashboard} className={c.link}>{t("bread.home")}</button>
        <span className="text-border">/</span>
        <span>{t("nav.doctor")}</span>
      </div>

      <div className="flex items-center justify-between">
        <h1 className="font-serif text-3xl flex items-center gap-3">
          <Stethoscope size={28} className="text-primary" />
          {t("doctor.title")}
        </h1>
        <button onClick={() => refetch()} className={`px-4 py-2 text-sm rounded-lg ${c.btnSecondary}`}>
          {t("doctor.recheck")}
        </button>
      </div>

      {!data ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 size={24} className="animate-spin text-primary" />
        </div>
      ) : (
        <div className={`border ${c.cardStatic} rounded-lg p-5`}>
          <CheckRow label={t("doctor.inkosJson")} ok={data.inkosJson} />
          <CheckRow label={t("doctor.projectEnv")} ok={data.projectEnv} />
          <CheckRow label={t("doctor.globalEnv")} ok={data.globalEnv} />
          <CheckRow label={t("doctor.booksDir")} ok={data.booksDir} detail={`${data.bookCount} book(s)`} />
          <CheckRow label={t("doctor.llmApi")} ok={data.llmConnected} detail={data.llmConnected ? t("doctor.connected") : t("doctor.failed")} />
        </div>
      )}

      {data && (
        <div className={`px-4 py-3 rounded-lg text-sm font-medium ${
          data.inkosJson && (data.projectEnv || data.globalEnv) && data.llmConnected
            ? "bg-emerald-500/10 text-emerald-600"
            : "bg-amber-500/10 text-amber-600"
        }`}>
          {data.inkosJson && (data.projectEnv || data.globalEnv) && data.llmConnected
            ? t("doctor.allPassed")
            : t("doctor.someFailed")
          }
        </div>
      )}

      <StorageRepairPanel theme={theme} t={t} onRepaired={() => refetch()} />

      <UpdatePanel theme={theme} t={t} />
    </div>
  );
}
