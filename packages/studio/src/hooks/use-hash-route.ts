import { useState, useEffect, useCallback } from "react";

export type HashRoute =
  | { page: "dashboard" }
  | { page: "chat" }
  | { page: "book"; bookId: string }
  | { page: "book-settings"; bookId: string }
  | { page: "book-create" }
  | { page: "services" }
  | { page: "project-settings" }
  | { page: "service-detail"; serviceId: string }
  | { page: "chapter"; bookId: string; chapterNumber: number }
  | { page: "analytics"; bookId: string }
  | { page: "truth"; bookId: string }
  | { page: "knowledge"; bookId: string }
  | { page: "timeline"; bookId: string }
  | { page: "schedule"; bookId: string }
  | { page: "character-graph"; bookId: string }
  | { page: "world-settings"; bookId: string }
  | { page: "foreshadowing"; bookId: string }
  | { page: "endings"; bookId: string }
  | { page: "daemon" }
  | { page: "logs" }
  | { page: "genres" }
  | { page: "style" }
  | { page: "import"; tab?: "chapters" | "canon" | "fanfic" | "spinoff" | "imitation" }
  | { page: "image-gen" }
  | { page: "images" }
  | { page: "radar" }
  | { page: "doctor" };

const IMPORT_TABS = new Set(["chapters", "canon", "fanfic", "spinoff", "imitation"]);

function isImportTab(value: unknown): value is NonNullable<Extract<HashRoute, { page: "import" }>["tab"]> {
  return typeof value === "string" && IMPORT_TABS.has(value);
}

function parseHash(hash: string): HashRoute {
  const path = hash.replace(/^#\/?/, "");

  if (!path || path === "/") return { page: "dashboard" };
  if (path === "chat") return { page: "chat" };
  if (path === "config" || path === "services") return { page: "services" };
  if (path === "settings") return { page: "project-settings" };
  if (path === "import") return { page: "import" };
  const importMatch = path.match(/^import\/(chapters|canon|fanfic|spinoff|imitation)$/);
  if (importMatch) return { page: "import", tab: importMatch[1] as "chapters" | "canon" | "fanfic" | "spinoff" | "imitation" };
  if (path === "book/new") return { page: "book-create" };

  const serviceMatch = path.match(/^services\/([^/]+)$/);
  if (serviceMatch) return { page: "service-detail", serviceId: decodeURIComponent(serviceMatch[1]) };

  const bookSettingsMatch = path.match(/^book\/([^/]+)\/settings$/);
  if (bookSettingsMatch) return { page: "book-settings", bookId: decodeURIComponent(bookSettingsMatch[1]) };

  const chapterMatch = path.match(/^book\/([^/]+)\/chapters\/(\d+)$/);
  if (chapterMatch) {
    return {
      page: "chapter",
      bookId: decodeURIComponent(chapterMatch[1]),
      chapterNumber: parseInt(chapterMatch[2], 10),
    };
  }

  const analyticsMatch = path.match(/^book\/([^/]+)\/analytics$/);
  if (analyticsMatch) return { page: "analytics", bookId: decodeURIComponent(analyticsMatch[1]) };

  const truthMatch = path.match(/^book\/([^/]+)\/truth$/);
  if (truthMatch) return { page: "truth", bookId: decodeURIComponent(truthMatch[1]) };

  const knowledgeMatch = path.match(/^book\/([^/]+)\/knowledge$/);
  if (knowledgeMatch) return { page: "knowledge", bookId: decodeURIComponent(knowledgeMatch[1]) };

  const timelineMatch = path.match(/^book\/([^/]+)\/timeline$/);
  if (timelineMatch) return { page: "timeline", bookId: decodeURIComponent(timelineMatch[1]) };

  const scheduleMatch = path.match(/^book\/([^/]+)\/schedule$/);
  if (scheduleMatch) return { page: "schedule", bookId: decodeURIComponent(scheduleMatch[1]) };

  const characterGraphMatch = path.match(/^book\/([^/]+)\/character-graph$/);
  if (characterGraphMatch) return { page: "character-graph", bookId: decodeURIComponent(characterGraphMatch[1]) };

  const worldSettingsMatch = path.match(/^book\/([^/]+)\/world-settings$/);
  if (worldSettingsMatch) return { page: "world-settings", bookId: decodeURIComponent(worldSettingsMatch[1]) };

  const foreshadowingMatch = path.match(/^book\/([^/]+)\/foreshadowing$/);
  if (foreshadowingMatch) return { page: "foreshadowing", bookId: decodeURIComponent(foreshadowingMatch[1]) };

  const endingsMatch = path.match(/^book\/([^/]+)\/endings$/);
  if (endingsMatch) return { page: "endings", bookId: decodeURIComponent(endingsMatch[1]) };

  const bookMatch = path.match(/^book\/([^/]+)$/);
  if (bookMatch) return { page: "book", bookId: decodeURIComponent(bookMatch[1]) };

  if (path === "logs") return { page: "logs" };
  if (path === "daemon") return { page: "daemon" };
  if (path === "genres") return { page: "genres" };
  if (path === "style") return { page: "style" };
  if (path === "image-gen") return { page: "image-gen" };
  if (path === "images") return { page: "images" };
  if (path === "radar") return { page: "radar" };
  if (path === "doctor") return { page: "doctor" };

  return { page: "dashboard" };
}

function routeToHash(route: HashRoute): string {
  switch (route.page) {
    case "dashboard": return "#/";
    case "chat": return "#/chat";
    case "book": return `#/book/${encodeURIComponent(route.bookId)}`;
    case "book-settings": return `#/book/${encodeURIComponent(route.bookId)}/settings`;
    case "chapter": return `#/book/${encodeURIComponent(route.bookId)}/chapters/${route.chapterNumber}`;
    case "analytics": return `#/book/${encodeURIComponent(route.bookId)}/analytics`;
    case "truth": return `#/book/${encodeURIComponent(route.bookId)}/truth`;
    case "knowledge": return `#/book/${encodeURIComponent(route.bookId)}/knowledge`;
    case "timeline": return `#/book/${encodeURIComponent(route.bookId)}/timeline`;
    case "schedule": return `#/book/${encodeURIComponent(route.bookId)}/schedule`;
    case "character-graph": return `#/book/${encodeURIComponent(route.bookId)}/character-graph`;
    case "world-settings": return `#/book/${encodeURIComponent(route.bookId)}/world-settings`;
    case "foreshadowing": return `#/book/${encodeURIComponent(route.bookId)}/foreshadowing`;
    case "endings": return `#/book/${encodeURIComponent(route.bookId)}/endings`;
    case "book-create": return "#/book/new";
    case "services": return "#/services";
    case "project-settings": return "#/settings";
    case "logs": return "#/logs";
    case "daemon": return "#/daemon";
    case "genres": return "#/genres";
    case "style": return "#/style";
    case "image-gen": return "#/image-gen";
    case "images": return "#/images";
    case "radar": return "#/radar";
    case "doctor": return "#/doctor";
    case "import": return isImportTab(route.tab) ? `#/import/${route.tab}` : "#/import";
    case "service-detail": return `#/services/${encodeURIComponent(route.serviceId)}`;
    default: return "";
  }
}

export { parseHash, routeToHash }; // for testing

const HASH_PAGES = new Set([
  "dashboard",
  "chat",
  "book",
  "book-settings",
  "book-create",
  "chapter",
  "analytics",
  "truth",
  "knowledge",
  "timeline",
  "schedule",
  "character-graph",
  "world-settings",
  "foreshadowing",
  "endings",
  "services",
  "project-settings",
  "service-detail",
  "logs",
  "daemon",
  "genres",
  "style",
  "import",
  "image-gen",
  "images",
  "radar",
  "doctor",
]);

export function useHashRoute() {
  const [route, setRouteState] = useState<HashRoute>(() => parseHash(window.location.hash));

  useEffect(() => {
    const onHashChange = () => setRouteState(parseHash(window.location.hash));
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const setRoute = useCallback((newRoute: HashRoute) => {
    // 先同步 React state：无论目标页面是否写 URL，保证页面立刻切换。
    // 之前只在非 hash 页面才 setRouteState，hash 页面完全靠 hashchange 事件回调触发。
    // 但当 URL 没有实际变化时（比如从 services → logs → services，中间的 logs
    // 不写 URL，URL 一直停在 #/services），再次赋值同一个 hash 不会触发 hashchange，
    // React state 就永远停留在 logs，表现为"点不动"。
    setRouteState(newRoute);
    if (HASH_PAGES.has(newRoute.page)) {
      const hash = routeToHash(newRoute);
      if (hash && window.location.hash !== hash) {
        window.location.hash = hash;
      }
    }
  }, []);

  const nav = {
    toServices: () => setRoute({ page: "services" }),
    toServiceDetail: (id: string) => setRoute({ page: "service-detail", serviceId: id }),
    toImageGen: () => setRoute({ page: "image-gen" }),
    toImages: () => setRoute({ page: "images" }),
  };

  return { route, setRoute, nav };
}
