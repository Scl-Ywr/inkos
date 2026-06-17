import {
  Zap,
  Search,
  Lightbulb,
} from "lucide-react";

export interface QuickActionsProps {
  readonly onAction: (command: string, requestedIntent?: "write_next") => void;
  readonly onScratchpad?: () => void;
  readonly disabled: boolean;
  readonly isZh: boolean;
}

interface ChipDef {
  readonly icon: React.ReactNode;
  readonly labelZh: string;
  readonly labelEn: string;
  readonly commandZh: string;
  readonly commandEn: string;
  readonly requestedIntent?: "write_next";
}

const CHIPS: ReadonlyArray<ChipDef> = [
  {
    icon: <Zap size={12} />,
    labelZh: "写下一章",
    labelEn: "Write next",
    commandZh: "写下一章",
    commandEn: "write next",
    requestedIntent: "write_next",
  },
  {
    icon: <Search size={12} />,
    labelZh: "审计",
    labelEn: "Audit",
    commandZh: "审计",
    commandEn: "audit",
  },
];

export function QuickActions({ onAction, onScratchpad, disabled, isZh }: QuickActionsProps) {
  const Scratchchip = isZh ? "灵感" : "Idea";
  return (
    <div className="legacy-chat-quick-actions contents sm:flex sm:shrink-0 sm:gap-2 sm:overflow-x-auto sm:px-0 sm:py-0">
      {CHIPS.map((chip) => {
        const label = isZh ? chip.labelZh : chip.labelEn;
        const command = isZh ? chip.commandZh : chip.commandEn;
        return (
          <button
            key={label}
            onClick={() => onAction(command, chip.requestedIntent)}
            disabled={disabled}
            className="legacy-chat-quick-action-chip group flex min-h-9 min-w-0 w-full items-center justify-center gap-1.5 rounded-full border border-border/45 bg-card/55 px-2.5 py-1.5 text-xs font-medium text-muted-foreground shadow-sm backdrop-blur transition-all hover:-translate-y-0.5 hover:border-primary/35 hover:bg-primary/5 hover:text-primary disabled:pointer-events-none disabled:opacity-40 sm:w-auto sm:shrink-0 sm:px-3.5"
          >
            <span className="group-hover:scale-110 transition-transform">{chip.icon}</span>
            {label}
          </button>
        );
      })}
      {onScratchpad && (
        <button
          onClick={onScratchpad}
          disabled={disabled}
          className="legacy-chat-quick-action-chip group flex min-h-9 min-w-0 w-full items-center justify-center gap-1.5 rounded-full border border-border/45 bg-card/55 px-2.5 py-1.5 text-xs font-medium text-muted-foreground shadow-sm backdrop-blur transition-all hover:-translate-y-0.5 hover:border-primary/35 hover:bg-primary/5 hover:text-primary disabled:pointer-events-none disabled:opacity-40 sm:w-auto sm:shrink-0 sm:px-3.5"
        >
          <span className="group-hover:scale-110 transition-transform"><Lightbulb size={12} /></span>
          {Scratchchip}
        </button>
      )}
    </div>
  );
}
