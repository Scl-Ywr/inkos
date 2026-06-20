import { useState, useEffect, useMemo, useCallback, Suspense, lazy } from "react";
import { useHashRoute } from "./hooks/use-hash-route";
import type { HashRoute } from "./hooks/use-hash-route";
import { Sidebar } from "./components/Sidebar";

const Dashboard       = lazy(() => import("./pages/Dashboard").then(m => ({ default: m.Dashboard })));
const ChatPage        = lazy(() => import("./pages/ChatPage").then(m => ({ default: m.ChatPage })));
const BookDetail      = lazy(() => import("./pages/BookDetail").then(m => ({ default: m.BookDetail })));
const ChapterReader   = lazy(() => import("./pages/ChapterReader").then(m => ({ default: m.ChapterReader })));
const Analytics       = lazy(() => import("./pages/Analytics").then(m => ({ default: m.Analytics })));
const ServiceListPage = lazy(() => import("./pages/ServiceListPage").then(m => ({ default: m.ServiceListPage })));
const ServiceDetailPage = lazy(() => import("./pages/ServiceDetailPage").then(m => ({ default: m.ServiceDetailPage })));
const ProjectSettings = lazy(() => import("./pages/ProjectSettings").then(m => ({ default: m.ProjectSettings })));
const TruthFiles      = lazy(() => import("./pages/TruthFiles").then(m => ({ default: m.TruthFiles })));
const DaemonControl   = lazy(() => import("./pages/DaemonControl").then(m => ({ default: m.DaemonControl })));
const LogViewer       = lazy(() => import("./pages/LogViewer").then(m => ({ default: m.LogViewer })));
const GenreManager    = lazy(() => import("./pages/GenreManager").then(m => ({ default: m.GenreManager })));
const StyleManager    = lazy(() => import("./pages/StyleManager").then(m => ({ default: m.StyleManager })));
const ImportManager   = lazy(() => import("./pages/ImportManager").then(m => ({ default: m.ImportManager })));
const ImageLibraryPage = lazy(() => import("./pages/ImageLibraryPage").then(m => ({ default: m.ImageLibraryPage })));
const ImageGenPage    = lazy(() => import("./pages/ImageGenPage").then(m => ({ default: m.ImageGenPage })));
const KnowledgePage   = lazy(() => import("./pages/KnowledgePage").then(m => ({ default: m.KnowledgePage })));
const TimelinePage    = lazy(() => import("./pages/TimelinePage").then(m => ({ default: m.TimelinePage })));
const SchedulePage    = lazy(() => import("./pages/SchedulePage").then(m => ({ default: m.SchedulePage })));
const CharacterGraphPage = lazy(() => import("./pages/CharacterGraphPage").then(m => ({ default: m.CharacterGraphPage })));
const WorldSettingsPage  = lazy(() => import("./pages/WorldSettingsPage").then(m => ({ default: m.WorldSettingsPage })));
const ForeshadowingPage  = lazy(() => import("./pages/ForeshadowingPage").then(m => ({ default: m.ForeshadowingPage })));
const EndingsPage     = lazy(() => import("./pages/EndingsPage").then(m => ({ default: m.EndingsPage })));
const RadarView       = lazy(() => import("./pages/RadarView").then(m => ({ default: m.RadarView })));
const DoctorView      = lazy(() => import("./pages/DoctorView").then(m => ({ default: m.DoctorView })));
const LanguageSelector = lazy(() => import("./pages/LanguageSelector").then(m => ({ default: m.LanguageSelector })));

function PageLoading() {
  return (
    <div className="flex h-full w-full items-center justify-center p-8">
      <div className="h-8 w-8 rounded-full border-[3px] border-primary/20 border-t-primary animate-spin" />
    </div>
  );
}
import { BookSidebar, BookSidebarToggle } from "./components/chat/BookSidebar";
import { useSSE } from "./hooks/use-sse";
import { useSessionEvents } from "./hooks/use-session-events";
import { useTheme } from "./hooks/use-theme";
import { useStyle } from "./hooks/use-style";
import { StylePanel } from "./components/StylePanel";
import { publishLanguageChange, useI18n } from "./hooks/use-i18n";
import { fetchJson, postApi, putApi, useApi } from "./hooks/use-api";
import { AppDialogProvider } from "./lib/app-dialog";
import {
  ensureEmbeddedNodeRunning,
  resetEmbeddedNodeRuntime,
  updateAndroidTaskNotification,
} from "./lib/android-runtime-plugin";
import { isNativeRuntime } from "./lib/mobile-runtime";
import {
  Menu,
  Moon,
  Sun,
  House,
} from "lucide-react";

import { LocalStorageButton } from "./components/LocalStorageButton";
import { RuntimeStatusButton } from "./components/RuntimeStatusButton";
import { TokenDiagnosticsButton } from "./components/TokenDiagnosticsButton";
import { deriveActiveBookId, isBookCreateChatRoute, readAndroidRuntimeDiagnostics } from "./components/app-utils";

export type { HashRoute as Route } from "./hooks/use-hash-route";

export function App() {
  const { route, setRoute } = useHashRoute();
  const sse = useSSE();
  const { theme, setTheme } = useTheme();
  const styleApi = useStyle();
  const { t, lang: currentLang } = useI18n();
  const { data: project, error: projectError, refetch: refetchProject } = useApi<{ language: string; languageExplicit: boolean }>("/project");
  const [showLanguageSelector, setShowLanguageSelector] = useState(false);
  const [ready, setReady] = useState(false);
  const [startupRetryCount, setStartupRetryCount] = useState(0);
  const [startupDiagnostics, setStartupDiagnostics] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const closeSidebar = useCallback(() => setSidebarOpen(false), []);

  const isDark = theme === "dark";

  useEffect(() => {
    document.documentElement.classList.toggle("dark", isDark);
  }, [isDark]);

  // project 加载完成后，等待 SSE 连接就绪，超时 8 秒则直接放行
  useEffect(() => {
    if (!project || sse.connected) return;
    const timer = window.setTimeout(() => setReady(true), 8000);
    return () => window.clearTimeout(timer);
  }, [project, sse.connected]);

  useEffect(() => {
    if (project) {
      setStartupRetryCount(0);
      if (!project.languageExplicit) {
        setShowLanguageSelector(true);
      }
      // 等待 SSE 连接就绪后再进入主界面，避免出现"重连中"闪烁
      if (sse.connected) {
        setReady(true);
      }
    }
  }, [project, sse.connected]);

  useEffect(() => {
    if (!isNativeRuntime()) return;
    const wakeNode = () => {
      if (document.visibilityState === "visible") {
        void ensureEmbeddedNodeRunning();
        window.setTimeout(() => refetchProject(), 300);
        window.setTimeout(() => refetchProject(), 1200);
      }
    };
    void ensureEmbeddedNodeRunning();
    document.addEventListener("visibilitychange", wakeNode);
    window.addEventListener("focus", wakeNode);
    window.addEventListener("online", wakeNode);
    return () => {
      document.removeEventListener("visibilitychange", wakeNode);
      window.removeEventListener("focus", wakeNode);
      window.removeEventListener("online", wakeNode);
    };
  }, [refetchProject]);

  useEffect(() => {
    if (!isNativeRuntime()) return;
    const operation = sse.activeOperations[0];
    if (!operation) {
      void updateAndroidTaskNotification({
        title: "InkOS Studio",
        message: "本地 Node 后端运行中，暂无写作任务",
        busy: false,
      });
      return;
    }
    void updateAndroidTaskNotification({
      title: operation.label?.trim() || "InkOS 正在执行任务",
      message: operation.message?.trim() || "任务正在运行",
      busy: true,
    });
  }, [sse.activeOperations]);

  useEffect(() => {
    if (!projectError || project) return;
    if (startupRetryCount < 24) {
      const timer = window.setTimeout(() => {
        setStartupRetryCount((count) => count + 1);
        refetchProject();
      }, startupRetryCount < 8 ? 1000 : 2500);
      return () => window.clearTimeout(timer);
    }
    setReady(true);
  }, [projectError, project, refetchProject, startupRetryCount]);

  useEffect(() => {
    if (!projectError || !isNativeRuntime()) {
      setStartupDiagnostics("");
      return;
    }
    void readAndroidRuntimeDiagnostics().then(({ status, output }) => {
      setStartupDiagnostics([
        status?.state ? `状态：${status.state}` : "",
        status?.message ?? "",
        output?.trim().slice(-4000) ?? "",
      ].filter(Boolean).join("\n\n"));
    });
  }, [projectError, startupRetryCount]);

  useSessionEvents(sse, route, setRoute);

  const nav = useMemo(() => ({
    toDashboard: () => { setRoute({ page: "dashboard" }); closeSidebar(); },
    toChat: () => { setRoute({ page: "chat" }); closeSidebar(); },
    toBook: (bookId: string) => { setRoute({ page: "book", bookId }); closeSidebar(); },
    toBookSettings: (bookId: string) => { setRoute({ page: "book-settings", bookId }); closeSidebar(); },
    toBookCreate: () => { setRoute({ page: "book-create" }); closeSidebar(); },
    toChapter: (bookId: string, chapterNumber: number) =>
      { setRoute({ page: "chapter", bookId, chapterNumber }); closeSidebar(); },
    toAnalytics: (bookId: string) => { setRoute({ page: "analytics", bookId }); closeSidebar(); },
    toServices: () => { setRoute({ page: "services" }); closeSidebar(); },
    toProjectSettings: () => { setRoute({ page: "project-settings" }); closeSidebar(); },
    toServiceDetail: (id: string) => { setRoute({ page: "service-detail", serviceId: id }); closeSidebar(); },
    toTruth: (bookId: string) => { setRoute({ page: "truth", bookId }); closeSidebar(); },
    toKnowledge: (bookId: string) => { setRoute({ page: "knowledge", bookId }); closeSidebar(); },
    toTimeline: (bookId: string) => { setRoute({ page: "timeline", bookId }); closeSidebar(); },
    toSchedule: (bookId: string) => { setRoute({ page: "schedule", bookId }); closeSidebar(); },
    toCharacterGraph: (bookId: string) => { setRoute({ page: "character-graph", bookId }); closeSidebar(); },
    toWorldSettings: (bookId: string) => { setRoute({ page: "world-settings", bookId }); closeSidebar(); },
    toForeshadowing: (bookId: string) => { setRoute({ page: "foreshadowing", bookId }); closeSidebar(); },
    toEndings: (bookId: string) => { setRoute({ page: "endings", bookId }); closeSidebar(); },
    toDaemon: () => { setRoute({ page: "daemon" }); closeSidebar(); },
    toLogs: () => { setRoute({ page: "logs" }); closeSidebar(); },
    toGenres: () => { setRoute({ page: "genres" }); closeSidebar(); },
    toStyle: () => { setRoute({ page: "style" }); closeSidebar(); },
    toImport: (tab?: "chapters" | "canon" | "fanfic" | "spinoff" | "imitation") => { setRoute({ page: "import", ...(tab ? { tab } : {}) }); closeSidebar(); },
    toImageGen: () => { setRoute({ page: "image-gen" }); closeSidebar(); },
    toImages: () => { setRoute({ page: "images" }); closeSidebar(); },
    toRadar: () => { setRoute({ page: "radar" }); closeSidebar(); },
    toDoctor: () => { setRoute({ page: "doctor" }); closeSidebar(); },
  }), [setRoute, closeSidebar]);

  const activeBookId = deriveActiveBookId(route);
  const activePage =
    activeBookId
      ? `book:${activeBookId}`
      : route.page === "service-detail"
        ? "services"
        : route.page;

  if (!ready) {
    return (
      <div className="min-h-screen claude-surface text-foreground flex items-center justify-center px-6 font-sans overflow-hidden relative">
        {/* Floating decorative particles */}
        <div className="absolute inset-0 pointer-events-none">
          <div className="absolute top-[15%] left-[20%] w-2 h-2 rounded-full bg-primary/30" style={{ animation: "splash-float 4s ease-in-out infinite" }} />
          <div className="absolute top-[25%] right-[25%] w-1.5 h-1.5 rounded-full bg-accent/40" style={{ animation: "splash-float 5s ease-in-out infinite 1s" }} />
          <div className="absolute bottom-[30%] left-[15%] w-2.5 h-2.5 rounded-full bg-primary/20" style={{ animation: "splash-float 6s ease-in-out infinite 2s" }} />
          <div className="absolute bottom-[20%] right-[20%] w-1.5 h-1.5 rounded-full bg-accent/30" style={{ animation: "splash-float 4.5s ease-in-out infinite 0.5s" }} />
          <div className="absolute top-[60%] left-[60%] w-1 h-1 rounded-full bg-primary/25" style={{ animation: "splash-float 7s ease-in-out infinite 3s" }} />
        </div>

        {/* Radial gradient backdrop */}
        <div className="absolute inset-0 pointer-events-none" style={{ background: "radial-gradient(ellipse at 50% 40%, rgba(214,111,117,0.08) 0%, transparent 60%), radial-gradient(ellipse at 30% 70%, rgba(227,189,85,0.06) 0%, transparent 50%)" }} />

        <div className="max-w-sm text-center relative z-10" style={{ animation: "fadeIn 0.8s ease-out" }}>
          {/* Glowing icon */}
          <div className="relative mx-auto w-20 h-20 mb-8">
            <div className="absolute inset-0 rounded-full bg-primary/10" style={{ animation: "splash-glow 3s ease-in-out infinite" }} />
            <div className="absolute inset-[-8px] rounded-full border border-primary/10" style={{ animation: "splash-orbit 12s linear infinite" }}>
              <div className="absolute top-0 left-1/2 w-1.5 h-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary/60" />
            </div>
            <div className="absolute inset-0 flex items-center justify-center">
              <span className="text-3xl font-serif font-bold text-primary" style={{ animation: "splash-glow 3s ease-in-out infinite" }}>Ink</span>
            </div>
          </div>

          {/* Brand text */}
          <h1 className="text-2xl font-serif font-bold tracking-tight text-foreground" style={{ animation: "fadeIn 0.8s ease-out 0.2s both" }}>
            InkOS Studio
          </h1>
          <p className="mt-1.5 text-sm text-muted-foreground" style={{ animation: "fadeIn 0.8s ease-out 0.4s both" }}>
            你的创作工作室
          </p>

          {/* Progress bar */}
          <div className="mt-8 mx-auto max-w-48 h-1 rounded-full bg-muted/60 overflow-hidden" style={{ animation: "fadeIn 0.8s ease-out 0.6s both" }}>
            <div className="h-full rounded-full bg-gradient-to-r from-primary/60 via-primary to-accent/60" style={{ animation: "splash-progress 4s ease-out forwards" }}>
              <div className="h-full w-full relative overflow-hidden">
                <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/30 to-transparent" style={{ animation: "splash-shimmer 1.5s ease-in-out infinite" }} />
              </div>
            </div>
          </div>

          {/* Status text */}
          <p className="mt-4 text-xs text-muted-foreground/70" style={{ animation: "fadeIn 0.8s ease-out 0.8s both" }}>
            {isNativeRuntime() && !sse.connected
              ? (currentLang === "zh" ? "正在连接后端服务..." : "Connecting to backend...")
              : "正在启动服务..."}
            {startupRetryCount > 0 ? ` (${startupRetryCount})` : ""}
          </p>
        </div>
      </div>
    );
  }

  if (projectError) {
    return (
      <div className="min-h-screen claude-surface text-foreground flex items-center justify-center px-6 font-sans">
        <div className="max-w-md rounded-3xl border border-destructive/20 bg-card/85 p-6 shadow-xl shadow-primary/5">
          <div className="text-sm font-semibold text-destructive">Studio 暂时连不上后端</div>
          <p className="mt-3 text-sm leading-7 text-muted-foreground">{projectError}</p>
          {startupDiagnostics && (
            <pre className="mt-4 max-h-48 overflow-auto whitespace-pre-wrap rounded-2xl border border-border/60 bg-muted/40 p-3 text-left text-xs leading-5 text-muted-foreground">
              {startupDiagnostics}
            </pre>
          )}
          <div className="mt-5 flex flex-wrap gap-2">
            <button
              onClick={async () => {
                await ensureEmbeddedNodeRunning();
                setReady(false);
                setStartupRetryCount(0);
                refetchProject();
              }}
              className="rounded-full bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
            >
              重启并重试
            </button>
            {isNativeRuntime() && (
              <button
                onClick={async () => {
                  await resetEmbeddedNodeRuntime();
                  setReady(false);
                  setStartupRetryCount(0);
                  window.setTimeout(() => refetchProject(), 1500);
                }}
                className="rounded-full border border-border bg-card px-4 py-2 text-sm font-medium text-foreground"
              >
                重置运行时缓存
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }

  if (showLanguageSelector) {
    return (
      <Suspense fallback={<PageLoading />}>
        <LanguageSelector
          onSelect={async (lang) => {
            await postApi("/project/language", { language: lang });
            setShowLanguageSelector(false);
            refetchProject();
          }}
        />
      </Suspense>
    );
  }

  return (
    <AppDialogProvider>
    <div className="app-shell h-[100dvh] claude-surface text-foreground flex overflow-hidden font-sans">
      {/* Left Sidebar — hidden on mobile, shown as overlay when toggled */}
      <div className="hidden md:block h-full">
        <Sidebar nav={nav} activePage={activePage} sse={sse} t={t} />
      </div>
      <Sidebar nav={nav} activePage={activePage} sse={sse} t={t} onClose={closeSidebar} mobileOpen={sidebarOpen} />

      {/* Center Content */}
      <div className="app-shell-content flex-1 flex flex-col min-w-0 bg-background/20">
        {/* Header Strip */}
        <header className="app-shell-header relative z-40 min-h-13 sm:min-h-16 shrink-0 flex items-center gap-1.5 overflow-visible px-2 sm:gap-2 sm:px-4 md:px-8 border-b border-border/45 claude-topbar shadow-sm shadow-primary/5 mobile-safe-top">
          <div className="flex shrink-0 items-center gap-1 sm:gap-2">
             <button
               onClick={() => setSidebarOpen(true)}
               className="md:hidden flex h-[2.05rem] w-[2.05rem] shrink-0 touch-manipulation items-center justify-center rounded-2xl text-muted-foreground hover:bg-secondary/80 hover:text-foreground transition-colors sm:h-10 sm:w-10"
               aria-label="打开导航"
             >
               <Menu size={17} />
             </button>
             <button
               onClick={nav.toDashboard}
               className="app-shell-home-button soft-pill inline-flex h-10 w-10 shrink-0 touch-manipulation items-center justify-center gap-2 rounded-full px-0 text-sm font-medium text-foreground transition-colors hover:border-primary/40 sm:w-auto sm:max-w-none sm:justify-start sm:px-3.5"
             >
               <House size={14} />
               <span className="hidden sm:inline">{t("bread.home")}</span>
               <span className="hidden sm:inline text-muted-foreground/70">/</span>
               <span className="hidden truncate font-serif sm:inline">InkOS Studio</span>
             </button>
          </div>

          <div className="app-shell-header-actions flex min-w-0 flex-1 items-center justify-end gap-1 overflow-visible pl-0 pr-0 sm:gap-3">
            {!sse.connected && isNativeRuntime() && (
              <span className="flex items-center gap-1.5 rounded-full bg-amber-500/10 px-2.5 py-1 text-[11px] font-medium text-amber-600">
                <span className="h-1.5 w-1.5 rounded-full bg-amber-500 animate-pulse" />
                {currentLang === "zh" ? "重连中" : "Reconnecting"}
              </span>
            )}
            <RuntimeStatusButton />
            <TokenDiagnosticsButton />
            <LocalStorageButton />
            <div className="app-shell-lang-switch soft-pill flex h-10 shrink-0 gap-0 rounded-full p-0.5">
              <button
                onClick={async () => {
                  publishLanguageChange("zh");
                  await putApi("/project", { language: "zh" });
                  refetchProject();
                }}
                className={`min-h-9 min-w-8 touch-manipulation rounded-full px-1.5 text-xs transition-colors sm:min-h-8 sm:min-w-8 sm:px-2.5 ${currentLang === "zh" ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
              >
                中
              </button>
              <button
                onClick={async () => {
                  publishLanguageChange("en");
                  await putApi("/project", { language: "en" });
                  refetchProject();
                }}
                className={`min-h-9 min-w-8 touch-manipulation rounded-full px-1.5 text-xs transition-colors sm:min-h-8 sm:min-w-8 sm:px-2.5 ${currentLang === "en" ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
              >
                EN
              </button>
            </div>

            <button
              onClick={() => setTheme(isDark ? "light" : "dark")}
              className="soft-pill flex h-10 w-10 shrink-0 touch-manipulation items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground"
              aria-label={isDark ? (currentLang === "zh" ? "切换到亮色模式" : "Switch to light mode") : (currentLang === "zh" ? "切换到暗色模式" : "Switch to dark mode")}
            >
              {isDark ? <Sun size={14} /> : <Moon size={14} />}
            </button>
            <StylePanel {...styleApi} />
          </div>
        </header>

        {/* Main Content Area */}
        <main className="app-shell-main mobile-scroll-area mobile-safe-bottom flex-1 relative overflow-y-auto scroll-smooth">
          <Suspense fallback={<PageLoading />}>
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
              <BookSidebar bookId={route.bookId} theme={theme} t={t} sse={sse} onOpenKnowledge={nav.toKnowledge} />
              <BookSidebarToggle bookId={route.bookId} theme={theme} t={t} sse={sse} onOpenKnowledge={nav.toKnowledge} />
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
          {route.page === "project-settings" && (
            <div className="max-w-6xl mx-auto px-4 py-6 md:px-10 md:py-10 lg:py-12 fade-in">
              <ProjectSettings nav={nav} theme={theme} t={t} />
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
          {route.page === "knowledge" && (
            <div className="max-w-6xl mx-auto px-4 py-6 md:px-10 md:py-10 lg:py-12 fade-in">
              <KnowledgePage bookId={route.bookId} nav={nav} theme={theme} t={t} />
            </div>
          )}
          {route.page === "timeline" && (
            <div className="max-w-6xl mx-auto px-4 py-6 md:px-10 md:py-10 lg:py-12 fade-in">
              <TimelinePage bookId={route.bookId} nav={nav} theme={theme} t={t} />
            </div>
          )}
          {route.page === "schedule" && (
            <div className="max-w-6xl mx-auto px-4 py-6 md:px-10 md:py-10 lg:py-12 fade-in">
              <SchedulePage bookId={route.bookId} nav={nav} theme={theme} t={t} />
            </div>
          )}
          {route.page === "character-graph" && (
            <div className="max-w-6xl mx-auto px-4 py-6 md:px-10 md:py-10 lg:py-12 fade-in">
              <CharacterGraphPage bookId={route.bookId} nav={nav} theme={theme} t={t} />
            </div>
          )}
          {route.page === "world-settings" && (
            <div className="max-w-6xl mx-auto px-4 py-6 md:px-10 md:py-10 lg:py-12 fade-in">
              <WorldSettingsPage bookId={route.bookId} nav={nav} theme={theme} t={t} />
            </div>
          )}
          {route.page === "foreshadowing" && (
            <div className="max-w-6xl mx-auto px-4 py-6 md:px-10 md:py-10 lg:py-12 fade-in">
              <ForeshadowingPage bookId={route.bookId} nav={nav} theme={theme} t={t} />
            </div>
          )}
          {route.page === "endings" && (
            <div className="max-w-6xl mx-auto px-4 py-6 md:px-10 md:py-10 lg:py-12 fade-in">
              <EndingsPage bookId={route.bookId} nav={nav} theme={theme} t={t} />
            </div>
          )}
          {route.page === "daemon" && (
            <div className="max-w-6xl mx-auto px-4 py-6 md:px-10 md:py-10 lg:py-12 fade-in">
              <DaemonControl nav={nav} theme={theme} t={t} sse={sse} />
            </div>
          )}
          {route.page === "logs" && (
            <div className="max-w-6xl mx-auto px-4 py-6 md:px-10 md:py-10 lg:py-12 fade-in">
              <LogViewer nav={nav} theme={theme} t={t} sse={sse} />
            </div>
          )}
          {route.page === "genres" && (
            <div className="max-w-6xl mx-auto px-4 py-6 md:px-10 md:py-10 lg:py-12 fade-in">
              <GenreManager nav={nav} theme={theme} t={t} />
            </div>
          )}
          {route.page === "style" && (
            <div className="max-w-6xl mx-auto px-4 py-6 md:px-10 md:py-10 lg:py-12 fade-in">
              <StyleManager nav={nav} theme={theme} t={t} />
            </div>
          )}
          {route.page === "import" && (
            <div className="max-w-6xl mx-auto px-4 py-6 md:px-10 md:py-10 lg:py-12 fade-in">
              <ImportManager nav={nav} theme={theme} t={t} initialTab={route.tab} />
            </div>
          )}
          {route.page === "image-gen" && (
            <div className="max-w-6xl mx-auto px-4 py-6 md:px-10 md:py-10 lg:py-12 fade-in">
              <ImageGenPage nav={nav} />
            </div>
          )}
          {route.page === "images" && (
            <div className="max-w-6xl mx-auto px-4 py-6 md:px-10 md:py-10 lg:py-12 fade-in">
              <ImageLibraryPage />
            </div>
          )}
          {route.page === "radar" && (
            <div className="max-w-6xl mx-auto px-4 py-6 md:px-10 md:py-10 lg:py-12 fade-in">
              <RadarView nav={nav} theme={theme} t={t} />
            </div>
          )}
          {route.page === "doctor" && (
            <div className="max-w-6xl mx-auto px-4 py-6 md:px-10 md:py-10 lg:py-12 fade-in">
              <DoctorView nav={nav} theme={theme} t={t} />
            </div>
          )}
          </Suspense>
        </main>
      </div>
    </div>
    </AppDialogProvider>
  );
}
