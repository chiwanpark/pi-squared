import {
  getEnvApiKey,
  getModels,
  getProviders,
  getSupportedThinkingLevels,
  type KnownProvider,
  type Model,
} from "@earendil-works/pi-ai";
import { getOAuthProvider, getOAuthProviders } from "@earendil-works/pi-ai/oauth";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

import type { AuthStore } from "./auth-store.js";

const PROVIDER_PREFERENCE: KnownProvider[] = [
  "anthropic",
  "openai",
  "google",
  "mistral",
  "openrouter",
  "groq",
  "xai",
  "deepseek",
  "zai",
  "together",
  "fireworks",
  "huggingface",
];

const DEFAULT_MODEL_IDS: Partial<Record<KnownProvider, string>> = {
  anthropic: "claude-sonnet-4-5",
  openai: "gpt-5.1",
  google: "gemini-2.5-pro",
  mistral: "magistral-medium-latest",
  openrouter: "anthropic/claude-sonnet-4.5",
  groq: "openai/gpt-oss-120b",
  xai: "grok-4",
  deepseek: "deepseek-chat",
  zai: "glm-4.6",
};

export interface ResolveModelOptions {
  provider?: string;
  model?: string;
  /** Optional auth store used to detect OAuth-backed providers. */
  authStore?: AuthStore;
}

export interface ResolvedModel {
  model: Model<any>;
  providerWasInferred: boolean;
  modelWasInferred: boolean;
  apiKeyAvailable: boolean;
}

export interface ProviderListEntry {
  id: KnownProvider;
  available: boolean;
  via: "env" | "oauth" | "stored-key" | "none";
  supportsOAuth: boolean;
}

export interface ApiKeyProviderEntry {
  id: KnownProvider;
  name: string;
  hasKey: boolean;
}

export interface ModelListEntry {
  id: string;
  name: string;
  provider: KnownProvider;
  reasoning: boolean;
}

export interface OAuthProviderEntry {
  id: string;
  name: string;
  loggedIn: boolean;
}

export interface ParsedModelReference {
  provider: string;
  model: string;
}

export function parseModelReference(options: ResolveModelOptions): ParsedModelReference {
  let provider = options.provider ?? "";
  let model = options.model ?? "";

  const slash = model.indexOf("/");
  if (!provider && slash > 0) {
    provider = model.slice(0, slash);
    model = model.slice(slash + 1);
  }

  return { provider, model };
}

export function resolveModel(options: ResolveModelOptions): ResolvedModel {
  const parsed = parseModelReference(options);
  const providerWasInferred = parsed.provider.length === 0;
  const provider = providerWasInferred ? inferProvider(options.authStore) : parsed.provider;
  const knownProvider = toKnownProvider(provider);
  const models = getModels(knownProvider);
  const modelWasInferred = parsed.model.length === 0;
  const model = modelWasInferred
    ? pickDefaultModel(knownProvider, models)
    : findModel(knownProvider, models, parsed.model);

  return {
    model,
    providerWasInferred,
    modelWasInferred,
    apiKeyAvailable: isProviderCredentialed(model.provider, options.authStore),
  };
}

export function normalizeThinkingLevel(model: Model<any>, requested: ThinkingLevel): ThinkingLevel {
  if (requested === "off") return "off";
  const supported = getSupportedThinkingLevels(model);
  return supported.includes(requested) ? requested : "off";
}

export function listKnownProviders(): string[] {
  return [...getProviders()];
}

export function listProvidersForSelection(authStore?: AuthStore): ProviderListEntry[] {
  const oauthCreds = authStore?.getAllOAuth() ?? {};
  const storedKeys = new Set(authStore?.listApiKeyProviderIds() ?? []);
  const providers = getProviders();
  const ordered = [
    ...PROVIDER_PREFERENCE.filter((entry) => providers.includes(entry)),
    ...providers.filter((entry) => !PROVIDER_PREFERENCE.includes(entry)),
  ];
  return ordered
    .map((id) => {
      const supportsOAuth = getOAuthProvider(id) !== undefined;
      const hasOAuth = oauthCreds[id] !== undefined;
      const hasStoredKey = storedKeys.has(id);
      const hasEnv = getEnvApiKey(id) !== undefined;
      const via: ProviderListEntry["via"] = hasOAuth ? "oauth" : hasStoredKey ? "stored-key" : hasEnv ? "env" : "none";
      return { id, supportsOAuth, available: via !== "none", via };
    })
    .filter((entry) => entry.available);
}

export function listApiKeyProviders(authStore?: AuthStore): ApiKeyProviderEntry[] {
  const storedKeys = new Set(authStore?.listApiKeyProviderIds() ?? []);
  const providers = getProviders();
  const ordered = [
    ...PROVIDER_PREFERENCE.filter((entry) => providers.includes(entry)),
    ...providers.filter((entry) => !PROVIDER_PREFERENCE.includes(entry)),
  ];
  return ordered.map((id) => ({ id, name: id, hasKey: storedKeys.has(id) }));
}

export function listModelsForProvider(provider: string): ModelListEntry[] {
  const known = toKnownProvider(provider);
  return getModels(known).map((model) => ({
    id: model.id,
    name: model.name,
    provider: known,
    reasoning: model.reasoning,
  }));
}

export function listOAuthProviders(authStore?: AuthStore): OAuthProviderEntry[] {
  const loggedIn = new Set(authStore?.listOAuthProviderIds() ?? []);
  return getOAuthProviders().map((provider) => ({
    id: provider.id,
    name: provider.name,
    loggedIn: loggedIn.has(provider.id),
  }));
}

export function getDefaultModelForProvider(provider: string): Model<any> {
  const known = toKnownProvider(provider);
  return pickDefaultModel(known, getModels(known));
}

export function findModelByReference(provider: string, modelId: string): Model<any> {
  const known = toKnownProvider(provider);
  return findModel(known, getModels(known), modelId);
}

function isProviderCredentialed(provider: string, authStore?: AuthStore): boolean {
  if (authStore && authStore.getOAuth(provider)) return true;
  if (authStore && authStore.getApiKey(provider)) return true;
  return getEnvApiKey(provider) !== undefined;
}

function inferProvider(authStore?: AuthStore): KnownProvider {
  if (authStore) {
    for (const provider of PROVIDER_PREFERENCE) {
      if (authStore.getOAuth(provider)) return provider;
    }
    for (const provider of PROVIDER_PREFERENCE) {
      if (authStore.getApiKey(provider)) return provider;
    }
  }
  for (const provider of PROVIDER_PREFERENCE) {
    if (getEnvApiKey(provider)) return provider;
  }
  return "anthropic";
}

function toKnownProvider(provider: string): KnownProvider {
  const knownProvider = getProviders().find((candidate) => candidate === provider);
  if (!knownProvider) {
    throw new Error(`Unknown provider '${provider}'. Known providers: ${getProviders().join(", ")}`);
  }
  return knownProvider;
}

function pickDefaultModel(provider: KnownProvider, models: Model<any>[]): Model<any> {
  const preferredId = DEFAULT_MODEL_IDS[provider];
  const preferred = preferredId ? models.find((candidate) => candidate.id === preferredId) : undefined;
  if (preferred) return preferred;

  const firstTextModel = models.find((candidate) => candidate.input.includes("text"));
  if (firstTextModel) return firstTextModel;

  const first = models[0];
  if (!first) throw new Error(`Provider '${provider}' has no known models.`);
  return first;
}

function findModel(provider: KnownProvider, models: Model<any>[], modelId: string): Model<any> {
  const exact = models.find((candidate) => candidate.id === modelId);
  if (exact) return exact;

  const lower = modelId.toLowerCase();
  const byName = models.find((candidate) => candidate.name.toLowerCase() === lower);
  if (byName) return byName;

  const sample = models
    .slice(0, 12)
    .map((candidate) => candidate.id)
    .join(", ");
  throw new Error(`Unknown model '${modelId}' for provider '${provider}'. Examples: ${sample}`);
}
