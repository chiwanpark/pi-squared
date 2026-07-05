import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { AuthStore } from "../src/runtime/auth-store.js";
import { ConfigStore } from "../src/runtime/config-store.js";
import { getDefaultModelForProvider } from "../src/runtime/model-resolver.js";
import { PiSquaredAgentRuntime } from "../src/runtime/pi-agent.js";
import { buildRegistry, createCommands, parseSlashCommand, type CommandContext } from "../src/tui/commands.js";

describe("slash commands", () => {
  it("parses commands and arguments", () => {
    expect(parseSlashCommand("not a command")).toBeNull();
    expect(parseSlashCommand("/quit")).toEqual({ name: "quit", args: "" });
    expect(parseSlashCommand("/model anthropic/claude-sonnet-4-5")).toEqual({
      name: "model",
      args: "anthropic/claude-sonnet-4-5",
    });
    expect(parseSlashCommand("  /login   openai-codex  ")).toEqual({
      name: "login",
      args: "openai-codex",
    });
  });

  it("registers the expected core commands", () => {
    const names = createCommands().map((def) => def.command.name);
    expect(names).not.toContain("help");
    expect(names).toEqual(
      expect.arrayContaining(["new", "continue", "quit", "exit", "model", "thinking", "search", "login", "logout"]),
    );
  });

  it("hides the /exit alias from slash autocomplete", () => {
    const registry = buildRegistry(createCommands());
    const names = registry.commands.map((command) => command.name);

    expect(names).toContain("quit");
    expect(names).not.toContain("exit");
    expect(registry.commands.find((command) => command.name === "quit")?.description).toContain("/exit");
  });

  it("still executes the hidden /exit alias", async () => {
    const { runtime, cleanup } = await createCommandFixture();
    let requestedExit = false;
    try {
      const registry = buildRegistry(createCommands());
      await registry.execute("/exit", {
        ...createCommandContext(runtime),
        requestExit: () => {
          requestedExit = true;
        },
      });

      expect(requestedExit).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it("returns top-level selection-menu Esc to slash autocomplete", async () => {
    const { authStore, configStore, runtime, cleanup } = await createCommandFixture();
    try {
      const registry = buildRegistry(createCommands(authStore, configStore));
      const { ctx, panels, slashMenuOpens } = createInteractiveCommandContext(runtime);

      const executed = registry.execute("/thinking", ctx);
      await waitForPanels(panels, 1);
      panels[0]?.handleInput("\u001b");
      await executed;

      expect(slashMenuOpens.count).toBe(1);
    } finally {
      await cleanup();
    }
  });

  it("returns nested search selection-menu Esc to the search menu", async () => {
    const { authStore, configStore, runtime, cleanup } = await createCommandFixture();
    try {
      const registry = buildRegistry(createCommands(authStore, configStore));
      const { ctx, panels, slashMenuOpens } = createInteractiveCommandContext(runtime);

      const executed = registry.execute("/search", ctx);
      await waitForPanels(panels, 1);
      panels[0]?.handleInput("\r");

      await waitForPanels(panels, 2);
      panels[1]?.handleInput("\u001b");
      await waitForPanels(panels, 3);
      await executed;

      expect(slashMenuOpens.count).toBe(0);
      expect(panels[2]?.render(80).join("\n")).toContain("Search Configuration");
    } finally {
      await cleanup();
    }
  });

  it("returns nested search text-input Esc to the previous selection menu", async () => {
    const { authStore, configStore, runtime, cleanup } = await createCommandFixture();
    try {
      const registry = buildRegistry(createCommands(authStore, configStore));
      const { ctx, panels, slashMenuOpens } = createInteractiveCommandContext(runtime);

      const executed = registry.execute("/search", ctx);
      await waitForPanels(panels, 1);
      panels[0]?.handleInput("\r");

      await waitForPanels(panels, 2);
      panels[1]?.handleInput("\u001b[B");
      panels[1]?.handleInput("\r");

      await waitForPanels(panels, 3);
      panels[2]?.handleInput("\u001b");
      await waitForPanels(panels, 4);
      await executed;

      expect(slashMenuOpens.count).toBe(0);
      expect(panels[3]?.render(80).join("\n")).toContain("Search model");
    } finally {
      await cleanup();
    }
  });

  it("persists thinking changes", async () => {
    const { authStore, configStore, runtime, cleanup } = await createCommandFixture();
    try {
      const registry = buildRegistry(createCommands(authStore, configStore));
      await registry.execute("/thinking off", createCommandContext(runtime));

      expect(configStore.getThinkingLevel()).toBe("off");
    } finally {
      await cleanup();
    }
  });

  it("persists model changes", async () => {
    const { authStore, configStore, runtime, cleanup } = await createCommandFixture();
    try {
      const model = getDefaultModelForProvider("anthropic");
      const registry = buildRegistry(createCommands(authStore, configStore));
      await registry.execute(`/model anthropic/${model.id}`, createCommandContext(runtime));

      expect(configStore.getModel()).toEqual({ provider: "anthropic", id: model.id });
      expect(configStore.getThinkingLevel()).toBe(runtime.status.getSnapshot().thinkingLevel);
    } finally {
      await cleanup();
    }
  });

  it("persists search configuration changes", async () => {
    const { authStore, configStore, runtime, cleanup } = await createCommandFixture();
    try {
      const registry = buildRegistry(createCommands(authStore, configStore));
      const ctx = createCommandContext(runtime);

      await registry.execute("/search model gpt-test", ctx);
      await registry.execute("/search max-sources 8", ctx);
      await registry.execute("/search timeout 30000", ctx);

      expect(runtime.getWebSearchConfig()).toEqual({ model: "gpt-test", maxSources: 8, timeoutMs: 30_000 });
      expect(configStore.getSearchConfig()).toEqual({ model: "gpt-test", maxSources: 8, timeoutMs: 30_000 });
    } finally {
      await cleanup();
    }
  });

  it("updates search configuration through the selection menu", async () => {
    const { authStore, configStore, runtime, cleanup } = await createCommandFixture();
    try {
      const registry = buildRegistry(createCommands(authStore, configStore));
      const { ctx, panels } = createInteractiveCommandContext(runtime);

      const executed = registry.execute("/search", ctx);
      await waitForPanels(panels, 1);
      panels[0]?.handleInput("\u001b[B");
      panels[0]?.handleInput("\r");

      await waitForPanels(panels, 2);
      for (let i = 0; i < 7; i += 1) panels[1]?.handleInput("\u001b[B");
      panels[1]?.handleInput("\r");
      await executed;

      expect(runtime.getWebSearchConfig()).toEqual({ maxSources: 8 });
      expect(configStore.getSearchConfig()).toEqual({ maxSources: 8 });
    } finally {
      await cleanup();
    }
  });

  it("resets search configuration", async () => {
    const { authStore, configStore, runtime, cleanup } = await createCommandFixture();
    try {
      const registry = buildRegistry(createCommands(authStore, configStore));
      const ctx = createCommandContext(runtime);

      await registry.execute("/search model gpt-test", ctx);
      await registry.execute("/search reset", ctx);

      expect(runtime.getWebSearchConfig()).toEqual({});
      expect(configStore.getSearchConfig()).toBeUndefined();
    } finally {
      await cleanup();
    }
  });
});

async function createCommandFixture(): Promise<{
  authStore: AuthStore;
  configStore: ConfigStore;
  runtime: PiSquaredAgentRuntime;
  cleanup: () => Promise<void>;
}> {
  const dir = await mkdtemp(join(tmpdir(), "pi2-commands-"));
  const authStore = new AuthStore({ filePath: join(dir, "auth.json") });
  const configStore = new ConfigStore({ filePath: join(dir, "config.json") });
  const runtime = new PiSquaredAgentRuntime({
    model: getDefaultModelForProvider("anthropic"),
    thinkingLevel: "off",
    authStore,
  });
  return {
    authStore,
    configStore,
    runtime,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

function createCommandContext(runtime: PiSquaredAgentRuntime): CommandContext {
  return {
    tui: {} as CommandContext["tui"],
    screen: { editor: { setText() {} } } as unknown as CommandContext["screen"],
    runtime,
    requestExit() {},
  };
}

function createInteractiveCommandContext(runtime: PiSquaredAgentRuntime): {
  ctx: CommandContext;
  panels: Exclude<Parameters<CommandContext["screen"]["setPanel"]>[0], null>[];
  slashMenuOpens: { count: number };
} {
  const panels: Exclude<Parameters<CommandContext["screen"]["setPanel"]>[0], null>[] = [];
  const slashMenuOpens = { count: 0 };
  const ctx: CommandContext = {
    tui: {} as CommandContext["tui"],
    screen: {
      editor: { setText() {} },
      setPanel(panel: Parameters<CommandContext["screen"]["setPanel"]>[0]) {
        if (panel) panels.push(panel);
      },
      openSlashMenu() {
        slashMenuOpens.count += 1;
      },
    } as unknown as CommandContext["screen"],
    runtime,
    requestExit() {},
  };
  return { ctx, panels, slashMenuOpens };
}

async function waitForPanels(
  panels: Exclude<Parameters<CommandContext["screen"]["setPanel"]>[0], null>[],
  count: number,
): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (panels.length >= count) return;
    await Promise.resolve();
  }
  throw new Error(`Timed out waiting for ${count} panel(s); saw ${panels.length}.`);
}
