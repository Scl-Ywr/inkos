import { useState, useEffect, useCallback } from "react";
import { useApi, postApi, fetchJson } from "../hooks/use-api";
import type { Theme } from "../hooks/use-theme";
import type { TFunction } from "../hooks/use-i18n";
import { cn } from "../lib/utils";
import { 
  Calendar, 
  ChevronLeft, 
  ChevronRight, 
  Plus, 
  Check, 
  Target, 
  Flag, 
  Star, 
  Trash2, 
  TrendingUp,
  Clock,
  Zap,
  X
} from "lucide-react";

interface CalendarDay {
  date: string;
  activity: { chaptersWritten: number; chaptersUpdated: number; wordsAdded: number } | null;
  schedule: Array<{ id: string; title: string; type: string; completed: boolean }>;
}

interface ScheduleData {
  calendarDays: CalendarDay[];
  stats: {
    totalDaysActive: number;
    totalWordsWritten: number;
    avgWordsPerDay: number;
    currentStreak: number;
    maxStreak: number;
  };
  scheduleEntries: Array<{ id: string; date: string; title: string; type: "deadline" | "goal" | "milestone"; completed: boolean }>;
}

interface Nav {
  toBookSettings: (id: string) => void;
}

export function SchedulePage({ bookId, nav, theme: _theme, t }: {
  bookId: string;
  nav: Nav;
  theme: Theme;
  t: TFunction;
}) {
  const [data, setData] = useState<ScheduleData | null>(null);
  const [loading, setLoading] = useState(true);
  const [currentMonth, setCurrentMonth] = useState(new Date());
  const [showAddForm, setShowAddForm] = useState(false);
  const [newEntry, setNewEntry] = useState({ date: "", title: "", type: "goal" as const });
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  
  const weekdays = t("schedule.weekdays").split(",");
  const months = t("schedule.months").split(",");

  const fetchSchedule = useCallback(async () => {
    try {
      setLoading(true);
      const response = await fetchJson<ScheduleData>(`/books/${bookId}/schedule`);
      setData(response);
    } catch (error) {
      console.error("Failed to fetch schedule:", error);
    } finally {
      setLoading(false);
    }
  }, [bookId]);

  useEffect(() => {
    fetchSchedule();
  }, [fetchSchedule]);

  const handleAddEntry = async () => {
    if (!newEntry.date || !newEntry.title) return;
    try {
      await postApi(`/books/${bookId}/schedule`, newEntry);
      setNewEntry({ date: "", title: "", type: "goal" });
      setShowAddForm(false);
      fetchSchedule();
    } catch (error) {
      console.error("Failed to add schedule entry:", error);
    }
  };

  const handleToggleComplete = async (entryId: string, completed: boolean) => {
    try {
      await postApi(`/books/${bookId}/schedule/${entryId}/toggle`, { completed: !completed });
      fetchSchedule();
    } catch (error) {
      console.error("Failed to update schedule entry:", error);
    }
  };

  const handleDeleteEntry = async (entryId: string) => {
    try {
      await postApi(`/books/${bookId}/schedule/${entryId}/delete`, {});
      fetchSchedule();
    } catch (error) {
      console.error("Failed to delete schedule entry:", error);
    }
  };

  const daysInMonth = (year: number, month: number) => new Date(year, month + 1, 0).getDate();
  const firstDayOfMonth = (year: number, month: number) => new Date(year, month, 1).getDay();

  const renderCalendar = () => {
    const year = currentMonth.getFullYear();
    const month = currentMonth.getMonth();
    const totalDays = daysInMonth(year, month);
    const startDay = firstDayOfMonth(year, month);
    const cells = [];

    // Empty cells for first week
    for (let i = 0; i < startDay; i++) {
      cells.push(<div key={`empty-${i}`} className="h-12 w-full sm:h-20" />);
    }

    // Actual days
    for (let day = 1; day <= totalDays; day++) {
      const dateStr = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      const dayData = data?.calendarDays.find(d => d.date === dateStr);
      const isToday = new Date().toISOString().slice(0, 10) === dateStr;
      const isSelected = selectedDate === dateStr;

      let intensity = 0;
      if (dayData?.activity) {
        const words = dayData.activity.wordsAdded;
        if (words > 2000) intensity = 3;
        else if (words > 1000) intensity = 2;
        else if (words > 0) intensity = 1;
      }

      const intensityClass = 
        intensity === 3 ? "bg-primary" :
        intensity === 2 ? "bg-primary/70" :
        intensity === 1 ? "bg-primary/15" :
        "";

      cells.push(
        <button
          key={day}
          onClick={() => setSelectedDate(isSelected ? null : dateStr)}
          className={cn(
            "group relative flex h-12 w-full flex-col items-center justify-center rounded-xl transition-all sm:h-20 sm:items-start sm:p-2 border-2",
            isSelected 
              ? "border-primary shadow-lg z-10 bg-card" 
              : "border-transparent hover:bg-muted/40",
            isToday ? "bg-primary/5" : ""
          )}
        >
          <span className={cn(
            "text-xs font-bold sm:text-sm",
            isToday ? "text-primary" : "text-foreground/70"
          )}>
            {day}
          </span>
          
          {intensity > 0 && (
             <div className={cn(
               "mt-auto h-1 w-1/2 rounded-full sm:h-1.5 sm:w-full",
               intensityClass
             )} />
          )}

          {dayData?.schedule && dayData.schedule.length > 0 && (
            <div className="absolute top-1 right-1 flex gap-0.5">
               {dayData.schedule.map((s, i) => (
                 <div key={i} className={`h-1 w-1 rounded-full ${s.completed ? "bg-emerald-500" : "bg-amber-500"}`} />
               ))}
            </div>
          )}
        </button>
      );
    }

    return cells;
  };

  const getTypeIcon = (type: string) => {
    switch (type) {
      case "deadline": return <Flag size={14} className="text-red-500" />;
      case "milestone": return <Star size={14} className="text-amber-500" />;
      default: return <Target size={14} className="text-primary" />;
    }
  };

  if (loading && !data) {
    return (
      <div className="flex flex-col items-center justify-center py-32 space-y-4">
        <div className="w-10 h-10 border-2 border-primary/20 border-t-primary rounded-full animate-spin" />
        <span className="text-sm font-medium text-muted-foreground animate-pulse">{t("common.loading")}</span>
      </div>
    );
  }

  const isZh = t("common.save") === "保存";

  return (
    <div className="space-y-6 sm:space-y-10 animate-in fade-in duration-500">
      <nav className="flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-muted-foreground/60">
        <button onClick={() => nav.toBookSettings(bookId)} className="hover:text-primary transition-colors">
          {bookId}
        </button>
        <span className="text-border/60">/</span>
        <span className="text-foreground">{t("schedule.title")}</span>
      </nav>

      {/* Hero Section */}
      <section className="glass-panel relative overflow-hidden rounded-[2.5rem] p-6 sm:p-10 shadow-3d">
        <div className="relative z-10 flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
          <div className="space-y-4">
            <div className="flex items-center gap-2.5 text-sm font-bold text-primary">
              <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/15 shadow-inner">
                <Calendar size={16} />
              </div>
              <span>PROGRESS & PLAN</span>
            </div>
            <h1 className="text-4xl font-serif font-bold tracking-tight text-foreground sm:text-5xl">
               {isZh ? "写作日历" : "Writing Calendar"}
            </h1>
            <p className="max-w-2xl text-base leading-relaxed text-muted-foreground">
              {isZh 
                ? "见证你的创作旅程。追踪每日字数波动，规划关键章节进度。自律即自由，让每一天的坚持都清晰可见。"
                : "Witness your creative journey. Track daily word counts and plan key chapters. Discipline is freedom, making every day's persistence visible."}
            </p>
          </div>
          <button
            onClick={() => setShowAddForm(true)}
            className="inline-flex h-12 shrink-0 items-center justify-center gap-2 rounded-2xl bg-primary px-6 text-sm font-bold text-primary-foreground shadow-lg shadow-primary/20 transition-all hover:scale-[1.02] active:scale-0.98"
          >
            <Plus size={18} />
            {t("schedule.addPlan")}
          </button>
        </div>
        
        {/* Decor */}
        <div className="absolute -right-16 -top-16 h-64 w-64 rounded-full bg-primary/5 blur-3xl opacity-60" />
      </section>

      {/* Stats Cards */}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-5 sm:gap-6">
        {[
          { label: t("schedule.activeDays"), value: data?.stats.totalDaysActive || 0, icon: Clock, color: "text-blue-500" },
          { label: t("schedule.totalWords"), value: data?.stats.totalWordsWritten.toLocaleString() || 0, icon: TrendingUp, color: "text-emerald-500" },
          { label: t("schedule.avgWords"), value: data?.stats.avgWordsPerDay || 0, icon: Zap, color: "text-amber-500" },
          { label: t("schedule.currentStreak"), value: data?.stats.currentStreak || 0, icon: Target, color: "text-primary" },
          { label: t("schedule.maxStreak"), value: data?.stats.maxStreak || 0, icon: Star, color: "text-purple-500" }
        ].map((stat, i) => (
          <div key={i} className="paper-sheet flex flex-col items-center justify-center rounded-3xl p-5 text-center transition-all hover:-translate-y-1">
             <stat.icon size={18} className={`${stat.color} mb-2 opacity-80`} />
             <div className="text-2xl font-serif font-bold text-foreground">{stat.value}</div>
             <div className="mt-1 text-[10px] font-bold uppercase tracking-widest text-muted-foreground/60">{stat.label}</div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-8 lg:grid-cols-3">
        {/* Calendar Section */}
        <div className="lg:col-span-2 space-y-6">
           <div className="paper-sheet overflow-hidden rounded-[2.5rem]">
              {/* Month Toggle */}
              <div className="flex items-center justify-between border-b border-border/40 bg-muted/10 p-6">
                <button
                  onClick={() => setCurrentMonth(new Date(currentMonth.getFullYear(), currentMonth.getMonth() - 1))}
                  className="soft-pill flex h-10 w-10 items-center justify-center rounded-full text-muted-foreground hover:text-foreground transition-colors"
                >
                  <ChevronLeft size={18} />
                </button>
                <h2 className="text-xl font-bold text-foreground">
                  {currentMonth.getFullYear()}年 {months[currentMonth.getMonth()]}
                </h2>
                <button
                  onClick={() => setCurrentMonth(new Date(currentMonth.getFullYear(), currentMonth.getMonth() + 1))}
                  className="soft-pill flex h-10 w-10 items-center justify-center rounded-full text-muted-foreground hover:text-foreground transition-colors"
                >
                  <ChevronRight size={18} />
                </button>
              </div>

              {/* Grid */}
              <div className="p-4 sm:p-8">
                 <div className="mb-4 grid grid-cols-7 gap-2">
                    {weekdays.map(day => (
                      <div key={day} className="text-center text-[11px] font-bold uppercase tracking-widest text-muted-foreground/60">{day}</div>
                    ))}
                 </div>
                 <div className="grid grid-cols-7 gap-2">
                    {renderCalendar()}
                 </div>
              </div>

              {/* Legend */}
              <div className="flex items-center justify-center gap-6 border-t border-border/40 bg-muted/5 p-5">
                 <div className="flex items-center gap-2 text-[10px] font-bold text-muted-foreground uppercase tracking-wider">
                    <div className="h-2 w-2 rounded-full bg-primary/15" />
                    {t("schedule.lowActivity")}
                 </div>
                 <div className="flex items-center gap-2 text-[10px] font-bold text-muted-foreground uppercase tracking-wider">
                    <div className="h-2 w-2 rounded-full bg-primary/70" />
                    {t("schedule.midActivity")}
                 </div>
                 <div className="flex items-center gap-2 text-[10px] font-bold text-muted-foreground uppercase tracking-wider">
                    <div className="h-2 w-2 rounded-full bg-primary" />
                    {t("schedule.highActivity")}
                 </div>
              </div>
           </div>
        </div>

        {/* Selected Day / Daily Goals */}
        <div className="space-y-6">
           <h2 className="flex items-center gap-2 text-xl font-bold text-foreground">
             <Target size={20} className="text-primary" />
             {selectedDate ? `${selectedDate} ${isZh ? "详情" : "Details"}` : t("schedule.todayPlan")}
           </h2>

           {selectedDate ? (
              <div className="space-y-4">
                 {/* Activity Summary */}
                 {data?.calendarDays.find(d => d.date === selectedDate)?.activity ? (
                    <div className="paper-sheet rounded-3xl p-6 space-y-4">
                       <h3 className="text-xs font-bold uppercase tracking-widest text-primary">{t("schedule.activity")}</h3>
                       <div className="grid grid-cols-2 gap-4">
                          <div className="rounded-2xl bg-secondary/30 p-4">
                             <div className="text-2xl font-serif font-bold text-foreground">
                               {data.calendarDays.find(d => d.date === selectedDate)?.activity?.wordsAdded.toLocaleString()}
                             </div>
                             <div className="text-[10px] font-bold text-muted-foreground uppercase mt-1">{t("schedule.wordsAdded")}</div>
                          </div>
                          <div className="rounded-2xl bg-secondary/30 p-4">
                             <div className="text-2xl font-serif font-bold text-foreground">
                               {data.calendarDays.find(d => d.date === selectedDate)?.activity?.chaptersWritten}
                             </div>
                             <div className="text-[10px] font-bold text-muted-foreground uppercase mt-1">{t("schedule.chaptersWritten")}</div>
                          </div>
                       </div>
                    </div>
                 ) : (
                    <div className="paper-sheet rounded-3xl p-8 text-center text-sm text-muted-foreground italic">
                       {t("schedule.noActivity")}
                    </div>
                 )}

                 {/* Items */}
                 <div className="paper-sheet divide-y divide-border/30 overflow-hidden rounded-3xl">
                    {data?.scheduleEntries.filter(e => e.date === selectedDate).length === 0 ? (
                       <div className="p-8 text-center">
                          <p className="text-sm text-muted-foreground">{t("schedule.noPlan")}</p>
                       </div>
                    ) : (
                       data?.scheduleEntries.filter(e => e.date === selectedDate).map(entry => (
                          <div key={entry.id} className="group flex items-center gap-4 p-5 transition-colors hover:bg-muted/10">
                             <button
                               onClick={() => handleToggleComplete(entry.id, entry.completed)}
                               className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-2 transition-all ${
                                 entry.completed ? "bg-primary border-primary text-primary-foreground scale-110 shadow-lg shadow-primary/20" : "border-border/60 hover:border-primary"
                               }`}
                             >
                               {entry.completed && <Check size={12} strokeWidth={4} />}
                             </button>
                             <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2 mb-0.5">
                                   {getTypeIcon(entry.type)}
                                   <span className={`truncate text-sm font-bold ${entry.completed ? "text-muted-foreground line-through" : "text-foreground"}`}>
                                      {entry.title}
                                   </span>
                                </div>
                             </div>
                             <button
                               onClick={() => handleDeleteEntry(entry.id)}
                               className="opacity-0 group-hover:opacity-100 p-2 rounded-lg text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition-all"
                             >
                               <Trash2 size={14} />
                             </button>
                          </div>
                       ))
                    )}
                 </div>
              </div>
           ) : (
              <div className="paper-sheet flex flex-col items-center justify-center rounded-[2.5rem] p-12 text-center">
                 <div className="h-16 w-16 flex items-center justify-center rounded-full bg-muted/50 text-muted-foreground mb-4">
                    <Calendar size={28} />
                 </div>
                 <p className="text-sm text-muted-foreground leading-relaxed">
                   {t("hud.calendarDetail")}
                 </p>
              </div>
           )}
        </div>
      </div>

      {/* Add Entry Modal */}
      {showAddForm && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-background/80 p-4 backdrop-blur-xl fade-in" onClick={() => setShowAddForm(false)}>
          <div className="glass-panel w-full max-w-md overflow-hidden rounded-[2.5rem] shadow-3d" onClick={e => e.stopPropagation()}>
             <div className="flex items-center justify-between border-b border-border/40 px-8 py-6">
                <h2 className="text-2xl font-bold text-foreground">{t("schedule.addPlan")}</h2>
                <button onClick={() => setShowAddForm(false)} className="soft-pill flex h-10 w-10 items-center justify-center rounded-full text-muted-foreground">
                  <X size={18} />
                </button>
             </div>

             <div className="p-8 space-y-6">
                <div className="space-y-2">
                   <label className="text-xs font-bold uppercase tracking-widest text-muted-foreground ml-1">{t("schedule.planDate")}</label>
                   <input
                     type="date"
                     value={newEntry.date}
                     onChange={(e) => setNewEntry({ ...newEntry, date: e.target.value })}
                     className="h-12 w-full rounded-2xl border border-border/50 bg-background/50 px-4 text-sm font-medium outline-none focus:border-primary/50 focus:ring-4 focus:ring-primary/5 transition-all"
                   />
                </div>
                <div className="space-y-2">
                   <label className="text-xs font-bold uppercase tracking-widest text-muted-foreground ml-1">{t("schedule.planContent")}</label>
                   <input
                     type="text"
                     autoFocus
                     value={newEntry.title}
                     onChange={(e) => setNewEntry({ ...newEntry, title: e.target.value })}
                     placeholder={isZh ? "例如：爆更 5000 字、完成高潮情节" : "e.g. Write 5000 words, finish climax"}
                     className="h-12 w-full rounded-2xl border border-border/50 bg-background/50 px-4 text-sm font-medium outline-none focus:border-primary/50 focus:ring-4 focus:ring-primary/5 transition-all"
                   />
                </div>
                <div className="space-y-2">
                   <label className="text-xs font-bold uppercase tracking-widest text-muted-foreground ml-1">{t("schedule.planType")}</label>
                   <div className="grid grid-cols-3 gap-2">
                      {[
                        { value: "goal", label: t("schedule.goal"), icon: Target },
                        { value: "deadline", label: t("schedule.deadline"), icon: Flag },
                        { value: "milestone", label: t("schedule.milestone"), icon: Star },
                      ].map((type) => (
                        <button
                          key={type.value}
                          onClick={() => setNewEntry({ ...newEntry, type: type.value as any })}
                          className={`flex flex-col items-center justify-center gap-2 h-20 rounded-2xl border transition-all ${
                            newEntry.type === type.value
                              ? "border-primary bg-primary/5 text-primary ring-2 ring-primary/20"
                              : "border-border/50 text-muted-foreground hover:bg-muted/50 hover:text-foreground"
                          }`}
                        >
                          <type.icon size={18} />
                          <span className="text-[10px] font-bold uppercase">{type.label}</span>
                        </button>
                      ))}
                   </div>
                </div>
             </div>

             <div className="flex gap-3 border-t border-border/40 bg-muted/20 px-8 py-6">
                <button
                  onClick={() => setShowAddForm(false)}
                  className="soft-pill flex-1 h-12 rounded-2xl font-bold text-foreground"
                >
                  {t("schedule.discard")}
                </button>
                <button
                  onClick={handleAddEntry}
                  disabled={!newEntry.date || !newEntry.title}
                  className="flex-1 h-12 rounded-2xl bg-primary font-bold text-primary-foreground shadow-lg shadow-primary/20 disabled:opacity-50 transition-all"
                >
                  {t("schedule.setPlan")}
                </button>
             </div>
          </div>
        </div>
      )}
    </div>
  );
}
