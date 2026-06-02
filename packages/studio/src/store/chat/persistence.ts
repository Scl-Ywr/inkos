import type { MessageState, SessionRuntime } from "./types";

const STORAGE_KEY = "inkos:chat-session-cache:v1";
const MAX_SESSIONS = 24;
const MAX_MESSAGES_PER_SESSION = 80;

interface PersistedSession {
  readonly sessionId: string;
  readonly bookId: string | null;
  readonly title: string | null;
  readonly messages: SessionRuntime["messages"];
  readonly isDraft: boolean;
}

interface PersistedChatState {
  readonly activeSessionId: string | null;
  readonly sessionIdsByBook: MessageState["sessionIdsByBook"];
  readonly sessions: Record<string, PersistedSession>;
}

function canUseStorage(): boolean {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

function sessionSortTime(session: SessionRuntime): number {
  const messageTime = session.messages.at(-1)?.timestamp;
  if (typeof messageTime === "number") return messageTime;
  const sessionTime = Number(session.sessionId.split("-")[0]);
  return Number.isFinite(sessionTime) ? sessionTime : 0;
}

export function loadPersistedMessageState(): Partial<MessageState> {
  if (!canUseStorage()) return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Partial<PersistedChatState>;
    const persistedSessions = parsed.sessions ?? {};
    const sessions: MessageState["sessions"] = {};
    for (const [sessionId, session] of Object.entries(persistedSessions)) {
      if (!session?.sessionId || session.sessionId !== sessionId) continue;
      sessions[sessionId] = {
        sessionId,
        bookId: session.bookId ?? null,
        title: session.title ?? null,
        messages: session.messages ?? [],
        stream: null,
        isStreaming: false,
        lastError: null,
        isDraft: session.isDraft ?? false,
      };
    }
    return {
      activeSessionId: parsed.activeSessionId ?? null,
      sessionIdsByBook: parsed.sessionIdsByBook ?? {},
      sessions,
    };
  } catch {
    return {};
  }
}

export function persistMessageState(state: MessageState): void {
  if (!canUseStorage()) return;
  try {
    const sessionEntries = Object.entries(state.sessions)
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
          messages: session.messages.slice(-MAX_MESSAGES_PER_SESSION),
          isDraft: session.isDraft,
        } satisfies PersistedSession,
      ]);

    const cachedSessionIds = new Set(sessionEntries.map(([sessionId]) => sessionId));
    const sessionIdsByBook = Object.fromEntries(
      Object.entries(state.sessionIdsByBook).map(([bookId, ids]) => [
        bookId,
        ids.filter((sessionId) => cachedSessionIds.has(sessionId)),
      ]),
    );

    const payload: PersistedChatState = {
      activeSessionId: state.activeSessionId && cachedSessionIds.has(state.activeSessionId)
        ? state.activeSessionId
        : null,
      sessionIdsByBook,
      sessions: Object.fromEntries(sessionEntries),
    };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // Storage failures should never interrupt chat.
  }
}
