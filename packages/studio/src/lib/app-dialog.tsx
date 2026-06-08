import type React from "react";
import { createContext, useContext, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, CheckCircle2, Info, MessageSquareText, X } from "lucide-react";
import { mobileTextInputHandlers } from "./mobile-input";

type DialogTone = "info" | "success" | "danger";

interface DialogRequest {
  readonly kind: "alert" | "confirm" | "prompt";
  readonly title: string;
  readonly message: string;
  readonly tone: DialogTone;
  readonly defaultValue?: string;
  readonly placeholder?: string;
  readonly confirmLabel?: string;
  readonly cancelLabel?: string;
  readonly resolve: (value: boolean | string | null | void) => void;
}

interface AppDialogApi {
  alert(input: DialogInput): Promise<void>;
  confirm(input: DialogInput): Promise<boolean>;
  prompt(input: PromptInput): Promise<string | null>;
}

interface DialogInput {
  readonly title?: string;
  readonly message: string;
  readonly tone?: DialogTone;
  readonly confirmLabel?: string;
  readonly cancelLabel?: string;
}

interface PromptInput extends DialogInput {
  readonly defaultValue?: string;
  readonly placeholder?: string;
}

const DialogContext = createContext<AppDialogApi | null>(null);
let activeDialogApi: AppDialogApi | null = null;

export function AppDialogProvider({ children }: { readonly children: React.ReactNode }) {
  const [request, setRequest] = useState<DialogRequest | null>(null);
  const [promptValue, setPromptValue] = useState("");
  const promptRef = useRef<HTMLTextAreaElement>(null);

  const api = useMemo<AppDialogApi>(() => ({
    alert(input) {
      return new Promise<void>((resolve) => {
        setRequest({
          kind: "alert",
          title: input.title ?? "提示",
          message: input.message,
          tone: input.tone ?? "info",
          confirmLabel: input.confirmLabel ?? "知道了",
          resolve: () => resolve(),
        });
      });
    },
    confirm(input) {
      return new Promise<boolean>((resolve) => {
        setRequest({
          kind: "confirm",
          title: input.title ?? "确认操作",
          message: input.message,
          tone: input.tone ?? "danger",
          confirmLabel: input.confirmLabel ?? "确认",
          cancelLabel: input.cancelLabel ?? "取消",
          resolve: (value) => resolve(Boolean(value)),
        });
      });
    },
    prompt(input) {
      return new Promise<string | null>((resolve) => {
        const value = input.defaultValue ?? "";
        setPromptValue(value);
        setRequest({
          kind: "prompt",
          title: input.title ?? "输入内容",
          message: input.message,
          tone: input.tone ?? "info",
          defaultValue: value,
          placeholder: input.placeholder,
          confirmLabel: input.confirmLabel ?? "继续",
          cancelLabel: input.cancelLabel ?? "取消",
          resolve: (value) => resolve(typeof value === "string" ? value : null),
        });
      });
    },
  }), []);

  activeDialogApi = api;

  const close = (value: boolean | string | null | void) => {
    const current = request;
    setRequest(null);
    current?.resolve(value);
  };

  return (
    <DialogContext.Provider value={api}>
      {children}
      {request ? createPortal(
        <div
          className="fixed inset-0 z-[10000] flex items-center justify-center bg-background/70 px-4 py-[calc(env(safe-area-inset-top)+1rem)] backdrop-blur-xl"
          role="dialog"
          aria-modal="true"
          aria-label={request.title}
          onClick={() => close(request.kind === "confirm" ? false : request.kind === "prompt" ? null : undefined)}
        >
          <div
            className="glass-panel fade-in w-full max-w-sm rounded-[1.75rem] border border-border/70 bg-card/95 p-5 shadow-2xl shadow-primary/10"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-4">
              <div className={`flex items-center gap-2 text-sm font-semibold ${toneClass(request.tone)}`}>
                <DialogIcon tone={request.tone} prompt={request.kind === "prompt"} />
                {request.title}
              </div>
              <button
                type="button"
                onClick={() => close(request.kind === "confirm" ? false : request.kind === "prompt" ? null : undefined)}
                className="soft-pill flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground"
                aria-label="关闭"
              >
                <X size={15} />
              </button>
            </div>
            <p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-muted-foreground">
              {request.message}
            </p>
            {request.kind === "prompt" && (
              <textarea
                ref={promptRef}
                defaultValue={promptValue}
                {...mobileTextInputHandlers(setPromptValue)}
                placeholder={request.placeholder}
                className="mt-4 block min-h-28 w-full rounded-2xl border border-border/55 bg-background/45 px-4 py-3 text-base leading-7 text-foreground outline-none transition-colors focus:border-primary focus:ring-2 focus:ring-primary/20"
                autoFocus
              />
            )}
            <div className={`mt-5 grid gap-3 ${request.kind === "alert" ? "grid-cols-1" : "grid-cols-2"}`}>
              {request.kind !== "alert" && (
                <button
                  type="button"
                  onClick={() => close(request.kind === "prompt" ? null : false)}
                  className="soft-pill h-11 rounded-2xl px-4 text-sm font-semibold text-foreground"
                >
                  {request.cancelLabel}
                </button>
              )}
              <button
                type="button"
                onClick={() => close(request.kind === "prompt" ? (promptRef.current?.value ?? promptValue) : true)}
                className={`inline-flex h-11 items-center justify-center gap-2 rounded-2xl px-4 text-sm font-semibold shadow-lg transition-colors ${
                  request.tone === "danger"
                    ? "bg-destructive text-destructive-foreground shadow-destructive/20 hover:bg-destructive/90"
                    : "bg-primary text-primary-foreground shadow-primary/20 hover:bg-primary/90"
                }`}
              >
                {request.confirmLabel}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      ) : null}
    </DialogContext.Provider>
  );
}

export function useAppDialog(): AppDialogApi {
  const api = useContext(DialogContext);
  if (!api) throw new Error("useAppDialog must be used inside AppDialogProvider");
  return api;
}

export function appAlert(input: string | DialogInput): Promise<void> {
  return requireDialogApi().alert(typeof input === "string" ? { message: input } : input);
}

export function appConfirm(input: string | DialogInput): Promise<boolean> {
  return requireDialogApi().confirm(typeof input === "string" ? { message: input } : input);
}

export function appPrompt(input: string | PromptInput, defaultValue = ""): Promise<string | null> {
  return requireDialogApi().prompt(typeof input === "string" ? { message: input, defaultValue } : input);
}

function requireDialogApi(): AppDialogApi {
  if (!activeDialogApi) {
    return {
      alert: async (input) => { window.alert(input.message); },
      confirm: async (input) => window.confirm(input.message),
      prompt: async (input) => window.prompt(input.message, input.defaultValue ?? ""),
    };
  }
  return activeDialogApi;
}

function toneClass(tone: DialogTone): string {
  if (tone === "danger") return "text-destructive";
  if (tone === "success") return "text-emerald-600 dark:text-emerald-400";
  return "text-primary";
}

function DialogIcon({ tone, prompt }: { readonly tone: DialogTone; readonly prompt: boolean }) {
  if (prompt) return <MessageSquareText size={16} />;
  if (tone === "danger") return <AlertTriangle size={16} />;
  if (tone === "success") return <CheckCircle2 size={16} />;
  return <Info size={16} />;
}
