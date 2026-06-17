import type { StateCreator } from "zustand";
import type { ChatStore, MessageActions, MessagePart, PipelineStage, TokenUsageSnapshot, ToolExecution } from "../../types";
import { shouldRefreshSidebarForTool } from "../../message-policy";
import {
  deriveFlat,
  extractToolDetails,
  extractToolError,
  findRunningToolPart,
  getOrCreateStream,
  replaceLast,
  resolveToolLabel,
  sessionMatchesEvent,
  summarizeResult,
  updateSession,
} from "./runtime";

type SliceSet = Parameters<StateCreator<ChatStore, [], [], MessageActions>>[0];
type SliceGet = Parameters<StateCreator<ChatStore, [], [], MessageActions>>[1];

type ContextCompressionCategory = "session_context" | "story_context";
type ContextCompressionPhase = "start" | "end" | "error";

function estimateTokensFromChars(totalChars: number, chineseChars: number): number {
  const total = Math.max(0, totalChars);
  const chinese = Math.max(0, Math.min(total, chineseChars));
  const nonChinese = Math.max(0, total - chinese);
  return Math.max(0, Math.ceil(chinese + nonChinese / 4));
}

interface ContextCompressionEventPayload {
  readonly sessionId?: string;
  readonly category?: ContextCompressionCategory;
  readonly phase?: ContextCompressionPhase;
  readonly message?: string;
  readonly protectedTokens?: number;
  readonly compressibleTokens?: number;
  readonly budgetTokens?: number;
  readonly sources?: readonly string[];
}

interface AttachSessionStreamListenersInput {
  sessionId: string;
  streamTs: number;
  streamEs: EventSource;
  set: SliceSet;
  get: SliceGet;
}

function readTokenUsage(value: unknown): TokenUsageSnapshot | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const promptTokens = typeof record.promptTokens === "number"
    ? record.promptTokens
    : typeof record.input === "number" ? record.input : undefined;
  const completionTokens = typeof record.completionTokens === "number"
    ? record.completionTokens
    : typeof record.output === "number" ? record.output : undefined;
  const totalTokens = typeof record.totalTokens === "number"
    ? record.totalTokens
    : (promptTokens ?? 0) + (completionTokens ?? 0);
  if (totalTokens <= 0) return undefined;
  return {
    ...(promptTokens !== undefined ? { promptTokens } : {}),
    ...(completionTokens !== undefined ? { completionTokens } : {}),
    totalTokens,
    estimated: false,
    source: "final",
    updatedAt: Date.now(),
  };
}

function extractTokenUsage(result: unknown): TokenUsageSnapshot | undefined {
  const direct = readTokenUsage(result);
  if (direct) return direct;
  if (!result || typeof result !== "object") return undefined;
  const record = result as Record<string, unknown>;
  return readTokenUsage(record.tokenUsage) ?? readTokenUsage((record.details as Record<string, unknown> | undefined)?.tokenUsage);
}

function accumulateStreamTokenUsage(
  previous: TokenUsageSnapshot | undefined,
  currentCallTokens: number,
  status: unknown,
): TokenUsageSnapshot {
  const normalizedStatus = typeof status === "string" && status.trim() ? status.trim() : "streaming";
  const previousAccumulated = previous?.streamAccumulatedTokens ?? 0;
  const previousCall = previous?.streamCallTokens ?? 0;
  const previousStatus = previous?.streamLastStatus;
  let accumulated = previousAccumulated;
  let callTokens = Math.max(0, currentCallTokens);

  if (normalizedStatus === "done" || normalizedStatus === "completed") {
    if (previousStatus !== "done" && previousStatus !== "completed") {
      accumulated += Math.max(previousCall, callTokens);
    } else {
      accumulated = Math.max(accumulated, previous?.totalTokens ?? 0);
    }
    callTokens = 0;
  } else if (previousStatus !== "done" && previousStatus !== "completed" && callTokens < previousCall) {
    accumulated += previousCall;
  }

  const totalTokens = Math.max(0, accumulated + callTokens);
  return {
    completionTokens: totalTokens,
    totalTokens,
    estimated: true,
    source: "stream",
    updatedAt: Date.now(),
    streamCallTokens: callTokens,
    streamAccumulatedTokens: accumulated,
    streamLastStatus: normalizedStatus,
  };
}

function mergeFinalTokenUsage(
  previous: TokenUsageSnapshot | undefined,
  finalUsage: TokenUsageSnapshot | undefined,
): TokenUsageSnapshot | undefined {
  if (!finalUsage) return previous;
  if (!previous || finalUsage.totalTokens >= previous.totalTokens) return finalUsage;
  return {
    ...previous,
    source: previous.source ?? "stream",
    updatedAt: Date.now(),
  };
}

function sumTokenUsages(executions: ReadonlyArray<{ tokenUsage?: TokenUsageSnapshot }>): TokenUsageSnapshot | undefined {
  let totalTokens = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  let hasPrompt = false;
  let hasCompletion = false;
  let estimated = false;

  for (const execution of executions) {
    const usage = execution.tokenUsage;
    if (!usage || usage.totalTokens <= 0) continue;
    totalTokens += usage.totalTokens;
    if (usage.promptTokens) {
      promptTokens += usage.promptTokens;
      hasPrompt = true;
    }
    if (usage.completionTokens) {
      completionTokens += usage.completionTokens;
      hasCompletion = true;
    }
    estimated ||= !!usage.estimated;
  }

  if (totalTokens <= 0) return undefined;
  return {
    ...(hasPrompt ? { promptTokens } : {}),
    ...(hasCompletion ? { completionTokens } : {}),
    totalTokens,
    estimated,
    source: estimated ? "stream" : "final",
    updatedAt: Date.now(),
  };
}

function normalizeStageLabel(label: string): string {
  return label
    .replace(/^\[[^\]]+\]\s*/, "")
    .replace(/^(阶段|Stage)\s*[：:]\s*/i, "")
    .replace(/[。.!！\s]+$/g, "")
    .trim();
}

function extractStageLabelFromLog(message: string): string | null {
  const match = message.match(/(?:阶段|Stage)\s*[：:]\s*(.+)$/i);
  if (!match?.[1]) return null;
  const label = normalizeStageLabel(match[1]);
  return label || null;
}

function stageMatchScore(stageLabel: string, incomingLabel: string): number {
  const stage = normalizeStageLabel(stageLabel);
  const incoming = normalizeStageLabel(incomingLabel);
  if (!stage || !incoming) return 0;
  if (stage === incoming) return 100;
  if (stage.includes(incoming) || incoming.includes(stage)) return 80;
  const keywordGroups = [
    ["准备", "输入"],
    ["撰写", "草稿", "正文", "创作"],
    ["落盘", "保存", "章节"],
    ["真相", "truth"],
    ["校验", "审计", "检查"],
    ["同步", "记忆", "索引"],
    ["导出", "文件"],
    ["封面", "图片"],
    ["市场", "雷达"],
  ];
  let score = 0;
  for (const keywords of keywordGroups) {
    const stageHits = keywords.filter((keyword) => stage.includes(keyword)).length;
    const incomingHits = keywords.filter((keyword) => incoming.includes(keyword)).length;
    if (stageHits > 0 && incomingHits > 0) score += Math.min(stageHits, incomingHits) * 10;
  }
  return score;
}

function advanceStagesFromLog(stages: PipelineStage[] | undefined, message: string): PipelineStage[] | undefined {
  if (!stages || stages.length === 0) return stages;
  const stageLabel = extractStageLabelFromLog(message);
  if (!stageLabel) return stages;
  let bestIndex = -1;
  let bestScore = 0;
  stages.forEach((stage, index) => {
    const score = stageMatchScore(stage.label, stageLabel);
    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  });
  if (bestIndex < 0 || bestScore <= 0) return stages;
  return stages.map((stage, index) => {
    if (index < bestIndex) return { ...stage, status: "completed" as const, progress: undefined };
    if (index === bestIndex) return { ...stage, status: "active" as const };
    return stage.status === "completed" ? stage : { ...stage, status: "pending" as const, progress: undefined };
  });
}

function updateActiveStageProgress(
  stages: PipelineStage[] | undefined,
  progress: NonNullable<PipelineStage["progress"]>,
): PipelineStage[] | undefined {
  if (!stages || stages.length === 0) return stages;
  const activeIndex = stages.findIndex((stage) => stage.status === "active");
  const targetIndex = activeIndex >= 0 ? activeIndex : stages.findIndex((stage) => stage.status !== "completed");
  if (targetIndex < 0) return stages;
  return stages.map((stage, index) => {
    if (index < targetIndex) return { ...stage, status: "completed" as const, progress: undefined };
    if (index === targetIndex) return { ...stage, status: "active" as const, progress };
    return stage;
  });
}

function settleStagesAfterError(stages: PipelineStage[] | undefined): PipelineStage[] | undefined {
  if (!stages || stages.length === 0) return stages;
  return stages.map((stage) => ({
    ...stage,
    status: stage.status === "completed" ? stage.status : "completed",
    progress: undefined,
  }));
}

function createTextDeltaBatcher(apply: (text: string) => void): { push: (text: string) => void; flush: () => void } {
  const isSmallTouchDevice = typeof window !== "undefined"
    && (window.innerWidth <= 700 || navigator.maxTouchPoints > 0);
  const maxBufferedChars = isSmallTouchDevice ? 600 : 240;
  const flushDelayMs = isSmallTouchDevice ? 180 : 80;
  let buffer = "";
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    const text = buffer;
    buffer = "";
    if (text) apply(text);
  };
  return {
    push: (text) => {
      buffer += text;
      if (buffer.length >= maxBufferedChars) {
        flush();
        return;
      }
      if (!timer) timer = setTimeout(flush, flushDelayMs);
    },
    flush,
  };
}

function appendBoundedText(existing: string | undefined, incoming: string, maxChars: number): string {
  const next = `${existing ?? ""}${incoming}`;
  if (next.length <= maxChars) return next;
  return next.slice(-maxChars);
}

export function attachSessionStreamListeners({
  sessionId,
  streamTs,
  streamEs,
  set,
  get,
}: AttachSessionStreamListenersInput): void {
  const applyThinkingDelta = (text: string) => {
    set((state) => ({
      sessions: updateSession(state.sessions, sessionId, (runtime) => {
        const [messages, stream] = getOrCreateStream(runtime.messages, streamTs);
        const parts = [...(stream.parts ?? [])];
        const last = parts[parts.length - 1];
        if (last?.type === "thinking") {
          parts[parts.length - 1] = { ...last, content: last.content + text };
        }
        const flat = deriveFlat(parts);
        return { messages: replaceLast(messages, { ...stream, ...flat, parts }) };
      }),
    }));
  };
  const applyDraftDelta = (text: string) => {
    set((state) => ({
      sessions: updateSession(state.sessions, sessionId, (runtime) => {
        const [messages, stream] = getOrCreateStream(runtime.messages, streamTs);
        const parts = [...(stream.parts ?? [])];
        const runningTool = findRunningToolPart(parts);
        if (runningTool) {
          const nextParts = parts.map((part) => {
            if (part.type !== "tool" || part.execution.id !== runningTool.execution.id) return part;
            return {
              type: "tool" as const,
              execution: {
                ...part.execution,
                streamingText: appendBoundedText(part.execution.streamingText, text, 50_000),
              },
            };
          });
          const flat = deriveFlat(nextParts);
          return { messages: replaceLast(messages, { ...stream, ...flat, parts: nextParts }) };
        }
        const last = parts[parts.length - 1];
        if (last?.type === "text") {
          parts[parts.length - 1] = { ...last, content: last.content + text };
        } else {
          parts.push({ type: "text", content: text });
        }
        const flat = deriveFlat(parts);
        return { messages: replaceLast(messages, { ...stream, ...flat, parts }) };
      }),
    }));
  };
  const applyWriteDelta = (text: string) => {
    set((state) => ({
      sessions: updateSession(state.sessions, sessionId, (runtime) => {
        const [messages, stream] = getOrCreateStream(runtime.messages, streamTs);
        const runningTool = findRunningToolPart([...(stream.parts ?? [])]);
        if (!runningTool) return {};
        const parts = (stream.parts ?? []).map((part) => {
          if (part.type !== "tool" || part.execution.id !== runningTool.execution.id) return part;
          return {
            type: "tool" as const,
            execution: {
              ...part.execution,
              streamingText: appendBoundedText(part.execution.streamingText, text, 50_000),
            },
          };
        });
        const flat = deriveFlat(parts);
        return { messages: replaceLast(messages, { ...stream, ...flat, parts }) };
      }),
    }));
  };
  const thinkingBatch = createTextDeltaBatcher(applyThinkingDelta);
  const draftBatch = createTextDeltaBatcher(applyDraftDelta);
  const writeBatch = createTextDeltaBatcher(applyWriteDelta);
  const flushTextBatches = () => {
    thinkingBatch.flush();
    draftBatch.flush();
    writeBatch.flush();
  };

  streamEs.addEventListener("thinking:start", (event: MessageEvent) => {
    try {
      const data = event.data ? JSON.parse(event.data) : null;
      if (!sessionMatchesEvent(sessionId, data)) return;
      set((state) => ({
        sessions: updateSession(state.sessions, sessionId, (runtime) => {
          const [messages, stream] = getOrCreateStream(runtime.messages, streamTs);
          const parts = [...(stream.parts ?? []), { type: "thinking" as const, content: "", streaming: true }];
          const flat = deriveFlat(parts);
          return { messages: replaceLast(messages, { ...stream, ...flat, parts }) };
        }),
      }));
    } catch {
      // ignore
    }
  });

  streamEs.addEventListener("thinking:delta", (event: MessageEvent) => {
    try {
      const data = event.data ? JSON.parse(event.data) : null;
      if (!sessionMatchesEvent(sessionId, data) || !data?.text) return;
      thinkingBatch.push(String(data.text));
    } catch {
      // ignore
    }
  });

  streamEs.addEventListener("thinking:end", (event: MessageEvent) => {
    try {
      const data = event.data ? JSON.parse(event.data) : null;
      if (!sessionMatchesEvent(sessionId, data)) return;
      flushTextBatches();
      set((state) => ({
        sessions: updateSession(state.sessions, sessionId, (runtime) => {
          const [messages, stream] = getOrCreateStream(runtime.messages, streamTs);
          const parts = [...(stream.parts ?? [])];
          const last = parts[parts.length - 1];
          if (last?.type === "thinking") {
            parts[parts.length - 1] = { ...last, streaming: false };
          }
          const flat = deriveFlat(parts);
          return { messages: replaceLast(messages, { ...stream, ...flat, parts }) };
        }),
      }));
    } catch {
      // ignore
    }
  });

  streamEs.addEventListener("draft:delta", (event: MessageEvent) => {
    try {
      const data = event.data ? JSON.parse(event.data) : null;
      if (!sessionMatchesEvent(sessionId, data) || !data?.text) return;
      draftBatch.push(String(data.text));
    } catch {
      // ignore
    }
  });

  streamEs.addEventListener("write:delta", (event: MessageEvent) => {
    try {
      const data = event.data ? JSON.parse(event.data) : null;
      if (!sessionMatchesEvent(sessionId, data) || !data?.text) return;
      writeBatch.push(String(data.text));
    } catch {
      // ignore
    }
  });

  streamEs.addEventListener("llm:delta", (event: MessageEvent) => {
    try {
      const data = event.data ? JSON.parse(event.data) : null;
      if (!sessionMatchesEvent(sessionId, data) || !data?.text) return;
      const current = get().sessions[sessionId]?.messages.find((message) => message.timestamp === streamTs);
      const runningTool = current?.parts ? findRunningToolPart([...(current.parts ?? [])]) : undefined;
      if (runningTool) {
        writeBatch.push(String(data.text));
      } else {
        draftBatch.push(String(data.text));
      }
    } catch {
      // ignore
    }
  });

  streamEs.addEventListener("tool:start", (event: MessageEvent) => {
    try {
      const data = event.data ? JSON.parse(event.data) : null;
      if (!sessionMatchesEvent(sessionId, data) || !data?.tool) return;
      flushTextBatches();
      set((state) => ({
        sessions: updateSession(state.sessions, sessionId, (runtime) => {
          const [messages, stream] = getOrCreateStream(runtime.messages, streamTs);
          const parts = [...(stream.parts ?? [])];

          if (data.tool === "sub_agent") {
            const last = parts[parts.length - 1];
            if (last?.type === "text" && last.content) {
              parts.pop();
              const prev = parts[parts.length - 1];
              if (prev?.type === "thinking") {
                parts[parts.length - 1] = {
                  ...prev,
                  content: prev.content + (prev.content ? "\n\n" : "") + last.content,
                };
              } else {
                parts.push({ type: "thinking", content: last.content, streaming: false });
              }
            }
          }

          const agent = data.tool === "sub_agent" ? (data.args?.agent as string | undefined) : undefined;
          const stages: PipelineStage[] | undefined = Array.isArray(data.stages) && data.stages.length > 0
            ? (data.stages as string[]).map((label) => ({ label, status: "pending" as const }))
            : undefined;

          parts.push({
            type: "tool",
            execution: {
              id: data.id as string,
              tool: data.tool as string,
              agent,
              label: resolveToolLabel(data.tool as string, agent),
              status: "running",
              args: data.args as Record<string, unknown> | undefined,
              stages,
              startedAt: Date.now(),
            },
          });

          const flat = deriveFlat(parts);
          return { messages: replaceLast(messages, { ...stream, ...flat, parts, tokenUsage: undefined }) };
        }),
      }));
    } catch {
      // ignore
    }
  });

  streamEs.addEventListener("tool:end", (event: MessageEvent) => {
    try {
      const data = event.data ? JSON.parse(event.data) : null;
      if (!sessionMatchesEvent(sessionId, data) || !data?.tool) return;
      flushTextBatches();
      set((state) => ({
        sessions: updateSession(state.sessions, sessionId, (runtime) => {
          const [messages, stream] = getOrCreateStream(runtime.messages, streamTs);
          const parts = (stream.parts ?? []).map((part) => {
            if (part.type !== "tool" || part.execution.id !== data.id) return part;
            const execution = { ...part.execution };
            execution.status = data.isError ? "error" : "completed";
            execution.completedAt = Date.now();
            execution.stages = data.isError
              ? settleStagesAfterError(execution.stages)
              : execution.stages?.map((stage) =>
                  stage.status !== "completed"
                    ? { ...stage, status: "completed" as const, progress: undefined }
                    : stage,
                );
            if (data.isError) execution.error = extractToolError(data.result);
            else execution.result = summarizeResult(data.result);
            execution.tokenUsage = mergeFinalTokenUsage(execution.tokenUsage, extractTokenUsage(data.result));
            const details = data.details ?? extractToolDetails(data.result);
            if (details !== undefined) execution.details = details;
            return { type: "tool" as const, execution };
          });
          const flat = deriveFlat(parts);
          const tokenUsage = sumTokenUsages(flat.toolExecutions ?? []);
          return { messages: replaceLast(messages, { ...stream, ...flat, parts, tokenUsage }) };
        }),
      }));

      if (shouldRefreshSidebarForTool(data.tool as string)) {
        get().bumpBookDataVersion();
      }
    } catch {
      // ignore
    }
  });

  streamEs.addEventListener("tool:update", (event: MessageEvent) => {
    try {
      const data = event.data ? JSON.parse(event.data) : null;
      if (!sessionMatchesEvent(sessionId, data) || !data?.tool) return;
      flushTextBatches();
      const updateText = summarizeResult(data.partialResult);
      if (!updateText) return;
      const partialDetails = extractToolDetails(data.partialResult);
      const isPlayScenePreview = (
        data.tool === "play_start"
        || data.tool === "play_step"
        || data.tool === "play_revise"
      ) && partialDetails && typeof partialDetails === "object"
        && (partialDetails as Record<string, unknown>).kind === "play_scene_preview";
      set((state) => ({
        sessions: updateSession(state.sessions, sessionId, (runtime) => {
          const [messages, stream] = getOrCreateStream(runtime.messages, streamTs);
          const runningTool = findRunningToolPart([...(stream.parts ?? [])]);
          const parts = (stream.parts ?? []).map((part) => {
            if (part.type !== "tool") return part;
            const matchesId = typeof data.id === "string" && part.execution.id === data.id;
            const matchesRunningTool = !data.id && part.execution.id === runningTool?.execution.id;
            if (!matchesId && !matchesRunningTool) return part;
            return {
              type: "tool" as const,
              execution: {
                ...part.execution,
                status: "processing" as const,
                ...(isPlayScenePreview
                  ? { streamingText: updateText }
                  : { logs: [...(part.execution.logs ?? []), updateText].slice(-40) }),
                stages: advanceStagesFromLog(part.execution.stages, updateText),
              },
            };
          });
          const flat = deriveFlat(parts);
          return { messages: replaceLast(messages, { ...stream, ...flat, parts }) };
        }),
      }));
    } catch {
      // ignore
    }
  });

  streamEs.addEventListener("agent:error", (event: MessageEvent) => {
    try {
      const data = event.data ? JSON.parse(event.data) : null;
      if (!sessionMatchesEvent(sessionId, data)) return;
      flushTextBatches();
      const error = typeof data?.error === "string" && data.error.trim()
        ? data.error.trim()
        : "用户已停止当前生成。";
      set((state) => ({
        sessions: updateSession(state.sessions, sessionId, (runtime) => {
          const [messages, stream] = getOrCreateStream(runtime.messages, streamTs);
          const parts = (stream.parts ?? []).map((part) => {
            if (part.type !== "tool") return part;
            if (part.execution.status !== "running" && part.execution.status !== "processing") return part;
            return {
              type: "tool" as const,
              execution: {
                ...part.execution,
                status: "error" as const,
                error,
                completedAt: Date.now(),
                stages: settleStagesAfterError(part.execution.stages),
              },
            };
          });
          const flat = deriveFlat(parts);
          const tokenUsage = sumTokenUsages(flat.toolExecutions ?? []) ?? stream.tokenUsage;
          return {
            messages: replaceLast(messages, { ...stream, ...flat, parts, tokenUsage }),
            isStreaming: false,
            stream: null,
            abortController: null,
            lastError: null,
          };
        }),
      }));
    } catch {
      // ignore
    }
  });

  streamEs.addEventListener("log", (event: MessageEvent) => {
    try {
      const data = event.data ? JSON.parse(event.data) : null;
      if (!sessionMatchesEvent(sessionId, data)) return;
      flushTextBatches();
      const message = data?.message as string | undefined;
      if (!message) return;
      set((state) => ({
        sessions: updateSession(state.sessions, sessionId, (runtime) => {
          const [messages, stream] = getOrCreateStream(runtime.messages, streamTs);
          const runningTool = findRunningToolPart([...(stream.parts ?? [])]);
          if (!runningTool) return {};
          const parts = (stream.parts ?? []).map((part) => {
            if (part.type !== "tool" || part.execution.id !== runningTool.execution.id) return part;
            return {
              type: "tool" as const,
              execution: {
                ...part.execution,
                logs: [...(part.execution.logs ?? []), message].slice(-40),
                stages: advanceStagesFromLog(part.execution.stages, message),
              },
            };
          });
          const flat = deriveFlat(parts);
          return { messages: replaceLast(messages, { ...stream, ...flat, parts }) };
        }),
      }));
    } catch {
      // ignore
    }
  });

  streamEs.addEventListener("llm:progress", (event: MessageEvent) => {
    try {
      const data = event.data ? JSON.parse(event.data) : null;
      if (!sessionMatchesEvent(sessionId, data)) return;
      flushTextBatches();
      const estimatedTokens = estimateTokensFromChars(data?.totalChars, data?.chineseChars);
      set((state) => ({
        sessions: updateSession(state.sessions, sessionId, (runtime) => {
          const [messages, stream] = getOrCreateStream(runtime.messages, streamTs);
          const runningTool = findRunningToolPart([...(stream.parts ?? [])]);
          let messageTokenUsage = runningTool
            ? stream.tokenUsage
            : estimatedTokens > 0 || stream.tokenUsage
              ? accumulateStreamTokenUsage(stream.tokenUsage, estimatedTokens, data?.status)
              : undefined;
          const parts = (stream.parts ?? []).map((part) => {
            if (part.type !== "tool" || part.execution.id !== runningTool?.execution.id) return part;
            const tokenUsage = estimatedTokens > 0 || part.execution.tokenUsage
              ? accumulateStreamTokenUsage(part.execution.tokenUsage, estimatedTokens, data?.status)
              : undefined;
            return {
              type: "tool" as const,
              execution: {
                ...part.execution,
                ...(tokenUsage ? { tokenUsage } : {}),
                stages: updateActiveStageProgress(part.execution.stages, {
                  status: data.status,
                  elapsedMs: data.elapsedMs,
                  totalChars: data.totalChars,
                  chineseChars: data.chineseChars,
                  estimatedTokens,
                }),
              },
            };
          });
          const flat = deriveFlat(parts);
          messageTokenUsage = sumTokenUsages(flat.toolExecutions ?? []) ?? messageTokenUsage;
          return { messages: replaceLast(messages, { ...stream, ...flat, tokenUsage: messageTokenUsage, parts }) };
        }),
      }));
    } catch {
      // ignore
    }
  });

  streamEs.addEventListener("context:compression", (event: MessageEvent) => {
    try {
      const data = event.data ? JSON.parse(event.data) as ContextCompressionEventPayload : null;
      if (!sessionMatchesEvent(sessionId, data) || !data?.category || !data.phase) return;
      flushTextBatches();
      const category = data.category;
      const phase = data.phase;
      set((state) => ({
        sessions: updateSession(state.sessions, sessionId, (runtime) => {
          const [messages, stream] = getOrCreateStream(runtime.messages, streamTs);
          const parts = [...(stream.parts ?? [])];
          applyContextCompressionToParts(parts, category, phase, data);
          const flat = deriveFlat(parts);
          return { messages: replaceLast(messages, { ...stream, ...flat, parts }) };
        }),
      }));
    } catch {
      // ignore
    }
  });

  streamEs.addEventListener("result", () => {
    flushTextBatches();
  });
}

function compressionLabel(category: ContextCompressionCategory): string {
  return category === "session_context" ? "整理会话记忆" : "压缩故事上下文";
}

function compressionSourceSummary(sources: readonly string[] | undefined): string {
  if (!sources || sources.length === 0) return "";
  const preview = sources.slice(0, 3).join(", ");
  const suffix = sources.length > 3 ? ` +${sources.length - 3}` : "";
  return `来源 ${sources.length}: ${preview}${suffix}`;
}

function compressionProgress(data: ContextCompressionEventPayload): PipelineStage["progress"] | undefined {
  if (data.phase !== "start") return undefined;
  const parts = [
    data.protectedTokens !== undefined ? `保护 ${data.protectedTokens}` : "",
    data.compressibleTokens !== undefined ? `可压缩 ${data.compressibleTokens}` : "",
    data.budgetTokens !== undefined ? `预算 ${data.budgetTokens}` : "",
    compressionSourceSummary(data.sources),
  ].filter(Boolean);
  return {
    status: parts.length > 0 ? parts.join(" · ") : "compressing",
    elapsedMs: 0,
    totalChars: 0,
    chineseChars: 0,
  };
}

function upsertCompressionStage(
  stages: PipelineStage[] | undefined,
  category: ContextCompressionCategory,
  phase: ContextCompressionPhase,
  data: ContextCompressionEventPayload,
): PipelineStage[] {
  const label = compressionLabel(category);
  const found = stages?.some((stage) => stage.label === label) ?? false;
  const base = found ? [...(stages ?? [])] : [...(stages ?? []), { label, status: "pending" as const }];
  const status: PipelineStage["status"] = phase === "start" ? "active" : "completed";
  return base.map((stage) =>
    stage.label === label
      ? { ...stage, status, progress: phase === "start" ? compressionProgress(data) : undefined }
      : stage
  );
}

function findRunningExecution(parts: MessagePart[]): ToolExecution | undefined {
  const running = findRunningToolPart(parts);
  return running?.execution;
}

function applyContextCompressionToParts(
  parts: MessagePart[],
  category: ContextCompressionCategory,
  phase: ContextCompressionPhase,
  data: ContextCompressionEventPayload,
): void {
  const running = category === "session_context" ? undefined : findRunningExecution(parts);
  if (running) {
    running.stages = upsertCompressionStage(running.stages, category, phase, data);
    if (phase === "error") {
      running.status = "error";
      running.error = data.message ?? `${compressionLabel(category)}失败`;
    }
    return;
  }

  const id = `context-${category}`;
  const existing = parts.find((part): part is { type: "tool"; execution: ToolExecution } =>
    part.type === "tool" && part.execution.id === id
  );
  const status: ToolExecution["status"] = phase === "start" ? "running" : phase === "error" ? "error" : "completed";
  const execution = existing?.execution ?? {
    id,
    tool: "context_compression",
    label: compressionLabel(category),
    status,
    stages: [],
    startedAt: Date.now(),
  };
  execution.status = status;
  execution.label = compressionLabel(category);
  execution.stages = upsertCompressionStage(execution.stages, category, phase, data);
  if (phase !== "start") execution.completedAt = Date.now();
  if (phase === "error") execution.error = data.message ?? `${compressionLabel(category)}失败`;
  if (!existing) parts.push({ type: "tool", execution });
}
