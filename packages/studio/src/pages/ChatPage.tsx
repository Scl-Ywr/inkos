import { useRef, useEffect, useMemo, useState } from "react";
import type { Theme } from "../hooks/use-theme";
import type { TFunction } from "../hooks/use-i18n";
import type { SSEMessage } from "../hooks/use-sse";
import { fetchJson } from "../hooks/use-api";
import { useCompositionInput } from "../hooks/use-composition-input";
import { useAndroidImeBridge } from "../hooks/use-android-ime-bridge";
import { appAlert, appConfirm } from "../lib/app-dialog";
import { chatSelectors, useChatStore } from "../store/chat";
import type { ChatSessionKind } from "../store/chat";
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
import { ToolExecutionSteps, type ProposedActionDetails } from "../components/chat/ToolExecutionSteps";
import { PlayHud } from "../components/chat/PlayHud";
import { PlayChoicePanel } from "../components/chat/PlayChoicePanel";
import { latestPlayChoiceSet } from "../components/chat/play-choices";
import {
  BotMessageSquare,
  ArrowUp,
  Square,
  ChevronDown,
  Check,
  Gamepad2,
  GitBranch,
  Palette,
  MoreHorizontal,
  Trash2,
  ShieldAlert,
  Wrench,
} from "lucide-react";
import { Shimmer } from "../components/ai-elements/shimmer";
import {
  Message,
  MessageContent,
} from "../components/ai-elements/message";
import {
  type ChatPageModelPreference,
  buildModelGroups,
  filterModelGroups,
  getBookCreateSessionId,
  getProjectChatSessionId,
  pickProjectChatSessionId,
  pickModelSelection,
  setBookCreateSessionId,
  setProjectChatSessionId,
  isChatScrollNearBottom,
  shouldShowPlayChoicePanel,
} from "./chat-page-state";

// -- Types --

interface Nav {
  toDashboard: () => void;
  toBook: (id: string) => void;
  toServices: () => void;
  toImport: (tab?: "chapters" | "canon" | "fanfic" | "spinoff" | "imitation") => void;
  toStyle: () => void;
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

interface PlayImageSettings {
  readonly actors: boolean;
  readonly moments: boolean;
  readonly inventory: boolean;
}

interface PlayRunImagePayload {
  readonly imageSettings?: PlayImageSettings;
}

interface CoverConfigResponse {
  readonly service?: string | null;
  readonly configured?: boolean;
  readonly providers?: ReadonlyArray<{ readonly service: string; readonly connected?: boolean }>;
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

interface BookChapterHealthPayload {
  readonly nextChapter: number;
  readonly chapters: ReadonlyArray<{
    readonly number: number;
    readonly status: string;
  }>;
}

// -- Component --

export function ChatPage({ activeBookId, mode = activeBookId ? "book" : "book-create", nav, theme, t, sse: _sse }: ChatPageProps) {
  // -- Store selectors --
  const messages = useChatStore(chatSelectors.activeMessages);
  const activeSession = useChatStore(chatSelectors.activeSession);
  const activeSessionId = useChatStore((s) => s.activeSessionId);
  const input = useChatStore((s) => s.input);
  const loading = useChatStore(chatSelectors.isActiveSessionStreaming);
  const selectedModel = useChatStore((s) => s.selectedModel);
  const selectedService = useChatStore((s) => s.selectedService);
  // -- Store actions --
  const setInput = useChatStore((s) => s.setInput);
  const sendMessage = useChatStore((s) => s.sendMessage);
  const deleteMessage = useChatStore((s) => s.deleteMessage);
  const cancelMessage = useChatStore((s) => s.cancelMessage);
  const setSelectedModel = useChatStore((s) => s.setSelectedModel);
  const loadSessionList = useChatStore((s) => s.loadSessionList);
  const createSession = useChatStore((s) => s.createSession);
  const markProposalResolved = useChatStore((s) => s.markProposalResolved);
  const loadSessionDetail = useChatStore((s) => s.loadSessionDetail);
  const activateSession = useChatStore((s) => s.activateSession);
  const setSessionPlayMode = useChatStore((s) => s.setSessionPlayMode);

  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const autoScrollPinnedRef = useRef(true);
  const [followingLatest, setFollowingLatest] = useState(true);
  const [degradedChapter, setDegradedChapter] = useState<number | null>(null);
  const [repairingChapter, setRepairingChapter] = useState(false);
  const compositionInput = useCompositionInput({
    value: input,
    onValueChange: setInput,
  });

  const isZh = t("nav.connected") === "\u5DF2\u8FDE\u63A5";
  const hasBook = Boolean(activeBookId);
  const currentSessionKind: ChatSessionKind = activeSession?.sessionKind
    ?? (mode === "book-create" ? "book-create" : activeBookId ? "book" : "chat");
  const playMode = activeSession?.playMode;
  const playModeInfo = currentSessionKind === "play" && playMode
    ? playMode === "guided"
      ? {
          label: isZh ? "分支互动" : "Branching",
          detail: isZh ? "点选项推进，也可以补充自由输入" : "Advance with choices, with optional free input",
          Icon: GitBranch,
        }
      : {
          label: isZh ? "开放世界" : "Open World",
          detail: isZh ? "自由输入行动，世界按状态持续推进" : "Type free actions and let the world react",
          Icon: Gamepad2,
        }
    : null;

  const refreshChapterHealth = async () => {
    if (!activeBookId) {
      setDegradedChapter(null);
      return;
    }
    try {
      const payload = await fetchJson<BookChapterHealthPayload>(`/books/${activeBookId}`);
      const latestChapter = payload.nextChapter - 1;
      const latest = payload.chapters.find((chapter) => chapter.number === latestChapter);
      setDegradedChapter(latest?.status === "state-degraded" ? latest.number : null);
    } catch {
      // The writing page remains usable if chapter metadata cannot be refreshed.
    }
  };

  useEffect(() => {
    void refreshChapterHealth();
  }, [activeBookId]);
  // A play session must pick its playstyle (点着玩 / 自由玩) before chatting.
  const needsPlayModeChoice = currentSessionKind === "play" && !playMode;
  // Even in 点着玩 the world is shaped by free typing first; the choice panel
  // only replaces the input once play has actually started (a play tool
  // produced choices).
  const playChoiceSet = useMemo(
    () => (currentSessionKind === "play" && playMode === "guided"
      ? latestPlayChoiceSet(messages, isZh
        ? ["观察眼前刚发生的变化", "主动与眼前的人或事物互动", "暂时按兵不动"]
        : ["Observe the immediate change", "Interact with what is in front of you", "Hold back and wait"])
      : null),
    [currentSessionKind, isZh, playMode, messages],
  );
  const [consumedPlayChoiceKey, setConsumedPlayChoiceKey] = useState<string | null>(null);
  const playChoices = playChoiceSet?.choices ?? [];
  const showChoicePanel = shouldShowPlayChoicePanel({
    playMode,
    choiceSetKey: playChoiceSet?.key ?? null,
    consumedChoiceKey: consumedPlayChoiceKey,
    choiceCount: playChoices.length,
  });
  const deleteConfirmOpenRef = useRef(false);

  const handleDeleteMessage = async (messageIndex: number, role: "user" | "assistant") => {
    if (!activeSessionId) return;
    if (deleteConfirmOpenRef.current) return;
    deleteConfirmOpenRef.current = true;
    const label = role === "user" ? "用户消息" : "AI 回复";
    try {
      const confirmed = await appConfirm({
        title: "删除消息",
        message: `确认删除这条${label}？\n\n删除后会同步写入会话记录，重新进入这个会话也不会恢复。`,
        tone: "danger",
        confirmLabel: "删除",
        cancelLabel: "取消",
      });
      if (!confirmed) return;
      await deleteMessage(activeSessionId, messageIndex);
    } finally {
      deleteConfirmOpenRef.current = false;
    }
  };
  // World panel (holdings / state / relations) defaults collapsed; the scene
  // image and choices live in the chat center now, opened on demand.
  const [worldPanelOpen, setWorldPanelOpen] = useState(false);
  const [playImageError, setPlayImageError] = useState<string | null>(null);
  const [playImageMenuOpen, setPlayImageMenuOpen] = useState(false);
  const [playImageSettings, setPlayImageSettings] = useState<PlayImageSettings>({ actors: false, moments: false, inventory: false });
  const [playImageCoverReady, setPlayImageCoverReady] = useState(false);
  const [tokenSavingsLabel, setTokenSavingsLabel] = useState<string | null>(null);
  const worldPanelInsetClass = currentSessionKind === "play" && worldPanelOpen ? "lg:pr-[380px]" : "";

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
    void fetchBankModels();
    void fetchCustomModels();
  }, [fetchBankModels, fetchCustomModels]);
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

  const groupedModels = useMemo(() => {
    return buildModelGroups(
      services,
      modelsByService,
      configuredModelSelection,
      { service: selectedService, model: selectedModel },
    );
  }, [configuredModelSelection, modelsByService, selectedModel, selectedService, services]);

  const modelPickerStatus = useMemo(() => {
    if (services.length === 0 && servicesLoading) return "loading" as const;
    const connected = services.filter((s) => s.connected);
    if (connected.length === 0) return "no-models" as const;
    if (groupedModels.length > 0) return "ready" as const;
    if (bankModelsLoading || customModelsLoading) return "loading" as const;
    return "no-models" as const;
  }, [services, servicesLoading, groupedModels, bankModelsLoading, customModelsLoading]);

  const selectedModelLabel = useMemo(() => {
    if (!selectedModel) return "选择模型";
    const group = groupedModels.find((item) => item.service === selectedService);
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
    );
    if (nextSelection) {
      setSelectedModel(nextSelection.model, nextSelection.service);
    }
  }, [configuredModelSelection, groupedModels, selectedModel, selectedService, serviceConfigLoaded, setSelectedModel]);

  // Auto-resize textarea
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [compositionInput.value]);

  // Keep the textarea fully uncontrolled so Android IMEs own the
  // selection/caret. In particular, do not pass a changing defaultValue:
  // some Android WebViews apply it again after an IME commit and move the
  // caret to the end. Only write into the DOM when an external action
  // restores or clears a draft.
  useEffect(() => {
    const el = textareaRef.current;
    if (
      !el
      || el.value === input
      || compositionInput.isComposing
      || document.activeElement === el
    ) return;
    el.value = input;
    compositionInput.setValue(input);
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [activeSessionId, input, compositionInput.isComposing, compositionInput.setValue]);

  useAndroidImeBridge({
    textareaRef,
    sessionId: activeSessionId,
    setValue: compositionInput.setValue,
  });

  const scrollToLatest = (behavior: ScrollBehavior = "smooth") => {
    if (!scrollRef.current) return;
    scrollRef.current.scrollTo({ top: scrollRef.current.scrollHeight, behavior });
  };

  // Auto-scroll only while the reader is already near the bottom. Play sessions
  // update tool/image state frequently, so unconditional scrolling makes it
  // impossible to read older turns.
  useEffect(() => {
    if (!scrollRef.current || !autoScrollPinnedRef.current) return;
    scrollToLatest("smooth");
  }, [messages]);

  useEffect(() => {
    autoScrollPinnedRef.current = true;
    setFollowingLatest(true);
  }, [activeSessionId]);

  // Entering a book loads its latest session; book-create mode persists its orphan session in localStorage.
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      if (!activeBookId && mode === "project-chat") {
        const state = useChatStore.getState();
        const currentSession = state.activeSessionId ? state.sessions[state.activeSessionId] : null;
        if (currentSession?.bookId === null && currentSession.isDraft) {
          return;
        }
      }

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

        await createSession(activeBookId, "book");
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

      const newSessionId = await createSession(null, mode === "book-create" ? "book-create" : "chat");
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
  }, [activeBookId, activateSession, createSession, loadSessionDetail, loadSessionList, mode]);

  const onSend = (text: string) => {
    if (!activeSessionId) return;
    autoScrollPinnedRef.current = true;
    setFollowingLatest(true);
    void sendMessage(activeSessionId, text, {
      activeBookId,
      sessionKind: currentSessionKind,
      playMode,
      actionSource: "free-text",
    }).finally(() => {
      window.setTimeout(() => void refreshChapterHealth(), 250);
    });
  };

  const handleRepairDegradedChapter = async () => {
    if (!activeBookId || degradedChapter === null || repairingChapter) return;
    const confirmed = await appConfirm({
      title: `恢复第 ${degradedChapter} 章状态`,
      message: "将根据该章正文重新整理 truth/state，并解除最新章节的降级状态。正文内容不会被重写。是否继续？",
      confirmLabel: "同意恢复",
      cancelLabel: "暂不恢复",
    });
    if (!confirmed) return;
    setRepairingChapter(true);
    try {
      await sendMessage(
        activeSessionId!,
        `恢复第 ${degradedChapter} 章的降级状态，并重新整理该章 truth/state。`,
        {
          activeBookId,
          sessionKind: "book",
          actionSource: "quick-action",
          requestedIntent: "repair_state",
        },
      );
      await refreshChapterHealth();
    } finally {
      setRepairingChapter(false);
    }
  };

  const submitComposer = () => {
    const text = textareaRef.current?.value ?? compositionInput.value;
    if (!text.trim() || loading || !activeSessionId) return;
    if (textareaRef.current) {
      textareaRef.current.value = "";
      textareaRef.current.style.height = "auto";
    }
    compositionInput.setValue("");
    onSend(text);
  };

  const handleQuickAction = (command: string, requestedIntent?: "write_next") => {
    if (!activeSessionId) return;
    autoScrollPinnedRef.current = true;
    setFollowingLatest(true);
    void sendMessage(activeSessionId, command, {
      activeBookId,
      sessionKind: currentSessionKind,
      actionSource: "quick-action",
      requestedIntent,
    });
  };

  const handleProposedAction = async (details: ProposedActionDetails) => {
    // Lock the proposal card so the production action can't be re-fired.
    markProposalResolved(details.execId, "confirmed");
    const targetPlayMode = details.targetSessionKind === "play"
      ? details.actionPayload?.playStart?.mode ?? activeSession?.playMode ?? (details.action === "play_start" ? "open" : undefined)
      : undefined;
    if (details.targetRoute) {
      if (details.targetRoute === "import:fanfic") nav.toImport("fanfic");
      else if (details.targetRoute === "import:chapters") nav.toImport("chapters");
      else if (details.targetRoute === "import:canon") nav.toImport("canon");
      else if (details.targetRoute === "import:spinoff") nav.toImport("spinoff");
      else if (details.targetRoute === "import:imitation") nav.toImport("imitation");
      else if (details.targetRoute === "style") nav.toStyle();
      return;
    }
    if (details.sameSession && activeSessionId) {
      autoScrollPinnedRef.current = true;
      await sendMessage(activeSessionId, details.instruction ?? "", {
        activeBookId,
        sessionKind: details.targetSessionKind,
        playMode: targetPlayMode,
        actionSource: "button",
        requestedIntent: details.action,
        actionPayload: details.actionPayload,
      });
      return;
    }
    const targetSessionId = await createSession(null, details.targetSessionKind, targetPlayMode);
    autoScrollPinnedRef.current = true;
    await sendMessage(targetSessionId, details.instruction ?? "", {
      sessionKind: details.targetSessionKind,
      playMode: targetPlayMode,
      actionSource: "button",
      requestedIntent: details.action,
      actionPayload: details.actionPayload,
    });
  };

  const handleRejectProposedAction = async (details: ProposedActionDetails) => {
    markProposalResolved(details.execId, "rejected");
    if (!activeSessionId) return;
    autoScrollPinnedRef.current = true;
    await sendMessage(activeSessionId, `取消这次操作：${details.title ?? details.instruction}`, {
      activeBookId,
      sessionKind: currentSessionKind,
      actionSource: "button",
    });
  };

  useEffect(() => { setPlayImageError(null); }, [activeSessionId]);

  useEffect(() => {
    if (!activeSessionId || currentSessionKind !== "play") return;
    let cancelled = false;
    void fetchJson<PlayRunImagePayload>(`/play/runs/${encodeURIComponent(activeSessionId)}/main`)
      .then((payload) => {
        if (!cancelled && payload.imageSettings) setPlayImageSettings(payload.imageSettings);
      })
      .catch(() => {
        // No persisted play world yet.
      });
    void fetchJson<CoverConfigResponse>("/cover/config")
      .then((cfg) => {
        if (cancelled) return;
        const selected = cfg.service ?? null;
        setPlayImageCoverReady(
          cfg.configured ?? (!!selected && (cfg.providers ?? []).some((p) => p.service === selected && p.connected)),
        );
      })
      .catch(() => {
        if (!cancelled) setPlayImageCoverReady(false);
      });
    return () => { cancelled = true; };
  }, [activeSessionId, currentSessionKind]);

  const togglePlayImageSetting = async (key: keyof PlayImageSettings) => {
    if (!activeSessionId || currentSessionKind !== "play" || !playImageCoverReady) return;
    const next = { ...playImageSettings, [key]: !playImageSettings[key] };
    setPlayImageSettings(next);
    setPlayImageError(null);
    try {
      await fetchJson(`/play/runs/${encodeURIComponent(activeSessionId)}/main/image-settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(next),
      });
    } catch (error) {
      setPlayImageSettings(playImageSettings);
      setPlayImageError(error instanceof Error ? error.message : String(error));
    }
  };

  const emptyGuidance = (() => {
    if (currentSessionKind === "short") {
      return isZh
        ? "说一个短篇方向、标题灵感、人物压力或核心冲突，我会走 InkOS Short 生成正文、简介和封面。"
        : "Describe a short-fiction direction, title hook, pressure, or core conflict to run InkOS Short.";
    }
    if (currentSessionKind === "play") {
      return isZh
        ? "说一个可玩的世界、角色处境或开场动作，我会启动互动世界；之后你可以自由行动或点建议动作。"
        : "Describe a playable world, character situation, or opening action to start an interactive world.";
    }
    return isZh
      ? "\u544A\u8BC9\u6211\u4F60\u60F3\u5199\u4EC0\u4E48\u2014\u2014\u9898\u6750\u3001\u4E16\u754C\u89C2\u3001\u4E3B\u89D2\u3001\u6838\u5FC3\u51B2\u7A81"
      : "Tell me what you want to write \u2014 genre, world, protagonist, core conflict";
  })();

  const handlePlayModeChange = (nextMode: "guided" | "open") => {
    if (!activeSessionId || loading || playMode === nextMode) return;
    setConsumedPlayChoiceKey(null);
    setSessionPlayMode(activeSessionId, nextMode);
  };

  return (
    <div className="relative flex h-full min-w-0 flex-1 flex-col overflow-hidden">
      {playModeInfo && (
        <div className={`shrink-0 border-b border-border/45 bg-background/80 px-2.5 py-2 backdrop-blur transition-[padding] duration-200 sm:px-4 ${worldPanelInsetClass}`}>
          <div className="mx-auto flex max-w-5xl items-center gap-2 rounded-xl border border-border/45 bg-card/65 px-2.5 py-2 text-sm shadow-sm">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
              {(() => {
                const Icon = playModeInfo.Icon;
                return <Icon size={16} />;
              })()}
            </span>
            <div className="min-w-0 flex-1">
              <div className="font-medium leading-5 text-foreground">{playModeInfo.label}</div>
              <div className="hidden truncate text-xs leading-5 text-muted-foreground sm:block">{playModeInfo.detail}</div>
            </div>
            <div className="grid shrink-0 grid-cols-2 rounded-lg border border-border/50 bg-secondary/45 p-0.5">
              <button
                type="button"
                disabled={loading}
                aria-pressed={playMode === "guided"}
                onClick={() => handlePlayModeChange("guided")}
                className={`flex min-h-9 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-colors disabled:opacity-50 ${
                  playMode === "guided"
                    ? "bg-background text-primary shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                <GitBranch size={14} />
                {isZh ? "分支" : "Guided"}
              </button>
              <button
                type="button"
                disabled={loading}
                aria-pressed={playMode === "open"}
                onClick={() => handlePlayModeChange("open")}
                className={`flex min-h-9 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-colors disabled:opacity-50 ${
                  playMode === "open"
                    ? "bg-background text-primary shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                <Gamepad2 size={14} />
                {isZh ? "开放" : "Open"}
              </button>
            </div>
          </div>
        </div>
      )}
      {activeBookId && degradedChapter !== null && (
        <div className={`shrink-0 border-b border-amber-500/20 bg-amber-500/[0.06] px-2.5 py-2 sm:px-4 ${worldPanelInsetClass}`}>
          <div className="mx-auto flex max-w-5xl items-center gap-3 rounded-xl border border-amber-500/25 bg-card/80 px-3 py-2.5 shadow-sm">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-amber-500/12 text-amber-600">
              <ShieldAlert size={17} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-semibold text-foreground">最新第 {degradedChapter} 章处于降级状态</div>
              <div className="mt-0.5 text-xs leading-5 text-muted-foreground">可在当前页面恢复章节状态，不会改写正文。</div>
            </div>
            <button
              type="button"
              onClick={() => void handleRepairDegradedChapter()}
              disabled={repairingChapter || loading || !activeSessionId}
              className="inline-flex min-h-10 shrink-0 items-center gap-1.5 rounded-lg bg-amber-500 px-3 text-xs font-semibold text-white shadow-sm disabled:opacity-50"
            >
              <Wrench size={14} />
              {repairingChapter ? "恢复中" : "恢复状态"}
            </button>
          </div>
        </div>
      )}
      {/* Message scroll area */}
      <div
        ref={scrollRef}
        onScroll={(event) => {
          const target = event.currentTarget;
          const isNearBottom = isChatScrollNearBottom({
            scrollTop: target.scrollTop,
            clientHeight: target.clientHeight,
            scrollHeight: target.scrollHeight,
          });
          autoScrollPinnedRef.current = isNearBottom;
          setFollowingLatest(isNearBottom);
        }}
        className={`chat-message-scroll flex-1 overflow-y-auto [scrollbar-gutter:stable] px-2.5 py-3 transition-[padding] duration-200 sm:px-4 sm:py-6 ${worldPanelInsetClass}`}
      >
        {needsPlayModeChoice ? (
          <div className="h-full flex flex-col items-center justify-center text-center select-none gap-4">
            <div className="w-14 h-14 rounded-2xl border border-dashed border-border/80 flex items-center justify-center bg-card/45 opacity-70">
              <Gamepad2 size={24} className="text-muted-foreground" />
            </div>
            <p className="text-sm text-muted-foreground/70 max-w-md leading-7">
              {isZh ? "选个玩法，进去再聊你想玩的世界。" : "Pick a playstyle, then describe the world you want in chat."}
            </p>
            <div className="grid w-full max-w-sm grid-cols-1 gap-3 px-4 sm:grid-cols-2 sm:px-0">
              <button
                type="button"
                onClick={() => handlePlayModeChange("guided")}
                className="paper-sheet rounded-2xl px-4 py-3 text-left transition-all hover:border-primary/40 hover:bg-primary/5"
              >
                <div className="text-sm font-medium text-foreground">{isZh ? "点着玩" : "Choices"}</div>
                <div className="mt-1 text-xs leading-5 text-muted-foreground">{isZh ? "GM 给选项，点着推进" : "Pick from offered actions"}</div>
              </button>
              <button
                type="button"
                onClick={() => handlePlayModeChange("open")}
                className="paper-sheet rounded-2xl px-4 py-3 text-left transition-all hover:border-primary/40 hover:bg-primary/5"
              >
                <div className="text-sm font-medium text-foreground">{isZh ? "自由玩" : "Free"}</div>
                <div className="mt-1 text-xs leading-5 text-muted-foreground">{isZh ? "自己打字，想干嘛干嘛" : "Type anything you want"}</div>
              </button>
            </div>
          </div>
        ) : messages.length === 0 && !loading ? (
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
                    isStreaming={loading}
                    onDelete={() => void handleDeleteMessage(i, "user")}
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
                          return (
                            <ToolExecutionSteps
                              key={`x-${item.startIdx}`}
                              executions={item.parts.map(p => p.execution)}
                              onProposedAction={handleProposedAction}
                              onRejectProposedAction={handleRejectProposedAction}
                            />
                          );
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
                              onDelete={item.pi === msg.parts!.findIndex((part) => part.type === "text")
                                ? () => void handleDeleteMessage(i, "assistant")
                                : undefined}
                            />
                          );
                        }
                        return null;
                      });
                      const hasTextContent = items.some((item) => item.kind === "text" && item.part.content.trim().length > 0);
                      if (!hasTextContent && activeSessionId && !loading) {
                        rendered.push(
                          <div key="delete-tool-only-message" className="mt-2 flex justify-start">
                            <DropdownMenu>
                              <DropdownMenuTrigger
                                className="inline-flex h-10 w-10 shrink-0 touch-manipulation items-center justify-center rounded-full border border-border/35 bg-background/30 text-muted-foreground/80 transition-colors hover:border-border/60 hover:bg-muted/60 hover:text-foreground"
                                aria-label="AI 工具消息操作"
                                title="消息操作"
                              >
                                <MoreHorizontal size={16} />
                              </DropdownMenuTrigger>
                              <DropdownMenuContent side="right" align="start" className="w-36 rounded-2xl border-border/60 bg-popover/95 p-1.5 shadow-xl shadow-primary/10 backdrop-blur">
                                <DropdownMenuItem
                                  variant="destructive"
                                  onClick={() => window.setTimeout(() => void handleDeleteMessage(i, "assistant"), 0)}
                                  className="min-h-10 rounded-xl px-3"
                                >
                                  <Trash2 size={14} />
                                  <span>删除消息</span>
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
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
                    isStreaming={loading && i === messages.length - 1}
                    onDelete={msg.role === "assistant" || msg.role === "user"
                      ? () => void handleDeleteMessage(i, msg.role)
                      : undefined}
                  />
                )}
              </div>
            ))}

            {/* Play turns always keep a visible generation state. Partial text above
                continues streaming while this status confirms the world is still working. */}
            {loading && (currentSessionKind === "play" || !isStreaming) && (
              <Message from="assistant">
                <MessageContent>
                  <div className="flex flex-wrap items-center gap-3">
                    <div className="flex gap-1">
                      <span className="h-2 w-2 animate-bounce rounded-full bg-primary/60" style={{ animationDelay: "0ms" }} />
                      <span className="h-2 w-2 animate-bounce rounded-full bg-primary/60" style={{ animationDelay: "150ms" }} />
                      <span className="h-2 w-2 animate-bounce rounded-full bg-primary/60" style={{ animationDelay: "300ms" }} />
                    </div>
                    <Shimmer className="text-sm" duration={1.5}>
                      {currentSessionKind === "play"
                        ? playMode === "guided"
                          ? (isZh ? "世界正在生成回应与下一步选项..." : "The world is generating a response and choices...")
                          : (isZh ? "世界正在根据你的行动继续演化..." : "The world is evolving from your action...")
                        : (isZh ? "AI 正在思考，即将开始写作..." : "AI is thinking, writing begins shortly...")}
                    </Shimmer>
                    {activeTokenLabel ? (
                      <span className="rounded-full border border-border/45 bg-background/45 px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                        {activeTokenLabel}
                      </span>
                    ) : null}
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
              autoScrollPinnedRef.current = true;
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
      {hasBook && !showChoicePanel && (
        <div className={`shrink-0 transition-[padding] duration-200 ${worldPanelInsetClass}`}>
          <div className="mx-auto w-full max-w-5xl px-2.5 sm:px-4">
            <QuickActions
              onAction={handleQuickAction}
              disabled={loading || !activeSessionId}
              isZh={isZh}
            />
          </div>
        </div>
      )}

      {/* Play choices are shortcuts, not a replacement for free actions. Scene
          images render inside their corresponding chat result card so the
          visual history scrolls with the conversation. */}
      {currentSessionKind === "play" && !needsPlayModeChoice && showChoicePanel && (
        <div className={`shrink-0 transition-[padding] duration-200 ${worldPanelInsetClass}`}>
          <PlayChoicePanel
            choices={playChoices}
            disabled={loading || !activeSessionId}
            isZh={isZh}
            onChoose={(action) => {
              if (!activeSessionId || !playChoiceSet) return;
              setConsumedPlayChoiceKey(playChoiceSet.key);
              autoScrollPinnedRef.current = true;
              void sendMessage(activeSessionId, action, { activeBookId, sessionKind: "play", playMode, actionSource: "button" });
            }}
          />
        </div>
      )}
      {needsPlayModeChoice ? null : (
      <div className={`relative z-30 shrink-0 border-t border-border/45 px-2.5 py-2 claude-topbar mobile-safe-bottom transition-[padding] duration-200 sm:px-4 sm:py-4 ${worldPanelInsetClass}`}>
        <div className="mx-auto max-w-5xl">
          <div className="flex items-start gap-2">
            <div className="claude-composer flex-1 rounded-[1.15rem] transition-all sm:rounded-2xl">
              <div
                className="flex items-end gap-2 px-3 py-2.5"
                onClick={(event) => {
                  if (
                    event.target instanceof HTMLButtonElement
                    || event.target instanceof HTMLTextAreaElement
                  ) return;
                  textareaRef.current?.focus();
                }}
              >
                <textarea
                  key={activeSessionId ?? "no-session"}
                  ref={textareaRef}
                  onChange={compositionInput.handleChange}
                  onInput={compositionInput.handleInput}
                  onCompositionStart={compositionInput.handleCompositionStart}
                  onCompositionEnd={compositionInput.handleCompositionEnd}
                  onKeyDown={(e) => {
                    const nativeEvent = e.nativeEvent as KeyboardEvent & { isComposing?: boolean; keyCode?: number };
                    if (e.key === "Enter" && !e.shiftKey && !compositionInput.isComposing && !nativeEvent.isComposing && nativeEvent.keyCode !== 229) {
                      e.preventDefault();
                      submitComposer();
                    }
                  }}
                  placeholder={currentSessionKind === "play"
                    ? playMode === "guided"
                      ? (isZh ? "输入行动，或点上方选项推进..." : "Type an action, or choose above...")
                      : (isZh ? "自由输入你要做的行动..." : "Type any action you want...")
                    : isZh ? "输入消息..." : "Message InkOS..."}
                  disabled={!activeSessionId}
                  rows={1}
                  className="max-h-[40dvh] min-h-11 flex-1 resize-none overflow-y-auto whitespace-pre-wrap break-words border-none! bg-transparent px-0 py-2 text-base leading-6 shadow-none outline-none! ring-0! placeholder:text-muted-foreground/60 focus:border-none! focus:outline-none! focus:ring-0! disabled:opacity-50 sm:max-h-[200px] sm:min-h-0 sm:text-sm"
                />
                <button
                  type="button"
                  onClick={() => {
                    if (loading) {
                      if (activeSessionId) void cancelMessage(activeSessionId);
                      return;
                    }
                    submitComposer();
                  }}
                  disabled={(!compositionInput.value.trim() && !loading) || !activeSessionId}
                  aria-label={loading ? (isZh ? "停止生成" : "Stop generation") : (isZh ? "发送消息" : "Send message")}
                  className="relative z-10 flex h-11 w-11 shrink-0 touch-manipulation items-center justify-center rounded-2xl bg-primary text-primary-foreground shadow-sm shadow-primary/20 transition-all hover:scale-105 active:scale-95 disabled:scale-100 disabled:opacity-35 sm:h-8 sm:w-8 sm:rounded-xl"
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
                <div className="ml-auto flex items-center gap-2">
                  {tokenSavingsLabel && (
                    <span className="rounded-full border border-emerald-500/25 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-600 dark:text-emerald-400">
                      {tokenSavingsLabel}
                    </span>
                  )}
                  {currentSessionKind === "play" && (
                    <button
                      type="button"
                      onClick={() => setWorldPanelOpen((v) => !v)}
                      className={`flex items-center justify-center h-8 w-8 shrink-0 rounded-full transition-all shadow-sm ${worldPanelOpen ? "bg-primary text-primary-foreground scale-105" : "bg-secondary text-muted-foreground hover:bg-muted hover:text-primary"}`}
                      title={isZh ? "查看世界：持有 / 状态 / 关系" : "View world: holdings / state / relations"}
                    >
                      <Gamepad2 size={15} />
                    </button>
                  )}
                </div>
              </div>
            </div>
            {currentSessionKind === "play" ? (
              <div className="relative mt-1 shrink-0">
                <button
                  type="button"
                  onClick={() => setPlayImageMenuOpen((value) => !value)}
                  disabled={loading || !activeSessionId}
                  title={isZh ? "自动配图" : "Auto illustration"}
                  className={`flex h-10 w-10 items-center justify-center rounded-xl border border-border/50 bg-secondary/40 shadow-sm transition-all hover:border-primary/50 hover:bg-primary/10 hover:text-primary active:scale-95 disabled:cursor-not-allowed disabled:opacity-30 ${playImageMenuOpen || playImageSettings.actors || playImageSettings.moments || playImageSettings.inventory ? "text-primary" : "text-muted-foreground"}`}
                  aria-label={isZh ? "自动配图" : "Auto illustration"}
                >
                  <Palette size={17} />
                </button>
                {playImageMenuOpen ? (
                  <div className="absolute bottom-12 right-0 z-30 w-44 rounded-xl border border-border/50 bg-card/95 p-2 shadow-xl backdrop-blur">
                    <div className="mb-1.5 px-1 text-[12px] leading-5 font-semibold uppercase tracking-wider text-muted-foreground/60">
                      {isZh ? "自动配图" : "Auto illustration"}
                    </div>
                    {(["actors", "moments", "inventory"] as const).map((key) => (
                      <label
                        key={key}
                        className={`flex items-center gap-2 rounded-lg px-2 py-1.5 text-[14px] leading-6 ${playImageCoverReady ? "cursor-pointer text-foreground hover:bg-secondary/50" : "cursor-not-allowed text-muted-foreground/40"}`}
                        title={playImageCoverReady ? undefined : (isZh ? "先在「模型配置」里配好生图 API 才能开启" : "Configure an image API in Model Settings first")}
                      >
                        <input
                          type="checkbox"
                          disabled={!playImageCoverReady}
                          checked={playImageCoverReady && playImageSettings[key]}
                          onChange={() => void togglePlayImageSetting(key)}
                          className="h-4 w-4 accent-primary"
                        />
                        {key === "actors"
                          ? (isZh ? "为角色配图" : "Characters")
                          : key === "moments"
                            ? (isZh ? "为时刻配图" : "Moments")
                            : (isZh ? "为背包配图" : "Inventory")}
                      </label>
                    ))}
                    {!playImageCoverReady ? (
                      <p className="mt-1 px-1 text-[12px] leading-5 text-muted-foreground/50">
                        {isZh ? "未检测到生图 API。" : "No image API configured."}
                      </p>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
          {playImageError ? (
            <p className="mt-2 text-right text-[13px] leading-5 text-destructive/80">
              {isZh ? `配图失败：${playImageError}` : `Image failed: ${playImageError}`}
            </p>
          ) : null}
        </div>
      </div>
      )}

      {currentSessionKind === "play" && activeSessionId && (
        <PlayHud
          sessionId={activeSessionId}
          isStreaming={loading}
          isZh={isZh}
          open={worldPanelOpen}
          onClose={() => setWorldPanelOpen(false)}
          imageSettings={playImageSettings}
          sessionTitle={activeSession?.title ?? null}
        />
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
          onChange={(e) => setSearch(e.target.value)}
          placeholder="搜索模型..."
          className="w-full rounded-xl bg-secondary/30 px-3 py-2 text-sm outline-none placeholder:text-muted-foreground/40"
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        />
      </div>
      <div className="flex-1 overflow-y-auto py-1.5">
        {filtered.map((group) => (
          <div key={group.service} className="py-1">
            <div className="px-2 py-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              {group.label}
            </div>
            {group.models.map((m) => {
              const isSelected = selectedModel === m.id && selectedService === group.service;
              return (
                <DropdownMenuItem
                  key={`${group.service}:${m.id}`}
                  onClick={() => onSelect(m.id, group.service)}
                  className={`rounded-xl text-sm ${isSelected ? "bg-muted/50" : ""}`}
                >
                  <div className="flex flex-1 items-center justify-between">
                    <span className="text-sm">{m.name ?? m.id}</span>
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
        <DropdownMenuItem onClick={onManage} className="text-primary">
          管理服务商
        </DropdownMenuItem>
      </div>
    </DropdownMenuContent>
  );
}
