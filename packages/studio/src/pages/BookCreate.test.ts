import { describe, expect, it } from "vitest";
import type { BookCreationDraft } from "@actalk/inkos-core";
import {
  buildBookCreateAgentRequest,
  defaultBookCreateForm,
  mergeBookCreationDraftIntoForm,
  platformOptionsForLanguage,
} from "./BookCreate";

describe("buildBookCreateAgentRequest", () => {
  it("includes the selected chat model route for book-create agent requests", () => {
    expect(buildBookCreateAgentRequest("写一本债务悬疑长篇", "session-1", {
      service: "google",
      model: "gemini-2.5-pro",
    })).toMatchObject({
      instruction: "写一本债务悬疑长篇",
      sessionId: "session-1",
      sessionKind: "book-create",
      actionSource: "free-text",
      service: "google",
      model: "gemini-2.5-pro",
    });
  });

  it("omits empty model route fields", () => {
    const request = buildBookCreateAgentRequest("/create", "session-1", {
      service: null,
      model: null,
    });

    expect(request).toMatchObject({
      requestedIntent: "create_book",
      actionSource: "slash",
    });
    expect(request).not.toHaveProperty("service");
    expect(request).not.toHaveProperty("model");
  });

  it("replaces non-empty form defaults when a model draft is updated", () => {
    const form = defaultBookCreateForm("zh");
    const draft = {
      title: "Debt Maze",
      genre: "suspense",
      platform: "qidian",
      targetChapters: 80,
      chapterWordCount: 2400,
      blurb: "A debtor investigates a missing ledger.",
    } as BookCreationDraft;

    expect(mergeBookCreationDraftIntoForm(
      draft,
      form,
      platformOptionsForLanguage("zh"),
    )).toMatchObject({
      title: "Debt Maze",
      genre: "suspense",
      platform: "qidian",
      targetChapters: "80",
      chapterWordCount: "2400",
      brief: "A debtor investigates a missing ledger.",
    });
  });
});
