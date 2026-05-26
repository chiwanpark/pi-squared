import { CombinedAutocompleteProvider, Key, matchesKey, ProcessTerminal, TUI } from "@earendil-works/pi-tui";

import type { PiSquaredAgentRuntime } from "../runtime/pi-agent.js";
import { ChatScreen } from "./chat-screen.js";
import { buildRegistry, createCommands, type CommandContext } from "./commands.js";

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
    process.exit(0);
  };

  const screen = new ChatScreen(tui, runtime, { onSubmit: (text) => submit(text) });
  const registry = buildRegistry(createCommands(runtime.authStore));
  const commandContext: CommandContext = {
    tui,
    screen,
    runtime,
    requestExit: () => {
      void stop();
    },
  };

  screen.editor.setAutocompleteProvider(new CombinedAutocompleteProvider(registry.commands, process.cwd()));

  const submit = (text: string): void => {
    const trimmed = text.trim();
    if (trimmed.length === 0) return;

    if (trimmed.startsWith("/")) {
      screen.editor.addToHistory(trimmed);
      void registry.execute(trimmed, commandContext);
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
      // If there's a running operation, abort it
      if (runtime.isBusy) {
        runtime.abort();
      }

      // Clear the editor input (remove the message being typed)
      screen.editor.setText("");

      // Request render to update the UI
      tui.requestRender();

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
