import { getSupportedThinkingLevels, type KnownProvider, type Model } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { getOAuthProvider, getOAuthProviders } from "@earendil-works/pi-ai/oauth";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

import type { AuthStore } from "./auth-store.js";

const MODEL_CATALOG = builtinModels();

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

export async function resolveModel(options: ResolveModelOptions): Promise<ResolvedModel> {
  const parsed = parseModelReference(options);
  const providerWasInferred = parsed.provider.length === 0;
  const provider = providerWasInferred ? await inferProvider(options.authStore) : parsed.provider;
  const knownProvider = toKnownProvider(provider);
  const models = getCatalogModels(knownProvider);
  const modelWasInferred = parsed.model.length === 0;
  const model = modelWasInferred
    ? pickDefaultModel(knownProvider, models)
    : findModel(knownProvider, models, parsed.model);

  return {
    model,
    providerWasInferred,
    modelWasInferred,
    apiKeyAvailable: await isModelCredentialed(model, options.authStore),
  };
}

export function normalizeThinkingLevel(model: Model<any>, requested: ThinkingLevel): ThinkingLevel {
  if (requested === "off") return "off";
  const supported = getSupportedThinkingLevels(model);
  return supported.includes(requested) ? requested : "off";
}

export function listKnownProviders(): string[] {
  return getCatalogProviders();
}

export async function listProvidersForSelection(authStore?: AuthStore): Promise<ProviderListEntry[]> {
  await authStore?.load();
  const providers = getCatalogProviders();
  const ordered = orderProviders(providers);
  const modelRegistry = createModelRegistry(authStore);
  const entries = await Promise.all(
    ordered.map(async (id) => {
      const provider = MODEL_CATALOG.getProvider(id);
      const supportsOAuth = provider?.auth.oauth !== undefined || getOAuthProvider(id) !== undefined;
      const credential = await authStore?.read(id);
      const hasOAuth = credential?.type === "oauth";
      const hasStoredKey = credential?.type === "api_key";
      const hasAmbientAuth = !credential && (await hasProviderAmbientAuth(id, modelRegistry).catch(() => false));
      const via: ProviderListEntry["via"] = hasOAuth
        ? "oauth"
        : hasStoredKey
          ? "stored-key"
          : hasAmbientAuth
            ? "env"
            : "none";
      return { id, supportsOAuth, available: via !== "none", via };
    }),
  );
  return entries.filter((entry) => entry.available);
}

export function listApiKeyProviders(authStore?: AuthStore): ApiKeyProviderEntry[] {
  const storedKeys = new Set(authStore?.listApiKeyProviderIds() ?? []);
  return orderProviders(getCatalogProviders())
    .filter((id) => MODEL_CATALOG.getProvider(id)?.auth.apiKey !== undefined)
    .map((id) => ({ id, name: id, hasKey: storedKeys.has(id) }));
}

export function listModelsForProvider(provider: string): ModelListEntry[] {
  const known = toKnownProvider(provider);
  return getCatalogModels(known).map((model) => ({
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
  return pickDefaultModel(known, getCatalogModels(known));
}

export function findModelByReference(provider: string, modelId: string): Model<any> {
  const known = toKnownProvider(provider);
  return findModel(known, getCatalogModels(known), modelId);
}

async function isModelCredentialed(model: Model<any>, authStore?: AuthStore): Promise<boolean> {
  await authStore?.load();
  const credential = await authStore?.read(model.provider);
  if (credential) return true;
  const modelRegistry = createModelRegistry(authStore);
  try {
    return (await modelRegistry.getAuth(model)) !== undefined;
  } catch {
    return false;
  }
}

async function inferProvider(authStore?: AuthStore): Promise<KnownProvider> {
  await authStore?.load();
  if (authStore) {
    for (const provider of PROVIDER_PREFERENCE) {
      if (authStore.getOAuth(provider)) return provider;
    }
    for (const provider of PROVIDER_PREFERENCE) {
      if (authStore.getApiKey(provider)) return provider;
    }
  }

  const modelRegistry = createModelRegistry(authStore);
  for (const provider of PROVIDER_PREFERENCE) {
    if (await hasProviderAmbientAuth(provider, modelRegistry).catch(() => false)) return provider;
  }
  return "anthropic";
}

async function hasProviderAmbientAuth(
  provider: KnownProvider,
  modelRegistry: ReturnType<typeof builtinModels>,
): Promise<boolean> {
  const model = pickDefaultModel(provider, getCatalogModels(provider));
  return (await modelRegistry.getAuth(model)) !== undefined;
}

function createModelRegistry(authStore?: AuthStore): ReturnType<typeof builtinModels> {
  return authStore ? builtinModels({ credentials: authStore }) : builtinModels();
}

function getCatalogProviders(): KnownProvider[] {
  return MODEL_CATALOG.getProviders().map((provider) => provider.id as KnownProvider);
}

function getCatalogModels(provider: KnownProvider): Model<any>[] {
  return [...MODEL_CATALOG.getModels(provider)];
}

function orderProviders(providers: KnownProvider[]): KnownProvider[] {
  return [
    ...PROVIDER_PREFERENCE.filter((entry) => providers.includes(entry)),
    ...providers.filter((entry) => !PROVIDER_PREFERENCE.includes(entry)),
  ];
}

function toKnownProvider(provider: string): KnownProvider {
  const knownProviders = getCatalogProviders();
  const knownProvider = knownProviders.find((candidate) => candidate === provider);
  if (!knownProvider) {
    throw new Error(`Unknown provider '${provider}'. Known providers: ${knownProviders.join(", ")}`);
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
