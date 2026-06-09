import type { FormEvent } from "react";

type TextElement = HTMLInputElement | HTMLTextAreaElement;

function readTarget(event: FormEvent<TextElement>): TextElement {
  return event.currentTarget;
}

export function readTextInput(event: FormEvent<TextElement>): string {
  return readTarget(event).value;
}

export function syncTextInput(
  event: FormEvent<TextElement>,
  setter: (value: string) => void,
): void {
  setter(readTarget(event).value);
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
