import { useState, useEffect } from "react";
import { useHashRoute } from "./hooks/use-hash-route";
import type { HashRoute } from "./hooks/use-hash-route";
import { Sidebar } from "./components/Sidebar";
import { Dashboard } from "./pages/Dashboard";
import { ChatPage } from "./pages/ChatPage";
import { BookDetail } from "./pages/BookDetail";
import { ChapterReader } from "./pages/ChapterReader";
import { Analytics } from "./pages/Analytics";
import { ServiceListPage } from "./pages/ServiceListPage";
import { ServiceDetailPage } from "./pages/ServiceDetailPage";
import { TruthFiles } from "./pages/TruthFiles";
import { DaemonControl } from "./pages/DaemonControl";
import { LogViewer } from "./pages/LogViewer";
import { GenreManager } from "./pages/GenreManager";
import { StyleManager } from "./pages/StyleManager";
import { ImportManager } from "./pages/ImportManager";
import { RadarView } from "./pages/RadarView";
import { DoctorView } from "./pages/DoctorView";
import { LanguageSelector } from "./pages/LanguageSelector";
import { BookSidebar, BookSidebarToggle } from "./components/chat/BookSidebar";
import { useSSE } from "./hooks/use-sse";
import { useSessionEvents } from "./hooks/use-session-events";
import { useTheme } from "./hooks/use-theme";
import { useI18n } from "./hooks/use-i18n";
import { postApi, putApi, useApi } from "./hooks/use-api";
import { Sun, Moon, Menu } from "lucide-react";
import { House } from "lucide-react";

export type { HashRoute as Route } from "./hooks/use-hash-route";

export function deriveActiveBookId(route: HashRoute): string | undefined {
  if ("bookId" in route) return route.bookId;
  return undefined;
}

export function isBookCreateChatRoute(route: HashRoute): boolean {
  return route.page === "book-create";
}

export function App() {
  const { route, setRoute } = useHashRoute();
  const sse = useSSE();
  const { theme, setTheme } = useTheme();
  const { t, lang: currentLang } = useI18n();
  const { data: project, error: projectError, refetch: refetchProject } = useApi<{ language: string; languageExplicit: boolean }>("/project");
  const [showLanguageSelector, setShowLanguageSelector] = useState(false);
  const [ready, setReady] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const closeSidebar = () => setSidebarOpen(false);

  const isDark = theme === "dark";

  useEffect(() => {
    document.documentElement.classList.toggle("dark", isDark);
  }, [isDark]);

  useEffect(() => {
    if (project) {
      if (!project.languageExplicit) {
        setShowLanguageSelector(true);
      }
      setReady(true);
    }
  }, [project]);

  useEffect(() => {
    if (projectError) {
      setReady(true);
    }
  }, [projectError]);

  useSessionEvents(sse, route, setRoute);

  const nav = {
    toDashboard: () => { setRoute({ page: "dashboard" }); closeSidebar(); },
    toChat: () => { setRoute({ page: "chat" }); closeSidebar(); },
    toBook: (bookId: string) => { setRoute({ page: "book", bookId }); closeSidebar(); },
    toBookSettings: (bookId: string) => { setRoute({ page: "book-settings", bookId }); closeSidebar(); },
    toBookCreate: () => { setRoute({ page: "book-create" }); closeSidebar(); },
    toChapter: (bookId: string, chapterNumber: number) =>
      { setRoute({ page: "chapter", bookId, chapterNumber }); closeSidebar(); },
    toAnalytics: (bookId: string) => { setRoute({ page: "analytics", bookId }); closeSidebar(); },
    toServices: () => { setRoute({ page: "services" }); closeSidebar(); },
    toServiceDetail: (id: string) => { setRoute({ page: "service-detail", serviceId: id }); closeSidebar(); },
    toTruth: (bookId: string) => { setRoute({ page: "truth", bookId }); closeSidebar(); },
    toDaemon: () => { setRoute({ page: "daemon" }); closeSidebar(); },
    toLogs: () => { setRoute({ page: "logs" }); closeSidebar(); },
    toGenres: () => { setRoute({ page: "genres" }); closeSidebar(); },
    toStyle: () => { setRoute({ page: "style" }); closeSidebar(); },
    toImport: () => { setRoute({ page: "import" }); closeSidebar(); },
    toRadar: () => { setRoute({ page: "radar" }); closeSidebar(); },
    toDoctor: () => { setRoute({ page: "doctor" }); closeSidebar(); },
  };

  const activeBookId = deriveActiveBookId(route);
  const activePage =
    activeBookId
      ? `book:${activeBookId}`
      : route.page === "service-detail"
        ? "services"
        : route.page;

  if (!ready) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="w-12 h-12 border-4 border-primary/20 border-t-primary rounded-full animate-spin" />
      </div>
    );
  }

  if (projectError) {
    return (
      <div className="min-h-screen claude-surface text-foreground flex items-center justify-center px-6 font-sans">
        <div className="max-w-md rounded-3xl border border-destructive/20 bg-card/85 p-6 shadow-xl shadow-primary/5">
          <div className="text-sm font-semibold text-destructive">Studio 暂时连不上后端</div>
          <p className="mt-3 text-sm leading-7 text-muted-foreground">{projectError}</p>
          <button
            onClick={() => {
              setReady(false);
              refetchProject();
            }}
            className="mt-5 rounded-full bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
          >
            重试
          </button>
        </div>
      </div>
    );
  }

  if (showLanguageSelector) {
    return (
      <LanguageSelector
        onSelect={async (lang) => {
          await postApi("/project/language", { language: lang });
          setShowLanguageSelector(false);
          refetchProject();
        }}
      />
    );
  }

  return (
    <div className="h-[100dvh] claude-surface text-foreground flex overflow-hidden font-sans">
      {/* Left Sidebar — hidden on mobile, shown as overlay when toggled */}
      <div className="hidden md:block h-full">
        <Sidebar nav={nav} activePage={activePage} sse={sse} t={t} />
      </div>
      {sidebarOpen && (
        <Sidebar nav={nav} activePage={activePage} sse={sse} t={t} onClose={closeSidebar} />
      )}

      {/* Center Content */}
      <div className="flex-1 flex flex-col min-w-0 bg-background/20">
        {/* Header Strip */}
        <header className="h-13 sm:h-16 shrink-0 flex items-center justify-between gap-2 px-2.5 sm:px-4 md:px-8 border-b border-border/45 claude-topbar shadow-sm shadow-primary/5 mobile-safe-top">
          <div className="flex min-w-0 items-center gap-1.5 sm:gap-2">
             <button
               onClick={() => setSidebarOpen(true)}
               className="md:hidden flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl text-muted-foreground hover:bg-secondary/80 hover:text-foreground transition-colors"
               aria-label="打开导航"
             >
               <Menu size={20} />
             </button>
             <button
               onClick={nav.toDashboard}
               className="soft-pill inline-flex h-10 min-w-0 max-w-[52vw] items-center gap-2 rounded-full px-3 text-sm font-medium text-foreground hover:border-primary/40 transition-colors sm:max-w-none sm:px-3.5"
             >
               <House size={14} />
               <span className="hidden sm:inline">首页</span>
               <span className="hidden sm:inline text-muted-foreground/70">/</span>
               <span className="truncate font-serif">InkOS Studio</span>
             </button>
          </div>

          <div className="flex shrink-0 items-center gap-2 sm:gap-3">
            <div className="soft-pill flex gap-0.5 rounded-full p-0.5">
              <button
                onClick={async () => {
                  await putApi("/project", { language: "zh" });
                  refetchProject();
                }}
                className={`min-h-8 min-w-8 rounded-full px-2 text-xs transition-colors sm:px-2.5 ${currentLang === "zh" ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
              >
                中
              </button>
              <button
                onClick={async () => {
                  await putApi("/project", { language: "en" });
                  refetchProject();
                }}
                className={`min-h-8 min-w-8 rounded-full px-2 text-xs transition-colors sm:px-2.5 ${currentLang === "en" ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
              >
                EN
              </button>
            </div>

            <button
              onClick={() => setTheme(isDark ? "light" : "dark")}
              className="soft-pill flex h-10 w-10 items-center justify-center rounded-full text-muted-foreground hover:text-foreground transition-colors"
              aria-label={isDark ? "切换到亮色模式" : "切换到暗色模式"}
            >
              {isDark ? <Sun size={14} /> : <Moon size={14} />}
            </button>
          </div>
        </header>

        {/* Main Content Area */}
        <main className="flex-1 relative overflow-y-auto scroll-smooth">
          {route.page === "dashboard" && (
            <div className="max-w-6xl mx-auto px-3 py-4 sm:px-4 sm:py-6 md:px-10 md:py-10 lg:py-12 fade-in">
              <Dashboard nav={nav} sse={sse} theme={theme} t={t} />
            </div>
          )}
          {isBookCreateChatRoute(route) && (
            <div className="absolute inset-0 flex min-w-0">
              <ChatPage
                mode="book-create"
                nav={nav}
                theme={theme}
                t={t}
                sse={sse}
              />
            </div>
          )}
          {route.page === "chat" && (
            <div className="absolute inset-0 flex min-w-0">
              <ChatPage
                mode="project-chat"
                nav={nav}
                theme={theme}
                t={t}
                sse={sse}
              />
            </div>
          )}
          {route.page === "book" && (
            <div className="absolute inset-0 flex min-w-0">
              <ChatPage
                activeBookId={route.bookId}
                mode="book"
                nav={nav}
                theme={theme}
                t={t}
                sse={sse}
              />
              <BookSidebar bookId={route.bookId} theme={theme} t={t} sse={sse} />
              <BookSidebarToggle bookId={route.bookId} theme={theme} t={t} sse={sse} />
            </div>
          )}
          {route.page === "book-settings" && (
            <div className="max-w-6xl mx-auto px-4 py-6 md:px-10 md:py-10 lg:py-12 fade-in">
              <BookDetail bookId={route.bookId} nav={nav} theme={theme} t={t} sse={sse} />
            </div>
          )}
          {route.page === "chapter" && (
            <div className="max-w-6xl mx-auto px-4 py-6 md:px-10 md:py-10 lg:py-12 fade-in">
              <ChapterReader bookId={route.bookId} chapterNumber={route.chapterNumber} nav={nav} theme={theme} t={t} />
            </div>
          )}
          {route.page === "analytics" && (
            <div className="max-w-6xl mx-auto px-4 py-6 md:px-10 md:py-10 lg:py-12 fade-in">
              <Analytics bookId={route.bookId} nav={nav} theme={theme} t={t} />
            </div>
          )}
          {route.page === "services" && (
            <div className="max-w-6xl mx-auto px-4 py-6 md:px-10 md:py-10 lg:py-12 fade-in">
              <ServiceListPage nav={nav} />
            </div>
          )}
          {route.page === "service-detail" && (
            <div className="max-w-6xl mx-auto px-4 py-6 md:px-10 md:py-10 lg:py-12 fade-in">
              <ServiceDetailPage serviceId={route.serviceId} nav={nav} />
            </div>
          )}
          {route.page === "truth" && (
            <div className="max-w-6xl mx-auto px-4 py-6 md:px-10 md:py-10 lg:py-12 fade-in">
              <TruthFiles bookId={route.bookId} nav={nav} theme={theme} t={t} />
            </div>
          )}
          {route.page === "daemon" && (
            <div className="max-w-6xl mx-auto px-4 py-6 md:px-10 md:py-10 lg:py-12 fade-in">
              <DaemonControl nav={nav} theme={theme} t={t} sse={sse} />
            </div>
          )}
          {route.page === "logs" && (
            <div className="max-w-4xl mx-auto px-4 py-8 md:px-12 md:py-12 lg:py-16 fade-in">
              <LogViewer nav={nav} theme={theme} t={t} />
            </div>
          )}
          {route.page === "genres" && (
            <div className="max-w-4xl mx-auto px-4 py-8 md:px-12 md:py-12 lg:py-16 fade-in">
              <GenreManager nav={nav} theme={theme} t={t} />
            </div>
          )}
          {route.page === "style" && (
            <div className="max-w-4xl mx-auto px-4 py-8 md:px-12 md:py-12 lg:py-16 fade-in">
              <StyleManager nav={nav} theme={theme} t={t} />
            </div>
          )}
          {route.page === "import" && (
            <div className="max-w-4xl mx-auto px-4 py-8 md:px-12 md:py-12 lg:py-16 fade-in">
              <ImportManager nav={nav} theme={theme} t={t} />
            </div>
          )}
          {route.page === "radar" && (
            <div className="max-w-4xl mx-auto px-4 py-8 md:px-12 md:py-12 lg:py-16 fade-in">
              <RadarView nav={nav} theme={theme} t={t} />
            </div>
          )}
          {route.page === "doctor" && (
            <div className="max-w-4xl mx-auto px-4 py-8 md:px-12 md:py-12 lg:py-16 fade-in">
              <DoctorView nav={nav} theme={theme} t={t} />
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
