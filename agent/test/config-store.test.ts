import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ConfigStore } from "../src/runtime/config-store.js";

describe("ConfigStore", () => {
  let dir: string;
  let filePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pi2-config-"));
    filePath = join(dir, "config.json");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns empty when the file does not exist", async () => {
    const store = new ConfigStore({ filePath });
    await store.load();
    expect(store.getConfig()).toEqual({});
    expect(store.getModel()).toBeUndefined();
    expect(store.getThinkingLevel()).toBeUndefined();
  });

  it("persists model, thinking, and search preferences", async () => {
    const store = new ConfigStore({ filePath });
    await store.setModelAndThinking("anthropic", "claude-sonnet-4-5", "medium");
    await store.setSearchConfig({ model: "gpt-5.4-mini", maxSources: 7, timeoutMs: 30_000 });

    const raw = JSON.parse(await readFile(filePath, "utf8")) as unknown;
    expect(raw).toEqual({
      model: { provider: "anthropic", id: "claude-sonnet-4-5" },
      thinking: "medium",
      search: { model: "gpt-5.4-mini", maxSources: 7, timeoutMs: 30_000 },
    });

    const reloaded = new ConfigStore({ filePath });
    await reloaded.load();
    expect(reloaded.getModel()).toEqual({ provider: "anthropic", id: "claude-sonnet-4-5" });
    expect(reloaded.getThinkingLevel()).toBe("medium");
    expect(reloaded.getSearchConfig()).toEqual({ model: "gpt-5.4-mini", maxSources: 7, timeoutMs: 30_000 });
  });

  it("updates individual preferences without clearing the other one", async () => {
    const store = new ConfigStore({ filePath });
    await store.setModel("anthropic", "claude-sonnet-4-5");
    await store.setThinkingLevel("high");

    expect(store.getConfig()).toEqual({
      model: { provider: "anthropic", id: "claude-sonnet-4-5" },
      thinking: "high",
    });
  });

  it("ignores malformed entries on load", async () => {
    await writeFile(
      filePath,
      JSON.stringify({
        model: { provider: "anthropic" },
        thinking: "very-hard",
        search: { model: "", maxSources: -1, timeoutMs: "slow" },
      }),
    );
    const store = new ConfigStore({ filePath });
    await store.load();
    expect(store.getConfig()).toEqual({});
  });
});
