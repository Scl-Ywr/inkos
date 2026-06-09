import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initialChatState } from "../../initialState";
import { useChatStore } from "../../store";

describe("chat message actions", () => {
  beforeEach(() => {
    useChatStore.setState(initialChatState);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("deletes only the selected user or assistant message from the active session", async () => {
    const sessionId = useChatStore.getState().createDraftSession(null);

    useChatStore.getState().addUserMessage(sessionId, "hello");
    useChatStore.getState().addErrorMessage(sessionId, "red warning");
    useChatStore.getState().addUserMessage(sessionId, "keep me");

    expect(useChatStore.getState().sessions[sessionId]?.messages.map((message) => message.content)).toEqual([
      "hello",
      "\u2717 red warning",
      "keep me",
    ]);

    await useChatStore.getState().deleteMessage(sessionId, 1);

    expect(useChatStore.getState().sessions[sessionId]?.messages.map((message) => message.content)).toEqual([
      "hello",
      "keep me",
    ]);
    expect(useChatStore.getState().sessions[sessionId]?.lastError).toBeNull();

    await useChatStore.getState().deleteMessage(sessionId, 0);

    expect(useChatStore.getState().sessions[sessionId]?.messages.map((message) => message.content)).toEqual([
      "keep me",
    ]);
  });

  it("does not delete the assistant reply next to a user message", async () => {
    const sessionId = useChatStore.getState().createDraftSession(null);
    useChatStore.getState().addUserMessage(sessionId, "delete only me");
    useChatStore.getState().addErrorMessage(sessionId, "keep assistant");

    await useChatStore.getState().deleteMessage(sessionId, 0);

    expect(useChatStore.getState().sessions[sessionId]?.messages.map((message) => message.content)).toEqual([
      "\u2717 keep assistant",
    ]);
  });

  it("keeps a local deletion when the backend reports that the message is already gone", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "Message or session not found" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    })));
    const sessionId = useChatStore.getState().createDraftSession(null);
    useChatStore.getState().addUserMessage(sessionId, "delete once");
    useChatStore.setState((state) => ({
      sessions: {
        ...state.sessions,
        [sessionId]: {
          ...state.sessions[sessionId]!,
          isDraft: false,
        },
      },
    }));

    await useChatStore.getState().deleteMessage(sessionId, 0);

    expect(useChatStore.getState().sessions[sessionId]?.messages).toEqual([]);
  });

  it("restores the draft input when sending without a selected model", async () => {
    const sessionId = useChatStore.getState().createDraftSession(null);
    useChatStore.getState().setInput("");

    await useChatStore.getState().sendMessage(sessionId, "keep this draft");

    expect(useChatStore.getState().input).toBe("keep this draft");
    expect(useChatStore.getState().sessions[sessionId]?.messages.map((message) => message.content)).toEqual([
      "keep this draft",
      "\u2717 请先选择一个模型",
    ]);
  });
});
