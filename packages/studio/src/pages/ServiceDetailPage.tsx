import { useState, useEffect } from "react";
import { fetchJson } from "../hooks/use-api";
import { useServiceStore } from "../store/service";
import { useChatStore } from "../store/chat";
import { AlertTriangle, ArrowLeft, CheckCircle2, Eye, EyeOff, Loader2, ShieldCheck, Trash2 } from "lucide-react";
import { ServiceQuickLinks } from "../components/ServiceQuickLinks";
import { StudioSelect } from "../components/StudioSelect";
import { appConfirm } from "../lib/app-dialog";
import {
  deleteServiceConfig,
  matchServiceConfigEntryForDetail,
  probeServiceForDetail,
  rehydrateServiceConnectionStatus,
  saveServiceConfig,
  type ServiceDetailConnectionStatus as ConnectionStatus,
  type ServiceDetailDetectedConfig as DetectedConfig,
  type ServiceDetailModelInfo as ModelInfo,
  type ServiceDetailOfficialVerification as OfficialVerification,
  type ServiceDetailVerifiedProbe as VerifiedProbe,
} from "./service-detail-state";

interface Nav {
  toServices: () => void;
}

function DetailSkeleton() {
  return (
    <div className="max-w-xl mx-auto space-y-6 animate-pulse">
      <div className="h-4 w-16 bg-muted rounded" />
      <div className="h-7 w-40 bg-muted rounded" />
      <div className="space-y-2"><div className="h-3 w-16 bg-muted/60 rounded" /><div className="h-10 w-full bg-muted/40 rounded-lg" /></div>
      <div className="h-9 w-24 bg-muted/40 rounded-lg" />
    </div>
  );
}

export function ServiceDetailPage({ serviceId, nav }: { serviceId: string; nav: Nav }) {
  // -- Service store --
  const services = useServiceStore((s) => s.services);
  const loading = useServiceStore((s) => s.servicesLoading);
  const fetchServices = useServiceStore((s) => s.fetchServices);
  const refreshServices = useServiceStore((s) => s.refreshServices);
  const setStoreModels = useServiceStore((s) => s.setLiveModels);
  const clearStoreModels = useServiceStore((s) => s.clearModels);

  useEffect(() => { void fetchServices(); }, [fetchServices]);

  const svc = services.find((s) => s.service === serviceId);
  const isCustom = serviceId === "custom" || serviceId.startsWith("custom:");
  const persistedCustomName = serviceId.startsWith("custom:") ? decodeURIComponent(serviceId.slice("custom:".length)) : "";

  // -- Local form state --
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [customName, setCustomName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [temperature, setTemperature] = useState("0.7");
  const [apiFormat, setApiFormat] = useState<"chat" | "responses">("chat");
  const [stream, setStream] = useState(true);
  const [detectedModel, setDetectedModel] = useState<string>("");
  const [testModel, setTestModel] = useState<string>("");
  const [detectedConfig, setDetectedConfig] = useState<DetectedConfig | null>(null);
  const [officialVerification, setOfficialVerification] = useState<OfficialVerification | null>(null);
  const [verifiedProbe, setVerifiedProbe] = useState<VerifiedProbe | null>(null);

  // -- Unified connection status --
  const [status, setStatus] = useState<ConnectionStatus>({ state: "idle" });

  useEffect(() => {
    let cancelled = false;
    void fetchJson<{ services: Array<Record<string, unknown>> }>("/services/config")
      .then((data) => {
        if (cancelled) return;
        const matched = matchServiceConfigEntryForDetail(data.services ?? [], serviceId);
        if (!matched) return;
        if (isCustom) {
          setCustomName(String(matched.name ?? persistedCustomName));
          setBaseUrl(String(matched.baseUrl ?? ""));
        }
        if (typeof matched.temperature === "number") setTemperature(String(matched.temperature));
        if (matched.apiFormat === "chat" || matched.apiFormat === "responses") setApiFormat(matched.apiFormat);
        if (typeof matched.stream === "boolean") setStream(matched.stream);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [isCustom, persistedCustomName, serviceId]);

  const resolvedCustomName = persistedCustomName || customName.trim() || "Custom";
  const effectiveServiceId = isCustom ? `custom:${resolvedCustomName}` : serviceId;
  const hydrationServiceId = persistedCustomName ? `custom:${persistedCustomName}` : serviceId;
  const label = isCustom ? (customName || persistedCustomName || "自定义服务") : (svc?.label ?? serviceId);
  const storeModels = useServiceStore((s) => s.modelsByService[effectiveServiceId]);

  useEffect(() => {
    let cancelled = false;
    void rehydrateServiceConnectionStatus({
      effectiveServiceId: hydrationServiceId,
    })
      .then((result) => {
        if (cancelled) return;
        // Only hydrate if fields are empty (initial load), don't overwrite user edits
        setApiKey((prev) => prev || result.apiKey);
        setDetectedModel((prev) => prev || result.detectedModel);
        setTestModel((prev) => prev || result.detectedModel);
        setDetectedConfig((prev) => prev ?? result.detectedConfig);
        setStatus(result.status);
      })
      .catch(() => {
        if (cancelled) return;
        setStatus({ state: "idle" });
      });
    return () => { cancelled = true; };
  }, [hydrationServiceId]);

  if (loading) return <DetailSkeleton />;

  // -- Derived state --
  const isConnected = Boolean(svc?.connected);
  const models = status.state === "connected" ? status.models : (storeModels ?? []);
  const isBusy = status.state === "testing" || status.state === "saving";

  // -- Handlers --
  const handleTest = async () => {
    const trimmedKey = apiKey.trim();
    if (!trimmedKey && !isCustom) {
      setStatus({ state: "error", message: "请先输入 API Key" });
      return;
    }
    if (isCustom && !baseUrl.trim()) {
      setStatus({ state: "error", message: "请先填写 Base URL" });
      return;
    }
    setApiKey(trimmedKey);
    setStatus({ state: "testing" });
    try {
      const result = await probeServiceForDetail(effectiveServiceId, {
        apiKey: trimmedKey,
        apiFormat,
        stream,
        ...(isCustom ? { baseUrl: baseUrl.trim() } : {}),
        ...(testModel.trim() ? { model: testModel.trim() } : {}),
      });
      if (result.ok) {
        const models = result.models ?? [];
        const verifiedApiFormat = result.detected?.apiFormat ?? apiFormat;
        const verifiedStream = typeof result.detected?.stream === "boolean" ? result.detected.stream : stream;
        const verifiedBaseUrl = isCustom ? (result.detected?.baseUrl ?? baseUrl.trim()) : "";
        if (result.detected?.apiFormat) setApiFormat(result.detected.apiFormat);
        if (typeof result.detected?.stream === "boolean") setStream(result.detected.stream);
        if (isCustom && result.detected?.baseUrl) setBaseUrl(result.detected.baseUrl);
        setDetectedModel(result.selectedModel ?? "");
        setTestModel(result.selectedModel ?? testModel.trim());
        setDetectedConfig(result.detected ?? null);
        setOfficialVerification(result.official ?? null);
        setVerifiedProbe({
          apiKey: trimmedKey,
          baseUrl: verifiedBaseUrl,
          apiFormat: verifiedApiFormat,
          stream: verifiedStream,
          models,
          selectedModel: result.selectedModel ?? testModel.trim(),
          detected: result.detected,
          official: result.official,
        });
        setStatus({ state: "connected", models });
        setStoreModels(effectiveServiceId, models); // Write to global store
      } else {
        setVerifiedProbe(null);
        setOfficialVerification(result.official ?? null);
        setStatus({ state: "error", message: result.error ?? "连接失败" });
        clearStoreModels(effectiveServiceId);
      }
    } catch (e) {
      setVerifiedProbe(null);
      setOfficialVerification(null);
      setStatus({ state: "error", message: e instanceof Error ? e.message : "连接失败" });
    }
  };

  const handleDelete = async () => {
    if (!await appConfirm({
      title: "删除配置",
      message: `删除“${label}”的配置和密钥？`,
      confirmLabel: "删除",
      tone: "danger",
    })) return;
    setStatus({ state: "saving" });
    try {
      await deleteServiceConfig(effectiveServiceId);
      clearStoreModels(effectiveServiceId);
      await refreshServices();
      nav.toServices();
    } catch (e) {
      setStatus({ state: "error", message: e instanceof Error ? e.message : "删除失败" });
    }
  };

  const handleSave = async () => {
    const trimmedKey = apiKey.trim();
    setApiKey(trimmedKey);
    if (isCustom && !baseUrl.trim()) {
      setStatus({ state: "error", message: "请先填写 Base URL" });
      return;
    }
    setStatus({ state: "saving" });
    try {
      const result = await saveServiceConfig({
        effectiveServiceId,
        serviceId,
        isCustom,
        resolvedCustomName,
        apiKey: trimmedKey,
        baseUrl,
        apiFormat,
        stream,
        temperature,
        detectedModel,
        testModel,
        verifiedProbe,
      });
      if (result.status.state === "connected") {
        if (result.detectedConfig?.apiFormat) setApiFormat(result.detectedConfig.apiFormat);
        if (typeof result.detectedConfig?.stream === "boolean") setStream(result.detectedConfig.stream);
        if (isCustom && result.detectedConfig?.baseUrl) setBaseUrl(result.detectedConfig.baseUrl);
        setDetectedModel(result.detectedModel);
        setTestModel(result.detectedModel);
        setDetectedConfig(result.detectedConfig);
        setStoreModels(effectiveServiceId, result.status.models);
        if (result.detectedModel) {
          useChatStore.getState().setSelectedModel(result.detectedModel, effectiveServiceId);
        }
        setStatus(result.status);
      } else {
        setStatus(result.status);
        if (result.status.state === "error") return;
      }
      await refreshServices();
      nav.toServices();
    } catch (e) {
      setStatus({ state: "error", message: e instanceof Error ? e.message : "保存失败" });
    }
  };

  return (
    <div className="mx-auto max-w-3xl space-y-5 px-1 pb-24 sm:px-0 sm:pb-8">
      <button
        onClick={nav.toServices}
        className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-border/50 bg-card/70 px-3.5 py-2 text-sm font-medium text-foreground transition-colors hover:bg-secondary/50"
      >
        <ArrowLeft size={14} />
        返回服务商管理
      </button>

      <div className="rounded-2xl border border-border/50 bg-card/75 p-5 shadow-sm">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="truncate font-serif text-2xl">{label}</h1>
              {isConnected && (
                <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2.5 py-1 text-xs font-medium text-emerald-600 dark:text-emerald-400">
                  <CheckCircle2 size={13} />
                  已连接
                </span>
              )}
            </div>
            <p className="mt-2 text-sm leading-6 text-muted-foreground/75">
              先用官方连接验证确认 Key、模型列表和协议可用，再保存到 Studio 配置，避免把会触发 401/403 的配置写进去。
            </p>
          </div>
          <ServiceQuickLinks serviceId={serviceId} />
        </div>
      </div>

      <div className="rounded-2xl border border-border/50 bg-card/75 p-5 shadow-sm">
        <div className="mb-5">
          <h2 className="text-sm font-semibold">连接配置</h2>
          <p className="mt-1 text-xs leading-5 text-muted-foreground/70">
            Base URL、协议和流式设置会参与连接验证；修改后请重新测试再保存。
          </p>
        </div>

        {isCustom && (
          <div className="mb-4 grid gap-4 sm:grid-cols-2">
            <Field label="服务名称" hint="用于在模型列表和聊天页识别该自定义通道">
              <input type="text" value={customName} onChange={(e) => setCustomName(e.target.value)}
                placeholder="例如：本地 Ollama" className="min-h-11 w-full rounded-xl border border-border/60 bg-background px-3 py-2 text-base sm:text-sm" />
            </Field>
            <Field label="Base URL" hint="兼容服务的 API 根地址，通常以 /v1 结尾">
              <input type="text" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="https://api.example.com/v1" className="min-h-11 w-full rounded-xl border border-border/60 bg-background px-3 py-2 font-mono text-base sm:text-sm" />
            </Field>
          </div>
        )}

        <Field label="API Key" hint="服务商鉴权密钥；保存前可先测试连接">
          <div className="relative">
            <input
              type={showKey ? "text" : "password"} value={apiKey}
              onChange={(e) => setApiKey(e.target.value)} placeholder="sk-..."
              className="min-h-11 w-full rounded-xl border border-border/60 bg-background px-3 py-2 pr-12 font-mono text-base sm:text-sm"
            />
            <button type="button" onClick={() => setShowKey((v) => !v)}
              aria-label={showKey ? "隐藏 API Key" : "显示 API Key"}
              className="absolute right-1.5 top-1/2 inline-flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-lg text-muted-foreground/60 transition-colors hover:bg-secondary/60 hover:text-muted-foreground">
              {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          </div>
        </Field>

        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <Field label="测试模型" hint="测试时优先使用这个模型；留空则自动选择第一个文本模型">
            <input
              type="text"
              value={testModel}
              onChange={(e) => setTestModel(e.target.value)}
              placeholder="例如：claude-sonnet-4-6"
              className="min-h-11 w-full rounded-xl border border-border/60 bg-background px-3 py-2 font-mono text-base sm:text-sm"
            />
          </Field>
          <Field label="从已发现模型选择" hint="测试成功后可在这里切换要保存的默认模型">
            <StudioSelect<string>
              value={testModel || detectedModel || models[0]?.id || ""}
              onValueChange={(value) => setTestModel(value)}
              options={(models.length > 0 ? models : detectedModel ? [{ id: detectedModel, name: detectedModel }] : []).map((model) => ({
                value: model.id,
                label: model.name ?? model.id,
              }))}
              placeholder="先测试或手填模型"
              triggerClassName="min-h-11 bg-background/70 font-mono text-base sm:text-sm"
              contentClassName="font-mono"
            />
          </Field>
        </div>

        <div className="mt-5 grid gap-3 sm:flex sm:items-center">
          <button onClick={handleTest} disabled={isBusy}
            className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-border/60 px-4 py-2 text-sm font-medium transition-colors hover:bg-secondary/50 disabled:opacity-50">
            {status.state === "testing" && <Loader2 size={12} className="animate-spin" />}
            测试连接
          </button>
          <button onClick={handleSave} disabled={isBusy}
            className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50">
            {status.state === "saving" && <Loader2 size={12} className="animate-spin" />}
            保存
          </button>
          {(isConnected || isCustom) && (
            <button onClick={handleDelete} disabled={isBusy}
              className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-destructive/30 px-4 py-2 text-sm font-medium text-destructive transition-colors hover:bg-destructive/10 disabled:opacity-50">
              <Trash2 size={12} />
              删除配置
            </button>
          )}
        </div>

        <StatusPanel
          status={status}
          modelsCount={models.length}
          detectedModel={detectedModel}
          detectedConfig={detectedConfig}
        />
      </div>

      <OfficialVerificationSummary verification={officialVerification} />

      <div className="rounded-2xl border border-border/50 bg-card/75 p-5 shadow-sm">
        <div className="mb-4">
          <h2 className="text-sm font-semibold">协议与高级参数</h2>
          <p className="mt-1 text-xs leading-5 text-muted-foreground/70">
            一般保持官方验证自动识别的结果即可；只有兼容端点需要手动调整。
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="协议类型" hint="Chat 兼容面更广；Responses 适用于支持新版响应协议的端点">
            <StudioSelect<"chat" | "responses">
              value={apiFormat}
              onValueChange={setApiFormat}
              options={[
                { value: "chat", label: "Chat / Completions" },
                { value: "responses", label: "Responses" },
              ]}
              triggerClassName="min-h-11 bg-background/70 text-base sm:text-sm"
            />
          </Field>

          <Field label="流式响应" hint="开启后逐段显示模型输出；部分兼容网关需要关闭">
            <label className="flex min-h-11 items-center gap-3 rounded-xl border border-border/60 bg-background px-3 text-sm">
              <input
                type="checkbox"
                checked={stream}
                onChange={(e) => setStream(e.target.checked)}
              />
              <span>{stream ? "开启" : "关闭"}</span>
            </label>
          </Field>
        </div>

        {isConnected && (
          <div className="mt-5 space-y-2">
            <p className="text-xs text-muted-foreground/70 font-medium uppercase tracking-wider">
              可用模型（{models.length}）
            </p>
            {models.length > 0 ? (
              <div className="max-h-52 overflow-y-auto rounded-xl border border-border/35 bg-background/40 p-2">
                <div className="flex flex-wrap gap-1.5">
                {models.map((m) => (
                  <span key={m.id} className="text-[11px] px-2.5 py-1 rounded-md bg-emerald-500/[0.06] text-emerald-600 dark:text-emerald-400 border border-emerald-500/15">
                    {m.name ?? m.id}
                  </span>
                ))}
                </div>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground/60">点击“测试连接”查看可用模型</p>
            )}
          </div>
        )}

        <details className="group pt-2 border-t border-border/20">
          <summary className="text-xs text-muted-foreground/60 cursor-pointer select-none hover:text-muted-foreground transition-colors py-2">
            高级参数
          </summary>
          <div className="space-y-4 pt-2">
            <Field label="temperature" hint="控制随机性：0 更稳定，数值越高变化越大">
              <div className="flex items-center gap-3">
                <input type="range" min="0" max="2" step="0.05" value={temperature}
                  onChange={(e) => setTemperature(e.target.value)} className="flex-1 accent-primary h-1" />
                <input type="number" value={temperature} onChange={(e) => setTemperature(e.target.value)}
                  min="0" max="2" step="0.05" className="min-h-10 w-20 rounded-lg border border-border/60 bg-background px-2 py-1 text-right font-mono text-sm" />
              </div>
            </Field>
          </div>
        </details>
      </div>
    </div>
  );
}

function StatusPanel({
  status,
  modelsCount,
  detectedModel,
  detectedConfig,
}: {
  status: ConnectionStatus;
  modelsCount: number;
  detectedModel: string;
  detectedConfig: DetectedConfig | null;
}) {
  if (status.state === "idle") {
    return null;
  }
  if (status.state === "testing" || status.state === "saving") {
    return (
      <div className="mt-4 flex items-start gap-2 rounded-xl border border-border/40 bg-secondary/25 p-3 text-sm text-muted-foreground">
        <Loader2 size={16} className="mt-0.5 animate-spin" />
        {status.state === "testing" ? "正在使用官方连接验证测试服务商…" : "正在保存已验证的连接配置…"}
      </div>
    );
  }
  if (status.state === "error") {
    return (
      <div className="mt-4 flex items-start gap-2 whitespace-pre-wrap rounded-xl border border-destructive/25 bg-destructive/[0.04] p-3 text-sm leading-6 text-destructive">
        <AlertTriangle size={16} className="mt-1 shrink-0" />
        <span>{status.message}</span>
      </div>
    );
  }
  if (status.state === "saved") {
    return (
      <div className="mt-4 flex items-center gap-2 rounded-xl border border-emerald-500/25 bg-emerald-500/[0.05] p-3 text-sm text-emerald-600 dark:text-emerald-400">
        <CheckCircle2 size={16} />
        已保存
      </div>
    );
  }
  return (
    <div className="mt-4 rounded-xl border border-emerald-500/25 bg-emerald-500/[0.05] p-3 text-sm leading-6 text-emerald-700 dark:text-emerald-300">
      <div className="flex items-center gap-2 font-medium">
        <CheckCircle2 size={16} />
        连接成功，发现 {modelsCount} 个模型
      </div>
      {detectedModel ? (
        <p className="mt-1 text-xs text-emerald-700/80 dark:text-emerald-300/80">
          已自动匹配 {detectedModel}
          {detectedConfig ? ` / ${detectedConfig.apiFormat === "responses" ? "Responses" : "Chat"} / ${detectedConfig.stream ? "流式" : "非流式"}` : ""}
        </p>
      ) : null}
    </div>
  );
}

function OfficialVerificationSummary({ verification }: { verification: OfficialVerification | null }) {
  if (!verification) return null;
  const chatLabel = verification.chat
    ? verification.chat.ok
      ? `chat hello 通过${typeof verification.chat.latencyMs === "number" ? ` · ${verification.chat.latencyMs}ms` : ""}`
      : `chat hello 未通过：${verification.chat.error ?? "未知错误"}`
    : "该服务商无需官方 chat hello";
  const ok = verification.probe.ok && (verification.chat?.ok ?? true);
  return (
    <div className={[
      "rounded-2xl border p-4 shadow-sm",
      ok
        ? "border-emerald-500/25 bg-emerald-500/[0.04]"
        : "border-amber-500/25 bg-amber-500/[0.04]",
    ].join(" ")}>
      <div className="flex items-start gap-3">
        <ShieldCheck size={18} className={ok ? "mt-0.5 text-emerald-600 dark:text-emerald-400" : "mt-0.5 text-amber-600"} />
        <div className="min-w-0 space-y-1">
          <div className="text-sm font-semibold">官方连接验证</div>
          <p className="text-xs leading-5 text-muted-foreground/75">
            /models 探针{verification.probe.ok ? `通过，返回 ${verification.probe.models} 个模型` : `未通过：${verification.probe.error ?? "未知错误"}`}
          </p>
          <p className="text-xs leading-5 text-muted-foreground/75">{chatLabel}</p>
        </div>
      </div>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <label className="text-xs font-medium text-muted-foreground/70">{label}</label>
        {hint && <span className="text-[11px] leading-4 text-muted-foreground/50">{hint}</span>}
      </div>
      {children}
    </div>
  );
}
