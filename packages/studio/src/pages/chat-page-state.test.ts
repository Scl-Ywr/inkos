import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearBookCreateSessionId,
  clearBookCreateAssistantInput,
  ensureConfiguredModelGroup,
  filterModelGroups,
  getBookCreateAssistantInput,
  getBookCreateSessionId,
  getProjectChatSessionId,
  pickModelSelection,
  pickProjectChatSessionId,
  resolveComposerTextSync,
  setBookCreateAssistantInput,
  setBookCreateSessionId,
  setProjectChatSessionId,
} from "./chat-page-state";

describe("book-create session localStorage helpers", () => {
  const storage = new Map<string, string>();

  beforeEach(() => {
    storage.clear();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storage.set(key, value);
      },
      removeItem: (key: string) => {
        storage.delete(key);
      },
      clear: () => {
        storage.clear();
      },
    });
  });

  afterEach(() => {
    storage.clear();
    vi.unstubAllGlobals();
  });

  it("getBookCreateSessionId returns null when empty", () => {
    expect(getBookCreateSessionId()).toBeNull();
  });

  it("setBookCreateSessionId + get round-trips", () => {
    setBookCreateSessionId("sess-123");
    expect(getBookCreateSessionId()).toBe("sess-123");
  });

  it("setBookCreateSessionId overwrites previous value", () => {
    setBookCreateSessionId("sess-old");
    setBookCreateSessionId("sess-new");
    expect(getBookCreateSessionId()).toBe("sess-new");
  });

  it("clearBookCreateSessionId removes the key", () => {
    setBookCreateSessionId("sess-123");
    clearBookCreateSessionId();
    expect(getBookCreateSessionId()).toBeNull();
  });

  it("clearBookCreateSessionId is safe when key doesn't exist", () => {
    clearBookCreateSessionId();
    expect(getBookCreateSessionId()).toBeNull();
  });

  it("persists the book-create assistant input separately from the session id", () => {
    setBookCreateSessionId("sess-123");
    setBookCreateAssistantInput("帮我写一本赛博修仙");

    expect(getBookCreateSessionId()).toBe("sess-123");
    expect(getBookCreateAssistantInput()).toBe("帮我写一本赛博修仙");

    clearBookCreateAssistantInput();
    expect(getBookCreateAssistantInput()).toBe("");
    expect(getBookCreateSessionId()).toBe("sess-123");
  });

  it("keeps project chat session separate from book-create session", () => {
    setBookCreateSessionId("book-create-session");
    setProjectChatSessionId("project-chat-session");
    expect(getBookCreateSessionId()).toBe("book-create-session");
    expect(getProjectChatSessionId()).toBe("project-chat-session");
  });
});

describe("filterModelGroups", () => {
  const grouped = [
    {
      service: "openai",
      label: "OpenAI",
      models: [
        { id: "gpt-5.4", name: "gpt-5.4" },
        { id: "gpt-4o", name: "gpt-4o" },
      ],
    },
    {
      service: "custom:gemma",
      label: "LM Studio",
      models: [
        { id: "google/gemma-4-27b-it", name: "google/gemma-4-27b-it" },
      ],
    },
  ] as const;

  it("returns all groups when search is blank", () => {
    expect(filterModelGroups(grouped, "")).toEqual(grouped);
    expect(filterModelGroups(grouped, "   ")).toEqual(grouped);
  });

  it("filters by model name and preserves only matching groups", () => {
    expect(filterModelGroups(grouped, "gemma")).toEqual([
      {
        service: "custom:gemma",
        label: "LM Studio",
        models: [{ id: "google/gemma-4-27b-it", name: "google/gemma-4-27b-it" }],
      },
    ]);
  });

  it("filters by service label", () => {
    expect(filterModelGroups(grouped, "openai")).toEqual([
      {
        service: "openai",
        label: "OpenAI",
        models: [
          { id: "gpt-5.4", name: "gpt-5.4" },
          { id: "gpt-4o", name: "gpt-4o" },
        ],
      },
    ]);
  });
});

describe("pickModelSelection", () => {
  const grouped = [
    {
      service: "google",
      label: "Google Gemini",
      models: [
        { id: "gemini-2.5-flash", name: "gemini-2.5-flash" },
      ],
    },
    {
      service: "moonshot",
      label: "Moonshot",
      models: [
        { id: "kimi-k2.5", name: "kimi-k2.5" },
      ],
    },
  ] as const;

  it("keeps the current selection when it is still available", () => {
    expect(pickModelSelection(grouped, "kimi-k2.5", "moonshot")).toBeNull();
  });

  it("selects the first available model when current selection is missing", () => {
    expect(pickModelSelection(grouped, "gemini-3.1-flash-image-preview", "google")).toEqual({
      model: "gemini-2.5-flash",
      service: "google",
    });
  });

  it("selects the first available model when there is no current selection", () => {
    expect(pickModelSelection(grouped, null, null)).toEqual({
      model: "gemini-2.5-flash",
      service: "google",
    });
  });

  it("prefers the configured service and model when there is no current selection", () => {
    expect(pickModelSelection(grouped, null, null, {
      service: "moonshot",
      model: "kimi-k2.5",
    })).toEqual({
      model: "kimi-k2.5",
      service: "moonshot",
    });
  });

  it("prefers the configured service even when its configured model is stale", () => {
    expect(pickModelSelection(grouped, null, null, {
      service: "moonshot",
      model: "kimi-k3",
    })).toEqual({
      model: "kimi-k2.5",
      service: "moonshot",
    });
  });

  it("keeps a valid user selection over the configured default", () => {
    expect(pickModelSelection(grouped, "gemini-2.5-flash", "google", {
      service: "moonshot",
      model: "kimi-k2.5",
    })).toBeNull();
  });

  it("keeps the current selection while model lists are still loading", () => {
    expect(pickModelSelection([], "manual-model", "custom:local", null, {
      modelsLoading: true,
    })).toBeNull();
  });

  it("returns null when no models are available", () => {
    expect(pickModelSelection([], "gemini-3.1-flash-image-preview", "google")).toBeNull();
  });
});

describe("ensureConfiguredModelGroup", () => {
  it("adds the configured custom model while its live model list is not loaded yet", () => {
    expect(ensureConfiguredModelGroup([], [
      { service: "custom:local", label: "Local API", connected: true },
    ], {
      service: "custom:local",
      model: "mimo-v2.5",
    })).toEqual([
      {
        service: "custom:local",
        label: "Local API",
        models: [{ id: "mimo-v2.5", name: "mimo-v2.5" }],
      },
    ]);
  });

  it("adds the configured model even before the matching service has refreshed", () => {
    expect(ensureConfiguredModelGroup([], [], {
      service: "custom:local",
      model: "mimo-v2.5",
    })).toEqual([
      {
        service: "custom:local",
        label: "custom:local",
        models: [{ id: "mimo-v2.5", name: "mimo-v2.5" }],
      },
    ]);
  });

  it("prepends the configured model to an existing service group when missing", () => {
    expect(ensureConfiguredModelGroup([
      {
        service: "custom:local",
        label: "Local API",
        models: [{ id: "other-model", name: "other-model" }],
      },
    ], [
      { service: "custom:local", label: "Local API", connected: true },
    ], {
      service: "custom:local",
      model: "mimo-v2.5",
    })).toEqual([
      {
        service: "custom:local",
        label: "Local API",
        models: [
          { id: "mimo-v2.5", name: "mimo-v2.5" },
          { id: "other-model", name: "other-model" },
        ],
      },
    ]);
  });
});

describe("pickProjectChatSessionId", () => {
  it("prefers the newest project chat session that already has messages", () => {
    expect(pickProjectChatSessionId([
      { sessionId: "empty-latest", messageCount: 0 },
      { sessionId: "short-fiction-session", messageCount: 3 },
      { sessionId: "older-session", messageCount: 1 },
    ])).toBe("short-fiction-session");
  });

  it("falls back to the newest empty session when all sessions are empty", () => {
    expect(pickProjectChatSessionId([
      { sessionId: "empty-latest", messageCount: 0 },
      { sessionId: "empty-older", messageCount: 0 },
    ])).toBe("empty-latest");
  });

  it("returns null when there is no project chat session", () => {
    expect(pickProjectChatSessionId([])).toBeNull();
  });
});

describe("resolveComposerTextSync", () => {
  it("keeps focused textarea text when store input is stale or empty", () => {
    expect(resolveComposerTextSync({
      storeInput: "",
      composerText: "本地草稿",
      elementValue: "正在输入的新内容",
      elementFocused: true,
    })).toEqual({
      text: "正在输入的新内容",
      syncStoreText: "正在输入的新内容",
      syncElementText: null,
    });
  });

  it("preserves the local composer snapshot when an external store refresh clears input", () => {
    expect(resolveComposerTextSync({
      storeInput: "",
      composerText: "还没发送的草稿",
      elementValue: "还没发送的草稿",
      elementFocused: false,
    })).toEqual({
      text: "还没发送的草稿",
      syncStoreText: "还没发送的草稿",
      syncElementText: null,
    });
  });

  it("allows an intentional clear after the composer snapshot is also empty", () => {
    expect(resolveComposerTextSync({
      storeInput: "",
      composerText: "",
      elementValue: "",
      elementFocused: false,
    })).toEqual({
      text: "",
      syncStoreText: null,
      syncElementText: null,
    });
  });

  it("syncs focused deletion back to the store instead of refilling old text", () => {
    expect(resolveComposerTextSync({
      storeInput: "旧内容",
      composerText: "",
      elementValue: "",
      elementFocused: true,
    })).toEqual({
      text: "",
      syncStoreText: "",
      syncElementText: null,
    });
  });
});
