import {
  Input,
  SelectList,
  truncateToWidth,
  wrapTextWithAnsi,
  type SelectItem,
  type SelectListTheme,
} from "@earendil-works/pi-tui";

import { style } from "./theme.js";
import type { ChatScreen } from "./chat-screen.js";

const SELECT_THEME: SelectListTheme = {
  selectedPrefix: style.cyan,
  selectedText: style.cyan,
  description: style.gray,
  scrollInfo: style.gray,
  noMatch: style.yellow,
};

function panelSeparator(width: number): string {
  return style.cyan("─".repeat(Math.max(1, width)));
}

export interface SelectOverlayOptions {
  title: string;
  items: SelectItem[];
  maxVisible?: number;
}

/**
 * Show a selectable list in the screen's inline panel area. Resolves with
 * the chosen value, or undefined if the user cancels with Esc.
 */
export function showSelect(screen: ChatScreen, options: SelectOverlayOptions): Promise<string | undefined> {
  if (options.items.length === 0) {
    return Promise.resolve(undefined);
  }

  return new Promise((resolve) => {
    const list = new SelectList(options.items, options.maxVisible ?? 10, SELECT_THEME);
    let settled = false;

    const finish = (value: string | undefined): void => {
      if (settled) return;
      settled = true;
      screen.setPanel(null);
      resolve(value);
    };

    list.onSelect = (item) => finish(item.value);
    list.onCancel = () => finish(undefined);

    screen.setPanel({
      render(width) {
        return [
          panelSeparator(width),
          truncateToWidth(` ${style.bold(options.title)}`, width, ""),
          truncateToWidth(style.gray(" ↑↓ navigate • enter select • esc cancel"), width, ""),
          "",
          ...list.render(width),
        ];
      },
      handleInput(data) {
        list.handleInput(data);
      },
      invalidate() {
        list.invalidate();
      },
    });
  });
}

export interface PromptOverlayOptions {
  title: string;
  message?: string;
  placeholder?: string;
  allowEmpty?: boolean;
}

/**
 * Show a text input prompt in the screen's inline panel area. Resolves with
 * the entered text, or undefined if the user cancels with Esc.
 */
export function showPrompt(screen: ChatScreen, options: PromptOverlayOptions): Promise<string | undefined> {
  return new Promise((resolve) => {
    const input = new Input();
    let settled = false;

    const finish = (value: string | undefined): void => {
      if (settled) return;
      settled = true;
      screen.setPanel(null);
      resolve(value);
    };

    input.onSubmit = (value) => {
      if (!options.allowEmpty && value.trim().length === 0) return;
      finish(value);
    };
    input.onEscape = () => finish(undefined);

    if (options.placeholder) input.setValue("");

    screen.setPanel({
      render(width) {
        const lines: string[] = [panelSeparator(width), truncateToWidth(` ${style.bold(options.title)}`, width, "")];
        if (options.message) {
          for (const chunk of wrapTextWithAnsi(options.message, Math.max(1, width - 2))) {
            lines.push(truncateToWidth(` ${chunk}`, width, ""));
          }
        }
        lines.push(truncateToWidth(style.gray(" enter submit • esc cancel"), width, ""), "");
        for (const line of input.render(Math.max(1, width - 2))) {
          lines.push(truncateToWidth(` ${line}`, width, ""));
        }
        return lines;
      },
      handleInput(data) {
        input.handleInput(data);
      },
      invalidate() {
        input.invalidate();
      },
    });
  });
}

export interface InfoOverlayOptions {
  title: string;
  body: string;
}

export interface InfoOverlayHandle {
  /** Resolves when the overlay is dismissed (by the user or programmatically). */
  promise: Promise<void>;
  /** Dismiss immediately without waiting for user input. */
  dismiss: () => void;
}

/**
 * Show an informational message in the screen's inline panel area. Resolves
 * when the user presses Enter or Esc, or when dismiss() is called.
 */
export function showInfo(screen: ChatScreen, options: InfoOverlayOptions): InfoOverlayHandle {
  let settled = false;
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });

  const finish = (): void => {
    if (settled) return;
    settled = true;
    screen.setPanel(null);
    resolve();
  };

  screen.setPanel({
    render(width) {
      const lines: string[] = [
        panelSeparator(width),
        truncateToWidth(` ${style.bold(options.title)}`, width, ""),
        truncateToWidth(style.gray(" press enter or esc to dismiss"), width, ""),
        "",
      ];
      for (const source of options.body.split("\n")) {
        const wrapped = wrapTextWithAnsi(source.length > 0 ? source : " ", Math.max(1, width - 2));
        for (const chunk of wrapped.length > 0 ? wrapped : [""]) {
          lines.push(truncateToWidth(` ${chunk}`, width, ""));
        }
      }
      return lines;
    },
    handleInput(data) {
      if (data === "\r" || data === "\n" || data === "\u001b") finish();
    },
    invalidate() {},
  });

  return { promise, dismiss: finish };
}
