import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type {
  ApiKeyCredential,
  Credential,
  CredentialStore,
  OAuthCredential,
  OAuthCredentials,
} from "@earendil-works/pi-ai";

const AUTH_FILE_ENV = "PI_SQUARED_AUTH_FILE";

export interface AuthFileShape {
  oauth?: Record<string, OAuthCredentials>;
  apiKeys?: Record<string, string>;
}

export interface AuthStoreOptions {
  /** Override the on-disk location (used by tests). */
  filePath?: string;
}

/**
 * Persisted credential store for pi-squared.
 *
 * Layout: ~/.pi-squared/auth.json (override via PI_SQUARED_AUTH_FILE).
 * OAuth and API key credentials are stored here. The class also implements
 * pi-ai's CredentialStore interface so provider auth can resolve credentials
 * through the new Models API.
 */
export class AuthStore implements CredentialStore {
  private readonly filePath: string;
  private cache: AuthFileShape = {};
  private loaded = false;

  constructor(options: AuthStoreOptions = {}) {
    this.filePath = options.filePath ?? defaultAuthFilePath();
  }

  getFilePath(): string {
    return this.filePath;
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as AuthFileShape;
      this.cache = sanitize(parsed);
    } catch (error) {
      if (isNotFound(error)) {
        this.cache = {};
        return;
      }
      throw new Error(
        `Failed to read auth file '${this.filePath}': ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  getAllOAuth(): Record<string, OAuthCredentials> {
    return { ...(this.cache.oauth ?? {}) };
  }

  getOAuth(providerId: string): OAuthCredentials | undefined {
    return this.cache.oauth?.[providerId];
  }

  async setOAuth(providerId: string, credentials: OAuthCredentials): Promise<void> {
    await this.load();
    const oauth = { ...(this.cache.oauth ?? {}) };
    oauth[providerId] = credentials;
    this.cache = { ...this.cache, oauth };
    await this.persist();
  }

  async removeOAuth(providerId: string): Promise<boolean> {
    await this.load();
    const oauth = { ...(this.cache.oauth ?? {}) };
    if (!(providerId in oauth)) return false;
    delete oauth[providerId];
    this.cache = { ...this.cache, oauth };
    await this.persist();
    return true;
  }

  listOAuthProviderIds(): string[] {
    return Object.keys(this.cache.oauth ?? {});
  }

  getApiKey(providerId: string): string | undefined {
    return this.cache.apiKeys?.[providerId];
  }

  async setApiKey(providerId: string, key: string): Promise<void> {
    await this.load();
    const apiKeys = { ...(this.cache.apiKeys ?? {}) };
    apiKeys[providerId] = key;
    this.cache = { ...this.cache, apiKeys };
    await this.persist();
  }

  async removeApiKey(providerId: string): Promise<boolean> {
    await this.load();
    const apiKeys = { ...(this.cache.apiKeys ?? {}) };
    if (!(providerId in apiKeys)) return false;
    delete apiKeys[providerId];
    this.cache = { ...this.cache, apiKeys };
    await this.persist();
    return true;
  }

  listApiKeyProviderIds(): string[] {
    return Object.keys(this.cache.apiKeys ?? {});
  }

  async read(providerId: string): Promise<Credential | undefined> {
    await this.load();
    return this.getCredentialFromCache(providerId);
  }

  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    await this.load();
    const current = this.getCredentialFromCache(providerId);
    const next = await fn(current);
    if (next === undefined) return current;
    this.setCredentialInCache(providerId, next);
    await this.persist();
    return next;
  }

  async delete(providerId: string): Promise<void> {
    await this.load();
    const oauth = { ...(this.cache.oauth ?? {}) };
    const apiKeys = { ...(this.cache.apiKeys ?? {}) };
    delete oauth[providerId];
    delete apiKeys[providerId];
    this.cache = { ...this.cache, oauth, apiKeys };
    await this.persist();
  }

  private getCredentialFromCache(providerId: string): Credential | undefined {
    const oauth = this.cache.oauth?.[providerId];
    if (oauth) return { ...oauth, type: "oauth" } satisfies OAuthCredential;
    const key = this.cache.apiKeys?.[providerId];
    if (key) return { type: "api_key", key } satisfies ApiKeyCredential;
    return undefined;
  }

  private setCredentialInCache(providerId: string, credential: Credential): void {
    const oauth = { ...(this.cache.oauth ?? {}) };
    const apiKeys = { ...(this.cache.apiKeys ?? {}) };
    if (credential.type === "oauth") {
      const { type: _type, ...stored } = credential;
      oauth[providerId] = stored;
      delete apiKeys[providerId];
    } else {
      if (credential.key) apiKeys[providerId] = credential.key;
      else delete apiKeys[providerId];
      delete oauth[providerId];
    }
    this.cache = { ...this.cache, oauth, apiKeys };
  }

  private async persist(): Promise<void> {
    const data = JSON.stringify(this.cache, null, 2);
    await mkdir(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    await writeFile(tmp, `${data}\n`, { mode: 0o600 });
    await rename(tmp, this.filePath);
  }
}

export function defaultAuthFilePath(): string {
  const override = process.env[AUTH_FILE_ENV];
  if (override && override.length > 0) return override;
  return join(homedir(), ".pi-squared", "auth.json");
}

function sanitize(value: unknown): AuthFileShape {
  if (!value || typeof value !== "object") return {};
  const shape = value as AuthFileShape;
  const oauth: Record<string, OAuthCredentials> = {};
  if (shape.oauth && typeof shape.oauth === "object") {
    for (const [key, entry] of Object.entries(shape.oauth)) {
      if (isOAuthCredentials(entry)) oauth[key] = entry;
    }
  }
  const apiKeys: Record<string, string> = {};
  if (shape.apiKeys && typeof shape.apiKeys === "object") {
    for (const [key, entry] of Object.entries(shape.apiKeys)) {
      if (typeof entry === "string" && entry.length > 0) apiKeys[key] = entry;
    }
  }
  return { oauth, apiKeys };
}

function isOAuthCredentials(value: unknown): value is OAuthCredentials {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.refresh === "string" && typeof record.access === "string" && typeof record.expires === "number";
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "ENOENT"
  );
}
