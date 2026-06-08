import type { MessageState, SessionRuntime } from "./types";

const STORAGE_KEY = "inkos:chat-session-cache:v1";
const INPUT_DRAFT_KEY = "inkos:chat-input-draft:v1";
const MAX_SESSIONS = 24;
const MAX_MESSAGES_PER_SESSION = 80;
const MAX_PERSISTED_BYTES = 240_000;

interface PersistedSession {
  readonly sessionId: string;
  readonly bookId: string | null;
  readonly title: string | null;
  readonly messages: SessionRuntime["messages"];
  readonly deletedMessageKeys?: ReadonlyArray<string>;
  readonly isDraft: boolean;
}

interface PersistedChatState {
  readonly activeSessionId: string | null;
  readonly sessionIdsByBook: MessageState["sessionIdsByBook"];
  readonly sessions: Record<string, PersistedSession>;
  readonly input: string;
  readonly selectedModel: string | null;
  readonly selectedService: string | null;
}

function canUseStorage(): boolean {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

export function loadPersistedInputDraft(): string {
  if (!canUseStorage()) return "";
  try {
    return window.localStorage.getItem(INPUT_DRAFT_KEY) ?? "";
  } catch {
    return "";
  }
}

export function persistInputDraft(input: string): void {
  if (!canUseStorage()) return;
  try {
    if (input.length > 0) {
      window.localStorage.setItem(INPUT_DRAFT_KEY, input);
    } else {
      window.localStorage.removeItem(INPUT_DRAFT_KEY);
    }
  } catch {
    // Storage failures should never interrupt typing.
  }
}

function sessionSortTime(session: SessionRuntime): number {
  const messageTime = session.messages.at(-1)?.timestamp;
  if (typeof messageTime === "number") return messageTime;
  const sessionTime = Number(session.sessionId.split("-")[0]);
  return Number.isFinite(sessionTime) ? sessionTime : 0;
}

function isTransientAssistantError(message: SessionRuntime["messages"][number]): boolean {
  if (message.role !== "assistant" || !message.content.startsWith("\u2717")) return false;
  return /network error|failed to fetch|无法连接到 API 服务|请求超时|请先选择一个模型|select a model/i.test(message.content);
}

function cacheableMessages(messages: SessionRuntime["messages"]): SessionRuntime["messages"] {
  const kept: Array<SessionRuntime["messages"][number]> = [];
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    const next = messages[index + 1];
    if (isTransientAssistantError(message)) continue;
    if (message.role === "user" && next && isTransientAssistantError(next)) continue;
    kept.push(message);
  }
  return kept;
}

export function loadPersistedMessageState(): Partial<MessageState> {
  if (!canUseStorage()) return {};
  try {
    const inputDraft = loadPersistedInputDraft();
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return inputDraft ? { input: inputDraft } : {};
    const parsed = JSON.parse(raw) as Partial<PersistedChatState>;
    const persistedSessions = parsed.sessions ?? {};
    const sessions: MessageState["sessions"] = {};
    for (const [sessionId, session] of Object.entries(persistedSessions)) {
      if (!session?.sessionId || session.sessionId !== sessionId) continue;
      sessions[sessionId] = {
        sessionId,
        bookId: session.bookId ?? null,
        title: session.title ?? null,
        messages: cacheableMessages(session.messages ?? []),
        deletedMessageKeys: session.deletedMessageKeys ?? [],
        stream: null,
        abortController: null,
        isStreaming: false,
        lastError: null,
        isDraft: session.isDraft ?? false,
      };
    }
    return {
      activeSessionId: parsed.activeSessionId ?? null,
      sessionIdsByBook: parsed.sessionIdsByBook ?? {},
      sessions,
      input: typeof parsed.input === "string" && parsed.input.length > 0 ? parsed.input : inputDraft,
      selectedModel: parsed.selectedModel ?? null,
      selectedService: parsed.selectedService ?? null,
    };
  } catch {
    return {};
  }
}

export function persistMessageState(state: MessageState): void {
  if (!canUseStorage()) return;
  try {
    persistInputDraft(state.input);
    let messageLimit = MAX_MESSAGES_PER_SESSION;
    const buildSessionEntries = () => Object.entries(state.sessions)
      .map(([sessionId, session]) => [sessionId, { ...session, messages: cacheableMessages(session.messages) }] as const)
      .filter(([, session]) => session.messages.length > 0 || session.isDraft)
      .sort(([, left], [, right]) => {
        return sessionSortTime(right) - sessionSortTime(left);
      })
      .slice(0, MAX_SESSIONS)
      .map(([sessionId, session]) => [
        sessionId,
        {
          sessionId,
          bookId: session.bookId,
          title: session.title,
          messages: session.messages.slice(-messageLimit),
          deletedMessageKeys: session.deletedMessageKeys,
          isDraft: session.isDraft,
        } satisfies PersistedSession,
      ]);

    let payload: PersistedChatState;
    let serialized = "";
    do {
      const sessionEntries = buildSessionEntries();
      const cachedSessionIds = new Set(sessionEntries.map(([sessionId]) => sessionId));
      const sessionIdsByBook = Object.fromEntries(
        Object.entries(state.sessionIdsByBook).map(([bookId, ids]) => [
          bookId,
          ids.filter((sessionId) => cachedSessionIds.has(sessionId)),
        ]),
      );

      payload = {
        activeSessionId: state.activeSessionId && cachedSessionIds.has(state.activeSessionId)
          ? state.activeSessionId
          : null,
        sessionIdsByBook,
        sessions: Object.fromEntries(sessionEntries),
        input: state.input,
        selectedModel: state.selectedModel,
        selectedService: state.selectedService,
      };
      serialized = JSON.stringify(payload);
      if (serialized.length <= MAX_PERSISTED_BYTES || messageLimit <= 12) break;
      messageLimit = Math.max(12, Math.floor(messageLimit * 0.65));
    } while (true);

    window.localStorage.setItem(STORAGE_KEY, serialized);
  } catch {
    // Storage failures should never interrupt chat.
  }
}
