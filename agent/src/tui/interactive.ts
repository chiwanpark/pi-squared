import { Key, matchesKey, ProcessTerminal, TUI } from "@earendil-works/pi-tui";

import type { PiSquaredAgentRuntime } from "../runtime/pi-agent.js";
import { ChatScreen } from "./chat-screen.js";

export interface InteractiveOptions {
  runtime: PiSquaredAgentRuntime;
  initialMessage?: string;
}

export async function runInteractive(options: InteractiveOptions): Promise<void> {
  const terminal = new ProcessTerminal();
  const tui = new TUI(terminal, true);
  const runtime = options.runtime;

  let stopped = false;
  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });

  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    if (runtime.isBusy) runtime.abort();
    try {
      await terminal.drainInput(150, 30);
    } catch {
      // Best-effort terminal cleanup only.
    }
    tui.stop();
    resolveDone();
  };

  const screen = new ChatScreen(tui, runtime, { onSubmit: (text) => submit(text) });

  const submit = (text: string): void => {
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    if (trimmed === "/quit" || trimmed === "/exit") {
      void stop();
      return;
    }

    screen.editor.addToHistory(trimmed);
    void runtime.prompt(trimmed).catch((error: unknown) => {
      runtime.setLastError(error instanceof Error ? error.message : String(error));
    });
  };

  tui.addChild(screen);
  tui.setFocus(screen.editor);

  runtime.status.subscribe(() => {
    screen.invalidate();
    tui.requestRender();
  });

  tui.addInputListener((data) => {
    if (matchesKey(data, Key.ctrl("c"))) {
      if (runtime.isBusy) {
        runtime.abort();
      } else {
        void stop();
      }
      return { consume: true };
    }

    if (matchesKey(data, Key.escape) && runtime.isBusy) {
      runtime.abort();
      return { consume: true };
    }

    return undefined;
  });

  process.once("SIGTERM", () => {
    void stop();
  });

  tui.start();
  tui.requestRender(true);

  if (options.initialMessage?.trim()) {
    submit(options.initialMessage);
  }

  await done;
}
