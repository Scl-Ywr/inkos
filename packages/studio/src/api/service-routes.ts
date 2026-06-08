import {
  applyOfficialOptimizationConfig,
  COVER_PROVIDER_PRESETS,
  coverSecretKey,
  getAllEndpoints,
  isApiKeyOptionalForEndpoint,
  listModelsForService,
  loadSecrets,
  probeModelsFromUpstream,
  resolveCoverProviderPreset,
  resolveServiceProviderFamily,
  saveSecrets,
} from "@actalk/inkos-core";
import type { Hono } from "hono";
import {
  EMBEDDING_SECRET_KEY,
  HEADROOM_SECRET_KEY,
  OFFICIAL_OPTIMIZATION_SERVICE_ID,
  clearTopLevelLlmMirror,
  isCustomServiceId,
  isOfficialOptimizationConfigured,
  mergeServiceConfig,
  normalizeConfigSource,
  normalizeCoverConfig,
  normalizeOfficialOptimizationServiceEntry,
  normalizeServiceConfig,
  serviceConfigKey,
  syncTopLevelLlmMirror,
  type EnvConfigStatus,
  type LLMConfigSource,
} from "./service-config-utils.js";

interface ServiceProbeResult {
  readonly ok: boolean;
  readonly models: Array<{ id: string; name: string }>;
  readonly selectedModel?: string;
  readonly apiFormat?: "chat" | "responses";
  readonly stream?: boolean;
  readonly baseUrl?: string;
  readonly modelsSource?: "api" | "fallback";
  readonly error?: string;
}

interface ProbeServiceCapabilitiesInput {
  readonly root: string;
  readonly service: string;
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly preferredApiFormat?: "chat" | "responses";
  readonly preferredStream?: boolean;
  readonly preferredModel?: string;
  readonly proxyUrl?: string;
}

interface ServiceModelRoutesDeps {
  readonly root: string;
  readonly loadRawConfig: (root: string) => Promise<Record<string, unknown>>;
  readonly saveRawConfig: (root: string, config: Record<string, unknown>) => Promise<void>;
  readonly readEnvConfigStatus: (root: string) => Promise<EnvConfigStatus>;
  readonly resolveConfiguredServiceBaseUrl: (root: string, serviceId: string, inlineBaseUrl?: string) => Promise<string | undefined>;
  readonly probeServiceCapabilities: (args: ProbeServiceCapabilitiesInput) => Promise<ServiceProbeResult>;
  readonly filterTextChatModels: <T extends { readonly id: string }>(models: ReadonlyArray<T>) => T[];
  readonly isTextChatModelId: (modelId: string) => boolean;
}
function compareServiceListItems(
  left: { readonly service: string },
  right: { readonly service: string },
): number {
  const priority = ["kkaiapi", "openrouter", "newapi", "siliconcloud"];
  const leftPriority = priority.indexOf(left.service);
  const rightPriority = priority.indexOf(right.service);
  if (leftPriority !== -1 || rightPriority !== -1) {
    return (leftPriority === -1 ? 999 : leftPriority) - (rightPriority === -1 ? 999 : rightPriority);
  }
  return 0;
}

function isHeaderSafeApiKey(value: string): boolean {
  if (!value) return true;
  return /^[\x21-\x7E]+$/.test(value);
}

// 内存缓存：service -> 模型列表 + 更新时间戳；避免每次 sidebar 挂载时都打真实 LLM /models
const modelListCache = new Map<string, { models: Array<{ id: string; name: string }>; at: number }>();

export function registerServiceModelRoutes(app: Hono, deps: ServiceModelRoutesDeps): void {
  const {
    root,
    loadRawConfig,
    saveRawConfig,
    readEnvConfigStatus,
    resolveConfiguredServiceBaseUrl,
    probeServiceCapabilities,
    filterTextChatModels,
    isTextChatModelId,
  } = deps;
  // --- Model discovery ---

  app.get("/api/v1/services", async (c) => {
    const secrets = await loadSecrets(root);
    const endpoints = getAllEndpoints().filter((ep) => ep.id !== "custom");

    // Fast: only check connection status from secrets, no external API calls.
    const services = endpoints.map((ep) => ({
      service: ep.id,
      label: ep.label,
      group: ep.group,
      connected: Boolean(secrets.services[ep.id]?.apiKey),
    })).sort(compareServiceListItems);

    // Add custom services from inkos.json
    try {
      const config = await loadRawConfig(root);
      const configuredServices = normalizeServiceConfig((config.llm as Record<string, unknown> | undefined)?.services);
      const officialOptimization = configuredServices.find((entry) => entry.service === OFFICIAL_OPTIMIZATION_SERVICE_ID);
      services.push({
        service: OFFICIAL_OPTIMIZATION_SERVICE_ID,
        label: "官方优化",
        group: "local",
        connected: isOfficialOptimizationConfigured(officialOptimization),
      });
      for (const svc of configuredServices) {
        if (svc.service === "custom") {
          const secretKey = `custom:${svc.name}`;
          services.push({
            service: secretKey,
            label: svc.name ?? "Custom",
            group: undefined,
            connected: Boolean(secrets.services[secretKey]?.apiKey),
          });
        }
      }
    } catch { /* no config file */ }

    return c.json({ services });
  });

  app.get("/api/v1/services/config", async (c) => {
    const config = await loadRawConfig(root);
    const llm = (config.llm as Record<string, unknown> | undefined) ?? {};
    const services = normalizeServiceConfig(llm.services);
    const envConfig = await readEnvConfigStatus(root);
    return c.json({
      services,
      service: typeof llm.service === "string" ? llm.service : null,
      defaultModel: llm.defaultModel ?? null,
      configSource: "studio" satisfies LLMConfigSource,
      storedConfigSource: normalizeConfigSource(llm.configSource),
      envConfig,
    });
  });

  app.put("/api/v1/services/config", async (c) => {
    const body = await c.req.json<{ services?: unknown; defaultModel?: string; configSource?: LLMConfigSource; service?: string }>();
    const config = await loadRawConfig(root);
    config.llm = config.llm ?? {};
    const llm = config.llm as Record<string, unknown>;
    if (body.services !== undefined) {
      const existingServices = normalizeServiceConfig(llm.services);
      const incomingServices = normalizeServiceConfig(body.services);
      llm.services = mergeServiceConfig(existingServices, incomingServices);
    }
    if (body.defaultModel !== undefined) {
      llm.defaultModel = body.defaultModel;
    }
    if (body.configSource === "env") {
      return c.json({
        error: "Studio 运行时不支持切换到 env；env 只在 CLI/daemon/部署运行时作为覆盖层使用。",
      }, 400);
    }
    if (body.configSource !== undefined) {
      llm.configSource = normalizeConfigSource(body.configSource);
    }
    if (body.service !== undefined) {
      llm.service = body.service;
    }
    syncTopLevelLlmMirror(llm);
    await saveRawConfig(root, config);
    return c.json({ ok: true });
  });

  app.get("/api/v1/cover/config", async (c) => {
    const config = await loadRawConfig(root);
    const llm = (config.llm as Record<string, unknown> | undefined) ?? {};
    const cover = normalizeCoverConfig(llm.cover);
    const secrets = await loadSecrets(root);
    return c.json({
      service: cover?.service ?? null,
      model: cover?.model ?? null,
      providers: COVER_PROVIDER_PRESETS.map((provider) => ({
        service: provider.service,
        label: provider.label,
        baseUrl: provider.baseUrl,
        defaultModel: provider.defaultModel,
        models: provider.models,
        connected: Boolean(secrets.services[coverSecretKey(provider.service)]?.apiKey || secrets.services[provider.service]?.apiKey),
      })),
    });
  });

  app.put("/api/v1/cover/config", async (c) => {
    const body = await c.req.json<{ service?: string; model?: string }>();
    const preset = resolveCoverProviderPreset(body.service);
    if (!preset) {
      return c.json({ error: "Unsupported cover service" }, 400);
    }
    const model = typeof body.model === "string" && preset.models.includes(body.model)
      ? body.model
      : preset.defaultModel;

    const config = await loadRawConfig(root);
    config.llm = config.llm ?? {};
    const llm = config.llm as Record<string, unknown>;
    llm.cover = {
      service: preset.service,
      model,
    };
    await saveRawConfig(root, config);
    return c.json({ ok: true, service: preset.service, model });
  });

  app.get("/api/v1/cover/secret/:service", async (c) => {
    const service = c.req.param("service");
    if (!resolveCoverProviderPreset(service)) {
      return c.json({ error: "Unsupported cover service" }, 400);
    }
    const secrets = await loadSecrets(root);
    return c.json({ apiKey: secrets.services[coverSecretKey(service)]?.apiKey ?? "" });
  });

  app.put("/api/v1/cover/secret/:service", async (c) => {
    const service = c.req.param("service");
    if (!resolveCoverProviderPreset(service)) {
      return c.json({ error: "Unsupported cover service" }, 400);
    }
    const body = await c.req.json<{ apiKey?: string }>();
    const trimmedKey = body.apiKey?.trim() ?? "";
    if (trimmedKey && !isHeaderSafeApiKey(trimmedKey)) {
      return c.json({ error: "API Key 包含不能放入 HTTP Authorization header 的字符，请只粘贴原始密钥。" }, 400);
    }

    const secrets = await loadSecrets(root);
    const key = coverSecretKey(service);
    if (trimmedKey) {
      secrets.services[key] = { apiKey: trimmedKey };
    } else {
      delete secrets.services[key];
    }
    await saveSecrets(root, secrets);
    return c.json({ ok: true, service });
  });

  app.get("/api/v1/services/official-optimization/config", async (c) => {
    const config = await loadRawConfig(root);
    const services = normalizeServiceConfig((config.llm as Record<string, unknown> | undefined)?.services);
    const entry = services.find((item) => item.service === OFFICIAL_OPTIMIZATION_SERVICE_ID)
      ?? normalizeOfficialOptimizationServiceEntry({ service: OFFICIAL_OPTIMIZATION_SERVICE_ID });
    const secrets = await loadSecrets(root);
    return c.json({
      service: OFFICIAL_OPTIMIZATION_SERVICE_ID,
      headroom: {
        enabled: entry.headroom?.enabled === true,
        baseUrl: entry.headroom?.baseUrl ?? "",
        timeoutMs: entry.headroom?.timeoutMs ?? 2500,
        hasApiKey: Boolean(secrets.services[HEADROOM_SECRET_KEY]?.apiKey),
      },
      embedding: {
        enabled: entry.embedding?.enabled === true,
        endpoint: entry.embedding?.endpoint ?? "",
        model: entry.embedding?.model ?? "BAAI/bge-small-zh-v1.5-int8",
        timeoutMs: entry.embedding?.timeoutMs ?? 3000,
        hasApiKey: Boolean(secrets.services[EMBEDDING_SECRET_KEY]?.apiKey),
      },
      headroomApiKey: secrets.services[HEADROOM_SECRET_KEY]?.apiKey ?? "",
      embeddingApiKey: secrets.services[EMBEDDING_SECRET_KEY]?.apiKey ?? "",
    });
  });

  app.put("/api/v1/services/official-optimization/config", async (c) => {
    const body = await c.req.json<{
      headroom?: { enabled?: boolean; baseUrl?: string; timeoutMs?: number | string; apiKey?: string };
      embedding?: { enabled?: boolean; endpoint?: string; model?: string; timeoutMs?: number | string; apiKey?: string };
    }>();
    const headroomKey = body.headroom?.apiKey?.trim() ?? "";
    const embeddingKey = body.embedding?.apiKey?.trim() ?? "";
    if (headroomKey && !isHeaderSafeApiKey(headroomKey)) {
      return c.json({ ok: false, error: "Headroom API Key 包含不能放入 HTTP Authorization header 的字符。" }, 400);
    }
    if (embeddingKey && !isHeaderSafeApiKey(embeddingKey)) {
      return c.json({ ok: false, error: "Embedding API Key 包含不能放入 HTTP Authorization header 的字符。" }, 400);
    }

    const update = normalizeOfficialOptimizationServiceEntry({
      service: OFFICIAL_OPTIMIZATION_SERVICE_ID,
      headroom: {
        enabled: body.headroom?.enabled === true,
        baseUrl: body.headroom?.baseUrl,
        timeoutMs: body.headroom?.timeoutMs,
      },
      embedding: {
        enabled: body.embedding?.enabled === true,
        endpoint: body.embedding?.endpoint,
        model: body.embedding?.model,
        timeoutMs: body.embedding?.timeoutMs,
      },
    });
    const config = await loadRawConfig(root);
    config.llm = config.llm ?? {};
    const llm = config.llm as Record<string, unknown>;
    llm.services = mergeServiceConfig(normalizeServiceConfig(llm.services), [update]);
    await saveRawConfig(root, config);

    const secrets = await loadSecrets(root);
    if (headroomKey) secrets.services[HEADROOM_SECRET_KEY] = { apiKey: headroomKey };
    else delete secrets.services[HEADROOM_SECRET_KEY];
    if (embeddingKey) secrets.services[EMBEDDING_SECRET_KEY] = { apiKey: embeddingKey };
    else delete secrets.services[EMBEDDING_SECRET_KEY];
    await saveSecrets(root, secrets);
    applyOfficialOptimizationConfig(root);
    return c.json({ ok: true, configured: isOfficialOptimizationConfigured(update) });
  });

  app.post("/api/v1/services/official-optimization/test", async (c) => {
    const body = await c.req.json<{
      headroom?: { enabled?: boolean; baseUrl?: string; apiKey?: string };
      embedding?: { enabled?: boolean; endpoint?: string; model?: string; apiKey?: string };
    }>();
    const results: Array<{ service: "headroom" | "embedding"; ok: boolean; message: string }> = [];
    const headroomBaseUrl = body.headroom?.baseUrl?.trim() ?? "";
    if (body.headroom?.enabled) {
      if (!headroomBaseUrl) {
        results.push({ service: "headroom", ok: false, message: "Headroom Base URL 为空。" });
      } else {
        try {
          const url = new URL(headroomBaseUrl);
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 2500);
          const response = await fetch(url, {
            method: "GET",
            headers: body.headroom.apiKey ? { Authorization: `Bearer ${body.headroom.apiKey}` } : {},
            signal: controller.signal,
          }).catch(() => null);
          clearTimeout(timer);
          results.push({
            service: "headroom",
            ok: !response || response.status < 500,
            message: response ? `Headroom 地址可访问，HTTP ${response.status}。` : "Headroom URL 格式有效；服务未提供 GET 健康检查。",
          });
        } catch (error) {
          results.push({ service: "headroom", ok: false, message: error instanceof Error ? error.message : "Headroom URL 无效。" });
        }
      }
    }

    const embeddingEndpoint = body.embedding?.endpoint?.trim() ?? "";
    if (body.embedding?.enabled) {
      if (!embeddingEndpoint) {
        results.push({ service: "embedding", ok: false, message: "Embedding endpoint 为空。" });
      } else {
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 3000);
          const response = await fetch(embeddingEndpoint, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...(body.embedding.apiKey ? { Authorization: `Bearer ${body.embedding.apiKey}` } : {}),
            },
            body: JSON.stringify({
              model: body.embedding.model?.trim() || "BAAI/bge-small-zh-v1.5-int8",
              input: "InkOS embedding probe",
            }),
            signal: controller.signal,
          });
          clearTimeout(timer);
          const payload = await response.json().catch(() => null) as { data?: unknown } | null;
          const ok = response.ok && Array.isArray(payload?.data);
          results.push({
            service: "embedding",
            ok,
            message: ok ? "Embedding endpoint 已返回向量数据。" : `Embedding 返回 HTTP ${response.status}，未识别到 data 数组。`,
          });
        } catch (error) {
          results.push({ service: "embedding", ok: false, message: error instanceof Error ? error.message : "Embedding 测试失败。" });
        }
      }
    }

    if (results.length === 0) {
      results.push({ service: "headroom", ok: true, message: "未启用官方服务，当前将继续使用本地 fallback。" });
    }
    return c.json({ ok: results.every((result) => result.ok), results });
  });

  app.delete("/api/v1/services/:service", async (c) => {
    const service = c.req.param("service");
    const config = await loadRawConfig(root);
    const llm = (config.llm as Record<string, unknown> | undefined) ?? {};
    const existingServices = normalizeServiceConfig(llm.services);
    const nextServices = existingServices.filter((entry) => serviceConfigKey(entry) !== service);

    if (!config.llm) config.llm = {};
    const nextLlm = config.llm as Record<string, unknown>;
    nextLlm.services = nextServices;
    if (nextLlm.service === service) {
      clearTopLevelLlmMirror(nextLlm);
      const fallback = nextServices[0];
      if (fallback) {
        nextLlm.service = serviceConfigKey(fallback);
        syncTopLevelLlmMirror(nextLlm);
      }
    } else {
      syncTopLevelLlmMirror(nextLlm);
    }
    await saveRawConfig(root, config);

    const secrets = await loadSecrets(root);
    delete secrets.services[service];
    if (service === OFFICIAL_OPTIMIZATION_SERVICE_ID) {
      delete secrets.services[HEADROOM_SECRET_KEY];
      delete secrets.services[EMBEDDING_SECRET_KEY];
    }
    await saveSecrets(root, secrets);
    for (const key of [...modelListCache.keys()]) {
      if (key.startsWith(`${service}::`)) modelListCache.delete(key);
    }
    return c.json({ ok: true, service });
  });

  app.post("/api/v1/services/:service/test", async (c) => {
    const service = c.req.param("service");
    const { apiKey, baseUrl, apiFormat, stream, model } = await c.req.json<{
      apiKey: string;
      baseUrl?: string;
      apiFormat?: "chat" | "responses";
      stream?: boolean;
      model?: string;
    }>();

    const resolvedBaseUrl = await resolveConfiguredServiceBaseUrl(root, service, baseUrl);
    if (!resolvedBaseUrl) {
      return c.json({ ok: false, error: `未知服务商: ${service}` }, 400);
    }

    const baseService = isCustomServiceId(service) ? "custom" : service;
    const apiKeyOptional = isApiKeyOptionalForEndpoint({
      provider: resolveServiceProviderFamily(baseService) ?? "openai",
      baseUrl: resolvedBaseUrl,
    });
    if (!apiKey?.trim() && !apiKeyOptional) {
      return c.json({
        ok: false,
        error: "API Key 不能为空",
      }, 400);
    }

    const rawConfig = await loadRawConfig(root).catch(() => ({} as Record<string, unknown>));
    const llm = (rawConfig.llm as Record<string, unknown> | undefined) ?? {};
    const probe = await probeServiceCapabilities({
      root,
      service,
      apiKey: apiKey?.trim() ?? "",
      baseUrl: resolvedBaseUrl,
      preferredApiFormat: apiFormat,
      preferredStream: stream,
      preferredModel: model,
      proxyUrl: typeof llm.proxyUrl === "string" ? llm.proxyUrl : undefined,
    });

    // B12: 升级响应 shape 为 { probe, chat, ... }，同时保留老字段供 UI 过渡期兼容
    const probeStatus = {
      ok: probe.ok,
      models: probe.models?.length ?? 0,
      ...(probe.ok ? {} : { error: probe.error ?? "连接失败" }),
    };

    if (!probe.ok) {
      return c.json({
        ok: false,
        error: probe.error ?? "连接失败",
        probe: probeStatus,
        chat: null,
      }, 400);
    }

    return c.json({
      ok: true,
      modelCount: probe.models.length,
      models: probe.models,
      selectedModel: probe.selectedModel,
      detected: {
        apiFormat: probe.apiFormat,
        stream: probe.stream,
        baseUrl: probe.baseUrl,
        modelsSource: probe.modelsSource,
      },
      // B12 新字段：两步验证状态
      probe: probeStatus,
      chat: null,  // probeServiceCapabilities 本身只做 probe，chat hello 在 Studio 的 follow-up 调用里单独触发
    });
  });

  app.put("/api/v1/services/:service/secret", async (c) => {
    const service = c.req.param("service");
    const { apiKey } = await c.req.json<{ apiKey: string }>();
    const secrets = await loadSecrets(root);
    const trimmedKey = apiKey?.trim() ?? "";
    if (trimmedKey) {
      if (!isHeaderSafeApiKey(trimmedKey)) {
        return c.json({
          ok: false,
          error: "API Key 只能包含可放进 HTTP Authorization header 的非空白 ASCII 字符；请不要粘贴连接失败提示或诊断文本。",
        }, 400);
      }
      secrets.services[service] = { apiKey: trimmedKey };
    } else {
      delete secrets.services[service];
    }
    await saveSecrets(root, secrets);
    return c.json({ ok: true });
  });

  app.get("/api/v1/services/:service/secret", async (c) => {
    const service = c.req.param("service");
    const secrets = await loadSecrets(root);
    return c.json({
      apiKey: secrets.services[service]?.apiKey ?? "",
    });
  });

  app.get("/api/v1/services/models", async (c) => {
    const secrets = await loadSecrets(root);
    const endpoints = getAllEndpoints()
      .filter((ep) => ep.id !== "custom" && Boolean(secrets.services[ep.id]?.apiKey));

    const groups = endpoints.map((ep) => ({
      service: ep.id,
      label: ep.label,
      models: ep.models
        .filter((m) => m.enabled !== false)
        .filter((m) => isTextChatModelId(m.id))
        .map((m) => ({
          id: m.id,
          name: m.id,
          ...(typeof m.maxOutput === "number" ? { maxOutput: m.maxOutput } : {}),
          ...(m.contextWindowTokens > 0 ? { contextWindow: m.contextWindowTokens } : {}),
        })),
    }));

    return c.json({ groups });
  });

  app.get("/api/v1/services/models/custom", async (c) => {
    const secrets = await loadSecrets(root);
    let config: Record<string, unknown> = {};
    try {
      config = await loadRawConfig(root);
    } catch {
      // no config file
    }

    const customs = normalizeServiceConfig((config.llm as Record<string, unknown> | undefined)?.services)
      .filter((s) => s.service === "custom")
      .map((s) => ({
        id: `custom:${s.name ?? "Custom"}`,
        baseUrl: s.baseUrl ?? "",
        label: s.name ?? "Custom",
      }))
      .filter((s) => s.baseUrl && Boolean(secrets.services[s.id]?.apiKey));

    const groups = await Promise.all(customs.map(async (s) => ({
      service: s.id,
      label: s.label,
      models: filterTextChatModels(
        await probeModelsFromUpstream(s.baseUrl, secrets.services[s.id].apiKey, 10_000),
      ),
    })));

    return c.json({ groups });
  });

  app.get("/api/v1/services/:service/models", async (c) => {
    const service = c.req.param("service");
    const refresh = c.req.query("refresh") === "1";
    const secrets = await loadSecrets(root);
    const apiKey = c.req.query("apiKey") || secrets.services[service]?.apiKey || "";

    const resolvedBaseUrl = await resolveConfiguredServiceBaseUrl(root, service);
    const baseService = isCustomServiceId(service) ? "custom" : service;
    const apiKeyOptional = isApiKeyOptionalForEndpoint({
      provider: resolveServiceProviderFamily(baseService) ?? "openai",
      baseUrl: resolvedBaseUrl,
    });

    // No key = no models, except local/self-hosted endpoints such as Ollama.
    if (!apiKey && !apiKeyOptional) return c.json({ models: [] });

    // Cache by service + resolved baseUrl + apiKey fingerprint; valid for 10 min unless ?refresh=1
    const cacheKey = `${service}::${resolvedBaseUrl ?? ""}::${apiKey.slice(-8)}`;
    if (!refresh) {
      const cached = modelListCache.get(cacheKey);
      if (cached && Date.now() - cached.at < 10 * 60 * 1000) {
        return c.json({ models: cached.models });
      }
    }

    // B13: 走 listModelsForService 走 live probe + bank 交叉，返回带元数据的 models
    const enriched = await listModelsForService(
      isCustomServiceId(service) ? "custom" : service,
      apiKey,
      isCustomServiceId(service) ? resolvedBaseUrl ?? undefined : undefined,
    );
    const models = filterTextChatModels(enriched).map((m) => ({
      id: m.id,
      name: m.name,
      ...(m.maxOutput !== undefined ? { maxOutput: m.maxOutput } : {}),
      ...(m.contextWindow > 0 ? { contextWindow: m.contextWindow } : {}),
    }));
    modelListCache.set(cacheKey, { models, at: Date.now() });
    return c.json({ models });
  });
}
