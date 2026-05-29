import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const CONFIG_FILE_ENV = "PI_SQUARED_CONFIG_FILE";
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

export interface PersistedModelConfig {
  provider: string;
  id: string;
}

export interface PersistedSearchConfig {
  model?: string;
  maxSources?: number;
  timeoutMs?: number;
}

export interface ConfigFileShape {
  model?: PersistedModelConfig;
  thinking?: ThinkingLevel;
  search?: PersistedSearchConfig;
}

export interface ConfigStoreOptions {
  /** Override the on-disk location (used by tests). */
  filePath?: string;
}

/**
 * Persisted user configuration for non-secret preferences.
 *
 * Layout: ~/.pi-squared/config.json (override via PI_SQUARED_CONFIG_FILE).
 */
export class ConfigStore {
  private readonly filePath: string;
  private cache: ConfigFileShape = {};
  private loaded = false;

  constructor(options: ConfigStoreOptions = {}) {
    this.filePath = options.filePath ?? defaultConfigFilePath();
  }

  getFilePath(): string {
    return this.filePath;
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      this.cache = sanitize(parsed);
    } catch (error) {
      if (isNotFound(error)) {
        this.cache = {};
        return;
      }
      throw new Error(
        `Failed to read config file '${this.filePath}': ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  getConfig(): ConfigFileShape {
    return cloneConfig(this.cache);
  }

  getModel(): PersistedModelConfig | undefined {
    return this.cache.model ? { ...this.cache.model } : undefined;
  }

  getThinkingLevel(): ThinkingLevel | undefined {
    return this.cache.thinking;
  }

  getSearchConfig(): PersistedSearchConfig | undefined {
    return this.cache.search ? { ...this.cache.search } : undefined;
  }

  async setModel(provider: string, id: string): Promise<void> {
    await this.update({ model: { provider, id } });
  }

  async setThinkingLevel(thinking: ThinkingLevel): Promise<void> {
    await this.update({ thinking });
  }

  async setModelAndThinking(provider: string, id: string, thinking: ThinkingLevel): Promise<void> {
    await this.update({ model: { provider, id }, thinking });
  }

  async setSearchConfig(search: PersistedSearchConfig): Promise<void> {
    await this.update({ search });
  }

  private async update(patch: ConfigFileShape): Promise<void> {
    await this.load();
    this.cache = sanitize({ ...this.cache, ...patch });
    await this.persist();
  }

  private async persist(): Promise<void> {
    const data = JSON.stringify(this.cache, null, 2);
    await mkdir(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    await writeFile(tmp, `${data}\n`, { mode: 0o600 });
    await rename(tmp, this.filePath);
  }
}

export function defaultConfigFilePath(): string {
  const override = process.env[CONFIG_FILE_ENV];
  if (override && override.length > 0) return override;
  return join(homedir(), ".pi-squared", "config.json");
}

function cloneConfig(config: ConfigFileShape): ConfigFileShape {
  return {
    ...(config.model ? { model: { ...config.model } } : {}),
    ...(config.thinking ? { thinking: config.thinking } : {}),
    ...(config.search ? { search: { ...config.search } } : {}),
  };
}

function sanitize(value: unknown): ConfigFileShape {
  if (!value || typeof value !== "object") return {};
  const record = value as Record<string, unknown>;
  const config: ConfigFileShape = {};

  if (isModelConfig(record.model)) {
    config.model = { provider: record.model.provider, id: record.model.id };
  }

  if (isThinkingLevel(record.thinking)) {
    config.thinking = record.thinking;
  }

  const search = sanitizeSearchConfig(record.search);
  if (search) config.search = search;

  return config;
}

function isModelConfig(value: unknown): value is PersistedModelConfig {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.provider === "string" &&
    record.provider.length > 0 &&
    typeof record.id === "string" &&
    record.id.length > 0
  );
}

function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);
}

function sanitizeSearchConfig(value: unknown): PersistedSearchConfig | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const search: PersistedSearchConfig = {};

  if (typeof record.model === "string" && record.model.trim().length > 0) {
    search.model = record.model.trim();
  }
  if (isPositiveNumber(record.maxSources)) {
    search.maxSources = Math.floor(record.maxSources);
  }
  if (isPositiveNumber(record.timeoutMs)) {
    search.timeoutMs = Math.floor(record.timeoutMs);
  }

  return Object.keys(search).length > 0 ? search : undefined;
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "ENOENT"
  );
}
