import { describe, expect, it } from "vitest";
import { parseHash, routeToHash } from "./use-hash-route";

describe("hash route", () => {
  describe("parseHash", () => {
    it("parses empty hash as dashboard", () => {
      expect(parseHash("")).toEqual({ page: "dashboard" });
    });

    it("parses #/ as dashboard", () => {
      expect(parseHash("#/")).toEqual({ page: "dashboard" });
    });

    it("parses chat route", () => {
      expect(parseHash("#/chat")).toEqual({ page: "chat" });
    });

    it("parses book route", () => {
      expect(parseHash("#/book/my-novel")).toEqual({ page: "book", bookId: "my-novel" });
    });

    it("parses book settings route", () => {
      expect(parseHash("#/book/my-novel/settings")).toEqual({ page: "book-settings", bookId: "my-novel" });
    });

    it("parses book knowledge route", () => {
      expect(parseHash("#/book/my-novel/knowledge")).toEqual({ page: "knowledge", bookId: "my-novel" });
    });

    it("parses chapter route", () => {
      expect(parseHash("#/book/my-novel/chapters/12")).toEqual({
        page: "chapter",
        bookId: "my-novel",
        chapterNumber: 12,
      });
    });

    it("parses logs route", () => {
      expect(parseHash("#/logs")).toEqual({ page: "logs" });
    });

    it("decodes encoded bookId", () => {
      expect(parseHash("#/book/%E4%B9%9D%E9%BE%99")).toEqual({ page: "book", bookId: "九龙" });
    });

    it("parses book/new as book-create", () => {
      expect(parseHash("#/book/new")).toEqual({ page: "book-create" });
    });

    it("parses config as services (redirect)", () => {
      expect(parseHash("#/config")).toEqual({ page: "services" });
    });

    it("parses services", () => {
      expect(parseHash("#/services")).toEqual({ page: "services" });
    });

    it("parses project settings", () => {
      expect(parseHash("#/settings")).toEqual({ page: "project-settings" });
    });

    it("parses service-detail", () => {
      expect(parseHash("#/services/openai")).toEqual({ page: "service-detail", serviceId: "openai" });
    });

    it("parses import tab routes", () => {
      expect(parseHash("#/import/fanfic")).toEqual({ page: "import", tab: "fanfic" });
    });

    it("parses the import landing route", () => {
      expect(parseHash("#/import")).toEqual({ page: "import" });
    });

    it("parses image library route", () => {
      expect(parseHash("#/images")).toEqual({ page: "images" });
    });

    it("decodes encoded serviceId", () => {
      expect(parseHash("#/services/%E8%87%AA%E5%AE%9A%E4%B9%89")).toEqual({ page: "service-detail", serviceId: "自定义" });
    });

    it("falls back to dashboard for unknown hash", () => {
      expect(parseHash("#/unknown/route")).toEqual({ page: "dashboard" });
    });
  });

  describe("routeToHash", () => {
    it("dashboard -> #/", () => {
      expect(routeToHash({ page: "dashboard" })).toBe("#/");
    });

    it("chat -> #/chat", () => {
      expect(routeToHash({ page: "chat" })).toBe("#/chat");
    });

    it("book -> #/book/{id}", () => {
      expect(routeToHash({ page: "book", bookId: "novel-1" })).toBe("#/book/novel-1");
    });

    it("book-settings -> #/book/{id}/settings", () => {
      expect(routeToHash({ page: "book-settings", bookId: "novel-1" })).toBe("#/book/novel-1/settings");
    });

    it("knowledge -> #/book/{id}/knowledge", () => {
      expect(routeToHash({ page: "knowledge", bookId: "novel-1" })).toBe("#/book/novel-1/knowledge");
    });

    it("chapter -> #/book/{id}/chapters/{num}", () => {
      expect(routeToHash({ page: "chapter", bookId: "novel-1", chapterNumber: 7 })).toBe("#/book/novel-1/chapters/7");
    });

    it("encodes Chinese bookId", () => {
      const hash = routeToHash({ page: "book", bookId: "九龙城夜行" });
      expect(hash).toContain("#/book/");
      expect(decodeURIComponent(hash)).toContain("九龙城夜行");
    });

    it("book-create -> #/book/new", () => {
      expect(routeToHash({ page: "book-create" })).toBe("#/book/new");
    });

    it("services -> #/services", () => {
      expect(routeToHash({ page: "services" })).toBe("#/services");
    });

    it("project-settings -> #/settings", () => {
      expect(routeToHash({ page: "project-settings" })).toBe("#/settings");
    });

    it("service-detail -> #/services/{id}", () => {
      expect(routeToHash({ page: "service-detail", serviceId: "openai" })).toBe("#/services/openai");
    });

    it("import tab -> #/import/{tab}", () => {
      expect(routeToHash({ page: "import", tab: "chapters" })).toBe("#/import/chapters");
    });

    it("ignores accidental click-event values passed as an import tab", () => {
      const malformedRoute = { page: "import", tab: { type: "click" } } as unknown as Parameters<typeof routeToHash>[0];
      expect(routeToHash(malformedRoute)).toBe("#/import");
    });

    it("images -> #/images", () => {
      expect(routeToHash({ page: "images" })).toBe("#/images");
    });

    it("encodes Chinese serviceId", () => {
      const hash = routeToHash({ page: "service-detail", serviceId: "自定义" });
      expect(hash).toContain("#/services/");
      expect(decodeURIComponent(hash)).toContain("自定义");
    });

    it("utility pages have stable hashes", () => {
      expect(routeToHash({ page: "daemon" })).toBe("#/daemon");
      expect(routeToHash({ page: "logs" })).toBe("#/logs");
    });
  });
});
