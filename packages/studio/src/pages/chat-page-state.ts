export interface ChatPageModelInfo {
  readonly id: string;
  readonly name?: string;
}

export interface ChatPageModelGroup {
  readonly service: string;
  readonly label: string;
  readonly models: ReadonlyArray<ChatPageModelInfo>;
}

export interface ChatPageModelPreference {
  readonly model?: string | null;
  readonly service?: string | null;
}

export interface ChatPageServiceInfo {
  readonly service: string;
  readonly label: string;
  readonly connected: boolean;
}

export interface ChatPageSessionSummary {
  readonly sessionId: string;
  readonly sessionKind?: string;
  readonly messageCount: number;
}

const BOOK_CREATE_SESSION_KEY = "inkos.book-create.session-id";
const PROJECT_CHAT_SESSION_KEY = "inkos.project-chat.session-id";

export function getBookCreateSessionId(): string | null {
  return globalThis.localStorage?.getItem(BOOK_CREATE_SESSION_KEY) ?? null;
}

export function setBookCreateSessionId(sessionId: string): void {
  globalThis.localStorage?.setItem(BOOK_CREATE_SESSION_KEY, sessionId);
}

export function clearBookCreateSessionId(): void {
  globalThis.localStorage?.removeItem(BOOK_CREATE_SESSION_KEY);
}

export function getProjectChatSessionId(): string | null {
  return globalThis.localStorage?.getItem(PROJECT_CHAT_SESSION_KEY) ?? null;
}

export function setProjectChatSessionId(sessionId: string): void {
  globalThis.localStorage?.setItem(PROJECT_CHAT_SESSION_KEY, sessionId);
}

export function filterModelGroups(
  groupedModels: ReadonlyArray<ChatPageModelGroup>,
  search: string,
): ReadonlyArray<ChatPageModelGroup> {
  const query = search.trim().toLowerCase();
  if (!query) return groupedModels;

  return groupedModels
    .map((group) => ({
      ...group,
      models: group.models.filter((model) =>
        (model.name ?? model.id).toLowerCase().includes(query)
        || group.label.toLowerCase().includes(query),
      ),
    }))
    .filter((group) => group.models.length > 0);
}

export function buildModelGroups(
  services: ReadonlyArray<ChatPageServiceInfo>,
  modelsByService: Readonly<Record<string, ReadonlyArray<ChatPageModelInfo>>>,
  preference?: ChatPageModelPreference | null,
  current?: ChatPageModelPreference | null,
): ReadonlyArray<ChatPageModelGroup> {
  return services
    .filter((service) => service.connected)
    .map((service) => {
      const discovered = modelsByService[service.service] ?? [];
      const fallbackModel = preference?.service === service.service
        ? preference.model?.trim()
        : current?.service === service.service
          ? current.model?.trim()
          : "";
      if (discovered.length > 0) {
        const models = fallbackModel && !discovered.some((model) => model.id === fallbackModel)
          ? [{ id: fallbackModel, name: fallbackModel }, ...discovered]
          : discovered;
        return { service: service.service, label: service.label, models };
      }
      return fallbackModel
        ? {
            service: service.service,
            label: service.label,
            models: [{ id: fallbackModel, name: fallbackModel }],
          }
        : null;
    })
    .filter((group): group is ChatPageModelGroup => group !== null);
}

export function pickModelSelection(
  groupedModels: ReadonlyArray<ChatPageModelGroup>,
  selectedModel: string | null,
  selectedService: string | null,
  preference?: ChatPageModelPreference | null,
): { model: string; service: string } | null {
  const selectedStillAvailable = selectedModel && selectedService
    ? groupedModels.some((group) =>
        group.service === selectedService
        && group.models.some((model) => model.id === selectedModel),
      )
    : false;
  if (selectedStillAvailable) return null;

  const preferredService = preference?.service?.trim();
  const preferredModel = preference?.model?.trim();
  if (preferredService) {
    const preferredGroup = groupedModels.find((group) => group.service === preferredService);
    const exactModel = preferredModel
      ? preferredGroup?.models.find((model) => model.id === preferredModel)
      : undefined;
    if (preferredGroup && exactModel) {
      return { model: exactModel.id, service: preferredGroup.service };
    }
    const firstPreferredModel = preferredGroup?.models[0];
    if (preferredGroup && firstPreferredModel) {
      return { model: firstPreferredModel.id, service: preferredGroup.service };
    }
  }

  if (preferredModel) {
    for (const group of groupedModels) {
      const exactModel = group.models.find((model) => model.id === preferredModel);
      if (exactModel) return { model: exactModel.id, service: group.service };
    }
  }

  const firstGroup = groupedModels.find((group) => group.models.length > 0);
  const firstModel = firstGroup?.models[0];
  if (!firstGroup || !firstModel) return null;
  return { model: firstModel.id, service: firstGroup.service };
}

export function pickProjectChatSessionId(
  sessions: ReadonlyArray<ChatPageSessionSummary>,
): string | null {
  const projectSurfaceSessions = sessions.filter((session) =>
    !session.sessionKind
    || session.sessionKind === "chat"
    || session.sessionKind === "short"
    || session.sessionKind === "play"
  );
  return projectSurfaceSessions.find((session) => session.messageCount > 0)?.sessionId
    ?? projectSurfaceSessions[0]?.sessionId
    ?? null;
}

export function isExplicitCreateBookInstruction(instruction: string): boolean {
  const trimmed = instruction.trim();
  if (!trimmed) return false;
  if (
    /[\uFF1F?]\s*$/.test(trimmed)
    && /(?:\u80FD\u4E0D\u80FD|\u53EF\u4EE5|\u662F\u5426|\u600E\u4E48|\u5982\u4F55|\u5EFA\u8BAE)/u.test(trimmed)
  ) {
    return false;
  }

  const imperative = trimmed.replace(
    /^(?:\u8BF7|\u9EBB\u70E6|\u5E2E\u6211|\u7ED9\u6211|\u66FF\u6211|\u76F4\u63A5|\u73B0\u5728|\u5F00\u59CB|\u7ACB\u523B|\u9A6C\u4E0A)\s*/u,
    "",
  );
  if (
    /^(?:\u5EFA\u4E66|\u521B\u5EFA(?:\u4E00?\u672C)?(?:\u4E66|\u4E66\u7C4D|\u5C0F\u8BF4|\u957F\u7BC7|\u8FDE\u8F7D|\u4F5C\u54C1)|\u65B0\u5EFA(?:\u4E00?\u672C)?(?:\u4E66|\u4E66\u7C4D|\u5C0F\u8BF4|\u957F\u7BC7|\u8FDE\u8F7D|\u4F5C\u54C1)|\u751F\u6210(?:\u4E00?\u672C)?(?:\u4E66|\u4E66\u7C4D|\u5C0F\u8BF4|\u957F\u7BC7|\u8FDE\u8F7D|\u4F5C\u54C1))(?:\s|[\uFF0C\u3002,.!\uFF01?\uFF1F;\uFF1B:\uFF1A]|$)/u.test(imperative)
    || /^(?:\u521B\u5EFA|\u65B0\u5EFA|\u751F\u6210)(?:\u4E00?\u672C)?[\u3400-\u9fffA-Za-z0-9_\-\s]{0,40}(?:\u4E66|\u4E66\u7C4D|\u5C0F\u8BF4|\u957F\u7BC7|\u8FDE\u8F7D|\u4F5C\u54C1)(?:\s|[\uFF0C\u3002,.!\uFF01?\uFF1F;\uFF1B:\uFF1A]|$)/u.test(imperative)
  ) {
    return true;
  }

  return /^(?:please\s+)?(?:create|start|build|make|generate)\s+(?:me\s+)?(?:a\s+)?(?:new\s+)?(?:book|novel|long[-\s]?form|serial)(?:\b|$)/i.test(trimmed);
}

export function shouldShowPlayChoicePanel(input: {
  readonly playMode?: string | null;
  readonly choiceSetKey?: string | null;
  readonly consumedChoiceKey?: string | null;
  readonly choiceCount: number;
}): boolean {
  if (input.playMode !== "guided") return false;
  if (!input.choiceSetKey) return false;
  if (input.choiceCount <= 0) return false;
  return input.choiceSetKey !== input.consumedChoiceKey;
}

export function isChatScrollNearBottom(input: {
  readonly scrollTop: number;
  readonly clientHeight: number;
  readonly scrollHeight: number;
  readonly thresholdPx?: number;
}): boolean {
  const threshold = input.thresholdPx ?? 96;
  const distanceFromBottom = input.scrollHeight - input.scrollTop - input.clientHeight;
  return distanceFromBottom <= threshold;
}

export function shouldSyncExternalChatInput(input: {
  readonly domValue: string;
  readonly storeValue: string;
  readonly sessionChanged: boolean;
  readonly focused: boolean;
  readonly composing: boolean;
}): boolean {
  if (input.domValue === input.storeValue) return false;
  if (input.sessionChanged) return true;
  return !input.focused && !input.composing;
}
