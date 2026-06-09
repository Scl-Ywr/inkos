import {
  createAndPersistBookSession,
  deleteBookSession,
  deleteBookSessionMessage,
  listBookSessions,
  loadBookSession,
  loadProjectSession,
  renameBookSession,
  resolveSessionActiveBook,
} from "@actalk/inkos-core";
import type { Hono } from "hono";
import { ApiError } from "./errors.js";
import { normalizeApiBookId } from "./api-validation.js";

interface SessionRoutesDeps {
  readonly root: string;
}

interface DeleteSessionMessageBody {
  readonly role?: "user" | "assistant";
  readonly content?: string;
  readonly timestamp?: number;
  readonly messageIndex?: number;
}

export function registerSessionRoutes(app: Hono, deps: SessionRoutesDeps): void {
  const { root } = deps;

  app.get("/api/v1/interaction/session", async (c) => {
    const session = await loadProjectSession(root);
    const activeBookId = await resolveSessionActiveBook(root, session);
    return c.json({
      session: activeBookId && session.activeBookId !== activeBookId
        ? { ...session, activeBookId }
        : session,
      activeBookId,
    });
  });

  app.get("/api/v1/sessions", async (c) => {
    const bookId = c.req.query("bookId");
    const sessions = await listBookSessions(root, bookId === undefined ? null : bookId === "null" ? null : bookId);
    return c.json({ sessions });
  });

  app.get("/api/v1/sessions/:sessionId", async (c) => {
    const session = await loadBookSession(root, c.req.param("sessionId"));
    if (!session) return c.json({ error: "Session not found" }, 404);
    return c.json({ session });
  });

  app.post("/api/v1/sessions", async (c) => {
    const body = await c.req.json<{ bookId?: string | null; sessionId?: string }>().catch(() => ({}));
    const bookId = normalizeApiBookId((body as { bookId?: unknown }).bookId, "bookId");
    const sessionId = (body as { sessionId?: string }).sessionId;
    const safeSessionId = sessionId && /^[0-9]+-[a-z0-9]+$/.test(sessionId) ? sessionId : undefined;
    const session = await createAndPersistBookSession(root, bookId, safeSessionId);
    return c.json({ session });
  });

  app.put("/api/v1/sessions/:sessionId", async (c) => {
    const sessionId = c.req.param("sessionId");
    const body = await c.req.json<{ title?: string }>().catch(() => ({}) as { title?: string });
    const title = body.title?.trim();
    if (!title) {
      throw new ApiError(400, "INVALID_SESSION_TITLE", "Session title is required");
    }

    const session = await renameBookSession(root, sessionId, title);
    if (!session) {
      return c.json({ error: "Session not found" }, 404);
    }
    return c.json({ session });
  });

  app.delete("/api/v1/sessions/:sessionId", async (c) => {
    await deleteBookSession(root, c.req.param("sessionId"));
    return c.json({ ok: true });
  });

  app.delete("/api/v1/sessions/:sessionId/messages", async (c) => {
    const sessionId = c.req.param("sessionId");
    const body = await c.req.json<DeleteSessionMessageBody>().catch((): DeleteSessionMessageBody => ({}));
    if (
      (body.role !== "user" && body.role !== "assistant") ||
      typeof body.content !== "string" ||
      typeof body.timestamp !== "number" ||
      !Number.isFinite(body.timestamp)
    ) {
      throw new ApiError(400, "INVALID_MESSAGE_TARGET", "A valid message target is required");
    }
    const deleteTarget = {
      role: body.role,
      content: body.content,
      timestamp: body.timestamp,
    } as {
      role: "user" | "assistant";
      content: string;
      timestamp: number;
      messageIndex?: number;
    };
    if (typeof body.messageIndex === "number" && Number.isFinite(body.messageIndex)) {
      deleteTarget.messageIndex = Math.trunc(body.messageIndex);
    }
    const session = await deleteBookSessionMessage(root, sessionId, deleteTarget);
    if (!session) return c.json({ error: "Message or session not found" }, 404);
    return c.json({ ok: true, session });
  });
}
