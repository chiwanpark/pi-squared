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
    expect(parseSlashCommand("/help")).toEqual({ name: "help", args: "" });
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
    expect(names).toEqual(
      expect.arrayContaining(["help", "new", "quit", "exit", "model", "thinking", "login", "logout"]),
    );
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
