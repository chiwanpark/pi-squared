import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AuthStore } from "../src/runtime/auth-store.js";

describe("AuthStore", () => {
  let dir: string;
  let filePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pi2-auth-"));
    filePath = join(dir, "auth.json");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns empty when the file does not exist", async () => {
    const store = new AuthStore({ filePath });
    await store.load();
    expect(store.getAllOAuth()).toEqual({});
    expect(store.listOAuthProviderIds()).toEqual([]);
  });

  it("persists oauth credentials atomically", async () => {
    const store = new AuthStore({ filePath });
    await store.setOAuth("anthropic", { refresh: "r", access: "a", expires: 100 });
    const raw = JSON.parse(await readFile(filePath, "utf8")) as {
      oauth: Record<string, { access: string }>;
    };
    expect(raw.oauth.anthropic).toEqual({ refresh: "r", access: "a", expires: 100 });

    const reloaded = new AuthStore({ filePath });
    await reloaded.load();
    expect(reloaded.getOAuth("anthropic")?.access).toBe("a");
    expect(reloaded.listOAuthProviderIds()).toEqual(["anthropic"]);
  });

  it("removes oauth credentials and returns whether anything was removed", async () => {
    const store = new AuthStore({ filePath });
    await store.setOAuth("anthropic", { refresh: "r", access: "a", expires: 100 });
    expect(await store.removeOAuth("anthropic")).toBe(true);
    expect(await store.removeOAuth("anthropic")).toBe(false);
    expect(store.listOAuthProviderIds()).toEqual([]);
  });

  it("ignores malformed entries on load", async () => {
    await writeFile(filePath, JSON.stringify({ oauth: { broken: { refresh: 1 } } }));
    const store = new AuthStore({ filePath });
    await store.load();
    expect(store.getAllOAuth()).toEqual({});
  });

  it("persists and retrieves API keys", async () => {
    const store = new AuthStore({ filePath });
    await store.setApiKey("openai", "sk-test-123");
    expect(store.getApiKey("openai")).toBe("sk-test-123");
    expect(store.listApiKeyProviderIds()).toEqual(["openai"]);

    const reloaded = new AuthStore({ filePath });
    await reloaded.load();
    expect(reloaded.getApiKey("openai")).toBe("sk-test-123");
  });

  it("removes API keys and returns whether anything was removed", async () => {
    const store = new AuthStore({ filePath });
    await store.setApiKey("openai", "sk-test");
    expect(await store.removeApiKey("openai")).toBe(true);
    expect(await store.removeApiKey("openai")).toBe(false);
    expect(store.listApiKeyProviderIds()).toEqual([]);
  });

  it("co-exists OAuth and API key entries", async () => {
    const store = new AuthStore({ filePath });
    await store.setOAuth("anthropic", { refresh: "r", access: "a", expires: 100 });
    await store.setApiKey("openai", "sk-key");
    expect(store.listOAuthProviderIds()).toEqual(["anthropic"]);
    expect(store.listApiKeyProviderIds()).toEqual(["openai"]);

    const reloaded = new AuthStore({ filePath });
    await reloaded.load();
    expect(reloaded.getOAuth("anthropic")?.access).toBe("a");
    expect(reloaded.getApiKey("openai")).toBe("sk-key");
  });
});
