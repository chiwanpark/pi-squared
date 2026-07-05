import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AuthStore } from "../src/runtime/auth-store.js";
import {
  findModelByReference,
  getDefaultModelForProvider,
  listKnownProviders,
  listModelsForProvider,
  listOAuthProviders,
  listProvidersForSelection,
  parseModelReference,
  resolveModel,
} from "../src/runtime/model-resolver.js";

const ENV_KEYS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY"];

describe("model-resolver", () => {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
    for (const key of ENV_KEYS) delete process.env[key];
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  it("splits provider/model references", () => {
    expect(parseModelReference({ model: "anthropic/claude-sonnet-4-5" })).toEqual({
      provider: "anthropic",
      model: "claude-sonnet-4-5",
    });
    expect(parseModelReference({ provider: "openai", model: "gpt-5.1" })).toEqual({
      provider: "openai",
      model: "gpt-5.1",
    });
    expect(parseModelReference({})).toEqual({ provider: "", model: "" });
  });

  it("infers anthropic when no credentials are present", async () => {
    const resolved = await resolveModel({});
    expect(resolved.providerWasInferred).toBe(true);
    expect(resolved.model.provider).toBe("anthropic");
    expect(resolved.apiKeyAvailable).toBe(false);
  });

  it("prefers a provider with an env api key", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    const resolved = await resolveModel({});
    expect(resolved.model.provider).toBe("openai");
    expect(resolved.apiKeyAvailable).toBe(true);
  });

  it("prefers an OAuth-authenticated provider over env", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    const dir = await mkdtemp(join(tmpdir(), "pi2-resolver-"));
    try {
      const authStore = new AuthStore({ filePath: join(dir, "auth.json") });
      await authStore.setOAuth("anthropic", { refresh: "r", access: "a", expires: Date.now() + 60_000 });
      const resolved = await resolveModel({ authStore });
      expect(resolved.model.provider).toBe("anthropic");
      expect(resolved.apiKeyAvailable).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects unknown providers", async () => {
    await expect(resolveModel({ provider: "totally-not-real" })).rejects.toThrow(/Unknown provider/);
  });

  it("rejects unknown models", () => {
    expect(() => findModelByReference("anthropic", "not-a-model")).toThrow(/Unknown model/);
  });

  it("returns default model and model list for a provider", () => {
    const def = getDefaultModelForProvider("anthropic");
    expect(def.provider).toBe("anthropic");
    expect(listModelsForProvider("anthropic").length).toBeGreaterThan(0);
    expect(listKnownProviders()).toContain("anthropic");
  });

  it("flags OAuth availability on provider listings", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi2-resolver-"));
    try {
      const authStore = new AuthStore({ filePath: join(dir, "auth.json") });
      await authStore.setOAuth("anthropic", { refresh: "r", access: "a", expires: Date.now() + 60_000 });
      const providers = await listProvidersForSelection(authStore);
      const anthropic = providers.find((entry) => entry.id === "anthropic");
      expect(anthropic?.via).toBe("oauth");
      expect(anthropic?.supportsOAuth).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reports built-in OAuth providers", () => {
    const providers = listOAuthProviders();
    const ids = providers.map((entry) => entry.id);
    expect(ids).toEqual(expect.arrayContaining(["anthropic", "openai-codex", "github-copilot"]));
  });
});
