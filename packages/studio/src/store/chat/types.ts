// -- Data types --

export interface ToolCall {
  readonly name: string;
  readonly arguments: Record<string, unknown>;
}

export interface TokenUsageSnapshot {
  readonly promptTokens?: number;
  readonly completionTokens?: number;
  readonly totalTokens: number;
  readonly estimated?: boolean;
  readonly source?: "stream" | "final" | "tool";
  readonly updatedAt?: number;
  readonly streamCallTokens?: number;
  readonly streamAccumulatedTokens?: number;
  readonly streamLastStatus?: string;
  readonly tokenSavings?: {
    readonly cacheSkippedCalls: number;
    readonly semanticL1Hits: number;
    readonly semanticL2Hits: number;
    readonly semanticMisses: number;
    readonly ccrBlocksCompressed: number;
    readonly originalChars: number;
    readonly optimizedChars: number;
    readonly estimatedTokensSaved: number;
    readonly pipeline?: ReadonlyArray<{
      readonly kind: string;
      readonly label: string;
      readonly originalChars?: number;
      readonly optimizedChars?: number;
      readonly estimatedTokensSaved?: number;
      readonly similarity?: number;
      readonly at: number;
    }>;
    readonly lastEvent?: {
      readonly kind: string;
      readonly originalChars?: number;
      readonly optimizedChars?: number;
      readonly estimatedTokensSaved?: number;
      readonly similarity?: number;
      readonly at: number;
    };
  };
}

export interface PipelineStage {
  label: string;
  status: "pending" | "active" | "completed";
  progress?: {
    status?: string;          // "thinking" | "streaming" | ...
    elapsedMs: number;
    totalChars: number;
    chineseChars: number;
    estimatedTokens?: number;
  };
}

export interface ToolExecution {
  id: string;
  tool: string;
  agent?: string;
  label: string;
  status: "running" | "processing" | "completed" | "error";
  args?: Record<string, unknown>;
  result?: string;
  details?: unknown;
  error?: string;
  stages?: PipelineStage[];
  tokenUsage?: TokenUsageSnapshot;
  logs?: string[];
  streamingText?: string;
  startedAt: number;
  completedAt?: number;
}

// -- Message parts (chronologically ordered for rendering) --

export type MessagePart =
  | { type: "thinking"; content: string; streaming: boolean }
  | { type: "text"; content: string }
  | { type: "tool"; execution: ToolExecution };

export interface Message {
  readonly role: "user" | "assistant";
  readonly content: string;
  readonly thinking?: string;
  readonly thinkingStreaming?: boolean;
  readonly timestamp: number;
  readonly toolCall?: ToolCall;
  readonly toolExecutions?: ToolExecution[];
  readonly tokenUsage?: TokenUsageSnapshot;
  readonly parts?: MessagePart[];              // chronological parts for interleaved rendering
}

export interface SessionMessage {
  readonly role: "user" | "assistant" | "system";
  readonly content: string;
  readonly thinking?: string;
  readonly toolExecutions?: ReadonlyArray<ToolExecution>;
  readonly tokenUsage?: TokenUsageSnapshot;
  readonly timestamp: number;
}

export interface SessionSummary {
  readonly sessionId: string;
  readonly bookId: string | null;
  readonly title: string | null;
  readonly messageCount: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface AgentResponse {
  readonly response?: string;
  readonly error?: string | { code?: string; message?: string };
  readonly details?: {
    readonly draftRaw?: string;
    readonly toolCall?: ToolCall;
    readonly toolExecutions?: ReadonlyArray<ToolExecution>;
  };
  readonly tokenUsage?: TokenUsageSnapshot;
  readonly tokenSavings?: TokenUsageSnapshot["tokenSavings"];
  readonly session?: {
    readonly sessionId?: string;
    readonly bookId?: string | null;
    readonly title?: string | null;
    readonly activeBookId?: string;
    readonly creationDraft?: unknown;
    readonly messages?: ReadonlyArray<SessionMessage>;
  };
  readonly request?: unknown;
}

export interface SessionResponse {
  readonly session?: {
    readonly sessionId?: string;
    readonly bookId?: string | null;
    readonly title?: string | null;
    readonly activeBookId?: string;
    readonly messages?: ReadonlyArray<SessionMessage>;
  };
  readonly activeBookId?: string;
}

// -- State interfaces --

export interface BookSummary {
  world: string;
  protagonist: string;
  cast: string;
}

export interface SessionRuntime {
  readonly sessionId: string;
  readonly bookId: string | null;
  readonly title: string | null;
  readonly messages: ReadonlyArray<Message>;
  readonly deletedMessageKeys: ReadonlyArray<string>;
  readonly stream: EventSource | null;
  readonly abortController: AbortController | null;
  readonly isStreaming: boolean;
  readonly lastError: string | null;
  // 仅前端存在、尚未持久化到磁盘的草稿会话。发送第一条消息时才调 POST /sessions 把它落盘。
  readonly isDraft: boolean;
}

export interface MessageState {
  sessions: Record<string, SessionRuntime>;
  sessionIdsByBook: Record<string, ReadonlyArray<string>>;
  activeSessionId: string | null;
  input: string;
  selectedModel: string | null;
  selectedService: string | null;
}

export interface CreateState {
  bookDataVersion: number;
  sidebarView: "panel" | "artifact";
  artifactFile: string | null;         // foundation file name, e.g. "story_bible.md"
  artifactChapter: number | null;      // chapter number, e.g. 1
  bookSummary: BookSummary | null;
}

export type ChatState = MessageState & CreateState;

// -- Action interfaces --

export interface MessageActions {
  activateSession: (sessionId: string | null) => void;
  setInput: (text: string) => void;
  addUserMessage: (sessionId: string, content: string) => void;
  appendStreamChunk: (sessionId: string, text: string, streamTs: number) => void;
  finalizeStream: (
    sessionId: string,
    streamTs: number,
    content: string,
    toolCall?: ToolCall,
    tokenUsage?: TokenUsageSnapshot,
  ) => void;
  replaceStreamWithError: (sessionId: string, streamTs: number, errorMsg: string) => void;
  addErrorMessage: (sessionId: string, errorMsg: string) => void;
  deleteMessage: (sessionId: string, messageIndex: number) => Promise<void>;
  loadSessionMessages: (sessionId: string, msgs: ReadonlyArray<SessionMessage>) => void;
  loadSessionList: (bookId: string | null) => Promise<ReadonlyArray<SessionSummary>>;
  createSession: (bookId: string | null) => Promise<string>;
  createDraftSession: (bookId: string | null) => string;
  renameSession: (sessionId: string, title: string) => Promise<void>;
  deleteSession: (sessionId: string) => Promise<void>;
  loadSessionDetail: (sessionId: string) => Promise<void>;
  sendMessage: (sessionId: string, text: string, activeBookId?: string) => Promise<void>;
  cancelMessage: (sessionId: string) => Promise<void>;
  setSelectedModel: (model: string | null, service: string | null) => void;
}

export interface CreateActions {
  bumpBookDataVersion: () => void;
  openArtifact: (file: string) => void;
  openChapterArtifact: (chapterNum: number) => void;
  closeArtifact: () => void;
  setBookSummary: (summary: BookSummary | null) => void;
}

// -- Composed store type --

export type ChatStore = ChatState & MessageActions & CreateActions;
