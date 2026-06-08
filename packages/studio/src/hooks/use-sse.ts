import { useEffect, useRef, useCallback, useState } from "react";
import { buildApiUrl } from "../lib/api-url";

export interface SSEMessage {
  readonly event: string;
  readonly data: unknown;
  readonly timestamp: number;
}

export interface ActiveOperation {
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
  "radar:start",
  "radar:complete",
  "radar:error",
  "log",
  "llm:progress",
  "operations:restore",
  "operations:update",
  "ping",
] as const;

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
    const interval = window.setInterval(() => {
      void restoreActiveOperations();
    }, document.visibilityState === "visible" ? 3000 : 8000);
    return () => window.clearInterval(interval);
  }, [restoreActiveOperations]);

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
