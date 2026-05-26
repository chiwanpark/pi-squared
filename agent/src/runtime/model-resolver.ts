import {
  getEnvApiKey,
  getModels,
  getProviders,
  getSupportedThinkingLevels,
  type KnownProvider,
  type Model,
} from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

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
}

export interface ResolvedModel {
  model: Model<any>;
  providerWasInferred: boolean;
  modelWasInferred: boolean;
  apiKeyAvailable: boolean;
}

export function parseModelReference(options: ResolveModelOptions): Required<ResolveModelOptions> {
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
  const provider = providerWasInferred ? inferProvider() : parsed.provider;
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
    apiKeyAvailable: getEnvApiKey(model.provider) !== undefined,
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

function inferProvider(): KnownProvider {
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
