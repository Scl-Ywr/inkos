import type { FormEvent } from "react";

type TextElement = HTMLInputElement | HTMLTextAreaElement;
type SelectionDirection = "forward" | "backward" | "none";

interface TextSelectionSnapshot {
  readonly start: number | null;
  readonly end: number | null;
  readonly direction: SelectionDirection | null;
}

function readTarget(event: FormEvent<TextElement>): TextElement {
  return event.currentTarget;
}

function readSelection(element: TextElement): TextSelectionSnapshot {
  return {
    start: element.selectionStart,
    end: element.selectionEnd,
    direction: element.selectionDirection as SelectionDirection | null,
  };
}

function restoreSelection(element: TextElement, selection: TextSelectionSnapshot): void {
  if (globalThis.document?.activeElement !== element) return;
  if (selection.start === null || selection.end === null) return;
  const max = element.value.length;
  const start = Math.min(selection.start, max);
  const end = Math.min(selection.end, max);
  try {
    element.setSelectionRange(start, end, selection.direction ?? "none");
  } catch {
    // Some input types (for example number/range) do not support text selection.
  }
}

export function preserveTextSelectionAfterUpdate(element: TextElement): void {
  const selection = readSelection(element);
  queueMicrotask(() => restoreSelection(element, selection));
  globalThis.requestAnimationFrame?.(() => restoreSelection(element, selection));
}

export function readTextInput(event: FormEvent<TextElement>): string {
  return readTarget(event).value;
}

export function syncTextInput(
  event: FormEvent<TextElement>,
  setter: (value: string) => void,
): void {
  const target = readTarget(event);
  const value = target.value;
  preserveTextSelectionAfterUpdate(target);
  setter(value);
}

export function mobileTextInputHandlers(
  setter: (value: string) => void,
): {
  readonly onChange: (event: FormEvent<TextElement>) => void;
} {
  return {
    onChange: (event) => syncTextInput(event, setter),
  };
}
