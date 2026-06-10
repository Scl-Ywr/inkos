import { useRef, useEffect, useMemo, useState, useCallback } from "react";
import type { Theme } from "../hooks/use-theme";
import type { TFunction } from "../hooks/use-i18n";
import type { SSEMessage } from "../hooks/use-sse";
import { fetchJson } from "../hooks/use-api";
import { chatSelectors, useChatStore } from "../store/chat";
import { useServiceStore } from "../store/service";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "../components/ui/dropdown-menu";
import {
  Reasoning,
  ReasoningTrigger,
  ReasoningContent,
} from "../components/ai-elements/reasoning";
import { ChatMessage } from "../components/chat/ChatMessage";
import { QuickActions } from "../components/chat/QuickActions";
import { ToolExecutionSteps } from "../components/chat/ToolExecutionSteps";
import { mobileTextInputHandlers, preserveTextSelectionAfterUpdate } from "../lib/mobile-input";
import { subscribeServiceConfigChanged } from "../lib/service-config-events";
import {
  BotMessageSquare,
  ArrowUp,
  Square,
  ChevronDown,
  Check,
  Trash2,
  X,
} from "lucide-react";
import { Shimmer } from "../components/ai-elements/shimmer";
import {
  Message,
  MessageContent,
} from "../components/ai-elements/message";
import {
  type ChatPageModelPreference,
  ensureConfiguredModelGroup,
  filterModelGroups,
  getBookCreateSessionId,
  getProjectChatSessionId,
  pickProjectChatSessionId,
  pickModelSelection,
  resolveComposerTextSync,
  setBookCreateSessionId,
  setProjectChatSessionId,
} from "./chat-page-state";

// -- Types --

interface Nav {
  toDashboard: () => void;
  toBook: (id: string) => void;
  toServices: () => void;
}

export interface ChatPageProps {
  readonly activeBookId?: string;
  readonly mode?: "book" | "book-create" | "project-chat";
  readonly nav: Nav;
  readonly theme: Theme;
  readonly t: TFunction;
  readonly sse: { messages: ReadonlyArray<SSEMessage>; connected: boolean };
}

interface ServiceConfigPayload {
  readonly service?: string | null;
  readonly defaultModel?: string | null;
}

interface TokenSavingsTelemetryPayload {
  readonly telemetry?: {
    readonly cacheSkippedCalls: number;
    readonly semanticL1Hits: number;
    readonly semanticL2Hits: number;
    readonly ccrBlocksCompressed: number;
    readonly estimatedTokensSaved: number;
  };
}

// -- Component --

export function ChatPage({ activeBookId, mode = activeBookId ? "book" : "book-create", nav, theme, t, sse: _sse }: ChatPageProps) {
  // -- Store selectors --
  const messages = useChatStore(chatSelectors.activeMessages);
  const activeSessionId = useChatStore((s) => s.activeSessionId);
  const loading = useChatStore(chatSelectors.isActiveSessionStreaming);
  const selectedModel = useChatStore((s) => s.selectedModel);
  const selectedService = useChatStore((s) => s.selectedService);
  // -- Store actions --
  const setInput = useChatStore((s) => s.setInput);
  const sendMessage = useChatStore((s) => s.sendMessage);
  const cancelMessage = useChatStore((s) => s.cancelMessage);
  const setSelectedModel = useChatStore((s) => s.setSelectedModel);
  const loadSessionList = useChatStore((s) => s.loadSessionList);
  const createSession = useChatStore((s) => s.createSession);
  const createDraftSession = useChatStore((s) => s.createDraftSession);
  const loadSessionDetail = useChatStore((s) => s.loadSessionDetail);
  const activateSession = useChatStore((s) => s.activateSession);
  const deleteMessage = useChatStore((s) => s.deleteMessage);

  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const composerTextSnapshotRef = useRef(useChatStore.getState().input);
  const composerFocusedRef = useRef(false);
  const composerPollFrameRef = useRef<number | null>(null);
  const composerSelectionRef = useRef<{
    readonly start: number;
    readonly end: number;
    readonly direction: "forward" | "backward" | "none";
    readonly valueLength: number;
    readonly value: string;
  } | null>(null);
  const composerInputAnchorRef = useRef<{
    readonly start: number;
    readonly end: number;
    readonly direction: "forward" | "backward" | "none";
    readonly valueLength: number;
    readonly value: string;
  } | null>(null);
  const composerCompositionRef = useRef<{
    readonly start: number;
    readonly end: number;
    readonly value: string;
    readonly insertedText?: string;
  } | null>(null);
  const [followingLatest, setFollowingLatest] = useState(true);
  const [composerHasText, setComposerHasText] = useState(() => composerTextSnapshotRef.current.trim().length > 0);
  const [tokenSavingsLabel, setTokenSavingsLabel] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<{
    readonly sessionId: string;
    readonly messageIndex: number;
    readonly messageKey: string;
    readonly role: "user" | "assistant";
    readonly preview: string;
  } | null>(null);
  const [deletingMessage, setDeletingMessage] = useState(false);

  const isZh = t("nav.connected") === "\u5DF2\u8FDE\u63A5";
  const hasBook = Boolean(activeBookId);

  // Derived: is the assistant currently streaming/thinking/executing tools?
  const isStreaming = useMemo(() => {
    const last = messages[messages.length - 1];
    if (!last || last.role !== "assistant") return false;
    return last.thinkingStreaming === true
      || !last.content
      || (last.toolExecutions?.some(t => t.status === "running" || t.status === "processing") ?? false);
  }, [messages]);

  const activeTokenLabel = useMemo(() => {
    const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant");
    const usage = lastAssistant?.tokenUsage;
    if (!usage || usage.totalTokens <= 0) return null;
    return `${usage.estimated ? "约 " : ""}${usage.totalTokens.toLocaleString()} tokens`;
  }, [messages]);

  // -- Model picker: read raw state, derive with useMemo (stable refs) --
  const services = useServiceStore((s) => s.services);
  const servicesLoading = useServiceStore((s) => s.servicesLoading);
  const bankModelsLoading = useServiceStore((s) => s.bankModelsLoading);
  const customModelsLoading = useServiceStore((s) => s.customModelsLoading);
  const modelsByService = useServiceStore((s) => s.modelsByService);
  const fetchServices = useServiceStore((s) => s.fetchServices);
  const fetchBankModels = useServiceStore((s) => s.fetchBankModels);
  const fetchCustomModels = useServiceStore((s) => s.fetchCustomModels);
  const [configuredModelSelection, setConfiguredModelSelection] = useState<ChatPageModelPreference | null>(null);
  const [serviceConfigLoaded, setServiceConfigLoaded] = useState(false);

  useEffect(() => { void fetchServices(); }, [fetchServices]);
  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const payload = await fetchJson<TokenSavingsTelemetryPayload>("/runtime/token-savings");
        if (cancelled) return;
        const telemetry = payload.telemetry;
        if (!telemetry) {
          setTokenSavingsLabel(null);
          return;
        }
        const hits = telemetry.semanticL1Hits + telemetry.semanticL2Hits;
        const saved = telemetry.estimatedTokensSaved;
        if (hits > 0) {
          setTokenSavingsLabel(`累计缓存命中 ${hits} 次 · 估算节省 ${saved.toLocaleString()}`);
        } else if (telemetry.ccrBlocksCompressed > 0) {
          setTokenSavingsLabel(`累计压缩 ${telemetry.ccrBlocksCompressed} 块 · 估算节省 ${saved.toLocaleString()}`);
        } else {
          setTokenSavingsLabel("Token 节省待触发");
        }
      } catch {
        if (!cancelled) setTokenSavingsLabel(null);
      }
    };
    const refreshWhenVisible = () => {
      if (document.visibilityState !== "visible") return;
      void refresh();
    };
    void refresh();
    const id = window.setInterval(refreshWhenVisible, 10_000);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    window.addEventListener("focus", refreshWhenVisible);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", refreshWhenVisible);
      window.removeEventListener("focus", refreshWhenVisible);
      window.clearInterval(id);
    };
  }, []);
  useEffect(() => {
    void fetchBankModels();
    void fetchCustomModels();
  }, [fetchBankModels, fetchCustomModels]);
  const refreshServiceConfig = useCallback(async () => {
    setServiceConfigLoaded(false);
    try {
      const payload = await fetchJson<ServiceConfigPayload>("/services/config");
      setConfiguredModelSelection({
        service: payload.service ?? null,
        model: payload.defaultModel ?? null,
      });
    } catch {
      setConfiguredModelSelection(null);
    } finally {
      setServiceConfigLoaded(true);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    void fetchJson<ServiceConfigPayload>("/services/config")
      .then((payload) => {
        if (cancelled) return;
        setConfiguredModelSelection({
          service: payload.service ?? null,
          model: payload.defaultModel ?? null,
        });
      })
      .catch(() => {
        if (!cancelled) setConfiguredModelSelection(null);
      })
      .finally(() => {
        if (!cancelled) setServiceConfigLoaded(true);
      });

    return () => {
      cancelled = true;
    };
  }, []);
  useEffect(() => {
    return subscribeServiceConfigChanged(() => {
      void (async () => {
        await useServiceStore.getState().refreshServices();
        await Promise.all([
          useServiceStore.getState().fetchBankModels(),
          useServiceStore.getState().fetchCustomModels(),
          refreshServiceConfig(),
        ]);
      })();
    });
  }, [refreshServiceConfig]);

  const groupedModels = useMemo(() => {
    const baseGroups = services
      .filter((s) => s.connected && (modelsByService[s.service]?.length ?? 0) > 0)
      .map((s) => ({ service: s.service, label: s.label, models: modelsByService[s.service]! }));
    return ensureConfiguredModelGroup(baseGroups, services, configuredModelSelection);
  }, [configuredModelSelection, services, modelsByService]);

  const modelPickerStatus = useMemo(() => {
    if (groupedModels.some((group) => group.models.length > 0)) return "ready" as const;
    if (servicesLoading || services.length === 0) return "loading" as const;
    const connected = services.filter((s) => s.connected);
    if (connected.length === 0) return "no-models" as const;
    if (bankModelsLoading) return "loading" as const;
    if (connected.some((s) => (modelsByService[s.service]?.length ?? 0) > 0)) return "ready" as const;
    const hasConnectedBank = connected.some((s) => !s.service.startsWith("custom"));
    const hasConnectedCustom = connected.some((s) => s.service.startsWith("custom"));
    if (!hasConnectedBank && hasConnectedCustom && customModelsLoading) return "loading" as const;
    return "no-models" as const;
  }, [groupedModels, services, servicesLoading, bankModelsLoading, customModelsLoading, modelsByService]);

  const selectedModelLabel = useMemo(() => {
    if (!selectedModel) return "选择模型";
    const group = groupedModels.find((item) => item.service === selectedService);
    if (!group) return "选择模型";
    const model = group?.models.find((item) => item.id === selectedModel);
    const modelLabel = model?.name ?? selectedModel;
    return group ? `${group.label} · ${modelLabel}` : modelLabel;
  }, [groupedModels, selectedModel, selectedService]);

  // Auto-select from saved service config first, then fall back to the first available model.
  useEffect(() => {
    if (!serviceConfigLoaded) return;
    const nextSelection = pickModelSelection(
      groupedModels,
      selectedModel,
      selectedService,
      configuredModelSelection,
      { modelsLoading: modelPickerStatus === "loading" },
    );
    if (nextSelection) {
      setSelectedModel(nextSelection.model, nextSelection.service);
      return;
    }
    const selectedStillAvailable = selectedModel && selectedService
      ? groupedModels.some((group) =>
          group.service === selectedService
          && group.models.some((model) => model.id === selectedModel),
        )
      : true;
    if (!selectedStillAvailable && modelPickerStatus !== "loading") {
      setSelectedModel(null, null);
    }
  }, [configuredModelSelection, groupedModels, modelPickerStatus, selectedModel, selectedService, serviceConfigLoaded, setSelectedModel]);

  const resizeComposer = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, []);

  useEffect(() => {
    const el = textareaRef.current;
    const storeInput = useChatStore.getState().input;
    const result = resolveComposerTextSync({
      storeInput,
      composerText: composerTextSnapshotRef.current,
      elementValue: el?.value ?? null,
      elementFocused: false,
    });
    composerTextSnapshotRef.current = result.text;
    setComposerHasText(result.text.trim().length > 0);
    if (result.syncStoreText !== null && storeInput !== result.syncStoreText) {
      setInput(result.syncStoreText);
    }
    if (el && el.value !== result.text) {
      el.value = result.text;
    }
    resizeComposer();
  }, [activeSessionId, resizeComposer, setInput]);

  const isNearScrollBottom = (el: HTMLDivElement) => {
    return el.scrollHeight - el.scrollTop - el.clientHeight < 96;
  };

  const scrollToLatest = (behavior: ScrollBehavior = "auto") => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior });
  };

  const handleMessageScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    setFollowingLatest(isNearScrollBottom(el));
  };

  // Follow the latest message while the user remains near the bottom.
  useEffect(() => {
    if (!followingLatest) return;
    requestAnimationFrame(() => scrollToLatest("auto"));
  }, [followingLatest, messages]);

  useEffect(() => {
    setFollowingLatest(true);
    requestAnimationFrame(() => scrollToLatest("auto"));
  }, [activeSessionId]);

  useEffect(() => {
    if (!activeSessionId) return;
    const refreshActiveSession = () => {
      if (document.visibilityState !== "visible") return;
      void loadSessionDetail(activeSessionId);
    };
    document.addEventListener("visibilitychange", refreshActiveSession);
    window.addEventListener("focus", refreshActiveSession);
    return () => {
      document.removeEventListener("visibilitychange", refreshActiveSession);
      window.removeEventListener("focus", refreshActiveSession);
    };
  }, [activeSessionId, loadSessionDetail]);

  // Entering a book loads its latest session; book-create mode persists its orphan session in localStorage.
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      if (activeBookId) {
        await loadSessionList(activeBookId);
        if (cancelled) return;

        const state = useChatStore.getState();
        const currentSession = state.activeSessionId ? state.sessions[state.activeSessionId] : null;
        if (currentSession?.bookId === activeBookId) {
          await loadSessionDetail(currentSession.sessionId);
          return;
        }
        const ids = state.sessionIdsByBook[activeBookId] ?? [];
        if (ids.length > 0) {
          activateSession(ids[0]);
          await loadSessionDetail(ids[0]);
          return;
        }

        createDraftSession(activeBookId);
        return;
      }

      const existingId = mode === "project-chat"
        ? getProjectChatSessionId()
        : getBookCreateSessionId();
      if (existingId) {
        await loadSessionDetail(existingId);
        if (cancelled) return;

        const state = useChatStore.getState();
        const session = state.sessions[existingId];
        if (session && session.bookId === null && (mode !== "project-chat" || session.messages.length > 0)) {
          activateSession(existingId);
          return;
        }
      }

      if (mode === "project-chat") {
        const projectSessions = await loadSessionList(null);
        if (cancelled) return;

        const reusableSessionId = pickProjectChatSessionId(projectSessions);
        if (reusableSessionId) {
          activateSession(reusableSessionId);
          await loadSessionDetail(reusableSessionId);
          if (!cancelled) setProjectChatSessionId(reusableSessionId);
          return;
        }
      }

      const newSessionId = createDraftSession(null);
      if (!cancelled) {
        if (mode === "project-chat") {
          setProjectChatSessionId(newSessionId);
        } else {
          setBookCreateSessionId(newSessionId);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [activeBookId, activateSession, createDraftSession, createSession, loadSessionDetail, loadSessionList, mode]);

  const updateComposerTextSnapshot = useCallback((text: string) => {
    composerTextSnapshotRef.current = text;
    setComposerHasText(text.trim().length > 0);
    resizeComposer();
  }, [resizeComposer]);

  const commitComposerText = useCallback((text: string) => {
    updateComposerTextSnapshot(text);
    if (text !== useChatStore.getState().input) {
      setInput(text);
    }
  }, [setInput, updateComposerTextSnapshot]);

  const setComposerText = (text: string) => {
    commitComposerText(text);
    if (textareaRef.current && textareaRef.current.value !== text) {
      preserveTextSelectionAfterUpdate(textareaRef.current);
      textareaRef.current.value = text;
    }
    resizeComposer();
  };

  const onSend = async (text: string) => {
    const nextText = text.trim();
    if (!nextText || loading) return;
    const sessionId = activeSessionId ?? createDraftSession(activeBookId ?? null);
    if (!activeBookId) {
      if (mode === "project-chat") {
        setProjectChatSessionId(sessionId);
      } else {
        setBookCreateSessionId(sessionId);
      }
    }
    setComposerText("");
    setInput("");
    await sendMessage(sessionId, nextText, activeBookId);
    const restoredInput = useChatStore.getState().input;
    if (restoredInput.trim().length > 0) {
      setComposerText(restoredInput);
    }
  };

  const getComposerText = () => textareaRef.current?.value ?? composerTextSnapshotRef.current;
  const syncComposerTextFromElement = useCallback((el: HTMLTextAreaElement, options?: { readonly commitStore?: boolean }) => {
    const nextText = el.value;
    if (options?.commitStore) {
      commitComposerText(nextText);
      return;
    }
    updateComposerTextSnapshot(nextText);
  }, [commitComposerText, updateComposerTextSnapshot]);
  const syncComposerTextAfterDomUpdate = useCallback((el: HTMLTextAreaElement) => {
    window.setTimeout(() => syncComposerTextFromElement(el), 0);
    window.requestAnimationFrame(() => syncComposerTextFromElement(el));
  }, [syncComposerTextFromElement]);
  const syncComposerText = useCallback(() => {
    const el = textareaRef.current;
    if (el) {
      syncComposerTextFromElement(el, { commitStore: true });
      return;
    }
    const nextText = getComposerText();
    commitComposerText(nextText);
  }, [commitComposerText, syncComposerTextFromElement]);

  const clearComposerSelectionAnchor = useCallback(() => {
    composerSelectionRef.current = null;
    composerInputAnchorRef.current = null;
  }, []);

  const rememberComposerSelection = useCallback((el: HTMLTextAreaElement, options?: { readonly allowEndOverwrite?: boolean; readonly updateInputAnchor?: boolean }) => {
    if (document.activeElement !== el) return;
    const start = el.selectionStart;
    const end = el.selectionEnd;
    if (start === null || end === null) return;
    const previous = composerSelectionRef.current;
    const isCollapsedAtEnd = start === el.value.length && end === el.value.length;
    const previousWasInsideText = previous
      && previous.valueLength === el.value.length
      && (previous.start < el.value.length || previous.end < el.value.length);
    if (isCollapsedAtEnd && previousWasInsideText) {
      return;
    }
    const snapshot = {
      start,
      end,
      direction: (el.selectionDirection ?? "none") as "forward" | "backward" | "none",
      valueLength: el.value.length,
      value: el.value,
    };
    composerSelectionRef.current = snapshot;
    if (options?.updateInputAnchor) {
      composerInputAnchorRef.current = snapshot;
    }
  }, []);

  const restoreComposerSelectionBeforeInput = useCallback((el: HTMLTextAreaElement) => {
    const selection = composerSelectionRef.current;
    if (!selection || document.activeElement !== el) return;
    if (selection.valueLength !== el.value.length) return;
    const currentStart = el.selectionStart;
    const currentEnd = el.selectionEnd;
    if (currentStart === selection.start && currentEnd === selection.end) return;
    const currentLooksForcedToEnd = currentStart === el.value.length && currentEnd === el.value.length;
    const rememberedWasInsideText = selection.start < el.value.length || selection.end < el.value.length;
    if (!currentLooksForcedToEnd || !rememberedWasInsideText) return;
    try {
      el.setSelectionRange(selection.start, selection.end, selection.direction);
    } catch {
      // Android WebView can transiently reject selection changes during IME updates.
    }
  }, []);

  const manuallyApplyComposerBeforeInput = useCallback((el: HTMLTextAreaElement, event: InputEvent): boolean => {
    const selection = composerInputAnchorRef.current ?? composerSelectionRef.current;
    if (!selection || document.activeElement !== el) return false;
    if (selection.valueLength !== el.value.length) return false;
    if (!(selection.start < el.value.length || selection.end < el.value.length)) return false;
    if (!(el.selectionStart === el.value.length && el.selectionEnd === el.value.length)) return false;
    if (event.isComposing) return false;
    const inputType = event.inputType;
    if (inputType === "deleteContentBackward" || inputType === "deleteContentForward") {
      event.preventDefault();
      const sourceText = selection.value;
      let deleteStart = selection.start;
      let deleteEnd = selection.end;
      if (deleteStart === deleteEnd && inputType === "deleteContentBackward" && deleteStart > 0) {
        const previousChar = Array.from(sourceText.slice(0, deleteStart)).at(-1) ?? "";
        deleteStart = Math.max(0, deleteStart - previousChar.length);
      } else if (deleteStart === deleteEnd && inputType === "deleteContentForward" && deleteEnd < sourceText.length) {
        const nextChar = Array.from(sourceText.slice(deleteEnd)).at(0) ?? "";
        deleteEnd = Math.min(sourceText.length, deleteEnd + nextChar.length);
      }
      const nextText = `${sourceText.slice(0, deleteStart)}${sourceText.slice(deleteEnd)}`;
      el.value = nextText;
      try {
        el.setSelectionRange(deleteStart, deleteStart, "none");
      } catch {
        // Ignore transient Android WebView selection errors.
      }
      updateComposerTextSnapshot(nextText);
      composerSelectionRef.current = {
        start: deleteStart,
        end: deleteStart,
        direction: "none",
        valueLength: nextText.length,
        value: nextText,
      };
      composerInputAnchorRef.current = composerSelectionRef.current;
      return true;
    }
    if (inputType !== "insertText" && inputType !== "insertReplacementText") return false;
    const insertedText = event.data ?? "";
    if (!insertedText) return false;

    event.preventDefault();
    const before = selection.value.slice(0, selection.start);
    const after = selection.value.slice(selection.end);
    const nextText = `${before}${insertedText}${after}`;
    const nextCursor = selection.start + insertedText.length;
    el.value = nextText;
    try {
      el.setSelectionRange(nextCursor, nextCursor, "none");
    } catch {
      // Ignore transient Android WebView selection errors.
    }
    updateComposerTextSnapshot(nextText);
    composerSelectionRef.current = {
      start: nextCursor,
      end: nextCursor,
      direction: "none",
      valueLength: nextText.length,
      value: nextText,
    };
    composerInputAnchorRef.current = composerSelectionRef.current;
    return true;
  }, [updateComposerTextSnapshot]);

  const repairAppendedComposerInput = useCallback((el: HTMLTextAreaElement): boolean => {
    const selection = composerInputAnchorRef.current ?? composerSelectionRef.current;
    if (!selection || document.activeElement !== el) return false;
    const selectionWasInsideText = selection.start < selection.value.length || selection.end < selection.value.length;
    if (!selectionWasInsideText) return false;
    const currentValue = el.value;
    if (currentValue === selection.value) return false;
    if (!currentValue.startsWith(selection.value)) return false;
    const appendedText = currentValue.slice(selection.value.length);
    if (!appendedText) return false;

    const repairedText = `${selection.value.slice(0, selection.start)}${appendedText}${selection.value.slice(selection.end)}`;
    const nextCursor = selection.start + appendedText.length;
    el.value = repairedText;
    try {
      el.setSelectionRange(nextCursor, nextCursor, "none");
    } catch {
      // Some Android IMEs briefly reject selection changes during commit.
    }
    updateComposerTextSnapshot(repairedText);
    composerSelectionRef.current = {
      start: nextCursor,
      end: nextCursor,
      direction: "none",
      valueLength: repairedText.length,
      value: repairedText,
    };
    composerInputAnchorRef.current = composerSelectionRef.current;
    return true;
  }, [updateComposerTextSnapshot]);

  const startComposerComposition = useCallback((el: HTMLTextAreaElement) => {
    const remembered = composerInputAnchorRef.current ?? composerSelectionRef.current;
    const currentStart = el.selectionStart ?? el.value.length;
    const currentEnd = el.selectionEnd ?? currentStart;
    const currentLooksForcedToEnd = currentStart === el.value.length && currentEnd === el.value.length;
    const rememberedWasInsideText = remembered
      && remembered.valueLength === el.value.length
      && (remembered.start < el.value.length || remembered.end < el.value.length);
    composerCompositionRef.current = {
      start: currentLooksForcedToEnd && rememberedWasInsideText ? remembered.start : currentStart,
      end: currentLooksForcedToEnd && rememberedWasInsideText ? remembered.end : currentEnd,
      value: el.value,
    };
  }, []);

  const repairComposerCompositionCommit = useCallback((el: HTMLTextAreaElement, options?: { readonly finish?: boolean; readonly committedText?: string }) => {
    const composition = composerCompositionRef.current;
    if (!composition || document.activeElement !== el) return;
    const committedValue = el.value;
    if (committedValue === composition.value) return;

    const insertedAtEnd = committedValue.startsWith(composition.value)
      ? committedValue.slice(composition.value.length)
      : options?.committedText ?? "";
    if (!insertedAtEnd) {
      if (options?.finish) composerCompositionRef.current = null;
      syncComposerTextFromElement(el);
      rememberComposerSelection(el);
      return;
    }

    const expectedAtCursor = `${composition.value.slice(0, composition.start)}${insertedAtEnd}${composition.value.slice(composition.end)}`;
    if (committedValue === expectedAtCursor) {
      composerCompositionRef.current = {
        ...composition,
        insertedText: insertedAtEnd,
      };
      if (options?.finish) composerCompositionRef.current = null;
      syncComposerTextFromElement(el);
      rememberComposerSelection(el);
      return;
    }

    el.value = expectedAtCursor;
    const nextCursor = composition.start + insertedAtEnd.length;
    try {
      el.setSelectionRange(nextCursor, nextCursor, "none");
    } catch {
      // Android WebView can transiently reject selection changes after IME commit.
    }
    updateComposerTextSnapshot(expectedAtCursor);
    composerSelectionRef.current = {
      start: nextCursor,
      end: nextCursor,
      direction: "none",
      valueLength: expectedAtCursor.length,
      value: expectedAtCursor,
    };
    composerInputAnchorRef.current = composerSelectionRef.current;
    composerCompositionRef.current = options?.finish
      ? null
      : {
          ...composition,
          insertedText: insertedAtEnd,
        };
  }, [rememberComposerSelection, syncComposerTextFromElement, updateComposerTextSnapshot]);

  const startComposerPolling = useCallback(() => {
    if (composerPollFrameRef.current !== null) return;
    const poll = () => {
      const el = textareaRef.current;
      if (!el || !composerFocusedRef.current) {
        composerPollFrameRef.current = null;
        return;
      }
      repairAppendedComposerInput(el);
      repairComposerCompositionCommit(el);
      if (el.value !== composerTextSnapshotRef.current) {
        syncComposerTextFromElement(el);
      }
      rememberComposerSelection(el);
      composerPollFrameRef.current = window.requestAnimationFrame(poll);
    };
    composerPollFrameRef.current = window.requestAnimationFrame(poll);
  }, [rememberComposerSelection, repairAppendedComposerInput, repairComposerCompositionCommit, syncComposerTextFromElement]);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return undefined;

    const repairThenSync = () => {
      repairAppendedComposerInput(el);
      repairComposerCompositionCommit(el);
      syncComposerTextFromElement(el);
    };
    const scheduleSync = () => {
      repairThenSync();
      window.setTimeout(repairThenSync, 0);
      window.requestAnimationFrame(repairThenSync);
      startComposerPolling();
    };
    const handleBeforeInput = (event: InputEvent) => {
      if (manuallyApplyComposerBeforeInput(el, event)) return;
      restoreComposerSelectionBeforeInput(el);
      scheduleSync();
    };
    const handleCompositionStart = () => {
      startComposerComposition(el);
    };
    const handleCompositionEnd = (event: CompositionEvent) => {
      const committedText = event.data ?? "";
      window.setTimeout(() => repairComposerCompositionCommit(el, { finish: true, committedText }), 0);
      window.requestAnimationFrame(() => repairComposerCompositionCommit(el, { finish: true, committedText }));
    };
    const handleSelectionChange = () => {
      rememberComposerSelection(el, { updateInputAnchor: true });
    };
    const handleDelayedSelectionChange = () => {
      handleSelectionChange();
      window.setTimeout(handleSelectionChange, 0);
      window.setTimeout(handleSelectionChange, 32);
      window.setTimeout(handleSelectionChange, 96);
      window.requestAnimationFrame(handleSelectionChange);
    };
    const handlePointerStart = () => {
      clearComposerSelectionAnchor();
    };
    const handleFocus = () => {
      composerFocusedRef.current = true;
      rememberComposerSelection(el, { updateInputAnchor: true });
      scheduleSync();
    };
    const handleBlur = () => {
      composerFocusedRef.current = false;
      composerSelectionRef.current = null;
      composerInputAnchorRef.current = null;
      if (composerPollFrameRef.current !== null) {
        window.cancelAnimationFrame(composerPollFrameRef.current);
        composerPollFrameRef.current = null;
      }
      syncComposerTextFromElement(el, { commitStore: true });
    };

    el.addEventListener("beforeinput", handleBeforeInput);
    el.addEventListener("input", scheduleSync);
    el.addEventListener("change", scheduleSync);
    el.addEventListener("compositionstart", handleCompositionStart);
    el.addEventListener("compositionupdate", scheduleSync);
    el.addEventListener("compositionend", handleCompositionEnd);
    el.addEventListener("keyup", scheduleSync);
    el.addEventListener("select", handleSelectionChange);
    el.addEventListener("selectionchange", handleSelectionChange);
    el.addEventListener("touchstart", handlePointerStart);
    el.addEventListener("pointerdown", handlePointerStart);
    el.addEventListener("click", handleDelayedSelectionChange);
    el.addEventListener("touchend", handleDelayedSelectionChange);
    el.addEventListener("pointerup", handleDelayedSelectionChange);
    el.addEventListener("paste", scheduleSync);
    el.addEventListener("cut", scheduleSync);
    el.addEventListener("drop", scheduleSync);
    el.addEventListener("focus", handleFocus);
    el.addEventListener("blur", handleBlur);

    return () => {
      el.removeEventListener("beforeinput", handleBeforeInput);
      el.removeEventListener("input", scheduleSync);
      el.removeEventListener("change", scheduleSync);
      el.removeEventListener("compositionstart", handleCompositionStart);
      el.removeEventListener("compositionupdate", scheduleSync);
      el.removeEventListener("compositionend", handleCompositionEnd);
      el.removeEventListener("keyup", scheduleSync);
      el.removeEventListener("select", handleSelectionChange);
      el.removeEventListener("selectionchange", handleSelectionChange);
      el.removeEventListener("touchstart", handlePointerStart);
      el.removeEventListener("pointerdown", handlePointerStart);
      el.removeEventListener("click", handleDelayedSelectionChange);
      el.removeEventListener("touchend", handleDelayedSelectionChange);
      el.removeEventListener("pointerup", handleDelayedSelectionChange);
      el.removeEventListener("paste", scheduleSync);
      el.removeEventListener("cut", scheduleSync);
      el.removeEventListener("drop", scheduleSync);
      el.removeEventListener("focus", handleFocus);
      el.removeEventListener("blur", handleBlur);
      if (composerPollFrameRef.current !== null) {
        window.cancelAnimationFrame(composerPollFrameRef.current);
        composerPollFrameRef.current = null;
      }
    };
  }, [
    rememberComposerSelection,
    clearComposerSelectionAnchor,
    manuallyApplyComposerBeforeInput,
    repairAppendedComposerInput,
    repairComposerCompositionCommit,
    restoreComposerSelectionBeforeInput,
    startComposerPolling,
    startComposerComposition,
    syncComposerTextAfterDomUpdate,
    syncComposerTextFromElement,
  ]);

  const handleQuickAction = (command: string) => {
    const sessionId = activeSessionId ?? createDraftSession(activeBookId ?? null);
    void sendMessage(sessionId, command, activeBookId);
  };

  const requestDeleteMessage = (messageIndex: number) => {
    if (!activeSessionId) return;
    const message = messages[messageIndex];
    if (!message) return;
    textareaRef.current?.blur();
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
    setPendingDelete({
      sessionId: activeSessionId,
      messageIndex,
      messageKey: `${message.role}\u001f${message.timestamp}\u001f${message.content.trim().slice(0, 240)}`,
      role: message.role === "user" ? "user" : "assistant",
      preview: message.content.replace(/^\u2717\s*/, "").trim().slice(0, 80),
    });
  };

  const confirmDeleteMessage = async () => {
    const target = pendingDelete;
    if (!target || deletingMessage) return;
    setDeletingMessage(true);
    try {
      const latestSession = useChatStore.getState().sessions[target.sessionId];
      const latestIndex = latestSession?.messages.findIndex((message) =>
        `${message.role}\u001f${message.timestamp}\u001f${message.content.trim().slice(0, 240)}` === target.messageKey,
      ) ?? -1;
      await deleteMessage(target.sessionId, latestIndex >= 0 ? latestIndex : target.messageIndex);
      setPendingDelete(null);
    } finally {
      setDeletingMessage(false);
    }
  };

  const emptyGuidance = isZh
    ? "\u544A\u8BC9\u6211\u4F60\u60F3\u5199\u4EC0\u4E48\u2014\u2014\u9898\u6750\u3001\u4E16\u754C\u89C2\u3001\u4E3B\u89D2\u3001\u6838\u5FC3\u51B2\u7A81"
    : "Tell me what you want to write \u2014 genre, world, protagonist, core conflict";

  return (
    <div className="flex flex-col h-full flex-1 min-w-0">
      {/* Message scroll area */}
      <div
        ref={scrollRef}
        onScroll={handleMessageScroll}
        className="chat-message-scroll flex-1 overflow-y-auto [scrollbar-gutter:stable] px-2.5 py-3 sm:px-4 sm:py-6"
      >
        {messages.length === 0 && !loading ? (
          <div className="h-full flex flex-col items-center justify-center text-center select-none">
            <div className="w-14 h-14 rounded-2xl border border-dashed border-border/80 flex items-center justify-center mb-4 bg-card/45 opacity-70">
              <BotMessageSquare size={24} className="text-muted-foreground" />
            </div>
            <p className="text-sm text-muted-foreground max-w-md leading-7">
              {emptyGuidance}
            </p>
          </div>
        ) : (
          <div className="mx-auto max-w-5xl space-y-3 sm:space-y-4">
            {messages.map((msg, i) => (
              <div key={`${msg.timestamp}-${i}`}>
                {msg.role === "user" ? (
                  /* User message */
                  <ChatMessage
                    role="user"
                    content={msg.content}
                    timestamp={msg.timestamp}
                    theme={theme}
                    onDelete={activeSessionId ? () => requestDeleteMessage(i) : undefined}
                  />
                ) : msg.parts && msg.parts.length > 0 ? (
                  /* Assistant message — parts-based rendering (chronological) */
                  /* Merge consecutive utility tool parts into one group */
                  <>
                    {(() => {
                      type RenderItem =
                        | { kind: "thinking"; pi: number; part: Extract<typeof msg.parts[0], { type: "thinking" }> }
                        | { kind: "text"; pi: number; part: Extract<typeof msg.parts[0], { type: "text" }> }
                        | { kind: "tools"; parts: Array<Extract<typeof msg.parts[0], { type: "tool" }>>; startIdx: number };

                      const items: RenderItem[] = [];
                      for (let pi = 0; pi < msg.parts!.length; pi++) {
                        const part = msg.parts![pi];
                        if (part.type === "thinking") {
                          items.push({ kind: "thinking", pi, part });
                        } else if (part.type === "text") {
                          items.push({ kind: "text", pi, part });
                        } else if (part.type === "tool") {
                          // Merge consecutive tool parts into one group
                          const last = items[items.length - 1];
                          if (last?.kind === "tools") {
                            last.parts.push(part);
                          } else {
                            items.push({ kind: "tools", parts: [part], startIdx: pi });
                          }
                        }
                      }

                      const rendered = items.map((item) => {
                        if (item.kind === "thinking") {
                          return (
                            <div key={`t-${item.pi}`} className="mb-2">
                              <Reasoning isStreaming={item.part.streaming}>
                                <ReasoningTrigger />
                                <ReasoningContent>{item.part.content}</ReasoningContent>
                              </Reasoning>
                            </div>
                          );
                        }
                        if (item.kind === "tools") {
                          return <ToolExecutionSteps key={`x-${item.startIdx}`} executions={item.parts.map(p => p.execution)} />;
                        }
                        if (item.kind === "text" && item.part.content) {
                          return (
                            <ChatMessage
                              key={`c-${item.pi}`}
                              role="assistant"
                              content={item.part.content}
                              timestamp={msg.timestamp}
                              theme={theme}
                              tokenUsage={msg.tokenUsage}
                              isStreaming={loading && i === messages.length - 1}
                              onDelete={activeSessionId ? () => requestDeleteMessage(i) : undefined}
                            />
                          );
                        }
                        return null;
                      });
                      const hasTextContent = items.some((item) => item.kind === "text" && item.part.content.trim().length > 0);
                      if (!hasTextContent && activeSessionId) {
                        rendered.push(
                          <div key="delete-tool-only-message" className="mt-2 flex justify-start">
                            <button
                              type="button"
                              onClick={() => requestDeleteMessage(i)}
                              className="inline-flex min-h-9 shrink-0 touch-manipulation items-center gap-1.5 rounded-full border border-border/35 bg-background/30 px-3 text-xs font-medium text-muted-foreground/85 transition-colors hover:border-destructive/35 hover:bg-destructive/10 hover:text-destructive"
                            >
                              删除
                            </button>
                          </div>,
                        );
                      }
                      return rendered;
                    })()}
                  </>
                ) : (
                  /* Assistant message — fallback (no parts, e.g. error messages) */
                  <ChatMessage
                    role={msg.role}
                    content={msg.content}
                    timestamp={msg.timestamp}
                    theme={theme}
                    tokenUsage={msg.tokenUsage}
                    isStreaming={loading && i === messages.length - 1 && msg.role === "assistant"}
                    onDelete={activeSessionId ? () => requestDeleteMessage(i) : undefined}
                  />
                )}
              </div>
            ))}

            {/* Loading indicator — only when loading and no streaming activity */}
            {loading && !isStreaming && (
              <Message from="assistant">
                <MessageContent>
                  <div className="flex items-center gap-3">
                    <div className="flex gap-1">
                      <span className="w-2 h-2 rounded-full bg-primary/60 animate-bounce" style={{ animationDelay: "0ms" }} />
                      <span className="w-2 h-2 rounded-full bg-primary/60 animate-bounce" style={{ animationDelay: "150ms" }} />
                      <span className="w-2 h-2 rounded-full bg-primary/60 animate-bounce" style={{ animationDelay: "300ms" }} />
                    </div>
                    <Shimmer className="text-sm" duration={1.5}>
                      {isZh ? "AI 正在思考，即将开始写作..." : "AI is thinking, writing begins shortly..."}
                    </Shimmer>
                    {activeTokenLabel && (
                      <span className="rounded-full border border-border/45 bg-background/45 px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                        {activeTokenLabel}
                      </span>
                    )}
                  </div>
                </MessageContent>
              </Message>
            )}

          </div>
        )}
        {!followingLatest && (
          <button
            type="button"
            onClick={() => {
              setFollowingLatest(true);
              requestAnimationFrame(() => scrollToLatest("auto"));
            }}
            className="sticky bottom-3 left-1/2 z-20 mx-auto mt-4 flex min-h-10 w-max -translate-x-1/2 items-center gap-2 rounded-full border border-border/70 bg-card/95 px-4 py-2 text-xs font-medium text-foreground shadow-lg shadow-primary/10 backdrop-blur transition-all hover:border-primary/40 hover:text-primary sm:bottom-4"
          >
            <ChevronDown size={14} />
            {isZh ? "追踪最新位置" : "Follow latest"}
          </button>
        )}
      </div>

      {/* Quick actions (only when a book is active) */}
      {hasBook && (
        <div className="shrink-0 mx-auto w-full max-w-5xl px-2.5 sm:px-4">
          <QuickActions
            onAction={handleQuickAction}
            disabled={loading}
            isZh={isZh}
          />
        </div>
      )}

      {/* Input area */}
      <div className="relative z-30 shrink-0 border-t border-border/45 px-2.5 py-2 claude-topbar mobile-safe-bottom sm:px-4 sm:py-4">
        <div className="mx-auto max-w-5xl">
            <form
              className="claude-composer rounded-[1.15rem] transition-all sm:rounded-2xl"
              onSubmit={(e) => {
                e.preventDefault();
                if (loading) {
                  if (activeSessionId) void cancelMessage(activeSessionId);
                  return;
                }
                syncComposerText();
                void onSend(getComposerText());
              }}
            >
              <div className="flex items-end gap-2 px-3 py-2.5">
                <textarea
                  ref={textareaRef}
                  defaultValue={composerTextSnapshotRef.current}
                  onInput={(e) => {
                    syncComposerTextAfterDomUpdate(e.currentTarget);
                  }}
                  onChange={(e) => {
                    syncComposerTextAfterDomUpdate(e.currentTarget);
                  }}
                  onCompositionUpdate={(e) => {
                    syncComposerTextAfterDomUpdate(e.currentTarget);
                  }}
                  onCompositionEnd={(e) => {
                    syncComposerTextAfterDomUpdate(e.currentTarget);
                  }}
                  onKeyUp={(e) => {
                    syncComposerTextAfterDomUpdate(e.currentTarget);
                  }}
                  onPaste={(e) => {
                    syncComposerTextAfterDomUpdate(e.currentTarget);
                  }}
                  onBlur={(e) => {
                    commitComposerText(e.currentTarget.value);
                  }}
                  onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); syncComposerText(); void onSend(getComposerText()); } }}
                  placeholder={isZh ? "输入消息..." : "Message InkOS..."}
                  disabled={loading}
                  rows={1}
                  className="max-h-[40dvh] min-h-11 flex-1 resize-none overflow-y-auto border-none! bg-transparent text-base leading-6 placeholder:text-muted-foreground/60 shadow-none outline-none! ring-0! focus:border-none! focus:outline-none! focus:ring-0! disabled:opacity-50 sm:max-h-[200px] sm:min-h-0 sm:text-sm"
                />
                <button
                  type={loading ? "button" : "submit"}
                  disabled={!loading && !composerHasText}
                  aria-disabled={!loading && !composerHasText}
                  onClick={(event) => {
                    if (loading) {
                      event.preventDefault();
                      event.stopPropagation();
                    }
                    if (loading && activeSessionId) {
                      void cancelMessage(activeSessionId);
                    }
                  }}
                  className={`relative z-10 flex h-11 w-11 shrink-0 touch-manipulation items-center justify-center rounded-2xl bg-primary text-primary-foreground shadow-sm shadow-primary/20 transition-all hover:scale-105 active:scale-95 disabled:scale-100 disabled:opacity-35 sm:h-8 sm:w-8 sm:rounded-xl ${
                    !composerHasText && !loading ? "opacity-35" : ""
                  }`}
                  aria-label={loading ? (isZh ? "停止生成" : "Stop generation") : (isZh ? "发送消息" : "Send message")}
                >
                  {loading ? <Square size={14} fill="currentColor" strokeWidth={2.5} className="sm:size-3" /> : <ArrowUp size={16} strokeWidth={2.5} className="sm:size-3.5" />}
                </button>
              </div>
              <div className="flex min-h-9 flex-wrap items-center gap-2 border-t border-border/35 px-3 pb-2 pt-1">
                {modelPickerStatus === "loading" ? (
                  <span className="text-xs text-muted-foreground/40 animate-pulse">加载模型...</span>
                ) : modelPickerStatus === "ready" ? (
                  <DropdownMenu>
                    <DropdownMenuTrigger className="flex min-h-8 max-w-full items-center gap-1.5 rounded-xl px-2.5 py-1 text-sm transition-colors hover:bg-secondary/70">
                      <span className="max-w-[calc(100vw-7rem)] truncate text-xs font-medium sm:max-w-[220px]">
                        {selectedModelLabel}
                      </span>
                      <ChevronDown size={14} className="text-muted-foreground" />
                    </DropdownMenuTrigger>
                    <ModelPickerContent
                      groupedModels={groupedModels}
                      selectedModel={selectedModel}
                      selectedService={selectedService}
                      onSelect={setSelectedModel}
                      onManage={() => nav.toServices()}
                    />
                  </DropdownMenu>
                ) : (
                  <button
                    onClick={() => nav.toServices()}
                    className="min-h-8 rounded-xl px-2.5 text-xs text-muted-foreground/50 transition-colors hover:text-primary"
                  >
                    配置模型 →
                  </button>
                )}
                {tokenSavingsLabel && (
                  <span className="ml-auto rounded-full border border-emerald-500/25 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-600 dark:text-emerald-400">
                    {tokenSavingsLabel}
                  </span>
                )}
              </div>
            </form>
        </div>
      </div>
      {pendingDelete && (
        <div
          className="fixed inset-0 z-[9999] flex items-center justify-center bg-background/70 px-4 py-[calc(env(safe-area-inset-top)+1rem)] backdrop-blur-xl"
          role="dialog"
          aria-modal="true"
          aria-label="确认删除消息"
          onClick={(event) => event.stopPropagation()}
        >
          <div
            className="glass-panel w-full max-w-sm rounded-[1.75rem] border border-border/70 bg-card/95 p-5 shadow-2xl shadow-primary/10"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-4">
              <div className="flex items-center gap-2 text-sm font-semibold text-destructive">
                <Trash2 size={16} />
                删除消息
              </div>
              <button
                type="button"
                onClick={() => setPendingDelete(null)}
                className="soft-pill flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground"
                aria-label="关闭"
              >
                <X size={15} />
              </button>
            </div>
            <h2 className="mt-3 text-xl font-semibold tracking-normal text-foreground">
              确认删除这条{pendingDelete.role === "user" ? "用户消息" : "AI 回复"}？
            </h2>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              删除后会同步写入会话记录，重新进入这个会话也不会恢复。
            </p>
            {pendingDelete.preview && (
              <p className="mt-4 line-clamp-3 rounded-2xl border border-border/45 bg-background/45 px-4 py-3 text-sm leading-6 text-muted-foreground">
                {pendingDelete.preview}
              </p>
            )}
            <div className="mt-5 grid grid-cols-2 gap-3">
              <button
                type="button"
                disabled={deletingMessage}
                onClick={() => setPendingDelete(null)}
                className="soft-pill h-11 rounded-2xl px-4 text-sm font-semibold text-foreground"
              >
                取消
              </button>
              <button
                type="button"
                disabled={deletingMessage}
                onClick={() => void confirmDeleteMessage()}
                className="inline-flex h-11 items-center justify-center gap-2 rounded-2xl bg-destructive px-4 text-sm font-semibold text-destructive-foreground shadow-lg shadow-destructive/20 transition-colors hover:bg-destructive/90"
              >
                <Trash2 size={15} />
                {deletingMessage ? "删除中..." : "删除"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ModelPickerContent({
  groupedModels,
  selectedModel,
  selectedService,
  onSelect,
  onManage,
}: {
  groupedModels: ReadonlyArray<{ service: string; label: string; models: ReadonlyArray<{ id: string; name?: string }> }>;
  selectedModel: string | null;
  selectedService: string | null;
  onSelect: (model: string, service: string) => void;
  onManage: () => void;
}) {
  const [search, setSearch] = useState("");
  const filtered = useMemo(() => filterModelGroups(groupedModels, search), [groupedModels, search]);

  return (
    <DropdownMenuContent side="top" align="start" className="flex max-h-[56dvh] w-[min(22rem,calc(100vw-1rem))] flex-col rounded-2xl p-1.5">
      <div className="border-b border-border/30 px-2 py-2">
        <input
          type="text"
          value={search}
          {...mobileTextInputHandlers(setSearch)}
          placeholder="搜索模型..."
          className="h-10 w-full rounded-xl bg-secondary/35 px-3 text-base outline-none placeholder:text-muted-foreground/40 sm:text-sm"
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        />
      </div>
      <div className="overflow-y-auto flex-1">
        {filtered.map((group) => (
          <div key={group.service}>
            <div className="px-2 py-1.5 text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
              {group.label}
            </div>
            {group.models.map((m) => {
              const isSelected = selectedModel === m.id && selectedService === group.service;
              return (
                <DropdownMenuItem
                  key={`${group.service}:${m.id}`}
                  onClick={() => onSelect(m.id, group.service)}
                  className={isSelected ? "bg-muted/50" : ""}
                >
                  <div className="flex min-h-10 flex-1 items-center justify-between gap-3">
                    <span className="truncate text-sm">{m.name ?? m.id}</span>
                    {isSelected && <Check size={14} className="text-primary shrink-0" />}
                  </div>
                </DropdownMenuItem>
              );
            })}
          </div>
        ))}
        {filtered.length === 0 && (
          <div className="px-3 py-4 text-xs text-muted-foreground/50 text-center italic">
            无匹配模型
          </div>
        )}
      </div>
      <div className="border-t border-border/30">
        <DropdownMenuItem onClick={onManage} className="min-h-10 text-primary">
          管理服务商
        </DropdownMenuItem>
      </div>
    </DropdownMenuContent>
  );
}
