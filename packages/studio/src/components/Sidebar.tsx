import { useEffect, useMemo, useState } from "react";
import { useApi } from "../hooks/use-api";
import type { SSEMessage } from "../hooks/use-sse";
import { applyBookCollectionEvent, shouldRefetchBookCollections, shouldRefetchDaemonStatus } from "../hooks/use-book-activity";
import type { TFunction } from "../hooks/use-i18n";
import { setProjectChatSessionId } from "../pages/chat-page-state";
import { useChatStore } from "../store/chat";
import { mobileTextInputHandlers } from "../lib/mobile-input";
import { ConfirmDialog } from "./ConfirmDialog";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import {
  Settings,
  Terminal,
  Plus,
  MessageSquare,
  ScrollText,
  Boxes,
  Wand2,
  FileInput,
  Images,
  TrendingUp,
  Stethoscope,
  FolderOpen,
  ChevronRight,
  Loader2,
  MoreHorizontal,
  Pencil,
  Trash2,
  X,
  Gamepad2,
  GitBranch,
  BookPlus,
} from "lucide-react";

// 历史记录里的会话混装多种类型，用图标区分。
function SessionKindIcon({ kind, className }: { readonly kind?: string; readonly className?: string }) {
  const Icon =
    kind === "play" ? Gamepad2
    : kind === "short" ? ScrollText
    : kind === "book-create" ? BookPlus
    : MessageSquare;
  return <Icon size={13} className={className} />;
}

interface BookSummary {
  readonly id: string;
  readonly title: string;
  readonly genre: string;
  readonly status: string;
  readonly chaptersWritten: number;
}

interface Nav {
  toDashboard: () => void;
  toChat: () => void;
  toBook: (id: string) => void;
  toBookCreate: () => void;
  toServices: () => void;
  toProjectSettings: () => void;
  toDaemon: () => void;
  toLogs: () => void;
  toGenres: () => void;
  toStyle: () => void;
  toImport: () => void;
  toImageGen: () => void;
  toImages: () => void;
  toRadar: () => void;
  toDoctor: () => void;
}

export function Sidebar({ nav, activePage, sse, t, onClose, mobileOpen }: {
  nav: Nav;
  activePage: string;
  sse: { messages: ReadonlyArray<SSEMessage> };
  t: TFunction;
  onClose?: () => void;
  mobileOpen?: boolean;
}) {
  const { data, refetch: refetchBooks, mutate: mutateBooks } = useApi<{ books: ReadonlyArray<BookSummary> }>("/books");
  const { data: daemon, refetch: refetchDaemon } = useApi<{ running: boolean }>("/daemon");
  const sessions = useChatStore((s) => s.sessions);
  const sessionIdsByBook = useChatStore((s) => s.sessionIdsByBook);
  const activeSessionId = useChatStore((s) => s.activeSessionId);
  const bookDataVersion = useChatStore((s) => s.bookDataVersion);
  const loadSessionList = useChatStore((s) => s.loadSessionList);
  const loadSessionDetail = useChatStore((s) => s.loadSessionDetail);
  const activateSession = useChatStore((s) => s.activateSession);
  const createDraftSession = useChatStore((s) => s.createDraftSession);
  const setInput = useChatStore((s) => s.setInput);
  const renameSession = useChatStore((s) => s.renameSession);
  const deleteSession = useChatStore((s) => s.deleteSession);
  const [renameTarget, setRenameTarget] = useState<{ sessionId: string; currentTitle: string } | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<{ sessionId: string; title: string } | null>(null);
  const [expandedBooks, setExpandedBooks] = useState<Set<string>>(new Set());
  const [projectChatExpanded, setProjectChatExpanded] = useState(true);

  const books = data?.books ?? [];
  const projectChatKey = "__null__";
  const projectChatSessions = useMemo(
    () =>
      (sessionIdsByBook[projectChatKey] ?? [])
        .map((sessionId) => sessions[sessionId])
        .filter((session): session is NonNullable<(typeof sessions)[string]> => {
          if (!session) return false;
          return Boolean(session.title)
            || session.messages.length > 0
            || session.isDraft
            || session.sessionId === activeSessionId;
        }),
    [activeSessionId, sessionIdsByBook, sessions],
  );

  useEffect(() => {
    const recent = sse.messages.at(-1);
    if (!recent) return;
    if (shouldRefetchBookCollections(recent)) {
      let appliedIncrementally = false;
      mutateBooks((current) => {
        const updatedBooks = applyBookCollectionEvent(current?.books ?? [], recent);
        if (!updatedBooks) return current;
        appliedIncrementally = true;
        return { books: updatedBooks };
      });
      if (appliedIncrementally) {
        return;
      }
      refetchBooks();
    }
    if (shouldRefetchDaemonStatus(recent)) {
      refetchDaemon();
    }
  }, [mutateBooks, refetchBooks, refetchDaemon, sse.messages]);

  // bookDataVersion 变化（外部数据信号）时才重拉当前已展开书的 session 列表；
  // 展开/折叠本身不触发请求（展开由 toggleBook 驱动，已带"首次加载"判断）。
  useEffect(() => {
    void refetchBooks();
    for (const bookId of expandedBooks) {
      void loadSessionList(bookId);
    }
    if (projectChatExpanded) {
      void loadSessionList(null);
    }
  }, [bookDataVersion, loadSessionList, projectChatExpanded, refetchBooks]);

  useEffect(() => {
    if (activePage === "chat") {
      setProjectChatExpanded(true);
      void loadSessionList(null);
    }
  }, [activePage, loadSessionList]);

  const toggleBook = (bookId: string) => {
    setExpandedBooks((prev) => {
      const next = new Set(prev);
      if (next.has(bookId)) {
        next.delete(bookId);
        return next;
      }
      next.add(bookId);
      // 首次展开才拉：已有 sessionIdsByBook 数据就直接用缓存
      if (sessionIdsByBook[bookId] === undefined) {
        void loadSessionList(bookId);
      }
      return next;
    });
  };

  const sessionsByBook = useMemo(
    () =>
      Object.fromEntries(
        books.map((book) => [
          book.id,
          (sessionIdsByBook[book.id] ?? [])
            .map((sessionId) => sessions[sessionId])
            .filter(Boolean),
        ]),
      ) as Record<string, Array<(typeof sessions)[string]>>,
    [books, sessionIdsByBook, sessions],
  );

  const openSession = (bookId: string, sessionId: string) => {
    activateSession(sessionId);
    nav.toBook(bookId);
    void loadSessionDetail(sessionId);
  };

  const handleCreateSession = (bookId: string) => {
    // 前端创建草稿会话：对话区立即变空，但 session 文件不落盘；
    // 发第一条消息时 sendMessage 会调 POST /sessions 真正创建。
    setExpandedBooks((prev) => new Set(prev).add(bookId));
    createDraftSession(bookId);
    nav.toBook(bookId);
  };

  const openProjectChatSession = (sessionId: string) => {
    activateSession(sessionId);
    setProjectChatSessionId(sessionId);
    nav.toChat();
    void loadSessionDetail(sessionId);
  };

  const handleCreateProjectChatSession = () => {
    setProjectChatExpanded(true);
    const sessionId = createDraftSession(null);
    setProjectChatSessionId(sessionId);
    nav.toChat();
  };

  const launchPlay = (playMode: "guided" | "open") => {
    setProjectChatExpanded(true);
    const sessionId = createDraftSession(null, "play", playMode);
    setProjectChatSessionId(sessionId);
    setInput("");
    nav.toChat();
  };

  const toggleProjectChat = () => {
    setProjectChatExpanded((prev) => {
      const next = !prev;
      if (next && sessionIdsByBook[projectChatKey] === undefined) {
        void loadSessionList(null);
      }
      return next;
    });
  };

  const handleRenameConfirm = async () => {
    if (!renameTarget) return;
    const nextTitle = renameValue.trim();
    if (!nextTitle) return;
    await renameSession(renameTarget.sessionId, nextTitle);
    setRenameTarget(null);
    setRenameValue("");
  };

  const handleDeleteConfirm = async () => {
    if (!deleteTarget) return;
    await deleteSession(deleteTarget.sessionId);
    setDeleteTarget(null);
  };

  const sidebarContent = (
    <aside className="h-full w-[min(20rem,calc(100vw-1rem))] shrink-0 select-none overflow-hidden border-r border-border/45 claude-sidebar flex flex-col shadow-2xl shadow-primary/5 md:w-[288px]">
      {/* Logo Area */}
      <div className="flex items-center justify-between px-5 py-4 mobile-safe-top sm:py-5">
        <button
          onClick={nav.toDashboard}
          className="group flex items-center gap-3 rounded-3xl px-2 py-1.5 hover:bg-card/45 transition-all duration-200"
        >
          <div className="w-10 h-10 rounded-full bg-primary flex items-center justify-center text-primary-foreground shadow-lg shadow-primary/25 ring-4 ring-primary/10 group-hover:scale-105 transition-transform">
            <ScrollText size={18} />
          </div>
          <div className="flex flex-col">
            <span className="font-serif text-xl leading-none font-semibold">InkOS</span>
            <span className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground font-semibold mt-1">Studio</span>
          </div>
        </button>
        {onClose && (
          <button
            onClick={onClose}
            className="flex h-11 w-11 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-card/45 hover:text-foreground sm:h-9 sm:w-9"
            aria-label="关闭导航"
          >
            <X size={18} />
          </button>
        )}
      </div>

      {/* Main Navigation */}
      <div className="flex-1 space-y-6 overflow-y-auto px-3 py-2">
        {/* Books Section */}
        <div>
          <div className="px-3 mb-3 flex items-center justify-between">
            <span className="text-[11px] uppercase tracking-widest text-muted-foreground font-bold">
              {t("nav.books")}
            </span>
            <button
              onClick={nav.toBookCreate}
              className="flex min-h-8 items-center gap-1 rounded-lg px-2 py-1 text-[10px] text-muted-foreground transition-all hover:bg-primary/10 hover:text-primary"
            >
              <Plus size={12} />
              <span>{t("nav.newBook")}</span>
            </button>
          </div>

          <div className="space-y-0.5">
            {books.map((book) => {
              const bookSessions = sessionsByBook[book.id] ?? [];
              const isActiveBook = activePage === `book:${book.id}`;
              const isExpanded = expandedBooks.has(book.id);
              return (
                <div key={book.id}>
                  {/* 书名行：点击展开折叠，双击进入书 */}
                  <div className="group/book flex items-center">
                    <button
                      type="button"
                      onClick={() => toggleBook(book.id)}
                      data-active={isActiveBook}
                      className={`claude-nav-item flex min-h-11 min-w-0 flex-1 items-center gap-1.5 rounded-2xl px-2.5 py-2 text-sm transition-colors md:min-h-0 ${
                        isActiveBook ? "text-foreground font-medium" : "text-muted-foreground hover:text-foreground hover:bg-card/45"
                      }`}
                    >
                      <ChevronRight
                        size={12}
                        className={`shrink-0 text-muted-foreground/60 transition-transform ${isExpanded ? "rotate-90" : ""}`}
                      />
                      <FolderOpen size={14} className="shrink-0 text-muted-foreground/60" />
                      <span className="truncate flex-1 text-left">{book.title}</span>
                    </button>
                  </div>

                  {/* 展开后才显示 session 列表 + 新建按钮 */}
                  {isExpanded && (
                    <div className="mt-0.5">
                      {bookSessions.map((session) => {
                        const isActiveSession = isActiveBook && activeSessionId === session.sessionId;
                        const label = getSessionLabel(session);
                        return (
                          <div
                            key={session.sessionId}
                            className={`group/session flex items-center rounded-2xl ${isActiveSession ? "bg-card/70 shadow-sm" : "hover:bg-card/45"}`}
                          >
                            <button
                              type="button"
                              onClick={() => openSession(book.id, session.sessionId)}
                              className="flex min-h-10 min-w-0 flex-1 items-center gap-2 py-1 pl-6 pr-2 text-left text-[13px] transition-colors md:min-h-0"
                            >
                              <SessionKindIcon
                                kind={(session as any).sessionKind}
                                className={`shrink-0 ${isActiveSession ? "text-foreground" : "text-muted-foreground/60 group-hover/session:text-foreground"}`}
                              />
                              <span className={`truncate flex-1 ${isActiveSession ? "text-foreground" : "text-muted-foreground group-hover/session:text-foreground"}`}>
                                {label}
                              </span>
                              {session.isStreaming ? (
                                <Loader2 size={12} className="shrink-0 animate-spin text-primary" />
                              ) : (
                                <span className="shrink-0 text-[11px] text-muted-foreground/40">
                                  {formatRelativeTime(session.sessionId)}
                                </span>
                              )}
                            </button>

                            <DropdownMenu>
                              <DropdownMenuTrigger className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-muted-foreground opacity-100 transition-opacity hover:text-foreground md:h-7 md:w-7 md:opacity-0 md:group-hover/session:opacity-100">
                                <MoreHorizontal size={14} />
                              </DropdownMenuTrigger>
                              <DropdownMenuContent side="right" align="start" className="w-36">
                                <DropdownMenuItem
                                  onClick={() => {
                                    setRenameTarget({ sessionId: session.sessionId, currentTitle: label });
                                    setRenameValue(session.title ?? "");
                                  }}
                                >
                                  <Pencil size={14} />
                                  <span>改名</span>
                                </DropdownMenuItem>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem
                                  variant="destructive"
                                  onClick={() => setDeleteTarget({ sessionId: session.sessionId, title: label })}
                                >
                                  <Trash2 size={14} />
                                  <span>删除</span>
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </div>
                        );
                      })}
                      <button
                        type="button"
                        onClick={() => void handleCreateSession(book.id)}
                        className="flex min-h-10 w-full items-center gap-2 py-1 pl-9 pr-2 text-xs text-muted-foreground/50 transition-colors hover:text-foreground md:min-h-0"
                      >
                        <Plus size={12} />
                        <span>新建会话</span>
                      </button>
                    </div>
                  )}
                </div>
              );
            })}

            {books.length === 0 && (
            <div className="soft-pill mx-3 px-3 py-6 text-xs text-muted-foreground italic text-center rounded-3xl">
                {t("dash.noBooks")}
              </div>
            )}
          </div>
        </div>

        {/* System Section */}
        <div>
          <div className="px-3 mb-3">
            <span className="text-[11px] uppercase tracking-widest text-muted-foreground font-bold">
              {t("nav.system")}
            </span>
          </div>
          <div className="space-y-1">
            <SidebarItem
              label={t("create.genre")}
              icon={<Boxes size={16} />}
              active={activePage === "genres"}
              onClick={nav.toGenres}
            />
            <SidebarItem
              label={t("nav.config")}
              icon={<Settings size={16} />}
              active={activePage === "services"}
              onClick={nav.toServices}
            />
            <SidebarItem
              label={t("nav.projectSettings")}
              icon={<Settings size={16} />}
              active={activePage === "project-settings"}
              onClick={nav.toProjectSettings}
            />
{/*            <SidebarItem
              label={t("nav.daemon")}
              icon={<Zap size={16} />}
              active={activePage === "daemon"}
              onClick={nav.toDaemon}
              badge={daemon?.running ? t("nav.running") : undefined}
              badgeColor={daemon?.running ? "bg-emerald-500/10 text-emerald-500" : "bg-muted text-muted-foreground"}
            />*/}
            <SidebarItem
              label={t("nav.logs")}
              icon={<Terminal size={16} />}
              active={activePage === "logs"}
              onClick={nav.toLogs}
            />
          </div>
        </div>

        {/* Tools Section */}
        <div>
          <div className="px-3 mb-3">
            <span className="text-[11px] uppercase tracking-widest text-muted-foreground font-bold">
              {t("nav.tools")}
            </span>
          </div>
          <div className="space-y-1">
            <SidebarItem
              label={t("nav.createBranching")}
              icon={<GitBranch size={16} />}
              active={false}
              onClick={() => launchPlay("guided")}
            />
            <SidebarItem
              label={t("nav.createFree")}
              icon={<Gamepad2 size={16} />}
              active={false}
              onClick={() => launchPlay("open")}
            />
            <SidebarItem
              label="图片生成"
              icon={<Pencil size={16} />}
              active={activePage === "image-gen"}
              onClick={nav.toImageGen}
            />
            <SidebarItem
              label="图片库"
              icon={<Images size={16} />}
              active={activePage === "images"}
              onClick={nav.toImages}
            />
            <div>
              <div
                data-active={activePage === "chat"}
                className={`claude-nav-item group/chat flex min-h-11 items-center rounded-2xl px-3 py-2.5 text-sm transition-all duration-200 md:min-h-0 ${
                  activePage === "chat"
                    ? "text-foreground font-medium"
                    : "text-foreground font-medium hover:text-foreground hover:bg-card/45"
                }`}
              >
                <button
                  type="button"
                  onClick={() => {
                    nav.toChat();
                    if (!projectChatExpanded) {
                      setProjectChatExpanded(true);
                    }
                    if (sessionIdsByBook[projectChatKey] === undefined) {
                      void loadSessionList(null);
                    }
                  }}
                  className="flex min-w-0 flex-1 items-center gap-3 text-left"
                >
                  <MessageSquare size={16} className={activePage === "chat" ? "text-primary" : "text-muted-foreground group-hover/chat:text-foreground"} />
                  <span className="flex-1 text-left">{t("nav.chat")}</span>
                </button>
                <button
                  type="button"
                  onClick={toggleProjectChat}
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-card/60 hover:text-foreground"
                  aria-label={projectChatExpanded ? "收起普通聊天会话" : "展开普通聊天会话"}
                >
                  <ChevronRight
                    size={13}
                    className={`text-muted-foreground/60 transition-transform ${projectChatExpanded ? "rotate-90" : ""}`}
                  />
                </button>
              </div>

              {projectChatExpanded && (
                <div className="mt-0.5">
                  {projectChatSessions.map((session) => {
                    const isActiveSession = activePage === "chat" && activeSessionId === session.sessionId;
                    const label = getSessionLabel(session);
                    return (
                      <div
                        key={session.sessionId}
                        className={`group/session flex items-center rounded-2xl ${isActiveSession ? "bg-card/70 shadow-sm" : "hover:bg-card/45"}`}
                      >
                        <button
                          type="button"
                          onClick={() => openProjectChatSession(session.sessionId)}
                          className="flex min-h-10 min-w-0 flex-1 items-center gap-2 py-1 pl-6 pr-2 text-left text-[13px] transition-colors md:min-h-0"
                        >
                          <SessionKindIcon
                            kind={(session as any).sessionKind}
                            className={`shrink-0 ${isActiveSession ? "text-foreground" : "text-muted-foreground/60 group-hover/session:text-foreground"}`}
                          />
                          <span className={`truncate flex-1 ${isActiveSession ? "text-foreground" : "text-muted-foreground group-hover/session:text-foreground"}`}>
                            {label}
                          </span>
                          {session.isStreaming ? (
                            <Loader2 size={12} className="shrink-0 animate-spin text-primary" />
                          ) : (
                            <span className="shrink-0 text-[11px] text-muted-foreground/40">
                              {formatRelativeTime(session.sessionId)}
                            </span>
                          )}
                        </button>

                        <DropdownMenu>
                          <DropdownMenuTrigger className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-muted-foreground opacity-100 transition-opacity hover:text-foreground md:h-7 md:w-7 md:opacity-0 md:group-hover/session:opacity-100">
                            <MoreHorizontal size={14} />
                          </DropdownMenuTrigger>
                          <DropdownMenuContent side="right" align="start" className="w-36">
                            <DropdownMenuItem
                              onClick={() => {
                                setRenameTarget({ sessionId: session.sessionId, currentTitle: label });
                                setRenameValue(session.title ?? "");
                              }}
                            >
                              <Pencil size={14} />
                              <span>改名</span>
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              variant="destructive"
                              onClick={() => setDeleteTarget({ sessionId: session.sessionId, title: label })}
                            >
                              <Trash2 size={14} />
                              <span>删除</span>
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    );
                  })}
                  <button
                    type="button"
                    onClick={handleCreateProjectChatSession}
                    className="flex min-h-10 w-full items-center gap-2 py-1 pl-9 pr-2 text-xs text-muted-foreground/50 transition-colors hover:text-foreground md:min-h-0"
                  >
                    <Plus size={12} />
                    <span>新建会话</span>
                  </button>
                </div>
              )}
            </div>
            <SidebarItem
              label={t("nav.style")}
              icon={<Wand2 size={16} />}
              active={activePage === "style"}
              onClick={nav.toStyle}
            />
            <SidebarItem
              label={t("nav.import")}
              icon={<FileInput size={16} />}
              active={activePage === "import"}
              onClick={() => nav.toImport()}
            />
            <SidebarItem
              label={t("nav.radar")}
              icon={<TrendingUp size={16} />}
              active={activePage === "radar"}
              onClick={nav.toRadar}
            />
            <SidebarItem
              label={t("nav.doctor")}
              icon={<Stethoscope size={16} />}
              active={activePage === "doctor"}
              onClick={nav.toDoctor}
            />
          </div>
        </div>
      </div>

      {/* Footer / Status Area — only show when agent is online */}
      {daemon?.running && (
        <div className="p-4 border-t border-border/45 bg-secondary/25">
          <div className="soft-pill flex items-center gap-3 px-3 py-2 rounded-2xl">
            <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
            <span className="text-[11px] font-semibold text-foreground/80 uppercase tracking-wider">
              {t("nav.agentOnline")}
            </span>
          </div>
        </div>
      )}

      <Dialog
        open={renameTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            setRenameTarget(null);
            setRenameValue("");
          }
        }}
      >
        <DialogContent
          showCloseButton={false}
          className="sm:max-w-[360px] p-4 gap-3"
        >
          <DialogHeader className="space-y-0 gap-0">
            <DialogTitle className="font-sans text-sm font-medium">重命名会话</DialogTitle>
          </DialogHeader>
          <input
            id="session-rename-input"
            autoFocus
            value={renameValue}
            {...mobileTextInputHandlers(setRenameValue)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void handleRenameConfirm();
              }
            }}
            placeholder="输入新标题"
            className="w-full rounded-2xl border border-border/70 bg-card/70 px-3 py-2 text-sm outline-none focus:border-ring"
          />
          <DialogFooter className="gap-1 sm:gap-1">
            <button
              type="button"
              onClick={() => {
                setRenameTarget(null);
                setRenameValue("");
              }}
              className="px-3 py-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              取消
            </button>
            <button
              type="button"
              onClick={() => void handleRenameConfirm()}
              disabled={!renameValue.trim()}
              className="px-3 py-1.5 text-xs font-medium rounded-full bg-primary text-primary-foreground hover:opacity-90 transition-opacity disabled:opacity-30"
            >
              保存
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={deleteTarget !== null}
        title="删除会话"
        message={`确认删除“${deleteTarget?.title ?? ""}”吗？该操作只删除这条会话，不影响书籍内容。`}
        confirmLabel="删除"
        cancelLabel="取消"
        variant="danger"
        onConfirm={() => void handleDeleteConfirm()}
        onCancel={() => setDeleteTarget(null)}
      />
    </aside>
  );

  // Mobile overlay mode: wrap sidebar in a backdrop
  if (onClose) {
    const isMobileOpen = mobileOpen ?? true;
    return (
      <div
        className={`fixed inset-0 z-50 md:hidden transition-opacity duration-150 ${isMobileOpen ? "opacity-100" : "pointer-events-none opacity-0"}`}
        aria-hidden={!isMobileOpen}
      >
        <div className="absolute inset-0 bg-black/30 backdrop-blur-sm mobile-sidebar-backdrop" onClick={onClose} />
        <div className={`absolute inset-y-0 left-0 mobile-sidebar-drawer transition-transform duration-150 ${isMobileOpen ? "translate-x-0" : "-translate-x-full"}`}>
          {sidebarContent}
        </div>
      </div>
    );
  }

  return sidebarContent;
}

function getSessionLabel(session: { sessionId: string; title: string | null; messages: ReadonlyArray<{ role: string; content: string }> }): string {
  if (session.title) return session.title;
  // 后端会在第一条用户消息发送时立即把消息内容持久化为占位标题。
  // 这里处理的是"已有消息但标题还没同步回来"的短暂中间态（乐观显示）。
  const firstUserMsg = session.messages.find((m) => m.role === "user")?.content?.trim();
  if (firstUserMsg) {
    const oneLine = firstUserMsg.replace(/\s+/g, " ");
    return oneLine.length > 20 ? `${oneLine.slice(0, 20)}…` : oneLine;
  }
  return "新会话";
}

function formatRelativeTime(sessionId: string): string {
  const rawTs = Number(sessionId.split("-")[0]);
  if (!Number.isFinite(rawTs)) return "";
  const diff = Date.now() - rawTs;
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天`;
  const months = Math.floor(days / 30);
  return `${months} 个月`;
}

function SidebarItem({ label, icon, active, onClick, badge, badgeColor }: {
  label: string;
  icon: React.ReactNode;
  active: boolean;
  onClick: () => void;
  badge?: string;
  badgeColor?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-active={active}
      className={`claude-nav-item group flex min-h-11 w-full items-center gap-3 rounded-2xl px-3 py-2.5 text-sm transition-all duration-200 md:min-h-0 ${
        active
          ? "text-foreground font-medium"
          : "text-foreground font-medium hover:text-foreground hover:bg-card/45"
      }`}
    >
      <span className={`transition-colors ${active ? "text-primary" : "text-muted-foreground group-hover:text-foreground"}`}>
        {icon}
      </span>
      <span className="flex-1 text-left">{label}</span>
      {badge && (
        <span className={`text-[9px] px-1.5 py-0.5 rounded-full font-bold uppercase tracking-tight ${badgeColor}`}>
          {badge}
        </span>
      )}
    </button>
  );
}
