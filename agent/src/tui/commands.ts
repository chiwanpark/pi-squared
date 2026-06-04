import type {
  OAuthAuthInfo,
  OAuthCredentials,
  OAuthDeviceCodeInfo,
  OAuthLoginCallbacks,
  OAuthPrompt,
  OAuthSelectPrompt,
} from "@earendil-works/pi-ai";
import type { OAuthProviderInterface } from "@earendil-works/pi-ai/oauth";
import { getOAuthProvider, getOAuthProviders } from "@earendil-works/pi-ai/oauth";
import type { AutocompleteItem, SlashCommand, TUI } from "@earendil-works/pi-tui";

import { Sequence as OscSequence } from "@tsports/go-osc52";

import type { AuthStore } from "../runtime/auth-store.js";
import type { ConfigStore, PersistedSearchConfig } from "../runtime/config-store.js";
import type { ChatScreen } from "./chat-screen.js";
import type { PiSquaredAgentRuntime } from "../runtime/pi-agent.js";
import {
  findModelByReference,
  listApiKeyProviders,
  listModelsForProvider,
  listOAuthProviders,
  listProvidersForSelection,
  normalizeThinkingLevel,
} from "../runtime/model-resolver.js";
import {
  DEFAULT_MAX_SOURCES,
  DEFAULT_SEARCH_MODEL,
  DEFAULT_SEARCH_TIMEOUT_MS,
  MAX_ALLOWED_SOURCES,
} from "../tools/web/index.js";
import { showInfo, showPrompt, showSelect } from "./overlays.js";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

export interface CommandContext {
  tui: TUI;
  screen: ChatScreen;
  runtime: PiSquaredAgentRuntime;
  /** Request the interactive loop to stop and exit. */
  requestExit: () => void;
}

export interface CommandDefinition {
  command: SlashCommand;
  execute(args: string, ctx: CommandContext): Promise<void>;
}

export interface ParsedCommand {
  name: string;
  args: string;
}

export function parseSlashCommand(text: string): ParsedCommand | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;
  const body = trimmed.slice(1);
  const space = body.indexOf(" ");
  if (space === -1) return { name: body.trim(), args: "" };
  return { name: body.slice(0, space).trim(), args: body.slice(space + 1).trim() };
}

/**
 * Build the slash command registry. Returns both the commands the editor
 * autocomplete uses and the handler map for dispatching submitted commands.
 */
export function createCommands(authStore?: AuthStore, configStore?: ConfigStore): CommandDefinition[] {
  return [
    helpCommand(),
    newSessionCommand(),
    continueCommand(),
    quitCommand("quit"),
    quitCommand("exit"),
    modelCommand(authStore, configStore),
    thinkingCommand(configStore),
    searchCommand(configStore),
    loginCommand(),
    logoutCommand(),
  ];
}

export interface CommandRegistry {
  commands: SlashCommand[];
  execute(text: string, ctx: CommandContext): Promise<boolean>;
}

export function buildRegistry(definitions: CommandDefinition[] = createCommands()): CommandRegistry {
  const byName = new Map<string, CommandDefinition>();
  for (const def of definitions) byName.set(def.command.name, def);
  return {
    commands: definitions.map((def) => def.command),
    async execute(text, ctx) {
      const parsed = parseSlashCommand(text);
      if (!parsed) return false;
      const def = byName.get(parsed.name);
      if (!def) {
        ctx.runtime.setNotice(`Unknown command '/${parsed.name}'. Type /help for available commands.`, "warn");
        return true;
      }
      try {
        await def.execute(parsed.args, ctx);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.runtime.setNotice(`/${parsed.name} failed: ${message}`, "error");
      }
      return true;
    },
  };
}

function helpCommand(): CommandDefinition {
  return {
    command: { name: "help", description: "Show available slash commands" },
    async execute(_args, ctx) {
      const lines = [
        "/help                 show this help",
        "/new                  clear chat and start a new session",
        "/continue             retry the last cancelled or failed request",
        "/quit, /exit          leave the chat",
        "/model [ref]          switch model (e.g. anthropic/claude-sonnet-4-5)",
        "/thinking [level]     off | minimal | low | medium | high | xhigh",
        "/search              configure search_web defaults",
        "/login [provider]     authenticate via OAuth (Anthropic, ChatGPT, GitHub Copilot)",
        "/logout [provider]    clear OAuth credentials",
        "",
        "Pass /command with no argument to open an interactive selector.",
      ];
      await showInfo(ctx.screen, { title: "Slash Commands", body: lines.join("\n") }).promise;
    },
  };
}

function newSessionCommand(): CommandDefinition {
  return {
    command: { name: "new", description: "Clear chat and start a new session" },
    async execute(_args, ctx) {
      ctx.runtime.newSession();
      ctx.screen.editor.setText("");
      ctx.runtime.setNotice("Started a new session.", "info");
    },
  };
}

function continueCommand(): CommandDefinition {
  return {
    command: { name: "continue", description: "Retry the last cancelled or failed request" },
    async execute(_args, ctx) {
      await ctx.runtime.continueLast();
    },
  };
}

function quitCommand(name: "quit" | "exit"): CommandDefinition {
  return {
    command: { name, description: name === "quit" ? "Exit pi-squared" : "Exit pi-squared (alias for /quit)" },
    async execute(_args, ctx) {
      ctx.requestExit();
    },
  };
}

function modelCommand(authStore?: AuthStore, configStore?: ConfigStore): CommandDefinition {
  return {
    command: {
      name: "model",
      description: "Switch model",
      argumentHint: "[provider/]model-id",
      getArgumentCompletions: (prefix) => completeModelReference(prefix, authStore),
    },
    async execute(args, ctx) {
      if (args.length > 0) {
        const next = resolveModelReference(args, ctx.runtime.authStore);
        await applyModel(ctx, next.provider, next.model, configStore);
        return;
      }

      const providers = listProvidersForSelection(ctx.runtime.authStore);
      const providerChoice = await showSelect(ctx.screen, {
        title: "Select provider",
        items: providers.map((entry) => ({
          value: entry.id,
          label: entry.id,
          description: providerAvailabilityLabel(entry.via),
        })),
      });
      if (!providerChoice) return;

      const models = listModelsForProvider(providerChoice);
      const modelChoice = await showSelect(ctx.screen, {
        title: `Select model (${providerChoice})`,
        items: models.map((entry) => ({
          value: entry.id,
          label: entry.id,
          description: entry.reasoning ? `${entry.name} · reasoning` : entry.name,
        })),
      });
      if (!modelChoice) return;

      await applyModel(ctx, providerChoice, modelChoice, configStore);
    },
  };
}

function thinkingCommand(configStore?: ConfigStore): CommandDefinition {
  return {
    command: {
      name: "thinking",
      description: "Set thinking level",
      argumentHint: "off|minimal|low|medium|high|xhigh",
      getArgumentCompletions: (prefix) =>
        THINKING_LEVELS.filter((level) => level.startsWith(prefix)).map((level) => ({
          value: level,
          label: level,
        })),
    },
    async execute(args, ctx) {
      let target = args.trim();
      if (target.length === 0) {
        const selected = await showSelect(ctx.screen, {
          title: "Select thinking level",
          items: THINKING_LEVELS.map((level) => ({ value: level, label: level })),
        });
        if (!selected) return;
        target = selected;
      }
      if (!(THINKING_LEVELS as readonly string[]).includes(target)) {
        ctx.runtime.setNotice(`Invalid thinking level '${target}'.`, "warn");
        return;
      }
      const snapshot = ctx.runtime.status.getSnapshot();
      const next = normalizeThinkingLevel(ctx.runtime.agent.state.model, target as (typeof THINKING_LEVELS)[number]);
      ctx.runtime.setThinkingLevel(next);
      await configStore?.setThinkingLevel(next);
      if (next !== target) {
        ctx.runtime.setNotice(
          `Model ${snapshot.model.provider}/${snapshot.model.id} does not support thinking='${target}'. Using '${next}'.`,
          "warn",
        );
      } else {
        ctx.runtime.setNotice(`Thinking level set to ${next}.`, "info");
      }
    },
  };
}

function searchCommand(configStore?: ConfigStore): CommandDefinition {
  return {
    command: {
      name: "search",
      description: "Configure search_web defaults",
    },
    async execute(args, ctx) {
      const trimmed = args.trim();
      if (trimmed.length === 0) {
        await showSearchConfigMenu(ctx, configStore);
        return;
      }

      // Keep the old argument form working for users who already have it in muscle memory,
      // but the command now advertises and defaults to the interactive menu above.
      await applySearchConfigFromArgs(trimmed, ctx, configStore);
    },
  };
}

async function showSearchConfigMenu(ctx: CommandContext, configStore?: ConfigStore): Promise<void> {
  const config = ctx.runtime.getWebSearchConfig();
  const selected = await showSelect(ctx.screen, {
    title: "Search Configuration",
    items: [
      {
        value: "model",
        label: "Model",
        description: searchConfigDescription(config.model, DEFAULT_SEARCH_MODEL),
      },
      {
        value: "max-sources",
        label: "Max sources",
        description: searchConfigDescription(config.maxSources, DEFAULT_MAX_SOURCES),
      },
      {
        value: "timeout",
        label: "Timeout",
        description: searchConfigDescription(
          config.timeoutMs === undefined ? undefined : `${config.timeoutMs}ms`,
          `${DEFAULT_SEARCH_TIMEOUT_MS}ms`,
        ),
      },
      {
        value: "reset",
        label: "Reset to defaults",
        description: `model ${DEFAULT_SEARCH_MODEL}, ${DEFAULT_MAX_SOURCES} sources, ${DEFAULT_SEARCH_TIMEOUT_MS}ms`,
      },
    ],
  });

  if (!selected) return;
  if (selected === "model") {
    await configureSearchModel(ctx, configStore);
  } else if (selected === "max-sources") {
    await configureSearchMaxSources(ctx, configStore);
  } else if (selected === "timeout") {
    await configureSearchTimeout(ctx, configStore);
  } else if (selected === "reset") {
    await applySearchConfig(ctx, {}, configStore, "Search configuration reset to defaults.");
  }
}

async function configureSearchModel(ctx: CommandContext, configStore?: ConfigStore): Promise<void> {
  const current = ctx.runtime.getWebSearchConfig().model ?? DEFAULT_SEARCH_MODEL;
  const selected = await showSelect(ctx.screen, {
    title: "Search model",
    items: [
      { value: "default", label: DEFAULT_SEARCH_MODEL, description: "default" },
      { value: "custom", label: "Custom model…", description: `current: ${current}` },
    ],
  });
  if (!selected) return;

  const next: PersistedSearchConfig = { ...ctx.runtime.getWebSearchConfig() };
  if (selected === "default") {
    delete next.model;
    await applySearchConfig(ctx, next, configStore, `Search model reset to default (${DEFAULT_SEARCH_MODEL}).`);
    return;
  }

  const model = await showPrompt(ctx.screen, {
    title: "Custom search model",
    message: `Current model: ${current}`,
    allowEmpty: false,
  });
  if (model === undefined) return;

  const value = model.trim();
  if (value === DEFAULT_SEARCH_MODEL) delete next.model;
  else next.model = value;
  await applySearchConfig(ctx, next, configStore, `Search model set to ${value}.`);
}

async function configureSearchMaxSources(ctx: CommandContext, configStore?: ConfigStore): Promise<void> {
  const selected = await showSelect(ctx.screen, {
    title: "Search max sources",
    items: [
      { value: "default", label: `${DEFAULT_MAX_SOURCES}`, description: "default" },
      ...Array.from({ length: MAX_ALLOWED_SOURCES }, (_, index) => index + 1)
        .filter((value) => value !== DEFAULT_MAX_SOURCES)
        .map((value) => ({ value: String(value), label: String(value) })),
    ],
  });
  if (!selected) return;

  const next: PersistedSearchConfig = { ...ctx.runtime.getWebSearchConfig() };
  if (selected === "default") {
    delete next.maxSources;
    await applySearchConfig(ctx, next, configStore, `Search max sources reset to default (${DEFAULT_MAX_SOURCES}).`);
    return;
  }

  const maxSources = parsePositiveInteger(selected);
  if (!maxSources) return;
  next.maxSources = maxSources;
  await applySearchConfig(ctx, next, configStore, `Search max sources set to ${maxSources}.`);
}

async function configureSearchTimeout(ctx: CommandContext, configStore?: ConfigStore): Promise<void> {
  const current = ctx.runtime.getWebSearchConfig().timeoutMs ?? DEFAULT_SEARCH_TIMEOUT_MS;
  const presets = [30_000, 60_000, DEFAULT_SEARCH_TIMEOUT_MS, 300_000];
  const selected = await showSelect(ctx.screen, {
    title: "Search timeout",
    items: [
      { value: "default", label: `${DEFAULT_SEARCH_TIMEOUT_MS}ms`, description: "default" },
      ...presets
        .filter((value) => value !== DEFAULT_SEARCH_TIMEOUT_MS)
        .map((value) => ({ value: String(value), label: `${value}ms` })),
      { value: "custom", label: "Custom timeout…", description: `current: ${current}ms` },
    ],
  });
  if (!selected) return;

  const next: PersistedSearchConfig = { ...ctx.runtime.getWebSearchConfig() };
  if (selected === "default") {
    delete next.timeoutMs;
    await applySearchConfig(
      ctx,
      next,
      configStore,
      `Search timeout reset to default (${DEFAULT_SEARCH_TIMEOUT_MS}ms).`,
    );
    return;
  }

  let timeoutMs = parsePositiveInteger(selected);
  if (selected === "custom") {
    const value = await showPrompt(ctx.screen, {
      title: "Custom search timeout",
      message: `Enter timeout in milliseconds. Current timeout: ${current}ms`,
      allowEmpty: false,
    });
    if (value === undefined) return;
    timeoutMs = parsePositiveInteger(value.trim());
    if (!timeoutMs) {
      ctx.runtime.setNotice("Search timeout must be a positive integer in milliseconds.", "warn");
      return;
    }
  }
  if (!timeoutMs) return;

  if (timeoutMs === DEFAULT_SEARCH_TIMEOUT_MS) delete next.timeoutMs;
  else next.timeoutMs = timeoutMs;
  await applySearchConfig(ctx, next, configStore, `Search timeout set to ${timeoutMs}ms.`);
}

async function applySearchConfigFromArgs(
  trimmed: string,
  ctx: CommandContext,
  configStore?: ConfigStore,
): Promise<void> {
  const [rawSetting, ...valueParts] = trimmed.split(/\s+/);
  const setting = normalizeSearchSetting(rawSetting ?? "");
  if (setting === "reset") {
    await applySearchConfig(ctx, {}, configStore, "Search configuration reset to defaults.");
    return;
  }

  const value = valueParts.join(" ").trim();
  if (value.length === 0) {
    ctx.runtime.setNotice(
      "Usage: /search (or legacy: /search model <id> | max-sources <n> | timeout <ms> | reset)",
      "warn",
    );
    return;
  }

  const next: PersistedSearchConfig = { ...ctx.runtime.getWebSearchConfig() };
  if (setting === "model") {
    next.model = value;
    await applySearchConfig(ctx, next, configStore, `Search model set to ${value}.`);
  } else if (setting === "max-sources") {
    const maxSources = parsePositiveInteger(value);
    if (!maxSources) {
      ctx.runtime.setNotice("Search max-sources must be a positive integer.", "warn");
      return;
    }
    next.maxSources = maxSources;
    await applySearchConfig(ctx, next, configStore, `Search max sources set to ${maxSources}.`);
  } else if (setting === "timeout") {
    const timeoutMs = parsePositiveInteger(value);
    if (!timeoutMs) {
      ctx.runtime.setNotice("Search timeout must be a positive integer in milliseconds.", "warn");
      return;
    }
    next.timeoutMs = timeoutMs;
    await applySearchConfig(ctx, next, configStore, `Search timeout set to ${timeoutMs}ms.`);
  } else {
    ctx.runtime.setNotice(`Unknown search setting '${rawSetting}'.`, "warn");
  }
}

function searchConfigDescription(value: string | number | undefined, defaultValue: string | number): string {
  return value === undefined ? `default: ${defaultValue}` : `current: ${value}`;
}

function normalizeSearchSetting(value: string): "model" | "max-sources" | "timeout" | "reset" | undefined {
  switch (value) {
    case "model":
      return "model";
    case "max-sources":
    case "maxSources":
    case "sources":
      return "max-sources";
    case "timeout":
    case "timeout-ms":
    case "timeoutMs":
      return "timeout";
    case "reset":
      return "reset";
    default:
      return undefined;
  }
}

async function applySearchConfig(
  ctx: CommandContext,
  config: PersistedSearchConfig,
  configStore: ConfigStore | undefined,
  notice: string,
): Promise<void> {
  ctx.runtime.setWebSearchConfig(config);
  await configStore?.setSearchConfig(config);
  ctx.runtime.setNotice(notice, "info");
}

function parsePositiveInteger(value: string): number | undefined {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.floor(parsed);
}

function loginCommand(): CommandDefinition {
  return {
    command: {
      name: "login",
      description: "Authenticate with a provider (OAuth or API key)",
      argumentHint: "provider",
      getArgumentCompletions: (prefix) => [
        ...getOAuthProviders()
          .filter((entry) => entry.id.startsWith(prefix))
          .map((entry) => ({ value: `oauth:${entry.id}`, label: entry.name, description: "OAuth" })),
        ...listApiKeyProviders()
          .filter((entry) => entry.id.startsWith(prefix))
          .map((entry) => ({ value: `apikey:${entry.id}`, label: entry.id, description: "API key" })),
      ],
    },
    async execute(args, ctx) {
      let choice = args.trim();
      if (choice.length === 0) {
        const oauthItems = listOAuthProviders(ctx.runtime.authStore).map((entry) => ({
          value: `oauth:${entry.id}`,
          label: entry.name,
          description: entry.loggedIn ? "OAuth · already signed in" : "OAuth",
        }));
        const apiKeyItems = listApiKeyProviders(ctx.runtime.authStore).map((entry) => ({
          value: `apikey:${entry.id}`,
          label: entry.id,
          description: entry.hasKey ? "API key · already stored" : "API key",
        }));
        const selected = await showSelect(ctx.screen, {
          title: "Sign in with",
          items: [...oauthItems, ...apiKeyItems],
        });
        if (!selected) return;
        choice = selected;
      }

      if (choice.startsWith("apikey:")) {
        const providerId = choice.slice("apikey:".length);
        const key = await showPrompt(ctx.screen, {
          title: `API key — ${providerId}`,
          message: `Enter your API key for ${providerId}:`,
          allowEmpty: false,
        });
        if (key === undefined) return;
        await ctx.runtime.authStore.setApiKey(providerId, key);
        ctx.runtime.refreshModelFromAuth();
        ctx.runtime.setNotice(`API key stored for ${providerId}.`, "info");
        return;
      }

      const providerId = choice.startsWith("oauth:") ? choice.slice("oauth:".length) : choice;
      const provider = getOAuthProvider(providerId);
      if (!provider) {
        ctx.runtime.setNotice(`Unknown OAuth provider '${providerId}'.`, "warn");
        return;
      }
      const { callbacks, cleanup } = createLoginCallbacks(ctx, provider);
      try {
        const credentials = await provider.login(callbacks).finally(cleanup);
        await ctx.runtime.authStore.setOAuth(provider.id, credentials);
        ctx.runtime.refreshModelFromAuth();
        ctx.runtime.setNotice(`Signed in to ${provider.name}.`, "info");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.runtime.setNotice(`Login to ${provider.name} failed: ${message}`, "error");
      }
    },
  };
}

function logoutCommand(): CommandDefinition {
  return {
    command: {
      name: "logout",
      description: "Clear stored credentials (OAuth or API key)",
      argumentHint: "provider",
      getArgumentCompletions: (prefix) => [
        ...getOAuthProviders()
          .filter((entry) => entry.id.startsWith(prefix))
          .map((entry) => ({ value: `oauth:${entry.id}`, label: entry.name, description: "OAuth" })),
        ...listApiKeyProviders()
          .filter((entry) => entry.id.startsWith(prefix))
          .map((entry) => ({ value: `apikey:${entry.id}`, label: entry.id, description: "API key" })),
      ],
    },
    async execute(args, ctx) {
      let choice = args.trim();
      if (choice.length === 0) {
        const oauthStored = listOAuthProviders(ctx.runtime.authStore)
          .filter((entry) => entry.loggedIn)
          .map((entry) => ({ value: `oauth:${entry.id}`, label: entry.name, description: "OAuth" }));
        const apiKeyStored = listApiKeyProviders(ctx.runtime.authStore)
          .filter((entry) => entry.hasKey)
          .map((entry) => ({ value: `apikey:${entry.id}`, label: entry.id, description: "API key" }));
        const allStored = [...oauthStored, ...apiKeyStored];
        if (allStored.length === 0) {
          ctx.runtime.setNotice("No stored credentials to clear.", "info");
          return;
        }
        const selected = await showSelect(ctx.screen, { title: "Sign out of", items: allStored });
        if (!selected) return;
        choice = selected;
      }

      if (choice.startsWith("apikey:")) {
        const providerId = choice.slice("apikey:".length);
        const removed = await ctx.runtime.authStore.removeApiKey(providerId);
        if (removed) {
          ctx.runtime.refreshModelFromAuth();
          ctx.runtime.setNotice(`API key removed for ${providerId}.`, "info");
        } else {
          ctx.runtime.setNotice(`No API key stored for ${providerId}.`, "info");
        }
        return;
      }

      const providerId = choice.startsWith("oauth:") ? choice.slice("oauth:".length) : choice;
      const provider = getOAuthProvider(providerId);
      if (!provider) {
        ctx.runtime.setNotice(`Unknown OAuth provider '${providerId}'.`, "warn");
        return;
      }
      const removed = await ctx.runtime.authStore.removeOAuth(providerId);
      if (removed) {
        ctx.runtime.refreshModelFromAuth();
        ctx.runtime.setNotice(`Signed out of ${provider.name}.`, "info");
      } else {
        ctx.runtime.setNotice(`No credentials stored for ${provider.name}.`, "info");
      }
    },
  };
}

async function applyModel(
  ctx: CommandContext,
  provider: string,
  modelId: string,
  configStore?: ConfigStore,
): Promise<void> {
  const model = findModelByReference(provider, modelId);
  ctx.runtime.setModel(model);
  const thinking = normalizeThinkingLevel(model, ctx.runtime.status.getSnapshot().thinkingLevel);
  ctx.runtime.setThinkingLevel(thinking);
  await configStore?.setModelAndThinking(model.provider, model.id, thinking);
  ctx.runtime.setNotice(`Switched to ${model.provider}/${model.id}.`, "info");
}

function resolveModelReference(reference: string, authStore?: AuthStore): { provider: string; model: string } {
  const slash = reference.indexOf("/");
  if (slash > 0) {
    return { provider: reference.slice(0, slash), model: reference.slice(slash + 1) };
  }
  // No provider: search authenticated providers in preference order (first match wins).
  for (const entry of listProvidersForSelection(authStore)) {
    try {
      const model = findModelByReference(entry.id, reference);
      return { provider: entry.id, model: model.id };
    } catch {
      // Not in this provider, keep looking.
    }
  }
  throw new Error(`Could not locate model '${reference}'. Use the form 'provider/model-id'.`);
}

function completeModelReference(prefix: string, authStore?: AuthStore): AutocompleteItem[] {
  const slash = prefix.indexOf("/");
  if (slash === -1) {
    return listProvidersForSelection(authStore)
      .filter((entry) => entry.id.startsWith(prefix))
      .map((entry) => ({ value: `${entry.id}/`, label: entry.id, description: "provider" }));
  }
  const provider = prefix.slice(0, slash);
  const modelPrefix = prefix.slice(slash + 1);
  try {
    return listModelsForProvider(provider)
      .filter((entry) => entry.id.startsWith(modelPrefix))
      .map((entry) => ({
        value: `${provider}/${entry.id}`,
        label: entry.id,
        description: entry.name,
      }));
  } catch {
    return [];
  }
}

function providerAvailabilityLabel(via: "env" | "oauth" | "stored-key" | "none"): string {
  switch (via) {
    case "env":
      return "env api key";
    case "oauth":
      return "oauth";
    case "stored-key":
      return "stored api key";
    case "none":
      return "no credentials";
  }
}

interface LoginCallbacksResult {
  callbacks: OAuthLoginCallbacks;
  cleanup: () => void;
}

function createLoginCallbacks(ctx: CommandContext, provider: OAuthProviderInterface): LoginCallbacksResult {
  let authUrl: string | undefined;
  let dismissAuthOverlay: (() => void) | undefined;
  let dismissDeviceOverlay: (() => void) | undefined;

  const cleanup = (): void => {
    dismissAuthOverlay?.();
    dismissAuthOverlay = undefined;
    dismissDeviceOverlay?.();
    dismissDeviceOverlay = undefined;
  };

  const callbacks: OAuthLoginCallbacks = {
    onAuth: (info: OAuthAuthInfo) => {
      authUrl = info.url;
      process.stdout.write(new OscSequence(info.url).toString());
      const body = [
        `Open this URL in your browser:`,
        `(copied to clipboard)`,
        ``,
        info.url,
        info.instructions ? `` : "",
        info.instructions ?? "",
        provider.usesCallbackServer ? `` : "",
        provider.usesCallbackServer
          ? `On a headless server: after the browser redirects to localhost, copy that URL and paste it when prompted.`
          : "",
      ]
        .filter((line) => line.length > 0 || line === "")
        .join("\n");
      dismissAuthOverlay = showInfo(ctx.screen, { title: "Authorize pi-squared", body }).dismiss;
    },
    onDeviceCode: (info: OAuthDeviceCodeInfo) => {
      process.stdout.write(new OscSequence(info.verificationUri).toString());
      const body = [
        `Open: ${info.verificationUri}`,
        `(copied to clipboard)`,
        ``,
        `Enter the code: ${info.userCode}`,
        info.expiresInSeconds ? `Expires in ${Math.floor(info.expiresInSeconds / 60)} min` : "",
      ]
        .filter((line) => line.length > 0)
        .join("\n");
      dismissDeviceOverlay = showInfo(ctx.screen, { title: "Device authorization", body }).dismiss;
    },
    onPrompt: async (prompt: OAuthPrompt) => {
      const result = await showPrompt(ctx.screen, {
        title: "Login",
        message: prompt.message,
        allowEmpty: prompt.allowEmpty ?? false,
      });
      if (result === undefined) {
        throw new Error("Login cancelled");
      }
      return result;
    },
    onManualCodeInput: async () => {
      dismissAuthOverlay?.();
      dismissAuthOverlay = undefined;
      dismissDeviceOverlay?.();
      dismissDeviceOverlay = undefined;
      const urlNote = authUrl ? `${authUrl}\n\n` : "";
      const result = await showPrompt(ctx.screen, {
        title: "Paste redirect URL",
        message: `${urlNote}Copy the full redirect URL from your browser's address bar and paste it here:`,
        allowEmpty: false,
      });
      if (result === undefined) {
        throw new Error("Login cancelled");
      }
      return result;
    },
    onProgress: (message: string) => {
      ctx.runtime.setNotice(message, "info");
    },
    onSelect: async (prompt: OAuthSelectPrompt) => {
      return showSelect(ctx.screen, {
        title: prompt.message,
        items: prompt.options.map((option) => ({ value: option.id, label: option.label })),
      });
    },
  };

  return { callbacks, cleanup };
}

export type { OAuthCredentials };
