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
  readonly messageCount: number;
}

export interface ComposerTextSyncInput {
  readonly storeInput: string;
  readonly composerText: string;
  readonly elementValue: string | null;
  readonly elementFocused: boolean;
}

export interface ComposerTextSyncResult {
  readonly text: string;
  readonly syncStoreText: string | null;
  readonly syncElementText: string | null;
}

const BOOK_CREATE_SESSION_KEY = "inkos.book-create.session-id";
const BOOK_CREATE_ASSISTANT_INPUT_KEY = "inkos.book-create.assistant-input";
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

export function getBookCreateAssistantInput(): string {
  return globalThis.localStorage?.getItem(BOOK_CREATE_ASSISTANT_INPUT_KEY) ?? "";
}

export function setBookCreateAssistantInput(input: string): void {
  if (input.length > 0) {
    globalThis.localStorage?.setItem(BOOK_CREATE_ASSISTANT_INPUT_KEY, input);
  } else {
    globalThis.localStorage?.removeItem(BOOK_CREATE_ASSISTANT_INPUT_KEY);
  }
}

export function clearBookCreateAssistantInput(): void {
  globalThis.localStorage?.removeItem(BOOK_CREATE_ASSISTANT_INPUT_KEY);
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

export function pickModelSelection(
  groupedModels: ReadonlyArray<ChatPageModelGroup>,
  selectedModel: string | null,
  selectedService: string | null,
  preference?: ChatPageModelPreference | null,
  options: { readonly modelsLoading?: boolean } = {},
): { model: string; service: string } | null {
  const selectedStillAvailable = selectedModel && selectedService
    ? groupedModels.some((group) =>
        group.service === selectedService
        && group.models.some((model) => model.id === selectedModel),
      )
    : false;
  if (selectedStillAvailable) return null;
  if (options.modelsLoading && selectedModel && selectedService) return null;

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

export function ensureConfiguredModelGroup(
  groupedModels: ReadonlyArray<ChatPageModelGroup>,
  services: ReadonlyArray<ChatPageServiceInfo>,
  preference?: ChatPageModelPreference | null,
): ReadonlyArray<ChatPageModelGroup> {
  const preferredService = preference?.service?.trim();
  const preferredModel = preference?.model?.trim();
  if (!preferredService || !preferredModel) return groupedModels;

  const existingIndex = groupedModels.findIndex((group) => group.service === preferredService);
  if (existingIndex >= 0) {
    const existing = groupedModels[existingIndex]!;
    if (existing.models.some((model) => model.id === preferredModel)) return groupedModels;
    return groupedModels.map((group, index) => index === existingIndex
      ? {
          ...existing,
          models: [
            { id: preferredModel, name: preferredModel },
            ...existing.models,
          ],
        }
      : group);
  }

  const service = services.find((item) => item.service === preferredService);
  return [
    {
      service: preferredService,
      label: service?.label || preferredService,
      models: [{ id: preferredModel, name: preferredModel }],
    },
    ...groupedModels,
  ];
}

export function pickProjectChatSessionId(
  sessions: ReadonlyArray<ChatPageSessionSummary>,
): string | null {
  return sessions.find((session) => session.messageCount > 0)?.sessionId
    ?? sessions[0]?.sessionId
    ?? null;
}

export function resolveComposerTextSync(input: ComposerTextSyncInput): ComposerTextSyncResult {
  const liveElementText = input.elementValue ?? input.composerText;

  if (input.elementFocused && liveElementText !== input.storeInput) {
    return {
      text: liveElementText,
      syncStoreText: liveElementText,
      syncElementText: null,
    };
  }

  const nextText = input.storeInput.length === 0 && input.composerText.length > 0
    ? input.composerText
    : input.storeInput;

  return {
    text: nextText,
    syncStoreText: nextText !== input.storeInput ? nextText : null,
    syncElementText: input.elementValue !== null && input.elementValue !== nextText ? nextText : null,
  };
}
