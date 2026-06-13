import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Eye, EyeOff, Image, Loader2, Plus, Search, WandSparkles, X } from "lucide-react";
import { GROUP_DESCRIPTIONS, GROUP_LABELS, GROUP_ORDER, GROUP_SHORT_LABELS } from "../constants/service-groups";
import { buildApiUrl, fetchJson } from "../hooks/use-api";
import { useServiceStore } from "../store/service";
import type { EndpointGroup, ServiceInfo } from "../store/service";
import { ServiceQuickLinks, getServiceQuickLinks } from "../components/ServiceQuickLinks";
import { ServiceConfigSourceCard } from "../components/ServiceConfigSourceCard";
import { StudioSelect } from "../components/StudioSelect";
import { mobileTextInputHandlers } from "../lib/mobile-input";

interface Nav {
  toDashboard: () => void;
  toServiceDetail: (id: string) => void;
}

function SkeletonCard() {
  return (
    <div className="rounded-lg border border-border/30 p-5 animate-pulse">
      <div className="flex items-center justify-between mb-3">
        <div className="h-4 w-24 bg-muted rounded" />
        <div className="w-2 h-2 rounded-full bg-muted" />
      </div>
      <div className="h-3 w-16 bg-muted/60 rounded" />
    </div>
  );
}

function ServiceCard({ svc, onClick }: { svc: ServiceInfo; onClick: () => void }) {
  const quickLinks = getServiceQuickLinks(svc.service);
  return (
    <div
      className={[
        "flex min-h-[92px] flex-col gap-2 rounded-lg border p-5 text-left transition-all hover:shadow-sm",
        svc.connected
          ? "border-emerald-500/30 bg-emerald-500/[0.03]"
          : "border-dashed border-border/40",
      ].join(" ")}
    >
      <button onClick={onClick} className="flex flex-1 flex-col gap-2 text-left">
        <div className="flex items-center justify-between gap-3">
          <span className="truncate text-sm font-medium">{svc.label}</span>
          <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${svc.connected ? "bg-emerald-500" : "bg-muted-foreground/30"}`} />
        </div>
        <span className="text-xs text-muted-foreground/60">
          {svc.connected ? "已连接" : "未配置"}
        </span>
      </button>
      {quickLinks.length > 0 && (
        <ServiceQuickLinks serviceId={svc.service} variant="card" className="pt-1" />
      )}
    </div>
  );
}

interface CoverProviderInfo {
  readonly service: string;
  readonly label: string;
  readonly baseUrl: string;
  readonly api: "responses" | "images" | "gemini";
  readonly defaultModel: string;
  readonly models: readonly string[];
  readonly connected: boolean;
}

interface CoverConfigPayload {
  readonly service: string | null;
  readonly model: string | null;
  readonly providers: readonly CoverProviderInfo[];
}

function CoverConfigCard() {
  const [providers, setProviders] = useState<readonly CoverProviderInfo[]>([]);
  const [service, setService] = useState("kkaiapi");
  const [model, setModel] = useState("gpt-image-2");
  const [apiKey, setApiKey] = useState("");
  const [customName, setCustomName] = useState("自定义封面");
  const [customBaseUrl, setCustomBaseUrl] = useState("");
  const [customApi, setCustomApi] = useState<"responses" | "images" | "gemini">("images");
  const [showKey, setShowKey] = useState(false);
  const [status, setStatus] = useState<"idle" | "loading" | "saving" | "saved" | "error">("loading");
  const [message, setMessage] = useState("");
  const [manualTitle, setManualTitle] = useState("");
  const [manualPrompt, setManualPrompt] = useState("");
  const [manualGenerating, setManualGenerating] = useState(false);
  const [manualCoverPath, setManualCoverPath] = useState<string | null>(null);
  const formRevisionRef = useRef(0);
  const apiKeyRevisionRef = useRef(0);
  const customNameRef = useRef<HTMLInputElement>(null);
  const customBaseUrlRef = useRef<HTMLInputElement>(null);
  const customModelRef = useRef<HTMLInputElement>(null);
  const apiKeyRef = useRef<HTMLInputElement>(null);
  const setCoverTextField = (
    ref: React.RefObject<HTMLInputElement | null>,
    setter: (value: string) => void,
    value: string,
  ) => {
    setter(value);
    if (ref.current && ref.current.value !== value) ref.current.value = value;
  };
  const coverTextHandlers = (
    revisionRef: React.MutableRefObject<number>,
    setter: (value: string) => void,
  ) => mobileTextInputHandlers((value) => {
    revisionRef.current += 1;
    setter(value);
  });

  const selected = providers.find((provider) => provider.service === service);

  useEffect(() => {
    let cancelled = false;
    const startingRevision = formRevisionRef.current;
    void fetchJson<CoverConfigPayload>("/cover/config")
      .then((payload) => {
        if (cancelled) return;
        setProviders(payload.providers);
        if (formRevisionRef.current !== startingRevision) {
          setStatus("idle");
          return;
        }
        const nextService = payload.service ?? payload.providers[0]?.service ?? "kkaiapi";
        const provider = payload.providers.find((item) => item.service === nextService) ?? payload.providers[0];
        setService(nextService);
        setCoverTextField(customModelRef, setModel, payload.model ?? provider?.defaultModel ?? "gpt-image-2");
        if (nextService.startsWith("custom:") && provider) {
          setCoverTextField(customNameRef, setCustomName, provider.label);
          setCoverTextField(customBaseUrlRef, setCustomBaseUrl, provider.baseUrl);
          setCustomApi(provider.api);
        }
        setStatus("idle");
      })
      .catch((error) => {
        if (cancelled) return;
        setStatus("error");
        setMessage(error instanceof Error ? error.message : "读取封面配置失败");
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!service) return;
    let cancelled = false;
    const startingRevision = apiKeyRevisionRef.current;
    void fetchJson<{ apiKey?: string }>(`/cover/secret/${encodeURIComponent(service)}`)
      .then((payload) => {
        if (cancelled || apiKeyRevisionRef.current !== startingRevision) return;
        setCoverTextField(apiKeyRef, setApiKey, payload.apiKey ?? "");
      })
      .catch(() => {
        if (!cancelled && apiKeyRevisionRef.current === startingRevision) {
          setCoverTextField(apiKeyRef, setApiKey, "");
        }
      });
    return () => { cancelled = true; };
  }, [service]);

  const handleServiceChange = (nextService: string) => {
    formRevisionRef.current += 1;
    apiKeyRevisionRef.current += 1;
    setCoverTextField(apiKeyRef, setApiKey, "");
    if (nextService === "__custom__") {
      const customService = `custom:${customName.trim() || "自定义封面"}`;
      setService(customService);
      setModel("");
      setStatus("idle");
      setMessage("");
      return;
    }
    const provider = providers.find((item) => item.service === nextService);
    setService(nextService);
    setModel(provider?.defaultModel ?? "gpt-image-2");
    setStatus("idle");
    setMessage("");
  };

  const handleSave = async (): Promise<boolean> => {
    const liveCustomName = customNameRef.current?.value ?? customName;
    const liveCustomBaseUrl = customBaseUrlRef.current?.value ?? customBaseUrl;
    const liveModel = customModelRef.current?.value ?? model;
    const liveApiKey = apiKeyRef.current?.value ?? apiKey;
    const isCustom = service.startsWith("custom:");
    const provider = selected;
    if (!provider && !isCustom) return false;
    const effectiveService = isCustom
      ? `custom:${liveCustomName.trim() || "自定义封面"}`
      : provider!.service;
    if (isCustom && (!liveCustomBaseUrl.trim() || !liveModel.trim())) {
      setStatus("error");
      setMessage("自定义封面服务需要填写 Base URL 和模型");
      return false;
    }
    setStatus("saving");
    setMessage("");
    try {
      await fetchJson(`/cover/secret/${encodeURIComponent(effectiveService)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: liveApiKey.trim() }),
      });
      await fetchJson("/cover/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          service: effectiveService,
          model: liveModel.trim(),
          ...(isCustom ? {
            label: liveCustomName.trim() || "自定义封面",
            baseUrl: liveCustomBaseUrl.trim(),
            api: customApi,
          } : {}),
        }),
      });
      setService(effectiveService);
      setStatus("saved");
      setMessage("封面配置已保存");
      return true;
    } catch (error) {
      setStatus("error");
      setMessage(error instanceof Error ? error.message : "保存封面配置失败");
      return false;
    }
  };

  const handleManualGenerate = async () => {
    if (!manualTitle.trim() || manualGenerating) return;
    const saved = await handleSave();
    if (!saved) return;
    setManualGenerating(true);
    setManualCoverPath(null);
    setMessage("正在调用生图模型...");
    try {
      const result = await fetchJson<{ coverImagePath: string }>("/cover/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: manualTitle.trim(),
          coverPrompt: manualPrompt.trim(),
        }),
      });
      setManualCoverPath(result.coverImagePath);
      setStatus("saved");
      setMessage("封面已生成");
    } catch (error) {
      setStatus("error");
      setMessage(error instanceof Error ? error.message : "封面生成失败");
    } finally {
      setManualGenerating(false);
    }
  };

  const manualCoverUrl = manualCoverPath
    ? buildApiUrl(`/project/files/${manualCoverPath.split("/").map(encodeURIComponent).join("/")}`)
    : null;

  if (providers.length === 0 && status !== "error") return null;

  return (
    <section className="rounded-xl border border-border/50 bg-card/50 p-4 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-sm font-medium text-foreground">
            <Image size={15} className="text-primary" />
            图片生成
          </h2>
          <p className="mt-1 text-xs text-muted-foreground/70">
            此处配置全局生图通道，供短篇封面和互动世界配图共同使用。
          </p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {["短篇封面", "互动场景", "角色形象", "物品与线索"].map((usage) => (
              <span key={usage} className="rounded-md border border-border/50 bg-secondary/40 px-2 py-1 text-[11px] text-muted-foreground">
                {usage}
              </span>
            ))}
          </div>
        </div>
        {selected?.connected && (
          <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-500">
            已有密钥
          </span>
        )}
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <label className="space-y-1.5">
          <span className="block text-xs font-medium text-muted-foreground/70">服务</span>
          <StudioSelect
            value={service}
            onValueChange={handleServiceChange}
            options={[
              ...providers.map((provider) => ({ value: provider.service, label: provider.label })),
              ...(service.startsWith("custom:") && !providers.some((provider) => provider.service === service)
                ? [{ value: service, label: customName || "自定义封面服务" }]
                : []),
              { value: "__custom__", label: "自定义封面服务" },
            ]}
            triggerClassName="min-h-11 rounded-xl bg-background/70"
          />
        </label>
        <label className="space-y-1.5">
          <span className="block text-xs font-medium text-muted-foreground/70">生图模型</span>
          <StudioSelect
            value={model}
            onValueChange={(value) => {
              formRevisionRef.current += 1;
              setModel(value);
            }}
            options={(selected?.models ?? (model ? [model] : [])).map((item) => ({ value: item, label: item }))}
            triggerClassName="min-h-11 rounded-xl bg-background/70 font-mono"
            contentClassName="font-mono"
            placeholder={service.startsWith("custom:") ? "请在下方填写模型" : "选择生图模型"}
          />
        </label>
      </div>

      {service.startsWith("custom:") && (
        <div className="grid gap-3 md:grid-cols-2">
          <label className="space-y-1.5">
            <span className="block text-xs font-medium text-muted-foreground/70">自定义名称</span>
            <input
              ref={customNameRef}
              defaultValue={customName}
              {...coverTextHandlers(formRevisionRef, setCustomName)}
              className="min-h-11 w-full rounded-xl border border-border/60 bg-background px-3 text-sm"
            />
          </label>
          <label className="space-y-1.5">
            <span className="block text-xs font-medium text-muted-foreground/70">协议类型</span>
            <StudioSelect
              value={customApi}
              onValueChange={(value) => {
                formRevisionRef.current += 1;
                setCustomApi(value);
              }}
              options={[
                { value: "images", label: "Images / Generations" },
                { value: "responses", label: "Responses" },
                { value: "gemini", label: "Gemini Generate Content" },
              ]}
              triggerClassName="min-h-11 rounded-xl bg-background/70"
            />
          </label>
          <label className="space-y-1.5 md:col-span-2">
            <span className="block text-xs font-medium text-muted-foreground/70">Base URL</span>
            <input
              ref={customBaseUrlRef}
              defaultValue={customBaseUrl}
              {...coverTextHandlers(formRevisionRef, setCustomBaseUrl)}
              placeholder="https://api.example.com/v1"
              className="min-h-11 w-full rounded-xl border border-border/60 bg-background px-3 font-mono text-sm"
            />
          </label>
          <label className="space-y-1.5 md:col-span-2">
            <span className="block text-xs font-medium text-muted-foreground/70">模型名称</span>
            <input
              ref={customModelRef}
              defaultValue={model}
              {...coverTextHandlers(formRevisionRef, setModel)}
              placeholder="例如：gpt-image-2"
              className="min-h-11 w-full rounded-xl border border-border/60 bg-background px-3 font-mono text-sm"
            />
          </label>
        </div>
      )}

      <label className="space-y-1.5">
        <span className="block text-xs font-medium text-muted-foreground/70">API Key</span>
        <div className="relative">
          <input
            ref={apiKeyRef}
            type={showKey ? "text" : "password"}
            defaultValue={apiKey}
            {...coverTextHandlers(apiKeyRevisionRef, setApiKey)}
            placeholder="sk-..."
            className="w-full rounded-lg border border-border/60 bg-background px-3 py-2 pr-10 text-sm font-mono"
          />
          <button
            type="button"
            onClick={() => setShowKey((value) => !value)}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground/50 hover:text-muted-foreground"
          >
            {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
          </button>
        </div>
      </label>

      <div className="space-y-3 border-t border-border/40 pt-3">
        <div>
          <div className="flex items-center gap-2 text-xs font-medium text-foreground">
            <WandSparkles size={14} className="text-primary" />
            手动生成封面
          </div>
          <p className="mt-1 text-xs text-muted-foreground/60">
            保存当前模型配置后立即调用，不经过聊天模型。
          </p>
        </div>
        <input
          value={manualTitle}
          onChange={(event) => setManualTitle(event.target.value)}
          placeholder="封面标题"
          className="min-h-11 w-full rounded-lg border border-border/60 bg-background px-3 text-sm"
        />
        <textarea
          value={manualPrompt}
          onChange={(event) => setManualPrompt(event.target.value)}
          placeholder="视觉要求，例如：雨夜霓虹街道，悬疑感，人物背影，标题留白"
          rows={3}
          className="w-full resize-none rounded-lg border border-border/60 bg-background px-3 py-2 text-sm leading-6"
        />
        <button
          type="button"
          onClick={() => void handleManualGenerate()}
          disabled={manualGenerating || !manualTitle.trim()}
          className="inline-flex min-h-10 items-center gap-2 rounded-lg border border-primary/40 bg-primary/10 px-3.5 text-xs font-medium text-primary transition-colors hover:bg-primary/15 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {manualGenerating ? <Loader2 size={14} className="animate-spin" /> : <WandSparkles size={14} />}
          {manualGenerating ? "生成中" : "调用生图模型"}
        </button>
        {manualCoverUrl ? (
          <div className="overflow-hidden rounded-lg border border-border/50 bg-background">
            <img src={manualCoverUrl} alt={manualTitle || "生成的封面"} className="max-h-96 w-full object-contain" />
            <div className="border-t border-border/40 px-3 py-2 font-mono text-[11px] text-muted-foreground break-all">
              {manualCoverPath}
            </div>
          </div>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button
          onClick={() => void handleSave()}
          disabled={status === "saving" || (!selected && !service.startsWith("custom:"))}
          className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3.5 py-2 text-xs text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
        >
          {status === "saving" && <Loader2 size={12} className="animate-spin" />}
          保存生图配置
        </button>
        {(selected?.baseUrl || customBaseUrl) && (
          <span className="text-xs text-muted-foreground/60">
            Base URL: <span className="font-mono">{selected?.baseUrl || customBaseUrl}</span>
          </span>
        )}
        {message && (
          <span className={`text-xs ${status === "error" ? "text-destructive" : "text-emerald-500"}`}>
            {message}
          </span>
        )}
      </div>
    </section>
  );
}

export function ServiceListPage({ nav }: { nav: Nav }) {
  const services = useServiceStore((s) => s.services);
  const loading = useServiceStore((s) => s.servicesLoading);
  const fetchServices = useServiceStore((s) => s.fetchServices);
  const refreshServices = useServiceStore((s) => s.refreshServices);

  useEffect(() => { void fetchServices(); }, [fetchServices]);

  const [query, setQuery] = useState("");
  const [selectedGroups, setSelectedGroups] = useState<Set<EndpointGroup>>(new Set());
  const [onlyConnected, setOnlyConnected] = useState(false);

  const bankServices = useMemo(
    () => services.filter((s) => !s.service.startsWith("custom")),
    [services],
  );
  const customServices = useMemo(
    () => services.filter((s) => s.service.startsWith("custom")),
    [services],
  );

  const groupCounts = useMemo(() => {
    const counts = {} as Record<EndpointGroup, number>;
    for (const group of GROUP_ORDER) {
      counts[group] = bankServices.filter((s) => s.group === group).length;
    }
    return counts;
  }, [bankServices]);

  const connectedCount = useMemo(
    () => services.filter((s) => s.connected).length,
    [services],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return bankServices.filter((svc) => {
      if (onlyConnected && !svc.connected) return false;
      if (selectedGroups.size > 0 && (!svc.group || !selectedGroups.has(svc.group))) return false;
      if (q && !svc.label.toLowerCase().includes(q) && !svc.service.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [bankServices, onlyConnected, query, selectedGroups]);

  const filteredCustom = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (selectedGroups.size > 0) return [];
    return customServices.filter((svc) => {
      if (onlyConnected && !svc.connected) return false;
      if (q && !svc.label.toLowerCase().includes(q) && !svc.service.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [customServices, onlyConnected, query, selectedGroups]);

  const byGroup = useMemo(() => {
    const map = {} as Record<EndpointGroup, ServiceInfo[]>;
    for (const group of GROUP_ORDER) map[group] = [];
    for (const svc of filtered) {
      if (svc.group) map[svc.group].push(svc);
    }
    return map;
  }, [filtered]);

  const toggleGroup = (group: EndpointGroup) => {
    setSelectedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      return next;
    });
  };

  const canCreateCustom = selectedGroups.size === 0 && query.trim() === "" && !onlyConnected;
  const showCustomSection = !loading && selectedGroups.size === 0 && (filteredCustom.length > 0 || canCreateCustom);

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <button
          onClick={nav.toDashboard}
          className="inline-flex items-center rounded-lg border border-border/50 bg-card/60 px-3 py-1.5 font-medium text-foreground hover:bg-secondary/50 transition-colors"
        >
          首页
        </button>
        <span className="text-border">/</span>
        <span className="text-foreground">服务商管理</span>
      </div>

      <h1 className="font-serif text-2xl">服务商管理</h1>

      <ServiceConfigSourceCard onChange={() => { void refreshServices(); }} />

      <CoverConfigCard />

      <div className="relative">
        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground/40" />
        <input
          type="text"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索服务商"
          className="w-full rounded-lg border border-border/60 bg-background py-2 pl-9 pr-9 text-sm outline-none focus:border-primary/50"
        />
        {query && (
          <button
            onClick={() => setQuery("")}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground/50 hover:text-muted-foreground"
            aria-label="清空搜索"
          >
            <X size={14} />
          </button>
        )}
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          onClick={() => setSelectedGroups(new Set())}
          className={[
            "inline-flex items-center gap-1 rounded-full border px-3 py-1 text-xs transition-colors",
            selectedGroups.size === 0
              ? "border-foreground bg-foreground text-background"
              : "border-border/60 text-muted-foreground hover:bg-secondary/50",
          ].join(" ")}
        >
          全部 {bankServices.length}
        </button>
        {GROUP_ORDER.map((group) => {
          const selected = selectedGroups.has(group);
          return (
            <button
              key={group}
              onClick={() => toggleGroup(group)}
              className={[
                "inline-flex items-center gap-1 rounded-full border px-3 py-1 text-xs transition-colors",
                selected
                  ? "border-foreground bg-foreground text-background"
                  : "border-border/60 text-muted-foreground hover:bg-secondary/50",
              ].join(" ")}
            >
              {selected && <Check size={12} />}
              {GROUP_SHORT_LABELS[group]} {groupCounts[group]}
            </button>
          );
        })}
        {selectedGroups.size > 0 && (
          <button
            onClick={() => setSelectedGroups(new Set())}
            className="inline-flex items-center rounded-full px-3 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            清除筛选
          </button>
        )}
      </div>

      <label className="inline-flex cursor-pointer select-none items-center gap-2 text-xs text-muted-foreground">
        <input
          type="checkbox"
          checked={onlyConnected}
          onChange={(event) => setOnlyConnected(event.target.checked)}
        />
        <span>只看已连接 ({connectedCount})</span>
      </label>

      <div className="h-px bg-border/30" />

      {loading && (
        <div className="grid grid-cols-2 gap-3">
          {Array.from({ length: 6 }, (_, i) => <SkeletonCard key={i} />)}
        </div>
      )}

      {!loading && GROUP_ORDER.map((group) => {
        const list = byGroup[group];
        if (!list || list.length === 0) return null;
        return (
          <section key={group} className="space-y-3">
            <div className="space-y-1">
              <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground/70">
                {GROUP_LABELS[group]}
              </h2>
              {GROUP_DESCRIPTIONS[group] && (
                <p className="text-xs text-muted-foreground/60">
                  {GROUP_DESCRIPTIONS[group]}
                </p>
              )}
            </div>
            <div className="grid grid-cols-2 gap-3">
              {list.map((svc) => (
                <ServiceCard
                  key={svc.service}
                  svc={svc}
                  onClick={() => nav.toServiceDetail(svc.service)}
                />
              ))}
            </div>
          </section>
        );
      })}

      {showCustomSection && (
        <section className="space-y-3">
          <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground/70">
            自定义服务
          </h2>
          <div className="grid grid-cols-2 gap-3">
            {filteredCustom.map((svc) => (
              <ServiceCard
                key={svc.service}
                svc={svc}
                onClick={() => nav.toServiceDetail(svc.service)}
              />
            ))}
            {canCreateCustom && (
              <button
                onClick={() => nav.toServiceDetail("custom")}
                className="flex min-h-[92px] flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed border-border/40 p-5 text-muted-foreground/60 transition-all hover:border-primary/30 hover:text-muted-foreground"
              >
                <Plus size={18} />
                <span className="text-xs">自定义服务</span>
              </button>
            )}
          </div>
        </section>
      )}

      {!loading && filtered.length === 0 && filteredCustom.length === 0 && !canCreateCustom && (
        <div className="rounded-lg border border-dashed border-border/40 p-8 text-center text-sm text-muted-foreground">
          没有匹配的服务商
        </div>
      )}
    </div>
  );
}
