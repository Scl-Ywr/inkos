import { beforeEach, describe, expect, it } from "vitest";
import { initialChatState } from "../../initialState";
import { useChatStore } from "../../store";

describe("chat message actions", () => {
  beforeEach(() => {
    useChatStore.setState(initialChatState);
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
