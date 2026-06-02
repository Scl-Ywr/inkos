import type { ReactNode } from "react";
import { cn } from "../lib/utils";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";

export interface StudioSelectOption<T extends string = string> {
  readonly value: T;
  readonly label: ReactNode;
  readonly disabled?: boolean;
}

export function StudioSelect<T extends string = string>({
  value,
  onValueChange,
  options,
  placeholder,
  disabled,
  className,
  triggerClassName,
  contentClassName,
}: {
  readonly value: T | "";
  readonly onValueChange: (value: T) => void;
  readonly options: ReadonlyArray<StudioSelectOption<T>>;
  readonly placeholder?: string;
  readonly disabled?: boolean;
  readonly className?: string;
  readonly triggerClassName?: string;
  readonly contentClassName?: string;
}) {
  return (
    <Select
      value={value || undefined}
      onValueChange={(next) => onValueChange(next as T)}
      disabled={disabled}
    >
      <SelectTrigger
        className={cn(
          "soft-pill h-10 w-full rounded-xl border-border/70 bg-card/70 px-3 text-sm font-medium shadow-sm shadow-primary/5 transition-all hover:border-primary/35 hover:bg-card focus-visible:border-primary/45 focus-visible:ring-primary/15 data-[popup-open]:border-primary/45 data-[popup-open]:ring-4 data-[popup-open]:ring-primary/10",
          className,
          triggerClassName,
        )}
      >
        <SelectValue placeholder={placeholder ?? "请选择"} />
      </SelectTrigger>
      <SelectContent
        align="start"
        sideOffset={6}
        className={cn(
          "z-[80] max-h-[min(20rem,60dvh)] rounded-2xl border border-border/70 bg-popover/95 p-1.5 shadow-2xl shadow-primary/10 ring-1 ring-primary/10 backdrop-blur",
          contentClassName,
        )}
      >
        {options.map((option) => (
          <SelectItem
            key={option.value}
            value={option.value}
            disabled={option.disabled}
            className="min-h-10 rounded-xl px-3 py-2 pr-9 text-sm font-medium transition-colors focus:bg-primary/10 focus:text-foreground data-[state=checked]:bg-primary/10 data-[state=checked]:text-primary"
          >
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
