import { useApi } from "../hooks/use-api";
import { useState } from "react";
import type { Theme } from "../hooks/use-theme";
import type { TFunction } from "../hooks/use-i18n";
import { useColors } from "../hooks/use-colors";
import { Stethoscope, CheckCircle2, XCircle, Loader2, RefreshCw, Download, ShieldCheck, PackageCheck } from "lucide-react";
import { downloadUpdateApk, installDownloadedApk, openInstallPermissionSettings } from "../lib/android-runtime-plugin";
import { isNativeRuntime } from "../lib/mobile-runtime";

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

function UpdatePanel({ theme, t }: { theme: Theme; t: TFunction }) {
  const c = useColors(theme);
  const native = isNativeRuntime();
  const { data, error, loading, refetch } = useApi<RuntimeUpdateCheck>("/runtime/update/check");
  const [downloadedPath, setDownloadedPath] = useState<string | null>(null);
  const [actionStatus, setActionStatus] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [needsPermission, setNeedsPermission] = useState(false);
  const update = data?.update ?? null;
  const available = Boolean(data?.available && update);
  const currentLabel = data?.current.versionCode
    ? `${data.current.versionName || "-"} (${data.current.versionCode})`
    : "-";
  const latestLabel = update ? `${update.versionName} (${update.versionCode})` : "-";

  const handleDownload = async () => {
    if (!update) return;
    setActionError(null);
    setNeedsPermission(false);
    setActionStatus(t("doctor.updateDownloading"));
    try {
      const result = await downloadUpdateApk({
        url: update.apkUrl,
        sha256: update.apkSha256,
        fileName: `inkos-studio-${update.versionName}.apk`,
      });
      setDownloadedPath(result.path);
      setActionStatus(t("doctor.updateDownloaded"));
    } catch (downloadError) {
      setActionStatus(null);
      setActionError(downloadError instanceof Error ? downloadError.message : String(downloadError));
    }
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

      <div className="mt-5 flex flex-wrap gap-2">
        <button
          disabled={!native || !available}
          onClick={() => void handleDownload()}
          className={`inline-flex h-9 items-center justify-center gap-2 rounded-md px-3 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50 ${c.btnPrimary}`}
        >
          <Download size={15} />
          {t("doctor.updateDownload")}
        </button>
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

      {!native && <p className="mt-3 text-sm text-muted-foreground">{t("doctor.updateUnsupported")}</p>}
      {error && <p className="mt-3 text-sm text-destructive">{error}</p>}
      {data?.error && <p className="mt-3 text-sm text-destructive">{data.error}</p>}
      {actionStatus && <p className="mt-3 text-sm text-emerald-600">{actionStatus}</p>}
      {actionError && <p className="mt-3 text-sm text-destructive">{actionError}</p>}
      <p className="mt-3 truncate text-xs text-muted-foreground">{data?.manifestUrl ?? ""}</p>
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

      <UpdatePanel theme={theme} t={t} />
    </div>
  );
}
