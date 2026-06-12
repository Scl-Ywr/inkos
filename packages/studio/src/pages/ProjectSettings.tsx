import { useEffect, useMemo, useState } from "react";
import { Bell, Bot, Radar, Settings2, Plus, Trash2, RotateCcw } from "lucide-react";
import { fetchJson, putApi, useApi } from "../hooks/use-api";
import type { Theme } from "../hooks/use-theme";
import type { TFunction } from "../hooks/use-i18n";
import { useColors } from "../hooks/use-colors";
import {
  AGENT_MODEL_ROUTES,
  buildAgentModelOverrides,
  buildDetectionConfig,
  buildNotifyChannel,
  DEFAULT_DETECTION,
  detectionDraftFromConfig,
  fixedAgentOverrideRows,
  modelRouteValue,
  notifyDraftFromChannel,
  NOTIFY_TYPES,
  parseModelRouteValue,
  type AgentModelRouteKey,
  type DetectionDraft,
  type NotifyChannelDraft,
  type NotifyType,
  type OverrideRow,
} from "./project-settings-model";
import { StudioSelect } from "../components/StudioSelect";
import { useServiceStore } from "../store/service/store";

interface Nav {
  toDashboard: () => void;
  toServices: () => void;
}

type NoticeTone = "success" | "error" | "info";

// Smooth open/close via grid-template-rows (same trick as the sidebar).
function Collapse({ open, children }: { open: boolean; children: React.ReactNode }) {
  return (
    <div className={`grid transition-[grid-template-rows] duration-200 ease-out ${open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"}`}>
      <div className="overflow-hidden">{children}</div>
    </div>
  );
}

function SettingsCard({
  title,
  description,
  icon,
  children,
}: {
  title: string;
  description: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-border/50 bg-card/70 p-5 shadow-sm space-y-4">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 rounded-xl bg-primary/10 p-2 text-primary">{icon}</div>
        <div>
          <h2 className="text-base font-bold">{title}</h2>
          <p className="mt-1 text-sm text-muted-foreground leading-relaxed">{description}</p>
        </div>
      </div>
      {children}
    </section>
  );
}

function ParameterLabel({ label, hint }: { label: React.ReactNode; hint: string }) {
  return (
    <span className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
      <span>{label}</span>
      <span className="text-[11px] font-normal leading-4 text-muted-foreground/55">{hint}</span>
    </span>
  );
}

const fieldClass = "w-full rounded-lg border border-border bg-secondary/30 px-3 py-2 text-sm outline-none focus:border-primary/50";
const DEFAULT_MODEL_SENTINEL = "__default__";

export function ProjectSettings({ nav, theme, t }: { nav: Nav; theme: Theme; t: TFunction }) {
  const c = useColors(theme);
  const { data: overridesData, refetch: refetchOverrides } = useApi<{ overrides: Record<string, unknown> }>("/project/model-overrides");
  const { data: notifyData, refetch: refetchNotify } = useApi<{ channels: unknown[] }>("/project/notify");
  const { data: modeData, refetch: refetchMode } = useApi<{ mode: "legacy" | "v2" }>("/project/input-governance-mode");
  const { data: detectionData, refetch: refetchDetection } = useApi<{ detection: unknown | null }>("/project/detection");
  const [mode, setMode] = useState<"legacy" | "v2">("v2");
  const [overrideRows, setOverrideRows] = useState<OverrideRow[]>([]);
  const [notifyChannels, setNotifyChannels] = useState<NotifyChannelDraft[]>([]);
  const [det, setDet] = useState<DetectionDraft>({ ...DEFAULT_DETECTION });
  const [notice, setNotice] = useState<{ tone: NoticeTone; message: string } | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const services = useServiceStore((state) => state.services);
  const modelsByService = useServiceStore((state) => state.modelsByService);
  const fetchServices = useServiceStore((state) => state.fetchServices);
  const fetchBankModels = useServiceStore((state) => state.fetchBankModels);
  const fetchCustomModels = useServiceStore((state) => state.fetchCustomModels);

  useEffect(() => {
    void fetchServices();
    void fetchBankModels();
    void fetchCustomModels();
  }, [fetchBankModels, fetchCustomModels, fetchServices]);

  useEffect(() => {
    if (modeData?.mode) setMode(modeData.mode);
  }, [modeData]);

  useEffect(() => {
    if (!overridesData) return;
    setOverrideRows(fixedAgentOverrideRows(overridesData.overrides));
  }, [overridesData]);

  useEffect(() => {
    if (!notifyData) return;
    setNotifyChannels((notifyData.channels ?? []).map(notifyDraftFromChannel));
  }, [notifyData]);

  useEffect(() => {
    if (!detectionData) return;
    setDet(detectionDraftFromConfig(detectionData.detection));
  }, [detectionData]);

  const runSave = async (key: string, work: () => Promise<void>, success: string) => {
    setSaving(key);
    setNotice(null);
    try {
      await work();
      setNotice({ tone: "success", message: success });
    } catch (e) {
      setNotice({ tone: "error", message: e instanceof Error ? e.message : String(e) });
    } finally {
      setSaving(null);
    }
  };

  const updateChannel = (index: number, patch: Partial<NotifyChannelDraft>) => {
    setNotifyChannels((prev) => prev.map((ch, i) => (i === index ? { ...ch, ...patch } : ch)));
  };

  const updateOverrideModel = (agent: AgentModelRouteKey, service: string | undefined, model: string) => {
    setOverrideRows((prev) => {
      const rows = prev.length > 0 ? prev : fixedAgentOverrideRows({});
      return rows.map((row) => row.agent === agent ? { ...row, service, model } : row);
    });
  };

  const modelOptions = useMemo(() => {
    const known = new Map<string, string>();
    for (const serviceInfo of services.filter((item) => item.connected)) {
      for (const model of modelsByService[serviceInfo.service] ?? []) {
        const id = model.id.trim();
        const service = serviceInfo.service.trim();
        if (!id || !service) continue;
        const value = modelRouteValue(service, id);
        if (!known.has(value)) known.set(value, `${serviceInfo.label} · ${model.name ?? id}`);
      }
    }
    return [
      { value: DEFAULT_MODEL_SENTINEL, label: "使用默认模型" },
      ...Array.from(known, ([value, label]) => ({ value, label })),
    ];
  }, [modelsByService, services]);

  useEffect(() => {
    if (modelOptions.length <= 1) return;
    setOverrideRows((rows) => rows.map((row) => {
      if (!row.model.trim() || row.service?.trim()) return row;
      const matches = modelOptions
        .map((option) => parseModelRouteValue(option.value))
        .filter((selection) => selection?.model === row.model);
      return matches.length === 1
        ? { ...row, service: matches[0]!.service }
        : row;
    }));
  }, [modelOptions]);

  return (
    <div className="space-y-8">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <button onClick={nav.toDashboard} className={c.link}>{t("bread.home")}</button>
        <span className="text-border">/</span>
        <span>{t("settings.title")}</span>
      </div>

      <div className="space-y-2">
        <h1 className="font-serif text-3xl flex items-center gap-3">
          <Settings2 size={28} className="text-primary" />
          {t("settings.title")}
        </h1>
        <p className="text-sm text-muted-foreground">{t("settings.subtitle")}</p>
      </div>

      {notice && (
        <div
          className={`rounded-xl px-4 py-3 text-sm ${
            notice.tone === "error"
              ? "bg-destructive/10 text-destructive"
              : notice.tone === "info"
                ? "bg-secondary text-muted-foreground"
                : "bg-emerald-500/10 text-emerald-600"
          }`}
        >
          {notice.message}
        </div>
      )}

      <SettingsCard title={t("settings.inputGovernance")} description={t("settings.inputGovernanceHint")} icon={<Radar size={18} />}>
        <div className="flex flex-wrap items-center gap-3">
          <StudioSelect<"legacy" | "v2">
            value={mode}
            onValueChange={setMode}
            options={[
              { value: "v2", label: "v2" },
              { value: "legacy", label: "legacy" },
            ]}
            triggerClassName="min-h-10 w-32 bg-secondary/30"
          />
          <span className="text-xs leading-5 text-muted-foreground/60">
            v2 使用分层上下文和预算控制；legacy 保留旧版输入拼接方式。
          </span>
          <button
            onClick={() => runSave("mode", async () => {
              await putApi("/project/input-governance-mode", { mode });
              await refetchMode();
            }, t("settings.saved"))}
            disabled={saving === "mode"}
            className={`rounded-lg px-4 py-2 text-sm font-bold ${c.btnPrimary} disabled:opacity-40`}
          >
            {saving === "mode" ? t("config.saving") : t("config.save")}
          </button>
        </div>
      </SettingsCard>

      {/* Model routing — per-agent model overrides */}
      <SettingsCard title={t("settings.modelOverrides")} description={t("settings.modelOverridesHint")} icon={<Bot size={18} />}>
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
          {AGENT_MODEL_ROUTES.map((route) => {
            const index = overrideRows.findIndex((row) => row.agent === route.agent);
            const row = index >= 0 ? overrideRows[index] : { agent: route.agent, model: "" };
            const selectedValue = row.model.trim() && row.service?.trim()
              ? modelRouteValue(row.service, row.model)
              : DEFAULT_MODEL_SENTINEL;
            return (
              <div key={route.agent} className="rounded-xl border border-border/60 bg-secondary/20 p-3">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="text-sm font-bold text-foreground">{route.label} Agent</div>
                    <div className="mt-0.5 font-mono text-[11px] text-muted-foreground/60">{route.agent}</div>
                  </div>
                  {row.model.trim() && (
                    <button
                      onClick={() => setOverrideRows((prev) => {
                        const rows = prev.length > 0 ? prev : fixedAgentOverrideRows({});
                        return rows.map((item) => item.agent === route.agent ? { ...item, service: undefined, model: "" } : item);
                      })}
                      className="rounded-lg p-1.5 text-muted-foreground hover:bg-secondary hover:text-foreground"
                      aria-label="reset"
                      title="恢复默认模型"
                    >
                      <RotateCcw size={14} />
                    </button>
                  )}
                </div>
                <p className="mt-2 min-h-10 text-xs leading-5 text-muted-foreground/65">{route.hint}</p>
                <StudioSelect<string>
                  value={selectedValue}
                  onValueChange={(value) => {
                    if (value === DEFAULT_MODEL_SENTINEL) {
                      updateOverrideModel(route.agent, undefined, "");
                      return;
                    }
                    const selection = parseModelRouteValue(value);
                    if (selection) updateOverrideModel(route.agent, selection.service, selection.model);
                  }}
                  options={modelOptions}
                  triggerClassName="mt-3 min-h-10 bg-background/70"
                  contentClassName="min-w-[18rem]"
                />
              </div>
            );
          })}
        </div>
        {modelOptions.length === 1 && (
          <div className="rounded-lg border border-dashed border-border/70 bg-secondary/20 px-4 py-3 text-sm text-muted-foreground">
            暂无可选模型。请先前往模型配置连接服务并完成模型测试。
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => setOverrideRows(fixedAgentOverrideRows({}))}
            className={`flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium ${c.btnSecondary}`}
          >
            <RotateCcw size={14} /> 全部使用默认模型
          </button>
          <button
            onClick={() => runSave("overrides", async () => {
              const overrides = buildAgentModelOverrides(overrideRows);
              await putApi("/project/model-overrides", { overrides });
              await refetchOverrides();
            }, t("settings.saved"))}
            disabled={saving === "overrides"}
            className={`rounded-lg px-4 py-2 text-sm font-bold ${c.btnPrimary} disabled:opacity-40`}
          >
            {saving === "overrides" ? t("config.saving") : t("config.save")}
          </button>
          <button onClick={nav.toServices} className={`rounded-lg px-4 py-2 text-sm font-bold ${c.btnSecondary}`}>
            {t("settings.openModelConfig")}
          </button>
        </div>
      </SettingsCard>

      {/* Notification channels */}
      <SettingsCard title={t("settings.notify")} description={t("settings.notifyHint")} icon={<Bell size={18} />}>
        <div className="space-y-3">
          {notifyChannels.length === 0 && (
            <p className="text-xs text-muted-foreground italic">{t("settings.noChannels")}</p>
          )}
          {notifyChannels.map((ch, i) => (
            <div key={i} className="rounded-xl border border-border/60 bg-secondary/20 p-3 space-y-2">
              <div className="flex items-center gap-2">
                <StudioSelect<NotifyType>
                  value={ch.type}
                  onValueChange={(type) => updateChannel(i, { type })}
                  options={NOTIFY_TYPES.map((nt) => ({ value: nt.value, label: nt.label }))}
                  triggerClassName="min-h-10 w-40 bg-background/70"
                />
                <span className="text-[11px] text-muted-foreground/55">选择完成事件的推送通道</span>
                <div className="flex-1" />
                <button
                  onClick={() => setNotifyChannels((prev) => prev.filter((_, j) => j !== i))}
                  className="rounded-lg p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition-colors"
                  aria-label="remove"
                >
                  <Trash2 size={15} />
                </button>
              </div>
              {ch.type === "telegram" && (
                <div className="grid grid-cols-2 gap-2">
                  <input value={ch.botToken ?? ""} onChange={(e) => updateChannel(i, { botToken: e.target.value })} placeholder="botToken" className={`${fieldClass} font-mono`} />
                  <input value={ch.chatId ?? ""} onChange={(e) => updateChannel(i, { chatId: e.target.value })} placeholder="chatId" className={`${fieldClass} font-mono`} />
                </div>
              )}
              {(ch.type === "feishu" || ch.type === "wechat-work") && (
                <input value={ch.webhookUrl ?? ""} onChange={(e) => updateChannel(i, { webhookUrl: e.target.value })} placeholder="webhookUrl" className={`${fieldClass} font-mono`} />
              )}
              {ch.type === "webhook" && (
                <div className="grid grid-cols-2 gap-2">
                  <input value={ch.url ?? ""} onChange={(e) => updateChannel(i, { url: e.target.value })} placeholder="url" className={`${fieldClass} font-mono`} />
                  <input value={ch.secret ?? ""} onChange={(e) => updateChannel(i, { secret: e.target.value })} placeholder="secret (可选)" className={`${fieldClass} font-mono`} />
                </div>
              )}
            </div>
          ))}
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => setNotifyChannels((prev) => [...prev, { type: "feishu" }])}
            className={`flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium ${c.btnSecondary}`}
          >
            <Plus size={14} /> {t("settings.addChannel")}
          </button>
          <button
            onClick={() => runSave("notify", async () => {
              await putApi("/project/notify", { channels: notifyChannels.map(buildNotifyChannel) });
              await refetchNotify();
            }, t("settings.saved"))}
            disabled={saving === "notify"}
            className={`rounded-lg px-4 py-2 text-sm font-bold ${c.btnPrimary} disabled:opacity-40`}
          >
            {saving === "notify" ? t("config.saving") : t("config.save")}
          </button>
        </div>
      </SettingsCard>

      {/* AIGC detection */}
      <SettingsCard title={t("settings.detection")} description={t("settings.detectionHint")} icon={<Radar size={18} />}>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={det.enabled} onChange={(e) => setDet((d) => ({ ...d, enabled: e.target.checked }))} />
          {t("settings.detectionEnable")}
        </label>
        <Collapse open={det.enabled}>
          <div className="space-y-2 pt-1">
            <div className="grid grid-cols-2 gap-2">
              <label className="text-xs text-muted-foreground space-y-1">
                <ParameterLabel label={t("settings.detectionProvider")} hint="检测服务类型" />
                <StudioSelect
                  value={det.provider}
                  onValueChange={(provider) => setDet((d) => ({ ...d, provider }))}
                  options={[
                    { value: "custom", label: "custom" },
                    { value: "gptzero", label: "gptzero" },
                    { value: "originality", label: "originality" },
                  ]}
                  triggerClassName="min-h-10 bg-secondary/30"
                />
              </label>
              <label className="text-xs text-muted-foreground space-y-1">
                <ParameterLabel label={t("settings.detectionApiKeyEnv")} hint="存放密钥的环境变量名" />
                <input value={det.apiKeyEnv} onChange={(e) => setDet((d) => ({ ...d, apiKeyEnv: e.target.value }))} placeholder="DETECTOR_API_KEY" className={`${fieldClass} font-mono`} />
              </label>
            </div>
            <label className="text-xs text-muted-foreground space-y-1 block">
              <ParameterLabel label={t("settings.detectionApiUrl")} hint="检测接口地址；custom 模式必须填写" />
              <input value={det.apiUrl} onChange={(e) => setDet((d) => ({ ...d, apiUrl: e.target.value }))} placeholder="https://..." className={`${fieldClass} font-mono`} />
            </label>
            <div className="grid grid-cols-2 gap-2">
              <label className="text-xs text-muted-foreground space-y-1">
                <ParameterLabel label={`${t("settings.detectionThreshold")} (0–1)`} hint="超过该值视为风险；越低越严格" />
                <input type="number" min={0} max={1} step={0.05} value={det.threshold} onChange={(e) => setDet((d) => ({ ...d, threshold: Number(e.target.value) }))} className={fieldClass} />
              </label>
              <label className="text-xs text-muted-foreground space-y-1">
                <ParameterLabel label={`${t("settings.detectionMaxRetries")} (1–10)`} hint="检测或改写失败后的最大重试次数" />
                <input type="number" min={1} max={10} step={1} value={det.maxRetries} onChange={(e) => setDet((d) => ({ ...d, maxRetries: Number(e.target.value) }))} className={fieldClass} />
              </label>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={det.autoRewrite} onChange={(e) => setDet((d) => ({ ...d, autoRewrite: e.target.checked }))} />
              <ParameterLabel label={t("settings.detectionAutoRewrite")} hint="命中阈值后自动尝试降低 AI 痕迹" />
            </label>
          </div>
        </Collapse>
        <button
          onClick={() => runSave("detection", async () => {
            const payload = { detection: buildDetectionConfig(det) };
            await fetchJson("/project/detection", {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(payload),
            });
            await refetchDetection();
          }, t("settings.saved"))}
          disabled={saving === "detection"}
          className={`rounded-lg px-4 py-2 text-sm font-bold ${c.btnPrimary} disabled:opacity-40`}
        >
          {saving === "detection" ? t("config.saving") : t("config.save")}
        </button>
      </SettingsCard>
    </div>
  );
}
