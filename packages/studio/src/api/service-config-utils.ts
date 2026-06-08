import {
  resolveCoverProviderPreset,
  resolveServicePreset,
  resolveServiceProviderFamily,
} from "@actalk/inkos-core";
export const OFFICIAL_OPTIMIZATION_SERVICE_ID = "official-optimization";
export const HEADROOM_SECRET_KEY = `${OFFICIAL_OPTIMIZATION_SERVICE_ID}:headroom`;
export const EMBEDDING_SECRET_KEY = `${OFFICIAL_OPTIMIZATION_SERVICE_ID}:embedding`;

export interface ServiceConfigEntry {
  service: string;
  name?: string;
  baseUrl?: string;
  temperature?: number;
  apiFormat?: "chat" | "responses";
  stream?: boolean;
  headroom?: {
    enabled?: boolean;
    baseUrl?: string;
    timeoutMs?: number;
  };
  embedding?: {
    enabled?: boolean;
    endpoint?: string;
    model?: string;
    timeoutMs?: number;
  };
}

export type LLMConfigSource = "env" | "studio";

export interface EnvConfigSummary {
  detected: boolean;
  provider: string | null;
  baseUrl: string | null;
  model: string | null;
  hasApiKey: boolean;
}

export interface EnvConfigStatus {
  project: EnvConfigSummary;
  global: EnvConfigSummary;
  effectiveSource: "project" | "global" | null;
  runtimeUsesEnv: false;
}

export function clearTopLevelLlmMirror(llm: Record<string, unknown>): void {
  delete llm.service;
  delete llm.defaultModel;
  delete llm.model;
  delete llm.baseUrl;
  delete llm.apiFormat;
  delete llm.stream;
  delete llm.temperature;
}

export function isCustomServiceId(serviceId: string): boolean {
  return serviceId === "custom" || serviceId.startsWith("custom:");
}

export function serviceConfigKey(entry: ServiceConfigEntry): string {
  return entry.service === "custom" ? `custom:${entry.name ?? "Custom"}` : entry.service;
}

function normalizePositiveInt(value: unknown): number | undefined {
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim()
      ? Number.parseInt(value, 10)
      : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : undefined;
}

export function normalizeOfficialOptimizationServiceEntry(value: Record<string, unknown>): ServiceConfigEntry {
  const headroom = value.headroom && typeof value.headroom === "object" && !Array.isArray(value.headroom)
    ? value.headroom as Record<string, unknown>
    : {};
  const embedding = value.embedding && typeof value.embedding === "object" && !Array.isArray(value.embedding)
    ? value.embedding as Record<string, unknown>
    : {};
  return {
    service: OFFICIAL_OPTIMIZATION_SERVICE_ID,
    headroom: {
      enabled: headroom.enabled === true,
      ...(typeof headroom.baseUrl === "string" && headroom.baseUrl.trim() ? { baseUrl: headroom.baseUrl.trim() } : {}),
      ...(normalizePositiveInt(headroom.timeoutMs) ? { timeoutMs: normalizePositiveInt(headroom.timeoutMs) } : {}),
    },
    embedding: {
      enabled: embedding.enabled === true,
      ...(typeof embedding.endpoint === "string" && embedding.endpoint.trim() ? { endpoint: embedding.endpoint.trim() } : {}),
      ...(typeof embedding.model === "string" && embedding.model.trim() ? { model: embedding.model.trim() } : {}),
      ...(normalizePositiveInt(embedding.timeoutMs) ? { timeoutMs: normalizePositiveInt(embedding.timeoutMs) } : {}),
    },
  };
}

function normalizeServiceEntry(serviceId: string, value: Record<string, unknown>): ServiceConfigEntry {
  if (serviceId === OFFICIAL_OPTIMIZATION_SERVICE_ID) {
    return normalizeOfficialOptimizationServiceEntry(value);
  }

  if (serviceId.startsWith("custom:")) {
    return {
      service: "custom",
      name: decodeURIComponent(serviceId.slice("custom:".length)),
      ...(typeof value.baseUrl === "string" && value.baseUrl.length > 0 ? { baseUrl: value.baseUrl } : {}),
      ...(typeof value.temperature === "number" ? { temperature: value.temperature } : {}),
      ...(value.apiFormat === "chat" || value.apiFormat === "responses" ? { apiFormat: value.apiFormat } : {}),
      ...(typeof value.stream === "boolean" ? { stream: value.stream } : {}),
    };
  }

  if (serviceId === "custom") {
    return {
      service: "custom",
      ...(typeof value.name === "string" && value.name.length > 0 ? { name: value.name } : {}),
      ...(typeof value.baseUrl === "string" && value.baseUrl.length > 0 ? { baseUrl: value.baseUrl } : {}),
      ...(typeof value.temperature === "number" ? { temperature: value.temperature } : {}),
      ...(value.apiFormat === "chat" || value.apiFormat === "responses" ? { apiFormat: value.apiFormat } : {}),
      ...(typeof value.stream === "boolean" ? { stream: value.stream } : {}),
    };
  }

  return {
    service: serviceId,
    ...(typeof value.temperature === "number" ? { temperature: value.temperature } : {}),
    ...(value.apiFormat === "chat" || value.apiFormat === "responses" ? { apiFormat: value.apiFormat } : {}),
    ...(typeof value.stream === "boolean" ? { stream: value.stream } : {}),
  };
}

export function normalizeConfigSource(value: unknown): LLMConfigSource {
  return value === "studio" ? "studio" : "env";
}

export function normalizeServiceConfig(raw: unknown): ServiceConfigEntry[] {
  if (Array.isArray(raw)) {
    return raw
      .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object")
      .map((entry) => ({
        service: typeof entry.service === "string" && entry.service.length > 0 ? entry.service : "custom",
        ...(typeof entry.name === "string" && entry.name.length > 0 ? { name: entry.name } : {}),
        ...(typeof entry.baseUrl === "string" && entry.baseUrl.length > 0 ? { baseUrl: entry.baseUrl } : {}),
        ...(typeof entry.temperature === "number" ? { temperature: entry.temperature } : {}),
        ...(entry.apiFormat === "chat" || entry.apiFormat === "responses" ? { apiFormat: entry.apiFormat } : {}),
        ...(typeof entry.stream === "boolean" ? { stream: entry.stream } : {}),
        ...(entry.service === OFFICIAL_OPTIMIZATION_SERVICE_ID ? normalizeOfficialOptimizationServiceEntry(entry) : {}),
      }));
  }

  if (raw && typeof raw === "object") {
    return Object.entries(raw as Record<string, unknown>)
      .filter(([, value]) => value && typeof value === "object")
      .map(([serviceId, value]) => normalizeServiceEntry(serviceId, value as Record<string, unknown>));
  }

  return [];
}

export function mergeServiceConfig(existing: ServiceConfigEntry[], updates: ServiceConfigEntry[]): ServiceConfigEntry[] {
  const merged = new Map(existing.map((entry) => [serviceConfigKey(entry), entry]));
  for (const update of updates) {
    merged.set(serviceConfigKey(update), update);
  }
  return [...merged.values()];
}

export function isOfficialOptimizationConfigured(entry?: ServiceConfigEntry): boolean {
  return Boolean(
    (entry?.headroom?.enabled && entry.headroom.baseUrl)
      || (entry?.embedding?.enabled && entry.embedding.endpoint),
  );
}

export function normalizeCoverConfig(raw: unknown): { service: string; model: string } | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const record = raw as Record<string, unknown>;
  const service = typeof record.service === "string" ? record.service : "";
  const preset = resolveCoverProviderPreset(service);
  if (!preset) return undefined;
  const requestedModel = typeof record.model === "string" ? record.model.trim() : "";
  const model = requestedModel && preset.models.includes(requestedModel)
    ? requestedModel
    : preset.defaultModel;
  return { service: preset.service, model };
}

export function syncTopLevelLlmMirror(llm: Record<string, unknown>): void {
  const selectedService = typeof llm.service === "string" ? llm.service : undefined;
  if (!selectedService) return;

  const services = normalizeServiceConfig(llm.services);
  const selectedEntry = services.find((entry) => serviceConfigKey(entry) === selectedService)
    ?? (!isCustomServiceId(selectedService) ? { service: selectedService } : undefined);
  if (!selectedEntry) return;

  const preset = resolveServicePreset(selectedEntry.service);
  llm.provider = resolveServiceProviderFamily(selectedEntry.service) ?? "openai";
  llm.baseUrl = selectedEntry.baseUrl ?? preset?.baseUrl ?? "";

  const defaultModel = typeof llm.defaultModel === "string" ? llm.defaultModel.trim() : "";
  if (defaultModel) llm.model = defaultModel;
  if (selectedEntry.temperature !== undefined) llm.temperature = selectedEntry.temperature;
  if (selectedEntry.apiFormat !== undefined) llm.apiFormat = selectedEntry.apiFormat;
  if (selectedEntry.stream !== undefined) llm.stream = selectedEntry.stream;
}
