import {
  Zap,
  Search,
  FileOutput,
  TrendingUp,
} from "lucide-react";

export interface QuickActionsProps {
  readonly onAction: (command: string) => void;
  readonly disabled: boolean;
  readonly isZh: boolean;
}

interface ChipDef {
  readonly icon: React.ReactNode;
  readonly labelZh: string;
  readonly labelEn: string;
  readonly commandZh: string;
  readonly commandEn: string;
}

const CHIPS: ReadonlyArray<ChipDef> = [
  {
    icon: <Zap size={12} />,
    labelZh: "写下一章",
    labelEn: "Write next",
    commandZh: "写下一章",
    commandEn: "write next",
  },
  {
    icon: <Search size={12} />,
    labelZh: "审计",
    labelEn: "Audit",
    commandZh: "审计",
    commandEn: "audit",
  },
  {
    icon: <FileOutput size={12} />,
    labelZh: "导出",
    labelEn: "Export",
    commandZh: "导出全书",
    commandEn: "export book",
  },
  {
    icon: <TrendingUp size={12} />,
    labelZh: "市场雷达",
    labelEn: "Market radar",
    commandZh: "扫描市场趋势",
    commandEn: "scan market trends",
  },
];

export function QuickActions({ onAction, disabled, isZh }: QuickActionsProps) {
  return (
    <div className="-mx-2 flex gap-2 overflow-x-auto px-2 py-1.5 [scrollbar-width:none] sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-1 sm:py-1 [&::-webkit-scrollbar]:hidden">
      {CHIPS.map((chip) => {
        const label = isZh ? chip.labelZh : chip.labelEn;
        const command = isZh ? chip.commandZh : chip.commandEn;
        return (
          <button
            key={label}
            onClick={() => onAction(command)}
            disabled={disabled}
            className="group flex min-h-10 shrink-0 items-center gap-1.5 rounded-xl border border-border/30 bg-secondary/50 px-3 py-2 text-xs font-medium text-muted-foreground transition-all hover:border-primary/30 hover:bg-primary/5 hover:text-primary disabled:pointer-events-none disabled:opacity-40 sm:min-h-0 sm:rounded-lg sm:py-1.5"
          >
            <span className="group-hover:scale-110 transition-transform">{chip.icon}</span>
            {label}
          </button>
        );
      })}
    </div>
  );
}
