import { useState, useEffect, useRef } from "react";
import { fetchJson } from "../hooks/use-api";
import { useServiceStore } from "../store/service";
import { AlertTriangle, CheckCircle2, Eye, EyeOff, Info, Loader2, ArrowLeft, Trash2 } from "lucide-react";
import { ServiceQuickLinks } from "../components/ServiceQuickLinks";
import { StudioSelect } from "../components/StudioSelect";
import { mobileTextInputHandlers } from "../lib/mobile-input";
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
  type ServiceDetailVerifiedProbe as VerifiedProbe,
  type ServiceCompatibilityReport,
  type ServiceCompatibilityStatus,
} from "./service-detail-state";

type ServiceDetailDirtyField =
  | "apiKey"
  | "customName"
  | "baseUrl"
  | "temperature"
  | "apiFormat"
  | "stream"
  | "detectedModel";

interface Nav {
  toServices: () => void;
}

interface OfficialOptimizationConfig {
  readonly headroom: {
    readonly enabled: boolean;
    readonly baseUrl: string;
    readonly timeoutMs: number;
    readonly hasApiKey: boolean;
  };
  readonly embedding: {
    readonly enabled: boolean;
    readonly endpoint: string;
    readonly model: string;
    readonly timeoutMs: number;
    readonly hasApiKey: boolean;
  };
  readonly headroomApiKey: string;
  readonly embeddingApiKey: string;
}

function OfficialOptimizationDetailPage({ nav, onSaved }: { nav: Nav; onSaved: () => Promise<void> }) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [showHeadroomKey, setShowHeadroomKey] = useState(false);
  const [showEmbeddingKey, setShowEmbeddingKey] = useState(false);
  const [message, setMessage] = useState("");
  const [headroomEnabled, setHeadroomEnabled] = useState(false);
  const [headroomBaseUrl, setHeadroomBaseUrl] = useState("");
  const [headroomApiKey, setHeadroomApiKey] = useState("");
  const [headroomTimeoutMs, setHeadroomTimeoutMs] = useState("2500");
  const [embeddingEnabled, setEmbeddingEnabled] = useState(false);
  const [embeddingEndpoint, setEmbeddingEndpoint] = useState("");
  const [embeddingApiKey, setEmbeddingApiKey] = useState("");
  const [embeddingModel, setEmbeddingModel] = useState("BAAI/bge-small-zh-v1.5-int8");
  const [embeddingTimeoutMs, setEmbeddingTimeoutMs] = useState("3000");

  const load = async () => {
    setLoading(true);
    setMessage("");
    try {
      const data = await fetchJson<OfficialOptimizationConfig>("/services/official-optimization/config");
      setHeadroomEnabled(data.headroom.enabled);
      setHeadroomBaseUrl(data.headroom.baseUrl);
      setHeadroomApiKey(data.headroomApiKey);
      setHeadroomTimeoutMs(String(data.headroom.timeoutMs || 2500));
      setEmbeddingEnabled(data.embedding.enabled);
      setEmbeddingEndpoint(data.embedding.endpoint);
      setEmbeddingApiKey(data.embeddingApiKey);
      setEmbeddingModel(data.embedding.model || "BAAI/bge-small-zh-v1.5-int8");
      setEmbeddingTimeoutMs(String(data.embedding.timeoutMs || 3000));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "读取官方优化配置失败");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, []);

  const payload = () => ({
    headroom: {
      enabled: headroomEnabled,
      baseUrl: headroomBaseUrl.trim(),
      apiKey: headroomApiKey.trim(),
      timeoutMs: Number.parseInt(headroomTimeoutMs, 10) || 2500,
    },
    embedding: {
      enabled: embeddingEnabled,
      endpoint: embeddingEndpoint.trim(),
      apiKey: embeddingApiKey.trim(),
      model: embeddingModel.trim() || "BAAI/bge-small-zh-v1.5-int8",
      timeoutMs: Number.parseInt(embeddingTimeoutMs, 10) || 3000,
    },
  });

  const handleTest = async () => {
    setSaving(true);
    setMessage("正在测试官方优化服务...");
    try {
      const result = await fetchJson<{ ok: boolean; results: Array<{ ok: boolean; message: string }> }>(
        "/services/official-optimization/test",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload()),
        },
      );
      setMessage(result.results.map((item) => `${item.ok ? "成功" : "失败"}：${item.message}`).join("\n"));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "测试失败");
    } finally {
      setSaving(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setMessage("正在保存官方优化配置...");
    try {
      await fetchJson("/services/official-optimization/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload()),
      });
      await onSaved();
      setMessage("已保存。下一次 AI 请求会在压缩/缓存前应用这组官方配置。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!await appConfirm({
      title: "删除官方优化配置",
      message: "删除官方优化配置和对应密钥？",
      tone: "danger",
      confirmLabel: "删除",
    })) return;
    setSaving(true);
    try {
      await deleteServiceConfig("official-optimization");
      await onSaved();
      nav.toServices();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "删除失败");
      setSaving(false);
    }
  };

  if (loading) return <DetailSkeleton />;

  return (
    <div className="mx-auto max-w-xl min-w-0 space-y-6">
      <button
        onClick={nav.toServices}
        className="inline-flex items-center gap-2 rounded-lg border border-border/50 bg-card/60 px-3 py-2 text-sm font-medium text-foreground transition-colors hover:bg-secondary/50"
      >
        <ArrowLeft size={14} />
        返回服务商管理
      </button>
      <div>
        <h1 className="font-serif text-2xl">官方优化</h1>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          配置官方 Headroom CacheAligner/CCR 和外部 bge-small-zh INT8 embedding。未启用时仍会使用本地 fallback。
        </p>
      </div>

      <div className="paper-sheet min-w-0 rounded-xl p-4 space-y-6 sm:p-6 md:p-8">
        <section className="space-y-4">
          <label className="flex items-center justify-between gap-3 rounded-lg border border-border/50 bg-background/45 px-3 py-2 text-sm">
            <span className="font-medium">官方 Headroom</span>
            <input type="checkbox" checked={headroomEnabled} onChange={(event) => setHeadroomEnabled(event.target.checked)} />
          </label>
          <Field label="Headroom Base URL">
            <input
              value={headroomBaseUrl}
              {...mobileTextInputHandlers(setHeadroomBaseUrl)}
              placeholder="https://headroom.example.com"
              className="w-full min-w-0 rounded-lg border border-border/60 bg-background px-3 py-2 text-sm font-mono"
            />
          </Field>
          <Field label="Headroom API Key">
            <div className="relative">
              <input
                type={showHeadroomKey ? "text" : "password"}
                value={headroomApiKey}
                {...mobileTextInputHandlers(setHeadroomApiKey)}
                placeholder="Bearer token"
                className="w-full min-w-0 rounded-lg border border-border/60 bg-background px-3 py-2 pr-10 text-sm font-mono"
              />
              <button type="button" onClick={() => setShowHeadroomKey((value) => !value)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground/50 hover:text-muted-foreground">
                {showHeadroomKey ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </div>
          </Field>
          <Field label="Headroom 超时 ms">
            <input
              value={headroomTimeoutMs}
              {...mobileTextInputHandlers(setHeadroomTimeoutMs)}
              inputMode="numeric"
              className="w-full min-w-0 rounded-lg border border-border/60 bg-background px-3 py-2 text-sm font-mono"
            />
          </Field>
        </section>

        <section className="space-y-4 border-t border-border/20 pt-5">
          <label className="flex items-center justify-between gap-3 rounded-lg border border-border/50 bg-background/45 px-3 py-2 text-sm">
            <span className="font-medium">外部 bge-small-zh INT8 Embedding</span>
            <input type="checkbox" checked={embeddingEnabled} onChange={(event) => setEmbeddingEnabled(event.target.checked)} />
          </label>
          <Field label="Embedding Endpoint">
            <input
              value={embeddingEndpoint}
              {...mobileTextInputHandlers(setEmbeddingEndpoint)}
              placeholder="https://embedding.example.com/v1/embeddings"
              className="w-full min-w-0 rounded-lg border border-border/60 bg-background px-3 py-2 text-sm font-mono"
            />
          </Field>
          <Field label="Embedding Model">
            <input
              value={embeddingModel}
              {...mobileTextInputHandlers(setEmbeddingModel)}
              placeholder="BAAI/bge-small-zh-v1.5-int8"
              className="w-full min-w-0 rounded-lg border border-border/60 bg-background px-3 py-2 text-sm font-mono"
            />
          </Field>
          <Field label="Embedding API Key">
            <div className="relative">
              <input
                type={showEmbeddingKey ? "text" : "password"}
                value={embeddingApiKey}
                {...mobileTextInputHandlers(setEmbeddingApiKey)}
                placeholder="Bearer token"
                className="w-full min-w-0 rounded-lg border border-border/60 bg-background px-3 py-2 pr-10 text-sm font-mono"
              />
              <button type="button" onClick={() => setShowEmbeddingKey((value) => !value)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground/50 hover:text-muted-foreground">
                {showEmbeddingKey ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </div>
          </Field>
          <Field label="Embedding 超时 ms">
            <input
              value={embeddingTimeoutMs}
              {...mobileTextInputHandlers(setEmbeddingTimeoutMs)}
              inputMode="numeric"
              className="w-full min-w-0 rounded-lg border border-border/60 bg-background px-3 py-2 text-sm font-mono"
            />
          </Field>
        </section>

        <div className="flex flex-wrap items-center gap-3 border-t border-border/20 pt-4">
          <button onClick={handleTest} disabled={saving}
            className="flex items-center gap-1.5 rounded-lg border border-border/60 px-3.5 py-2 text-xs transition-colors hover:bg-secondary/50 disabled:opacity-50">
            {saving && <Loader2 size={12} className="animate-spin" />}
            测试官方服务
          </button>
          <button onClick={handleSave} disabled={saving}
            className="flex items-center gap-1.5 rounded-lg bg-primary px-3.5 py-2 text-xs text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50">
            {saving && <Loader2 size={12} className="animate-spin" />}
            保存
          </button>
          <button onClick={handleDelete} disabled={saving}
            className="flex items-center gap-1.5 rounded-lg border border-destructive/30 px-3.5 py-2 text-xs text-destructive transition-colors hover:bg-destructive/10 disabled:opacity-50">
            <Trash2 size={12} />
            删除配置
          </button>
        </div>
        {message && <p className="whitespace-pre-wrap rounded-lg border border-border/40 bg-background/45 px-3 py-2 text-xs leading-5 text-muted-foreground">{message}</p>}
      </div>
    </div>
  );
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

function compatibilityTone(status: ServiceCompatibilityStatus): {
  readonly text: string;
  readonly icon: React.ReactNode;
} {
  switch (status) {
    case "pass":
      return { text: "text-emerald-500", icon: <CheckCircle2 size={14} /> };
    case "warn":
      return { text: "text-amber-500", icon: <AlertTriangle size={14} /> };
    case "fail":
      return { text: "text-destructive", icon: <AlertTriangle size={14} /> };
  }
}

function CompatibilityDiagnostics({ report }: { readonly report: ServiceCompatibilityReport }) {
  const tone = compatibilityTone(report.level);
  return (
    <section className="space-y-3 border-t border-border/20 pt-4">
      <div className={`flex items-start gap-2 text-xs font-semibold ${tone.text}`}>
        <span className="mt-0.5 shrink-0">{tone.icon}</span>
        <span className="leading-5">{report.summary}</span>
      </div>
      <div className="space-y-2">
        {report.checks.map((check) => {
          const checkTone = compatibilityTone(check.status);
          return (
            <div key={check.id} className="grid grid-cols-[1rem_minmax(0,1fr)] gap-2 text-xs leading-5">
              <span className={`mt-0.5 ${checkTone.text}`}>{checkTone.icon}</span>
              <div className="min-w-0">
                <div className="font-medium text-foreground">{check.label}</div>
                <div className="break-words text-muted-foreground">{check.message}</div>
                {check.action && <div className="mt-0.5 break-words text-primary/80">{check.action}</div>}
              </div>
            </div>
          );
        })}
      </div>
      {report.recommended && (
        <div className="flex items-start gap-2 rounded-lg bg-primary/[0.05] px-3 py-2 text-xs leading-5 text-muted-foreground">
          <Info size={14} className="mt-0.5 shrink-0 text-primary" />
          <span>
            建议：
            {report.recommended.apiFormat ? ` 协议改为 ${report.recommended.apiFormat};` : ""}
            {typeof report.recommended.stream === "boolean" ? ` 流式响应改为 ${report.recommended.stream ? "开启" : "关闭"};` : ""}
            {report.recommended.maxTokens ? ` 输出预算不超过 ${report.recommended.maxTokens};` : ""}
          </span>
        </div>
      )}
    </section>
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
  const [detectedConfig, setDetectedConfig] = useState<DetectedConfig | null>(null);
  const [verifiedProbe, setVerifiedProbe] = useState<VerifiedProbe | null>(null);
  const [compatibility, setCompatibility] = useState<ServiceCompatibilityReport | null>(null);
  const customNameRef = useRef<HTMLInputElement>(null);
  const baseUrlRef = useRef<HTMLInputElement>(null);
  const modelRef = useRef<HTMLInputElement>(null);
  const apiKeyRef = useRef<HTMLInputElement>(null);
  const dirtyFieldsRef = useRef<Set<ServiceDetailDirtyField>>(new Set());
  const textFieldRefs = {
    apiKey: apiKeyRef,
    customName: customNameRef,
    baseUrl: baseUrlRef,
    detectedModel: modelRef,
  } as const;

  // -- Unified connection status --
  const [status, setStatus] = useState<ConnectionStatus>({ state: "idle" });

  const resolvedCustomName = persistedCustomName || customName.trim() || "Custom";
  const effectiveServiceId = isCustom ? `custom:${resolvedCustomName}` : serviceId;
  const label = isCustom ? (customName || persistedCustomName || "自定义服务") : (svc?.label ?? serviceId);
  const storeModels = useServiceStore((s) => s.modelsByService[effectiveServiceId]);

  const setIfClean = <T,>(
    field: ServiceDetailDirtyField,
    setter: (value: T) => void,
    value: T,
  ) => {
    if (!dirtyFieldsRef.current.has(field)) {
      setter(value);
      if (field in textFieldRefs) {
        const ref = textFieldRefs[field as keyof typeof textFieldRefs];
        if (ref.current && typeof value === "string" && ref.current.value !== value) {
          ref.current.value = value;
        }
      }
    }
  };

  const resetTextField = (
    field: keyof typeof textFieldRefs,
    setter: (value: string) => void,
    value: string,
  ) => {
    setter(value);
    const ref = textFieldRefs[field];
    if (ref.current && ref.current.value !== value) {
      ref.current.value = value;
    }
  };

  const textHandlers = (
    field: ServiceDetailDirtyField,
    setter: (value: string) => void,
  ) => mobileTextInputHandlers((value) => {
    dirtyFieldsRef.current.add(field);
    setter(value);
  });

  useEffect(() => {
    dirtyFieldsRef.current.clear();
    resetTextField("apiKey", setApiKey, "");
    setShowKey(false);
    resetTextField("customName", setCustomName, persistedCustomName);
    resetTextField("baseUrl", setBaseUrl, "");
    setTemperature("0.7");
    setApiFormat("chat");
    setStream(true);
    resetTextField("detectedModel", setDetectedModel, "");
    setDetectedConfig(null);
    setVerifiedProbe(null);
    setCompatibility(null);
    setStatus({ state: "idle" });
  }, [persistedCustomName, serviceId]);

  useEffect(() => {
    let cancelled = false;
    void fetchJson<{ services: Array<Record<string, unknown>>; service?: string | null; defaultModel?: string | null }>("/services/config")
      .then((data) => {
        if (cancelled) return;
        const matched = matchServiceConfigEntryForDetail(data.services ?? [], serviceId);
        if (!matched) return;
        if (isCustom) {
          setIfClean("customName", setCustomName, String(matched.name ?? persistedCustomName));
          setIfClean("baseUrl", setBaseUrl, String(matched.baseUrl ?? ""));
        }
        if (typeof matched.temperature === "number") setIfClean("temperature", setTemperature, String(matched.temperature));
        if (matched.apiFormat === "chat" || matched.apiFormat === "responses") setIfClean("apiFormat", setApiFormat, matched.apiFormat);
        if (typeof matched.stream === "boolean") setIfClean("stream", setStream, matched.stream);

        const configServiceId = serviceId === "custom" ? "" : serviceId;
        if (configServiceId && data.service === configServiceId && data.defaultModel) {
          setIfClean("detectedModel", setDetectedModel, data.defaultModel);
        }
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [isCustom, persistedCustomName, serviceId]);

  useEffect(() => {
    if (serviceId === "custom") {
      setStatus({ state: "idle" });
      return;
    }
    let cancelled = false;
    const persistedServiceId = serviceId;
    void rehydrateServiceConnectionStatus({
      effectiveServiceId: persistedServiceId,
      shouldVerify: Boolean(svc?.connected),
      isCustom,
      baseUrl,
      apiFormat,
      stream,
    })
      .then((result) => {
        if (cancelled) return;
        setIfClean("apiKey", setApiKey, result.apiKey);
        if (result.detectedModel) setIfClean("detectedModel", setDetectedModel, result.detectedModel);
        setDetectedConfig(result.detectedConfig);
        setStatus(result.status);
        if (result.status.state === "connected") {
          setStoreModels(persistedServiceId, result.status.models);
        }
      })
      .catch(() => {
        if (cancelled) return;
        setStatus({ state: "idle" });
      });
    return () => { cancelled = true; };
  }, [
    isCustom,
    setStoreModels,
    serviceId,
    svc?.connected,
  ]);

  if (loading) return <DetailSkeleton />;
  if (serviceId === "official-optimization") {
    return <OfficialOptimizationDetailPage nav={nav} onSaved={refreshServices} />;
  }

  // -- Derived state --
  const isConnected = Boolean(svc?.connected);
  const models = status.state === "connected" ? status.models : (storeModels ?? []);
  const isBusy = status.state === "testing" || status.state === "saving";
  const readForm = () => {
    const nextCustomName = customNameRef.current?.value ?? customName;
    const nextBaseUrl = baseUrlRef.current?.value ?? baseUrl;
    const nextModel = modelRef.current?.value ?? detectedModel;
    const nextApiKey = apiKeyRef.current?.value ?? apiKey;
    resetTextField("customName", setCustomName, nextCustomName);
    resetTextField("baseUrl", setBaseUrl, nextBaseUrl);
    resetTextField("detectedModel", setDetectedModel, nextModel);
    resetTextField("apiKey", setApiKey, nextApiKey);
    return {
      customName: nextCustomName,
      baseUrl: nextBaseUrl,
      detectedModel: nextModel,
      apiKey: nextApiKey,
      resolvedCustomName: persistedCustomName || nextCustomName.trim() || "Custom",
    };
  };

  // -- Handlers --
  const handleTest = async () => {
    const form = readForm();
    const currentEffectiveServiceId = isCustom ? `custom:${form.resolvedCustomName}` : serviceId;
    const trimmedKey = form.apiKey.trim();
    if (!trimmedKey && !isCustom) {
      setStatus({ state: "error", message: "请先输入 API Key" });
      return;
    }
    if (isCustom && !form.baseUrl.trim()) {
      setStatus({ state: "error", message: "请先填写 Base URL" });
      return;
    }
    resetTextField("apiKey", setApiKey, trimmedKey);
    setStatus({ state: "testing" });
    setCompatibility(null);
    try {
      const result = await probeServiceForDetail(currentEffectiveServiceId, {
        apiKey: trimmedKey,
        apiFormat,
        stream,
        model: form.detectedModel,
        diagnose: true,
        ...(isCustom ? { baseUrl: form.baseUrl.trim() } : {}),
      });
      setCompatibility(result.compatibility ?? null);
      if (result.ok) {
        const models = result.models ?? [];
        const verifiedApiFormat = result.detected?.apiFormat ?? apiFormat;
        const verifiedStream = typeof result.detected?.stream === "boolean" ? result.detected.stream : stream;
        const verifiedBaseUrl = isCustom ? (result.detected?.baseUrl ?? form.baseUrl.trim()) : "";
        if (result.detected?.apiFormat) {
          dirtyFieldsRef.current.delete("apiFormat");
          setApiFormat(result.detected.apiFormat);
        }
        if (typeof result.detected?.stream === "boolean") {
          dirtyFieldsRef.current.delete("stream");
          setStream(result.detected.stream);
        }
        if (isCustom && result.detected?.baseUrl) {
          dirtyFieldsRef.current.delete("baseUrl");
          resetTextField("baseUrl", setBaseUrl, result.detected.baseUrl);
        }
        dirtyFieldsRef.current.delete("detectedModel");
        resetTextField("detectedModel", setDetectedModel, result.selectedModel ?? "");
        setDetectedConfig(result.detected ?? null);
        setVerifiedProbe({
          apiKey: trimmedKey,
          baseUrl: verifiedBaseUrl,
          apiFormat: verifiedApiFormat,
          stream: verifiedStream,
          models,
          selectedModel: result.selectedModel,
          detected: result.detected,
        });
        setStatus({ state: "connected", models });
        setStoreModels(currentEffectiveServiceId, models); // Write to global store
      } else {
        setVerifiedProbe(null);
        setCompatibility(result.compatibility ?? null);
        setStatus({ state: "error", message: result.error ?? "连接失败" });
        clearStoreModels(currentEffectiveServiceId);
      }
    } catch (e) {
      setVerifiedProbe(null);
      setCompatibility(null);
      setStatus({ state: "error", message: e instanceof Error ? e.message : "连接失败" });
    }
  };

  const handleDelete = async () => {
    if (!await appConfirm({
      title: "删除模型供应商",
      message: `删除“${label}”的配置和密钥？`,
      tone: "danger",
      confirmLabel: "删除",
    })) return;
    setStatus({ state: "saving" });
    setCompatibility(null);
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
    const form = readForm();
    const currentEffectiveServiceId = isCustom ? `custom:${form.resolvedCustomName}` : serviceId;
    const trimmedKey = form.apiKey.trim();
    resetTextField("apiKey", setApiKey, trimmedKey);
    if (isCustom && !form.baseUrl.trim()) {
      setStatus({ state: "error", message: "请先填写 Base URL" });
      return;
    }
    setStatus({ state: "saving" });
    try {
      const result = await saveServiceConfig({
        effectiveServiceId: currentEffectiveServiceId,
        serviceId,
        isCustom,
        resolvedCustomName: form.resolvedCustomName,
        apiKey: trimmedKey,
        baseUrl: form.baseUrl,
        apiFormat,
        stream,
        temperature,
        detectedModel: form.detectedModel,
        verifiedProbe,
      });
      if (result.status.state === "connected") {
        if (result.detectedConfig?.apiFormat) setApiFormat(result.detectedConfig.apiFormat);
        if (typeof result.detectedConfig?.stream === "boolean") setStream(result.detectedConfig.stream);
        if (isCustom && result.detectedConfig?.baseUrl) resetTextField("baseUrl", setBaseUrl, result.detectedConfig.baseUrl);
        resetTextField("detectedModel", setDetectedModel, result.detectedModel);
        dirtyFieldsRef.current.clear();
        setDetectedConfig(result.detectedConfig);
        setStoreModels(currentEffectiveServiceId, result.status.models);
        setStatus(result.status);
      } else {
        setStatus(result.status);
        if (result.status.state === "error") return;
      }
      await refreshServices();
      setStatus({ state: "saved" });
    } catch (e) {
      setStatus({ state: "error", message: e instanceof Error ? e.message : "保存失败" });
    }
  };

  return (
    <div className="mx-auto max-w-xl min-w-0 space-y-6">
      {/* Back */}
      <button
        onClick={nav.toServices}
        className="inline-flex items-center gap-2 rounded-lg border border-border/50 bg-card/60 px-3 py-2 text-sm font-medium text-foreground hover:bg-secondary/50 transition-colors"
      >
        <ArrowLeft size={14} />
        返回服务商管理
      </button>

      {/* Title + status */}
      <div className="flex items-center gap-3">
        <h1 className="font-serif text-2xl">{label}</h1>
        {isConnected && (
          <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-500 font-medium">
            已连接
          </span>
        )}
      </div>
      <ServiceQuickLinks serviceId={serviceId} />

      <div className="paper-sheet min-w-0 rounded-xl p-4 space-y-6 sm:p-6 md:p-8">
        {/* Custom fields */}
        {isCustom && (
          <div className="min-w-0 space-y-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="服务名称">
                <input ref={customNameRef} type="text" defaultValue={customName}
                  {...textHandlers("customName", setCustomName)}
                  placeholder="例如：本地 Ollama" className="w-full min-w-0 rounded-lg border border-border/60 bg-background px-3 py-2 text-sm" />
              </Field>
              <Field label="Base URL">
                <input ref={baseUrlRef} type="text" defaultValue={baseUrl}
                  {...textHandlers("baseUrl", setBaseUrl)}
                  placeholder="https://api.example.com/v1" className="w-full min-w-0 rounded-lg border border-border/60 bg-background px-3 py-2 text-sm font-mono" />
              </Field>
            </div>
            <Field label="选择模型">
              {models.length > 0 ? (
                <div className="flex min-w-0 flex-col gap-2 sm:flex-row">
                  <StudioSelect
                    value={models.some((m) => m.id === detectedModel) ? detectedModel : "custom"}
                    onValueChange={(val) => {
                      if (val === "custom") {
                        // Keep typing custom ID
                      } else {
                        dirtyFieldsRef.current.add("detectedModel");
                        setDetectedModel(val);
                      }
                    }}
                    options={[
                      ...models.map((m) => ({
                        value: m.id,
                        label: m.name || m.id,
                      })),
                      { value: "custom", label: "自定义 / 手动输入..." },
                    ]}
                    triggerClassName="min-w-0 flex-1 bg-background shadow-none"
                  />
                  {(!models.some((m) => m.id === detectedModel) || 
                    !models.find((m) => m.id === detectedModel)) && (
                    <input
                      ref={modelRef}
                      type="text"
                      defaultValue={detectedModel}
                      {...textHandlers("detectedModel", setDetectedModel)}
                      placeholder="手动输入模型 ID"
                      className="min-w-0 flex-1 rounded-lg border border-border/60 bg-background px-3 py-2 text-sm font-mono"
                    />
                  )}
                </div>
              ) : (
                <input
                  ref={modelRef}
                  type="text"
                  defaultValue={detectedModel}
                  {...textHandlers("detectedModel", setDetectedModel)}
                  placeholder="测试连接后可选择，或在此处手动输入模型 ID（例如：gpt-4o）"
                  className="w-full min-w-0 rounded-lg border border-border/60 bg-background px-3 py-2 text-sm font-mono"
                />
              )}
            </Field>
          </div>
        )}

        {/* API Key */}
        <Field label="API Key">
          <div className="relative">
            <input
              ref={apiKeyRef}
              type={showKey ? "text" : "password"} defaultValue={apiKey}
              {...textHandlers("apiKey", setApiKey)}
              placeholder="sk-..."
              className="w-full min-w-0 rounded-lg border border-border/60 bg-background px-3 py-2 pr-10 text-sm font-mono"
            />
            <button type="button" onClick={() => setShowKey((v) => !v)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground/50 hover:text-muted-foreground transition-colors">
              {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          </div>
        </Field>

        {/* Actions + feedback */}
        <div className="flex flex-wrap items-center gap-3 pt-4 border-t border-border/20">
          <button onClick={handleTest} disabled={isBusy}
            className="flex items-center gap-1.5 px-3.5 py-2 text-xs rounded-lg border border-border/60 hover:bg-secondary/50 transition-colors disabled:opacity-50">
            {status.state === "testing" && <Loader2 size={12} className="animate-spin" />}
            测试连接
          </button>
          <button onClick={handleSave} disabled={isBusy}
            className="flex items-center gap-1.5 px-3.5 py-2 text-xs rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50">
            {status.state === "saving" && <Loader2 size={12} className="animate-spin" />}
            保存
          </button>
          {(isConnected || isCustom) && (
            <button onClick={handleDelete} disabled={isBusy}
              className="flex items-center gap-1.5 px-3.5 py-2 text-xs rounded-lg border border-destructive/30 text-destructive hover:bg-destructive/10 transition-colors disabled:opacity-50">
              <Trash2 size={12} />
              删除配置
            </button>
          )}
          {/* Status feedback */}
          {status.state === "connected" && (
            <span className="text-xs text-emerald-500">
              连接成功，{models.length} 个模型
              {detectedModel ? `，已自动匹配 ${detectedModel}${detectedConfig ? ` / ${detectedConfig.apiFormat === "responses" ? "Responses" : "Chat"} / ${detectedConfig.stream ? "流式" : "非流式"}` : ""}` : ""}
            </span>
          )}
          {status.state === "error" && (
            <span className="text-xs text-destructive">{status.message}</span>
          )}
          {status.state === "saved" && (
            <span className="text-xs text-emerald-500">已保存</span>
          )}
        </div>

        {compatibility && <CompatibilityDiagnostics report={compatibility} />}

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="协议类型">
            <StudioSelect
              value={apiFormat}
              onValueChange={(value) => {
                dirtyFieldsRef.current.add("apiFormat");
                setApiFormat(value);
              }}
              options={[
                { value: "chat", label: "Chat / Completions" },
                { value: "responses", label: "Responses" },
              ]}
              triggerClassName="bg-background shadow-none"
            />
          </Field>

          <Field label="流式响应">
            <label className="flex h-10 items-center gap-2 rounded-lg border border-border/60 bg-background px-3 text-sm">
              <input
                type="checkbox"
                checked={stream}
                onChange={(e) => {
                  dirtyFieldsRef.current.add("stream");
                  setStream(e.target.checked);
                }}
              />
              <span>{stream ? "开启" : "关闭"}</span>
            </label>
          </Field>
        </div>

        {/* Models */}
        {isConnected && (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground/70 font-medium uppercase tracking-wider">
              可用模型（{models.length}）
            </p>
            {models.length > 0 ? (
              <div className="flex gap-1.5 flex-wrap">
                {models.map((m) => (
                  <span key={m.id} className="text-[11px] px-2.5 py-1 rounded-md bg-emerald-500/[0.06] text-emerald-600 dark:text-emerald-400 border border-emerald-500/15">
                    {m.name ?? m.id}
                  </span>
                ))}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground/60">点击“测试连接”查看可用模型</p>
            )}
          </div>
        )}

        {/* Advanced params */}
        <details className="group pt-2 border-t border-border/20">
          <summary className="text-xs text-muted-foreground/60 cursor-pointer select-none hover:text-muted-foreground transition-colors py-2">
            高级参数
          </summary>
          <div className="space-y-4 pt-2">
            <Field label="temperature">
              <div className="flex items-center gap-3">
                <input type="range" min="0" max="2" step="0.05" value={temperature}
                  onChange={(e) => {
                    dirtyFieldsRef.current.add("temperature");
                    setTemperature(e.target.value);
                  }} className="flex-1 accent-primary h-1" />
                <input type="number" value={temperature}
                  {...textHandlers("temperature", setTemperature)}
                  min="0" max="2" step="0.05" className="w-16 rounded-md border border-border/60 bg-background px-2 py-1 text-xs text-right font-mono" />
              </div>
            </Field>
          </div>
        </details>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0 space-y-1.5">
      <label className="block text-xs text-muted-foreground/70 font-medium">{label}</label>
      {children}
    </div>
  );
}
