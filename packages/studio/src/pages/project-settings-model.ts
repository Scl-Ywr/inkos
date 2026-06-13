export type NotifyType = "telegram" | "wechat-work" | "feishu" | "webhook";

export interface NotifyChannelDraft {
  type: NotifyType;
  botToken?: string;
  chatId?: string;
  webhookUrl?: string;
  url?: string;
  secret?: string;
  rest?: Record<string, unknown>;
}

export interface OverrideRow {
  agent: string;
  model: string;
  service?: string;
  rest?: Record<string, unknown>;
}

export const AGENT_MODEL_ROUTES = [
  {
    agent: "architect",
    label: "建书",
    hint: "创建书籍、世界观、角色与基础设定。",
  },
  {
    agent: "writer",
    label: "写作",
    hint: "生成正文与章节内容，建议使用文风最稳定的模型。",
  },
  {
    agent: "auditor",
    label: "审计",
    hint: "检查逻辑、伏笔、状态文件与前后矛盾。",
  },
  {
    agent: "reviser",
    label: "修订",
    hint: "根据审计意见改稿，可与写作模型相同。",
  },
  {
    agent: "exporter",
    label: "导出",
    hint: "整理导出内容，通常可使用默认或轻量模型。",
  },
  {
    agent: "play",
    label: "互动",
    hint: "开放世界与分支互动场景生成，建议使用创意强的模型。",
  },
] as const;

export type AgentModelRouteKey = typeof AGENT_MODEL_ROUTES[number]["agent"];

export interface DetectionDraft {
  enabled: boolean;
  provider: string;
  apiUrl: string;
  apiKeyEnv: string;
  threshold: number;
  autoRewrite: boolean;
  maxRetries: number;
  rest?: Record<string, unknown>;
}

export const DEFAULT_DETECTION: DetectionDraft = {
  enabled: false,
  provider: "custom",
  apiUrl: "",
  apiKeyEnv: "",
  threshold: 0.5,
  autoRewrite: false,
  maxRetries: 3,
};

export const NOTIFY_TYPES: ReadonlyArray<{ value: NotifyType; label: string }> = [
  { value: "telegram", label: "Telegram" },
  { value: "feishu", label: "飞书 Feishu" },
  { value: "wechat-work", label: "企业微信" },
  { value: "webhook", label: "Webhook" },
];

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function omitKeys(source: Record<string, unknown>, keys: ReadonlyArray<string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (!keys.includes(key)) out[key] = value;
  }
  return out;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberField(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function booleanField(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function decodeRepeatedly(value: string): string {
  let current = value.trim();
  for (let i = 0; i < 3; i++) {
    try {
      const decoded = decodeURIComponent(current);
      if (decoded === current) break;
      current = decoded.trim();
    } catch {
      break;
    }
  }
  return current;
}

export function normalizeModelRouteService(service: string | undefined): string | undefined {
  const normalized = service ? decodeRepeatedly(service) : "";
  return normalized || undefined;
}

export function notifyDraftFromChannel(value: unknown): NotifyChannelDraft {
  const raw = asRecord(value);
  const type = raw.type === "telegram" || raw.type === "wechat-work" || raw.type === "feishu" || raw.type === "webhook"
    ? raw.type
    : "webhook";
  return {
    type,
    botToken: stringField(raw.botToken),
    chatId: stringField(raw.chatId),
    webhookUrl: stringField(raw.webhookUrl),
    url: stringField(raw.url),
    secret: stringField(raw.secret),
    rest: omitKeys(raw, ["type", "botToken", "chatId", "webhookUrl", "url", "secret"]),
  };
}

export function buildNotifyChannel(d: NotifyChannelDraft): Record<string, unknown> {
  if (d.type === "telegram") {
    return { ...(d.rest ?? {}), type: "telegram", botToken: d.botToken ?? "", chatId: d.chatId ?? "" };
  }
  if (d.type === "wechat-work") {
    return { ...(d.rest ?? {}), type: "wechat-work", webhookUrl: d.webhookUrl ?? "" };
  }
  if (d.type === "feishu") {
    return { ...(d.rest ?? {}), type: "feishu", webhookUrl: d.webhookUrl ?? "" };
  }
  const base: Record<string, unknown> = { ...(d.rest ?? {}), type: "webhook", url: d.url ?? "" };
  if (d.secret) base.secret = d.secret;
  else delete base.secret;
  if (!("events" in base)) base.events = [];
  return base;
}

export function detectionDraftFromConfig(value: unknown): DetectionDraft {
  const raw = asRecord(value);
  if (Object.keys(raw).length === 0) return { ...DEFAULT_DETECTION };
  return {
    enabled: booleanField(raw.enabled, true),
    provider: stringField(raw.provider) ?? DEFAULT_DETECTION.provider,
    apiUrl: stringField(raw.apiUrl) ?? DEFAULT_DETECTION.apiUrl,
    apiKeyEnv: stringField(raw.apiKeyEnv) ?? DEFAULT_DETECTION.apiKeyEnv,
    threshold: numberField(raw.threshold, DEFAULT_DETECTION.threshold),
    autoRewrite: booleanField(raw.autoRewrite, DEFAULT_DETECTION.autoRewrite),
    maxRetries: numberField(raw.maxRetries, DEFAULT_DETECTION.maxRetries),
    rest: omitKeys(raw, ["enabled", "provider", "apiUrl", "apiKeyEnv", "threshold", "autoRewrite", "maxRetries"]),
  };
}

export function buildDetectionConfig(det: DetectionDraft): Record<string, unknown> | null {
  if (!det.enabled) return null;
  return {
    ...(det.rest ?? {}),
    provider: det.provider,
    apiUrl: det.apiUrl,
    apiKeyEnv: det.apiKeyEnv,
    threshold: det.threshold,
    enabled: true,
    autoRewrite: det.autoRewrite,
    maxRetries: det.maxRetries,
  };
}

export function fixedAgentOverrideRows(overrides: Record<string, unknown> | undefined): OverrideRow[] {
  const raw = overrides ?? {};
  return AGENT_MODEL_ROUTES.map(({ agent }) => {
    const value = raw[agent];
    if (typeof value === "string") return { agent, model: value };
    const { model, service, ...rest } = asRecord(value);
    return {
      agent,
      model: stringField(model) ?? "",
      service: normalizeModelRouteService(stringField(service)),
      ...(Object.keys(rest).length > 0 ? { rest } : {}),
    };
  });
}

export function buildAgentModelOverrides(rows: ReadonlyArray<OverrideRow>): Record<string, unknown> {
  const allowed = new Set<string>(AGENT_MODEL_ROUTES.map((route) => route.agent));
  const overrides: Record<string, unknown> = {};
  for (const row of rows) {
    const agent = row.agent.trim();
    const model = row.model.trim();
    if (!allowed.has(agent) || !model) continue;
    const service = normalizeModelRouteService(row.service);
    overrides[agent] = service || (row.rest && Object.keys(row.rest).length > 0)
      ? { ...(row.rest ?? {}), ...(service ? { service } : {}), model }
      : model;
  }
  return overrides;
}

export function modelRouteValue(service: string, model: string): string {
  return `${encodeURIComponent(service)}::${encodeURIComponent(model)}`;
}

export function parseModelRouteValue(value: string): { service: string; model: string } | null {
  const separator = value.indexOf("::");
  if (separator < 0) return null;
  try {
    const service = decodeRepeatedly(value.slice(0, separator));
    const model = decodeRepeatedly(value.slice(separator + 2));
    return service && model ? { service, model } : null;
  } catch {
    return null;
  }
}
