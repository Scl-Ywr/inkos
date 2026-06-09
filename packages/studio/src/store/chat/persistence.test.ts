import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadPersistedInputDraft,
  loadPersistedMessageState,
  persistInputDraft,
  persistMessageState,
} from "./persistence";
import type { MessageState } from "./types";

const storage = new Map<string, string>();

describe("chat persistence", () => {
  beforeEach(() => {
    storage.clear();
    const localStorage = {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storage.set(key, value);
      },
      removeItem: (key: string) => {
        storage.delete(key);
      },
    };
    vi.stubGlobal("localStorage", localStorage);
    vi.stubGlobal("window", { localStorage });
  });

  it("caps persisted localStorage payloads for large chat sessions", () => {
    const messages = Array.from({ length: 120 }, (_, index) => ({
      role: index % 2 === 0 ? "user" as const : "assistant" as const,
      content: `message-${index} ${"长文本".repeat(1_800)}`,
      timestamp: index + 1,
    }));
    const state: MessageState = {
      activeSessionId: "session-large",
      sessionIdsByBook: { book: ["session-large"] },
      sessions: {
        "session-large": {
          sessionId: "session-large",
          bookId: "book",
          title: null,
          messages,
          deletedMessageKeys: [],
          stream: null,
          abortController: null,
          isStreaming: false,
          lastError: null,
          isDraft: false,
        },
      },
      input: "",
      selectedModel: "model",
      selectedService: "service",
    };

    persistMessageState(state);

    const raw = [...storage.values()][0] ?? "";
    const loaded = loadPersistedMessageState();
    expect(raw.length).toBeLessThanOrEqual(240_000);
    expect(loaded.sessions?.["session-large"]?.messages.length).toBeLessThan(80);
    expect(loaded.sessions?.["session-large"]?.messages.at(-1)?.content).toContain("message-119");
  });

  it("persists unsent chat input", () => {
    const state: MessageState = {
      activeSessionId: "session-draft",
      sessionIdsByBook: { null: ["session-draft"] },
      sessions: {
        "session-draft": {
          sessionId: "session-draft",
          bookId: null,
          title: null,
          messages: [],
          deletedMessageKeys: [],
          stream: null,
          abortController: null,
          isStreaming: false,
          lastError: null,
          isDraft: true,
        },
      },
      input: "do not lose this draft",
      selectedModel: "model",
      selectedService: "service",
    };

    persistMessageState(state);

    expect(loadPersistedMessageState().input).toBe("do not lose this draft");
  });

  it("persists chat input immediately outside the debounced session cache", () => {
    persistInputDraft("typed just before webview reload");

    expect(loadPersistedInputDraft()).toBe("typed just before webview reload");
    expect(loadPersistedMessageState().input).toBe("typed just before webview reload");

    persistInputDraft("");
    expect(loadPersistedInputDraft()).toBe("");
  });
});
