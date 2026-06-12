import { useEffect, useRef, useCallback, useState } from "react";
import { buildApiUrl } from "../lib/api-url";

export interface SSEMessage {
  readonly event: string;
  readonly data: unknown;
  readonly timestamp: number;
}

export interface ActiveOperation {
  readonly id?: string;
  readonly type?: string;
  readonly bookId?: string;
  readonly status?: string;
  readonly label?: string;
  readonly message?: string;
  readonly startedAt?: number;
  readonly updatedAt?: number;
  readonly chapter?: number;
  readonly sessionId?: string;
  readonly instruction?: string;
}

export const STUDIO_SSE_EVENTS = [
  "book:creating",
  "book:created",
  "book:deleted",
  "book:error",
  "write:start",
  "write:complete",
  "write:error",
  "draft:start",
  "draft:complete",
  "draft:error",
  "daemon:chapter",
  "daemon:started",
  "daemon:stopped",
  "daemon:error",
  "agent:start",
  "agent:complete",
  "agent:error",
  "session:title",
  "audit:start",
  "audit:complete",
  "audit:error",
  "revise:start",
  "revise:complete",
  "revise:error",
  "rewrite:start",
  "rewrite:complete",
  "rewrite:error",
  "resync:start",
  "resync:complete",
  "resync:error",
  "style:start",
  "style:complete",
  "style:error",
  "import:start",
  "import:complete",
  "import:error",
  "fanfic:start",
  "fanfic:complete",
  "fanfic:error",
  "fanfic:refresh:start",
  "fanfic:refresh:complete",
  "fanfic:refresh:error",
  "draft:delta",
  "write:delta",
  "llm:delta",
  "radar:start",
  "radar:complete",
  "radar:error",
  "log",
  "logs:clear",
  "llm:progress",
  "context:compression",
  "tool:start",
  "tool:update",
  "tool:end",
  "operations:restore",
  "operations:update",
  "operations:history",
  "ping",
] as const;

function operationId(event: string, data: unknown): string {
  const record = data && typeof data === "object" ? data as Record<string, unknown> : {};
  return String(record.execId ?? record.requestId ?? record.sessionId ?? record.bookId ?? event);
}

function operationLabel(event: string, data: unknown): string {
  const record = data && typeof data === "object" ? data as Record<string, unknown> : {};
  const tool = String(record.tool ?? record.toolName ?? record.name ?? "").trim();
  if (event === "tool:start" && tool) return tool.startsWith("play_") ? "InkOS Play" : tool;
  const type = event.split(":")[0];
  const labels: Record<string, string> = {
    agent: "智能体任务",
    write: "章节写作",
    draft: "草稿生成",
    audit: "章节审稿",
    revise: "章节修订",
    rewrite: "章节重写",
    style: "文风分析",
    import: "内容导入",
    fanfic: "同人创作",
    imitation: "仿写创作",
    spinoff: "番外创作",
    radar: "雷达分析",
    foundation: "设定生成",
  };
  return labels[type] ?? "InkOS 正在执行任务";
}

function isOperationStart(event: string): boolean {
  return event === "tool:start" || event.endsWith(":start") || event === "book:creating";
}

function isOperationEnd(event: string): boolean {
  return event === "tool:end" || event.endsWith(":complete") || event.endsWith(":error") || event === "book:created" || event === "book:error";
}

function normalizeActiveOperations(operations: unknown): ActiveOperation[] {
  return Array.isArray(operations)
    ? operations.filter(
        (operation): operation is ActiveOperation => Boolean(operation) && typeof operation === "object",
      )
    : [];
}

export function activeOperationsSignature(operations: ReadonlyArray<ActiveOperation>): string {
  return JSON.stringify(operations.map((operation) => ({
    type: operation.type,
    bookId: operation.bookId,
    label: operation.label,
    message: operation.message,
    updatedAt: operation.updatedAt,
    chapter: operation.chapter,
    sessionId: operation.sessionId,
  })));
}

export function useSSE(url = "/events") {
  const [messages, setMessages] = useState<ReadonlyArray<SSEMessage>>([]);
  const [connected, setConnected] = useState(false);
  const [activeOperations, setActiveOperations] = useState<ReadonlyArray<ActiveOperation>>([]);
  const [reconnectNonce, setReconnectNonce] = useState(0);
  const esRef = useRef<EventSource | null>(null);
  const lastOperationsSignature = useRef("");
  const eventsUrl = buildApiUrl(url) ?? url;
  const activeOperationsUrl = buildApiUrl("/active-operations");

  const restoreActiveOperations = useCallback(() => {
    if (!activeOperationsUrl) return;
    let cancelled = false;
    fetch(activeOperationsUrl)
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { operations?: unknown } | null) => {
        if (cancelled || !Array.isArray(data?.operations)) {
          return;
        }
        const operations = normalizeActiveOperations(data.operations);
        const signature = activeOperationsSignature(operations);
        if (signature === lastOperationsSignature.current) return;
        lastOperationsSignature.current = signature;
        setActiveOperations(operations);
        setMessages((prev) => [
          ...prev.slice(-99),
          { event: "operations:restore", data: { operations }, timestamp: Date.now() },
        ]);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [activeOperationsUrl]);

  useEffect(() => restoreActiveOperations(), [restoreActiveOperations, reconnectNonce]);

  useEffect(() => {
    let timer: number | null = null;
    let cancelled = false;
    const poll = () => {
      if (cancelled) return;
      void restoreActiveOperations();
      const delay = document.visibilityState !== "visible"
        ? 30_000
        : connected
          ? 15_000
          : 3_000;
      timer = window.setTimeout(poll, delay);
    };
    timer = window.setTimeout(poll, connected ? 15_000 : 3_000);
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [connected, restoreActiveOperations]);

  useEffect(() => {
    const reconnect = () => {
      if (document.visibilityState !== "visible") return;
      esRef.current?.close();
      esRef.current = null;
      setConnected(false);
      setReconnectNonce((value) => value + 1);
    };
    document.addEventListener("visibilitychange", reconnect);
    window.addEventListener("focus", reconnect);
    window.addEventListener("online", reconnect);
    return () => {
      document.removeEventListener("visibilitychange", reconnect);
      window.removeEventListener("focus", reconnect);
      window.removeEventListener("online", reconnect);
    };
  }, []);

  useEffect(() => {
    const es = new EventSource(eventsUrl);
    esRef.current = es;

    es.onopen = () => {
      setConnected(true);
      restoreActiveOperations();
    };
    es.onerror = () => setConnected(false);

    const handleEvent = (e: MessageEvent) => {
      try {
        const data = e.data ? JSON.parse(e.data) : null;
        if (isOperationStart(e.type)) {
          const id = operationId(e.type, data);
          const record = data && typeof data === "object" ? data as Record<string, unknown> : {};
          const operation: ActiveOperation = {
            id,
            type: e.type.replace(/:start$/, ""),
            label: operationLabel(e.type, data),
            message: String(record.message ?? record.instruction ?? "任务正在运行"),
            sessionId: typeof record.sessionId === "string" ? record.sessionId : undefined,
            bookId: typeof record.bookId === "string" ? record.bookId : undefined,
            startedAt: Date.now(),
            updatedAt: Date.now(),
          };
          setActiveOperations((current) => [operation, ...current.filter((item) => item.id !== id)].slice(0, 8));
        } else if (isOperationEnd(e.type)) {
          const id = operationId(e.type.replace(/:(?:complete|error|end)$/, ":start"), data);
          const baseType = e.type.replace(/:(?:complete|error|end)$/, "");
          setActiveOperations((current) => current.filter((item) => item.id !== id && item.type !== baseType));
        }
        if (
          (e.type === "operations:restore" || e.type === "operations:update")
          && Array.isArray(data?.operations)
        ) {
          const operations = normalizeActiveOperations(data.operations);
          const signature = activeOperationsSignature(operations);
          if (signature === lastOperationsSignature.current) return;
          lastOperationsSignature.current = signature;
          setActiveOperations(operations);
          setMessages((prev) => [...prev.slice(-99), { event: e.type, data: { operations }, timestamp: Date.now() }]);
          return;
        }
        setMessages((prev) => [...prev.slice(-99), { event: e.type, data, timestamp: Date.now() }]);
      } catch {
        // ignore parse errors
      }
    };

    for (const event of STUDIO_SSE_EVENTS) {
      es.addEventListener(event, handleEvent);
    }

    return () => {
      es.close();
      esRef.current = null;
    };
  }, [eventsUrl, reconnectNonce, restoreActiveOperations]);

  const clear = useCallback(() => setMessages([]), []);

  return { messages, connected, activeOperations, clear };
}
