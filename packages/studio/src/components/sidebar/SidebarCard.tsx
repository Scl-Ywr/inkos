import { useEffect, useState } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "../../lib/utils";

const sidebarCardOpenState = new Map<string, boolean>();

interface SidebarCardProps {
  readonly title: string;
  readonly defaultOpen?: boolean;
  readonly children: React.ReactNode;
  readonly actions?: React.ReactNode;
  readonly stateKey?: string;
}

export function SidebarCard({ title, defaultOpen = true, children, actions, stateKey }: SidebarCardProps) {
  const [open, setOpen] = useState(() =>
    stateKey && sidebarCardOpenState.has(stateKey)
      ? sidebarCardOpenState.get(stateKey) ?? defaultOpen
      : defaultOpen,
  );

  useEffect(() => {
    if (!stateKey) {
      setOpen(defaultOpen);
      return;
    }
    setOpen(sidebarCardOpenState.has(stateKey) ? sidebarCardOpenState.get(stateKey) ?? defaultOpen : defaultOpen);
  }, [defaultOpen, stateKey]);

  const toggleOpen = () => {
    setOpen((current) => {
      const next = !current;
      if (stateKey) sidebarCardOpenState.set(stateKey, next);
      return next;
    });
  };

  return (
    <div className="rounded-xl bg-card/60">
      <button
        onClick={toggleOpen}
        className="w-full flex items-center justify-between px-3 py-2.5"
      >
        <span className="text-base font-medium text-foreground font-['SimSun','Songti_SC','STSong',serif]">{title}</span>
        <div className="flex items-center gap-1.5">
          {actions}
          <ChevronDown className={cn("w-4 h-4 text-muted-foreground transition-transform", open && "rotate-180")} />
        </div>
      </button>
      {open && <div className="px-3 pb-3">{children}</div>}
    </div>
  );
}
