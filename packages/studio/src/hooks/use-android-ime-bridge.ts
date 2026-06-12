import { useEffect, type RefObject } from "react";

interface AndroidImeBridgeOptions {
  readonly textareaRef: RefObject<HTMLTextAreaElement | null>;
  readonly sessionId: string | null;
  readonly setValue: (value: string) => void;
}

export function useAndroidImeBridge({
  textareaRef,
  sessionId,
  setValue,
}: AndroidImeBridgeOptions): void {
  useEffect(() => {
    const element = textareaRef.current;
    if (!element) return;
    let focused = document.activeElement === element;
    let composing = false;
    let timer: number | null = null;
    let lastValue = element.value;

    const syncFromDom = () => {
      const next = element.value;
      if (next === lastValue) return;
      lastValue = next;
      setValue(next);
      element.style.height = "auto";
      element.style.height = `${Math.min(element.scrollHeight, 200)}px`;
    };
    const syncAfterImeCommit = () => {
      syncFromDom();
      queueMicrotask(syncFromDom);
      window.setTimeout(syncFromDom, 0);
      window.setTimeout(syncFromDom, 32);
    };
    const poll = () => {
      if (!focused) {
        timer = null;
        return;
      }
      syncFromDom();
      timer = window.setTimeout(poll, composing ? 80 : 160);
    };
    const onFocus = () => {
      focused = true;
      lastValue = element.value;
      if (timer === null) timer = window.setTimeout(poll, 80);
    };
    const onBlur = () => {
      syncAfterImeCommit();
      focused = false;
      if (timer !== null) window.clearTimeout(timer);
      timer = null;
    };
    const onCompositionStart = () => {
      composing = true;
    };
    const onCompositionEnd = () => {
      composing = false;
      syncAfterImeCommit();
    };

    element.addEventListener("focus", onFocus);
    element.addEventListener("blur", onBlur);
    element.addEventListener("compositionstart", onCompositionStart);
    element.addEventListener("beforeinput", syncAfterImeCommit);
    element.addEventListener("input", syncAfterImeCommit);
    element.addEventListener("compositionupdate", syncAfterImeCommit);
    element.addEventListener("compositionend", onCompositionEnd);
    element.addEventListener("textInput", syncAfterImeCommit);
    if (focused) timer = window.setTimeout(poll, 80);

    return () => {
      if (timer !== null) window.clearTimeout(timer);
      element.removeEventListener("focus", onFocus);
      element.removeEventListener("blur", onBlur);
      element.removeEventListener("compositionstart", onCompositionStart);
      element.removeEventListener("beforeinput", syncAfterImeCommit);
      element.removeEventListener("input", syncAfterImeCommit);
      element.removeEventListener("compositionupdate", syncAfterImeCommit);
      element.removeEventListener("compositionend", onCompositionEnd);
      element.removeEventListener("textInput", syncAfterImeCommit);
    };
  }, [sessionId, setValue, textareaRef]);
}
