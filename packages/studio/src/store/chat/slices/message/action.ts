import type { StateCreator } from "zustand";
import type {
  AgentResponse,
  ChatStore,
  MessageActions,
  SessionResponse,
  SessionSummary,
} from "../../types";
import { buildApiUrl, fetchJson } from "../../../../hooks/use-api";
import { ensureEmbeddedNodeRunning } from "../../../../lib/android-runtime-plugin";
import { isNativeRuntime } from "../../../../lib/mobile-runtime";
import { persistInputDraft } from "../../persistence";
import { attachSessionStreamListeners } from "./stream-events";
import {
  bookKey,
  createSessionRuntime,
  deserializeMessages,
  extractErrorMessage,
  filterDeletedMessages,
  mergeSessionIds,
  messageDeletionKey,
  updateSession,
  upsertSessionSummary,
} from "./runtime";
import type { Message } from "../../types";
import type { TokenUsageSnapshot } from "../../types";

function shouldUseRemoteMessages(
  localMessages: ReadonlyArray<Message>,
  remoteMessages: ReadonlyArray<Message>,
): boolean {
  if (remoteMessages.length === 0) return localMessages.length === 0;
  if (localMessages.length === 0) return true;
  if (remoteMessages.length > localMessages.length) return true;
  if (remoteMessages.length < localMessages.length) return false;

  const localLast = localMessages[localMessages.length - 1];
  const remoteLast = remoteMessages[remoteMessages.length - 1];
  if (!localLast || !remoteLast) return false;
  if (remoteLast.role !== localLast.role) return false;
  if (localLast.tokenUsage && !remoteLast.tokenUsage) return false;
  return remoteLast.content.length >= localLast.content.length;
}

function isDeleteAlreadyAppliedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /404|not found|Message or session not found|消息.*不存在|会话.*不存在/i.test(message);
}

function parseAgentSseResult(text: string): AgentResponse | null {
  const blocks = text.split(/\r?\n\r?\n/u);
  for (const block of blocks) {
    let eventName = "";
    const dataLines: string[] = [];

    for (const rawLine of block.split(/\r?\n/u)) {
      const line = rawLine.trimEnd();
      if (line.startsWith("event:")) {
        eventName = line.slice("event:".length).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice("data:".length).trimStart());
      }
    }

    if (eventName !== "result" || dataLines.length === 0) continue;
    try {
      return JSON.parse(dataLines.join("\n")) as AgentResponse;
    } catch {
      return null;
    }
  }
  return null;
}

function normalizeAgentTokenUsage(data: AgentResponse): TokenUsageSnapshot | undefined {
  const usage = data.tokenUsage;
  const savings = data.tokenSavings;
  const responseText = data.details?.draftRaw || data.response || "";
  const estimatedTotal = estimateResponseTokens(responseText);
  const normalizedUsage = usage && usage.totalTokens > 0
    ? usage
    : estimatedTotal > 0
      ? {
          completionTokens: estimatedTotal,
          totalTokens: estimatedTotal,
          estimated: true,
          source: "final" as const,
          updatedAt: Date.now(),
        }
      : undefined;
  const hasSavings = Boolean(savings && (savings.estimatedTokensSaved > 0 || savings.cacheSkippedCalls > 0));
  if (!normalizedUsage && !hasSavings) return undefined;
  return {
    ...(normalizedUsage ?? {
      totalTokens: 0,
      estimated: true,
      source: "final" as const,
      updatedAt: Date.now(),
    }),
    ...(hasSavings && savings ? { tokenSavings: savings } : {}),
  };
}

function estimateResponseTokens(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  let chinese = 0;
  let nonWhitespace = 0;
  for (const char of trimmed) {
    if (/\s/u.test(char)) continue;
    nonWhitespace += 1;
    if (/[\u3400-\u9fff]/u.test(char)) chinese += 1;
  }
  const nonChinese = Math.max(0, nonWhitespace - chinese);
  return Math.max(1, Math.ceil(chinese + nonChinese / 4));
}

const AGENT_REQUEST_TIMEOUT_MS = 6 * 60 * 60_000;

function isLikelyBackgroundDisconnect(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return error instanceof TypeError
    || /failed to fetch|network|load failed|connection|aborted|net::|无法连接|api 服务|err_connection|econnrefused/iu.test(message);
}

function isCancelledAgentResponse(data: AgentResponse): boolean {
  const error = data.error;
  if (!error) return false;
  const message = extractErrorMessage(error);
  return /operation_cancelled|用户已停止当前生成|当前生成已停止/i.test(message);
}

function isRecoverableBackendApiError(data: AgentResponse): boolean {
  const message = data.error ? extractErrorMessage(data.error) : data.response ?? "";
  return /无法连接到 API 服务|failed to fetch|network|api 服务暂时不可用|baseUrl|econnrefused|err_connection|请求超时/i.test(message);
}

async function cancelBackendOperation(sessionId: string): Promise<void> {
  try {
    await fetchJson(`/active-operations/${encodeURIComponent(`agent:${sessionId}`)}/cancel`, {
      method: "POST",
    });
  } catch {
    // Local UI cancellation must remain responsive even if the backend is busy.
  }
}

async function hasActiveBackgroundSession(sessionId: string): Promise<boolean> {
  try {
    const data = await fetchJson<{
      operations?: ReadonlyArray<{ sessionId?: string; type?: string; status?: string }>;
    }>("/active-operations");
    return Boolean(data.operations?.some((operation) => operation.sessionId === sessionId));
  } catch {
    return false;
  }
}

async function pollAgentRequestResult(
  sessionId: string,
  requestId: string,
  timeoutMs = 15_000,
): Promise<AgentResponse | null> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const url = buildApiUrl(`/agent-results/${encodeURIComponent(sessionId)}/${encodeURIComponent(requestId)}`);
    if (!url) return null;
    try {
      const response = await fetch(url, { headers: { Accept: "application/json" } });
      if (response.status === 202) {
        await new Promise((resolve) => setTimeout(resolve, 800));
        continue;
      }
      if (!response.ok) return null;
      const data = await response.json() as {
        status?: string;
        payload?: AgentResponse;
      };
      if (data.status === "completed" && data.payload) {
        return data.payload;
      }
      await new Promise((resolve) => setTimeout(resolve, 800));
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 800));
    }
  }
  return null;
}

export const createMessageSlice: StateCreator<ChatStore, [], [], MessageActions> = (set, get) => ({
  activateSession: (sessionId) =>
    set({ activeSessionId: sessionId }),

  setInput: (text) => {
    persistInputDraft(text);
    set({ input: text });
  },

  addUserMessage: (sessionId, content) =>
    set((state) => ({
      sessions: updateSession(state.sessions, sessionId, (session) => ({
        messages: [...session.messages, { role: "user", content, timestamp: Date.now() }],
        lastError: null,
      })),
    })),

  appendStreamChunk: (sessionId, text, streamTs) =>
    set((state) => ({
      sessions: updateSession(state.sessions, sessionId, (session) => {
        const last = session.messages[session.messages.length - 1];
        if (last?.timestamp === streamTs && last.role === "assistant") {
          return {
            messages: [...session.messages.slice(0, -1), { ...last, content: last.content + text }],
          };
        }
        return {
          messages: [...session.messages, { role: "assistant", content: text, timestamp: streamTs }],
        };
      }),
    })),

  finalizeStream: (sessionId, streamTs, content, toolCall, tokenUsage) =>
    set((state) => ({
      sessions: updateSession(state.sessions, sessionId, (session) => ({
        messages: session.messages.map((message) => {
          if (message.timestamp !== streamTs || message.role !== "assistant") return message;
          const parts = [...(message.parts ?? [])];
          const lastPart = parts[parts.length - 1];
          if (lastPart?.type === "text") {
            parts[parts.length - 1] = { ...lastPart, content };
          } else if (content) {
            parts.push({ type: "text", content });
          }
          return {
            ...message,
            content,
            toolCall,
            parts,
            tokenUsage,
          };
        }),
      })),
    })),

  replaceStreamWithError: (sessionId, streamTs, errorMsg) =>
    set((state) => ({
      sessions: updateSession(state.sessions, sessionId, (session) => ({
        messages: [
          ...session.messages.filter(
            (message) => !(message.timestamp === streamTs && message.role === "assistant"),
          ),
          { role: "assistant", content: `\u2717 ${errorMsg}`, timestamp: Date.now() },
        ],
        isStreaming: false,
        lastError: errorMsg,
        stream: null,
      })),
    })),

  addErrorMessage: (sessionId, errorMsg) =>
    set((state) => ({
      sessions: updateSession(state.sessions, sessionId, (session) => ({
        messages: [...session.messages, { role: "assistant", content: `\u2717 ${errorMsg}`, timestamp: Date.now() }],
        lastError: errorMsg,
      })),
    })),

  deleteMessage: async (sessionId, messageIndex) => {
    const session = get().sessions[sessionId];
    if (session?.isStreaming) {
      // If we are deleting a message while generating, abort the stream
      // so it doesn't immediately recreate the assistant message from SSE events.
      session.abortController?.abort();
      session.stream?.close();
      set((state) => ({
        sessions: updateSession(state.sessions, sessionId, () => ({
          isStreaming: false,
          abortController: null,
          stream: null,
        })),
      }));
    }

    const beforeDelete = get().sessions[sessionId];
    const target = beforeDelete?.messages[messageIndex];
    if (!beforeDelete || !target) return;

    set((state) => ({
      sessions: updateSession(state.sessions, sessionId, (session) => {
        if (messageIndex < 0 || messageIndex >= session.messages.length) return {};
        const target = session.messages[messageIndex];
        const newDeletedKeys = [messageDeletionKey(target)];
        const deletedMessageKeys = Array.from(new Set([...session.deletedMessageKeys, ...newDeletedKeys]));
        return {
          messages: session.messages.filter((_, index) => index !== messageIndex),
          deletedMessageKeys,
          lastError: null,
        };
      }),
    }));

    if (beforeDelete.isDraft) return;
    try {
      const data = await fetchJson<SessionResponse>(`/sessions/${encodeURIComponent(sessionId)}/messages`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          role: target.role,
          content: target.content,
          timestamp: target.timestamp,
          messageIndex,
        }),
      });
      const deletedSession = data.session;
      if (deletedSession?.sessionId) {
        const remoteMessages = deletedSession.messages ? deserializeMessages(deletedSession.messages) : [];
        set((state) => {
          const runtime = state.sessions[sessionId];
          if (!runtime) return {};
          return {
            sessions: updateSession(state.sessions, sessionId, () => ({
              messages: filterDeletedMessages(remoteMessages, runtime.deletedMessageKeys),
              title: deletedSession.title ?? runtime.title,
              bookId: deletedSession.bookId ?? runtime.bookId,
            })),
          };
        });
      }
    } catch (error) {
      if (isDeleteAlreadyAppliedError(error)) {
        return;
      }
      set((state) => ({
        sessions: {
          ...state.sessions,
          [sessionId]: beforeDelete,
        },
      }));
    }
  },

  cancelMessage: async (sessionId) => {
    const session = get().sessions[sessionId];
    if (!session?.isStreaming) return;

    session.abortController?.abort();
    session.stream?.close();
    set((state) => ({
      sessions: updateSession(state.sessions, sessionId, (runtime) => ({
        messages: [
          ...runtime.messages,
          {
            role: "assistant",
            content: "已停止当前生成。需要的话可以调整提示后重新发送。",
            timestamp: Date.now(),
          },
        ],
        isStreaming: false,
        stream: null,
        abortController: null,
        lastError: null,
      })),
    }));
    await cancelBackendOperation(sessionId);
  },

  loadSessionMessages: (sessionId, msgs) =>
    set((state) => ({
      sessions: updateSession(state.sessions, sessionId, (session) => {
        if (session.messages.length > 0) return {};
        return { messages: deserializeMessages(msgs) };
      }),
    })),

  setSelectedModel: (model, service) => set({ selectedModel: model, selectedService: service }),

  loadSessionList: async (bookId) => {
    const query = bookId === null ? "null" : encodeURIComponent(bookId);
    try {
      const data = await fetchJson<{ sessions: ReadonlyArray<SessionSummary> }>(`/sessions?bookId=${query}`);
      set((state) => {
        let sessions = state.sessions;
        for (const summary of data.sessions) {
          sessions = upsertSessionSummary(sessions, summary);
        }
        return {
          sessions,
          sessionIdsByBook: {
            ...state.sessionIdsByBook,
            [bookKey(bookId)]: data.sessions.map((session) => session.sessionId),
          },
        };
      });
      return data.sessions;
    } catch {
      return [];
    }
  },

  createSession: async (bookId) => {
    const data = await fetchJson<SessionResponse>("/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bookId }),
    });
    const sessionId = data.session?.sessionId;
    if (!sessionId) {
      throw new Error("Failed to create session");
    }

    set((state) => {
      const runtime = createSessionRuntime({
        sessionId,
        bookId: data.session?.bookId ?? bookId ?? null,
        title: data.session?.title ?? null,
      });
      return {
        sessions: {
          ...state.sessions,
          [sessionId]: runtime,
        },
        sessionIdsByBook: {
          ...state.sessionIdsByBook,
          [bookKey(runtime.bookId)]: mergeSessionIds(
            state.sessionIdsByBook[bookKey(runtime.bookId)],
            [sessionId],
          ),
        },
        activeSessionId: sessionId,
      };
    });

    return sessionId;
  },

  createDraftSession: (bookId) => {
    // 前端生成 sessionId（与后端 createBookSession 同格式），暂不持久化到磁盘，
    // 也暂不写入 sessionIdsByBook——侧边栏看不到这条 draft。
    // 发送第一条消息时 sendMessage 会调 POST /sessions { sessionId, bookId } 落盘
    // 并把 id 追加进 sessionIdsByBook，那一刻侧边栏才出现该会话（带着 title）。
    const sessionId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    set((state) => {
      const runtime = createSessionRuntime({
        sessionId,
        bookId,
        title: null,
        isDraft: true,
      });
      return {
        sessions: {
          ...state.sessions,
          [sessionId]: runtime,
        },
        activeSessionId: sessionId,
      };
    });
    return sessionId;
  },

  renameSession: async (sessionId, title) => {
    const previous = get().sessions[sessionId]?.title ?? null;
    set((state) => ({
      sessions: updateSession(state.sessions, sessionId, () => ({ title })),
    }));

    try {
      await fetchJson(`/sessions/${sessionId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title }),
      });
    } catch {
      set((state) => ({
        sessions: updateSession(state.sessions, sessionId, () => ({ title: previous })),
      }));
    }
  },

  deleteSession: async (sessionId) => {
    const session = get().sessions[sessionId];
    session?.stream?.close();
    // 草稿会话还没写到磁盘，跳过 DELETE 请求避免后端返回 404
    if (session && !session.isDraft) {
      try {
        await fetchJson(`/sessions/${sessionId}`, { method: "DELETE" });
      } catch {
        // ignore
      }
    }

    set((state) => {
      const { [sessionId]: deleted, ...rest } = state.sessions;
      const sessionIdsByBook = Object.fromEntries(
        Object.entries(state.sessionIdsByBook).map(([key, ids]) => [
          key,
          ids.filter((id) => id !== sessionId),
        ]),
      );

      let activeSessionId = state.activeSessionId;
      if (activeSessionId === sessionId) {
        const fallbackKey = bookKey(session?.bookId ?? null);
        activeSessionId = sessionIdsByBook[fallbackKey]?.[0] ?? null;
      }

      return {
        sessions: rest,
        sessionIdsByBook,
        activeSessionId,
      };
    });
  },

  loadSessionDetail: async (sessionId) => {
    // 草稿会话：磁盘上还没有文件，直接跳过远端拉取。
    const existing = get().sessions[sessionId];
    if (existing?.isDraft) return;

    try {
      const data = await fetchJson<SessionResponse>(`/sessions/${sessionId}`);
      const detail = data.session;
      if (!detail?.sessionId) return;
      const detailSessionId = detail.sessionId;
      const messages = detail.messages ? deserializeMessages(detail.messages) : [];

      set((state) => {
        const runtime = state.sessions[detailSessionId];
        const nextBookId = detail.bookId ?? runtime?.bookId ?? null;
        const deletedMessageKeys = runtime?.deletedMessageKeys ?? [];
        const remoteMessages = filterDeletedMessages(messages, deletedMessageKeys);
        const nextMessages = runtime?.isStreaming
          ? runtime.messages
          : shouldUseRemoteMessages(runtime?.messages ?? [], remoteMessages)
            ? remoteMessages
            : runtime?.messages ?? remoteMessages;
        return {
          sessions: {
            ...state.sessions,
            [detailSessionId]: {
              ...(runtime ?? createSessionRuntime({
                sessionId: detailSessionId,
                bookId: nextBookId,
                title: detail.title ?? null,
              })),
              bookId: nextBookId,
              title: detail.title ?? runtime?.title ?? null,
              messages: nextMessages,
              deletedMessageKeys,
            },
          },
          sessionIdsByBook: {
            ...state.sessionIdsByBook,
            [bookKey(nextBookId)]: mergeSessionIds(
              state.sessionIdsByBook[bookKey(nextBookId)],
              [detailSessionId],
            ),
          },
        };
      });
    } catch {
      // ignore
    }
  },

  sendMessage: async (sessionId, text, activeBookId) => {
    const trimmed = text.trim();
    const session = get().sessions[sessionId];
    if (!trimmed || !session || session.isStreaming) return;

    if (!get().selectedModel) {
      get().addUserMessage(sessionId, trimmed);
      get().addErrorMessage(sessionId, "请先选择一个模型");
      set((state) => ({
        input: state.input || trimmed,
      }));
      return;
    }

    // 草稿会话：第一条消息发送时才真正把 session 文件写到磁盘。
    // 后端 POST /sessions 支持接受客户端传入的 sessionId，所以 id 保持一致，
    // 前端 store 里的 runtime 不用 remount，只需要把 isDraft 翻成 false。
    if (session.isDraft) {
      try {
        await fetchJson<SessionResponse>("/sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId, bookId: session.bookId }),
        });
        // 落盘成功：把 isDraft 翻成 false，同时把 sessionId 追加进 sessionIdsByBook
        // 让侧边栏现在才看到这条会话。
        set((state) => ({
          sessions: updateSession(state.sessions, sessionId, () => ({ isDraft: false })),
          sessionIdsByBook: {
            ...state.sessionIdsByBook,
            [bookKey(session.bookId)]: mergeSessionIds(
              state.sessionIdsByBook[bookKey(session.bookId)],
              [sessionId],
            ),
          },
        }));
      } catch (err) {
        set((state) => ({
          sessions: updateSession(state.sessions, sessionId, () => ({
            lastError: err instanceof Error ? err.message : String(err),
          })),
        }));
      }
    }

    const instruction = trimmed;
    const streamTs = Date.now() + 1;
    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const clientStartedAt = Date.now();
    const abortController = new AbortController();
    let requestBackgrounded = typeof document !== "undefined" && document.visibilityState === "hidden";
    const markBackgrounded = () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        requestBackgrounded = true;
      }
    };
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", markBackgrounded);
    }

    set((state) => ({
      activeSessionId: sessionId,
      sessions: updateSession(state.sessions, sessionId, () => ({
        isStreaming: true,
        abortController,
        lastError: null,
      })),
    }));

    get().addUserMessage(sessionId, trimmed);

    session.stream?.close();
    const eventsUrl = buildApiUrl("/events");
    if (!eventsUrl) {
      get().addErrorMessage(sessionId, "API 地址无效");
      set((state) => ({
        input: state.input || trimmed,
        sessions: updateSession(state.sessions, sessionId, () => ({
          isStreaming: false,
          stream: null,
          abortController: null,
        })),
      }));
      return;
    }
    const streamEs = new EventSource(eventsUrl);
    set((state) => ({
      sessions: updateSession(state.sessions, sessionId, () => ({ stream: streamEs })),
    }));
    attachSessionStreamListeners({ sessionId, streamTs, streamEs, set, get });

    // Wait for the EventSource connection to be fully open before initiating the agent call
    await new Promise<void>((resolve) => {
      if (streamEs.readyState === streamEs.OPEN) {
        resolve();
      } else {
        const onOpen = () => {
          streamEs.removeEventListener("open", onOpen);
          streamEs.removeEventListener("error", onError);
          resolve();
        };
        const onError = () => {
          streamEs.removeEventListener("open", onOpen);
          streamEs.removeEventListener("error", onError);
          resolve(); // Resolve anyway on error to not block execution
        };
        streamEs.addEventListener("open", onOpen);
        streamEs.addEventListener("error", onError);
        // Fallback timeout in case EventSource fails to open
        setTimeout(() => {
          streamEs.removeEventListener("open", onOpen);
          streamEs.removeEventListener("error", onError);
          resolve();
        }, 800);
      }
    });

    if (abortController.signal.aborted || get().sessions[sessionId]?.abortController !== abortController) {
      streamEs.close();
      return;
    }

    const applyAgentResponse = async (data: AgentResponse) => {
      if (get().sessions[sessionId]?.abortController !== abortController) {
        return;
      }
      if (isCancelledAgentResponse(data)) {
        return;
      }
      if (isNativeRuntime() && requestBackgrounded && data.error && isRecoverableBackendApiError(data)) {
        await get().loadSessionDetail(sessionId);
        set((state) => ({
          sessions: updateSession(state.sessions, sessionId, () => ({
            lastError: null,
          })),
        }));
        return;
      }
      set((state) => ({
        input: state.input === trimmed ? "" : state.input,
      }));

      const finalContent = data.details?.draftRaw || data.response || "";
      const toolCall = data.details?.toolCall ?? undefined;
      const tokenUsage = normalizeAgentTokenUsage(data);
      const hasStream = Boolean(
        get().sessions[sessionId]?.messages.some((message) => message.timestamp === streamTs),
      );

      if (data.error) {
        const errorMessage = extractErrorMessage(data.error);
        if (hasStream) {
          get().replaceStreamWithError(sessionId, streamTs, errorMessage);
        } else {
          get().addErrorMessage(sessionId, errorMessage);
        }
      } else if (finalContent) {
        if (hasStream) {
          get().finalizeStream(sessionId, streamTs, finalContent, toolCall, tokenUsage);
        } else {
          set((state) => ({
            sessions: updateSession(state.sessions, sessionId, (runtime) => ({
              messages: [
                ...runtime.messages,
                {
                  role: "assistant",
                  content: finalContent,
                  timestamp: Date.now(),
                  toolCall,
                  ...(tokenUsage ? { tokenUsage } : {}),
                },
              ],
            })),
          }));
        }
      } else {
        const emptyMessage = "模型未返回文本内容。请检查协议类型（chat/responses）、流式开关或上游服务兼容性。";
        if (hasStream) {
          get().replaceStreamWithError(sessionId, streamTs, emptyMessage);
        } else {
          get().addErrorMessage(sessionId, emptyMessage);
        }
      }
    };

    try {
      const agentUrl = buildApiUrl("/agent");
      if (!agentUrl) {
        throw new Error("API 地址无效");
      }
      const timeoutId = globalThis.setTimeout(() => {
        abortController.abort();
      }, AGENT_REQUEST_TIMEOUT_MS);
      let response: Response;
      try {
        response = await fetch(agentUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "text/event-stream",
          },
          signal: abortController.signal,
          body: JSON.stringify({
            instruction,
            activeBookId,
            sessionId,
            requestId,
            clientStartedAt,
            model: get().selectedModel ?? undefined,
            service: get().selectedService ?? undefined,
          }),
        });
      } catch (error) {
        globalThis.clearTimeout(timeoutId);
        streamEs.close();
        throw error;
      }
      globalThis.clearTimeout(timeoutId);

      let data: AgentResponse | null = null;
      const contentType = response.headers.get("content-type") ?? "";
      if (contentType.includes("application/json")) {
        data = await response.json() as AgentResponse;
      } else if (response.body) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
        }
        buffer += decoder.decode();
        data = parseAgentSseResult(buffer);
      }

      if (!data) {
        throw new Error(response.ok ? "未收到服务器响应" : `${response.status} ${response.statusText}`.trim());
      }

      streamEs.close();
      if (get().sessions[sessionId]?.abortController !== abortController) {
        return;
      }
      await applyAgentResponse(data);
    } catch (error) {
      streamEs.close();
      if (get().sessions[sessionId]?.abortController !== abortController) {
        return;
      }
      if (error instanceof DOMException
        && error.name === "AbortError"
        && get().sessions[sessionId]?.abortController !== abortController) {
        return;
      }
      if (isNativeRuntime() && isLikelyBackgroundDisconnect(error)) {
        await ensureEmbeddedNodeRunning();
        const recoveredResult = await pollAgentRequestResult(sessionId, requestId);
        if (recoveredResult) {
          await applyAgentResponse(recoveredResult);
          return;
        }
        if (await hasActiveBackgroundSession(sessionId)) {
          set((state) => ({
            sessions: updateSession(state.sessions, sessionId, (runtime) => ({
              messages: [
                ...runtime.messages,
                {
                  role: "assistant",
                  content: "已转入后台继续执行。你可以稍后回到本会话，InkOS 会从本地 Node 后端恢复最新进度和结果。",
                  timestamp: Date.now(),
                },
              ],
              lastError: null,
            })),
          }));
          return;
        }
        await get().loadSessionDetail(sessionId);
        set((state) => ({
          sessions: updateSession(state.sessions, sessionId, () => ({
            lastError: null,
          })),
        }));
        return;
      }
      const errorMessage = error instanceof DOMException && error.name === "AbortError"
        ? get().sessions[sessionId]?.abortController === abortController
          ? "请求超时或已被手动停止，发送按钮已解锁。"
          : "当前生成已停止。"
        : error instanceof Error ? error.message : String(error);
      const hasStream = Boolean(
        get().sessions[sessionId]?.messages.some((message) => message.timestamp === streamTs),
      );
      if (hasStream) {
        get().replaceStreamWithError(sessionId, streamTs, errorMessage);
      } else {
        get().addErrorMessage(sessionId, errorMessage);
      }
      set((state) => ({
        input: state.input || trimmed,
      }));
    } finally {
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", markBackgrounded);
      }
      set((state) => ({
        sessions: updateSession(state.sessions, sessionId, (runtime) => ({
          isStreaming: false,
          stream: runtime.stream === streamEs ? null : runtime.stream,
          abortController: runtime.abortController === abortController ? null : runtime.abortController,
        })),
      }));
    }
  },
});
