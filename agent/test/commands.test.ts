import { describe, expect, it } from "vitest";

import { createCommands, parseSlashCommand } from "../src/tui/commands.js";

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
    expect(names).toEqual(expect.arrayContaining(["help", "quit", "exit", "model", "thinking", "login", "logout"]));
  });
});
