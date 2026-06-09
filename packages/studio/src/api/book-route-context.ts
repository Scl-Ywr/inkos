import type {
  FileAuditEvent,
  LogEntry,
  PipelineConfig,
  ProjectConfig,
  StateManager,
} from "@actalk/inkos-core";
import type { ActiveOperation, ActiveOperationInput, OperationFinishInput } from "./active-operations.js";

export interface StudioBookListSummary {
  readonly chaptersWritten: number;
  readonly [key: string]: unknown;
}

export interface RuntimeTokenUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
}

export interface RuntimeTokenSavings {
  readonly estimatedTokensSaved: number;
}

export interface RuntimeNoticeInput {
  readonly kind: "completed" | "error";
  readonly title: string;
  readonly message: string;
  readonly tokenUsage?: RuntimeTokenUsage;
  readonly tokenSavings?: RuntimeTokenSavings;
}

export type BookCreateStatus = Map<string, { status: "creating" | "error"; error?: string }>;

export type BuildPipelineConfig = (overrides?: {
  readonly bookId?: string;
  readonly externalContext?: string;
  readonly operationKey?: string;
  readonly signal?: AbortSignal;
}) => Promise<PipelineConfig>;

export interface BookChapterRoutesDeps {
  readonly root: string;
  readonly state: StateManager;
  readonly bookCreateStatus: BookCreateStatus;
  readonly buildPipelineConfig: BuildPipelineConfig;
  readonly loadCurrentProjectConfig: () => Promise<ProjectConfig>;
  readonly syncBookDerivedFoundationFiles: (bookId: string) => Promise<void>;
  readonly shouldRefreshDerivedFoundationFile: (file: string) => boolean;
  readonly loadStudioBookListSummary: (state: StateManager, bookId: string) => Promise<StudioBookListSummary>;
  readonly broadcast: (event: string, data: unknown) => void;
  readonly serverLog: (level: LogEntry["level"], tag: string, message: string) => void;
  readonly emitStudioFileAudit: (event: FileAuditEvent, context?: { readonly sessionId?: string; readonly bookId?: string }) => void;
  readonly setOperation: (key: string, op: ActiveOperationInput) => void;
  readonly getActiveOperation: (key: string) => ActiveOperation | undefined;
  readonly touchOperation: (key: string, message: string) => void;
  readonly createOperationController: (key: string) => AbortController;
  readonly isOperationCancelled: (key: string) => boolean;
  readonly clearOperation: (key: string, outcome?: OperationFinishInput) => void;
  readonly isOperationAbortError: (error: unknown) => boolean;
  readonly rememberRuntimeNotice: (input: RuntimeNoticeInput) => void;
  readonly readRuntimeTokenUsage: (value: unknown) => RuntimeTokenUsage | undefined;
  readonly appendRuntimeTokenSummary: (message: string, tokenUsage?: RuntimeTokenUsage, tokenSavings?: RuntimeTokenSavings) => string;
}
