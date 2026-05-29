export { PiSquaredAgentRuntime, type PiSquaredAgentRuntimeOptions } from "./runtime/pi-agent.js";
export { createUserMessage, messageRole, messageToText, contentToText } from "./runtime/messages.js";
export {
  AgentStatusStore,
  createInitialStatus,
  modelToStatus,
  type AgentNotice,
  type AgentPhase,
  type AgentStatusListener,
  type AgentStatusSnapshot,
  type ModelStatus,
  type NoticeLevel,
} from "./runtime/status-store.js";
export {
  findModelByReference,
  getDefaultModelForProvider,
  listKnownProviders,
  listModelsForProvider,
  listApiKeyProviders,
  listOAuthProviders,
  listProvidersForSelection,
  normalizeThinkingLevel,
  parseModelReference,
  resolveModel,
  type ModelListEntry,
  type ApiKeyProviderEntry,
  type OAuthProviderEntry,
  type ParsedModelReference,
  type ProviderListEntry,
  type ResolveModelOptions,
  type ResolvedModel,
} from "./runtime/model-resolver.js";
export { AuthStore, defaultAuthFilePath, type AuthFileShape, type AuthStoreOptions } from "./runtime/auth-store.js";
export {
  ConfigStore,
  defaultConfigFilePath,
  type ConfigFileShape,
  type ConfigStoreOptions,
  type PersistedModelConfig,
  type PersistedSearchConfig,
} from "./runtime/config-store.js";
export { runInteractive, type InteractiveOptions } from "./tui/interactive.js";
export {
  buildRegistry,
  createCommands,
  parseSlashCommand,
  type CommandContext,
  type CommandDefinition,
  type CommandRegistry,
  type ParsedCommand,
} from "./tui/commands.js";

export {
  createReadTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createWriteTool,
  type ReadToolInput,
  type EditToolInput,
  type FindToolInput,
  type GrepToolInput,
  type LsToolInput,
  type WriteToolInput,
} from "./tools/file/index.js";
export {
  createSearchWebTool,
  type SearchWebAuth,
  type SearchWebSource,
  type SearchWebToolConfig,
  type SearchWebToolDetails,
  type SearchWebToolInput,
  type SearchWebToolOptions,
} from "./tools/web/index.js";
