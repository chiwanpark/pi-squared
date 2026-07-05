import {
  Agent,
  type AgentEvent,
  type AgentMessage,
  type AgentTool,
  type ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import { type Model, type SimpleStreamOptions, type Transport } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { createBashTool } from "../tools/bash/tool.js";
import {
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
} from "../tools/file/index.js";
import { createSearchWebTool, type SearchWebAuth, type SearchWebToolConfig } from "../tools/web/index.js";
import { randomUUID } from "node:crypto";

import { AuthStore } from "./auth-store.js";
import { createUserMessage } from "./messages.js";
import { AgentStatusStore, createInitialStatus, modelToStatus, type NoticeLevel } from "./status-store.js";
import { buildSystemPrompt } from "./system-prompt.js";

export interface PiSquaredAgentRuntimeOptions {
  model: Model<any>;
  apiKey?: string;
  systemPrompt?: string | undefined;
  thinkingLevel?: ThinkingLevel;
  transport?: Transport;
  sessionId?: string;
  authStore?: AuthStore;
  /** Working directory for tool execution. Defaults to process.cwd(). */
  cwd?: string;
  /** Custom guidelines for the system prompt. */
  guidelines?: string[] | undefined;
  /** Extra context file paths (relative to cwd) to inject into the system prompt. */
  extraContextFiles?: string[] | undefined;
  /** Configuration for the search_web tool. */
  webSearch?: SearchWebToolConfig | undefined;
}

export class PiSquaredAgentRuntime {
  readonly agent: Agent;
  readonly status: AgentStatusStore;
  readonly authStore: AuthStore;

  private model: Model<any>;
  private apiKey: string | undefined;
  private sessionId: string;
  private readonly models: ReturnType<typeof builtinModels>;
  private readonly transportOverride: Transport | undefined;
  private readonly tools: AgentTool<any>[];
  private webSearchConfig: SearchWebToolConfig;
  private readonly cwd: string;
  private readonly guidelines: string[] | undefined;
  private readonly extraContextFiles: string[] | undefined;
  private systemPromptOverride: string | undefined;

  constructor(options: PiSquaredAgentRuntimeOptions) {
    this.authStore = options.authStore ?? new AuthStore();
    this.models = builtinModels({ credentials: this.authStore });
    this.model = options.model;
    this.apiKey = options.apiKey;
    this.transportOverride = options.transport;
    this.sessionId = options.sessionId ?? randomUUID();
    this.cwd = options.cwd ?? process.cwd();
    this.webSearchConfig = { ...(options.webSearch ?? {}) };
    this.tools = [
      createBashTool(this.cwd),
      createReadTool(this.cwd),
      createEditTool(this.cwd),
      createFindTool(this.cwd),
      createGrepTool(this.cwd),
      createLsTool(this.cwd),
      createWriteTool(this.cwd),
      this.createSearchWebRuntimeTool(),
    ];
    this.guidelines = options.guidelines;
    this.extraContextFiles = options.extraContextFiles;
    this.systemPromptOverride = options.systemPrompt;

    const thinkingLevel = options.thinkingLevel ?? "off";
    const initialSystemPrompt = this.systemPromptOverride ?? "";

    this.status = new AgentStatusStore(
      createInitialStatus({
        sessionId: this.sessionId,
        model: this.model,
        thinkingLevel,
        systemPrompt: initialSystemPrompt,
      }),
    );

    this.agent = new Agent({
      initialState: {
        model: this.model,
        thinkingLevel,
        systemPrompt: initialSystemPrompt,
        messages: [],
        tools: [],
      },
      streamFn: (model, context, streamOptions) =>
        this.models.streamSimple(model, context, this.withRuntimeStreamOptions(streamOptions)),
      sessionId: this.sessionId,
      transport: this.resolveTransportForModel(this.model),
    });

    this.agent.subscribe((event) => {
      this.handleAgentEvent(event);
    });
  }

  get isBusy(): boolean {
    return this.agent.state.isStreaming;
  }

  getCwd(): string {
    return this.cwd;
  }

  get messages(): AgentMessage[] {
    return this.status.getSnapshot().messages;
  }

  async prompt(text: string): Promise<void> {
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    if (this.isBusy) {
      throw new Error(
        "The agent is already responding. Abort or wait for it to finish before sending another message.",
      );
    }

    await this.applyStatusToAgent();
    this.status.update((draft) => {
      draft.phase = "streaming";
      draft.lastError = undefined;
      draft.currentEvent = "prompt";
    });

    try {
      await this.agent.prompt(createUserMessage(trimmed));
    } finally {
      this.syncFromAgent("idle", "settled");
    }
  }

  async continueLast(): Promise<void> {
    if (this.isBusy) {
      throw new Error("The agent is already responding. Abort or wait for it to finish before continuing.");
    }

    await this.applyStatusToAgent();

    const messages = [...this.agent.state.messages];
    while (messages.length > 0 && isFailedAssistantMessage(messages[messages.length - 1])) {
      messages.pop();
    }

    const lastMessage = messages[messages.length - 1];
    if (!lastMessage) {
      throw new Error("No cancelled or failed request to continue.");
    }
    if (!isContinuableMessage(lastMessage)) {
      throw new Error("The last request completed successfully. There is nothing to continue.");
    }

    this.agent.state.messages = messages;
    this.status.update((draft) => {
      draft.phase = "streaming";
      draft.messages = [...messages];
      draft.lastError = undefined;
      draft.currentEvent = "continue";
    });

    try {
      await this.agent.continue();
    } finally {
      this.syncFromAgent("idle", "settled");
    }
  }

  abort(): void {
    if (!this.isBusy) return;
    this.status.update((draft) => {
      draft.phase = "aborting";
      draft.currentEvent = "abort";
    });
    this.agent.abort();
  }

  waitForIdle(): Promise<void> {
    return this.agent.waitForIdle();
  }

  newSession(): string {
    if (this.isBusy) {
      throw new Error("Cannot start a new session while the agent is responding.");
    }

    this.sessionId = randomUUID();
    const snapshot = this.status.getSnapshot();
    const systemPrompt = this.systemPromptOverride ?? snapshot.systemPrompt;

    this.agent.reset();
    this.agent.sessionId = this.sessionId;
    this.agent.state.model = this.model;
    this.agent.state.thinkingLevel = snapshot.thinkingLevel;
    this.agent.state.systemPrompt = systemPrompt;

    this.status.replace(
      createInitialStatus({
        sessionId: this.sessionId,
        model: this.model,
        thinkingLevel: snapshot.thinkingLevel,
        systemPrompt,
      }),
    );

    return this.sessionId;
  }

  setMessages(messages: AgentMessage[]): void {
    if (this.isBusy) {
      throw new Error("Cannot replace messages while the agent is responding.");
    }

    this.agent.state.messages = messages;
    this.syncFromAgent("idle", "messages_replace");
  }

  setModel(model: Model<any>): void {
    if (this.isBusy) {
      throw new Error("Cannot replace the model while the agent is responding.");
    }

    this.model = model;
    this.agent.state.model = model;
    this.agent.transport = this.resolveTransportForModel(model);
    this.status.update((draft) => {
      draft.model = modelToStatus(model);
      draft.currentEvent = "model_replace";
    });
  }

  /**
   * Re-apply OAuth model transformations (e.g. github-copilot baseUrl rewrite)
   * after credentials change.
   */
  refreshModelFromAuth(): void {
    this.setModel(this.model);
  }

  setApiKey(apiKey: string | undefined): void {
    this.apiKey = apiKey;
  }

  setThinkingLevel(thinkingLevel: ThinkingLevel): void {
    this.agent.state.thinkingLevel = thinkingLevel;
    this.status.update((draft) => {
      draft.thinkingLevel = thinkingLevel;
      draft.currentEvent = "thinking_replace";
    });
  }

  setSystemPrompt(systemPrompt: string): void {
    this.systemPromptOverride = systemPrompt;
    this.agent.state.systemPrompt = systemPrompt;
    this.status.update((draft) => {
      draft.systemPrompt = systemPrompt;
      draft.currentEvent = "system_prompt_replace";
    });
  }

  getWebSearchConfig(): SearchWebToolConfig {
    return { ...this.webSearchConfig };
  }

  setWebSearchConfig(config: SearchWebToolConfig): void {
    if (this.isBusy) {
      throw new Error("Cannot replace search configuration while the agent is responding.");
    }
    this.webSearchConfig = { ...config };
    const index = this.tools.findIndex((tool) => tool.name === "search_web");
    const tool = this.createSearchWebRuntimeTool();
    if (index >= 0) this.tools[index] = tool;
    else this.tools.push(tool);
    this.status.update((draft) => {
      draft.currentEvent = "search_config_replace";
    });
  }

  setLastError(error: string | undefined): void {
    this.status.update((draft) => {
      draft.phase = error ? "error" : draft.phase;
      draft.lastError = error;
      draft.currentEvent = error ? "error" : draft.currentEvent;
    });
  }

  setNotice(message: string, level: NoticeLevel = "info"): void {
    this.status.update((draft) => {
      draft.lastNotice = { message, level, at: Date.now() };
      draft.currentEvent = `notice_${level}`;
    });
  }

  clearNotice(): void {
    this.status.update((draft) => {
      draft.lastNotice = undefined;
    });
  }

  private createSearchWebRuntimeTool(): AgentTool<any> {
    return createSearchWebTool({ ...this.webSearchConfig, getAuth: () => this.resolveSearchWebAuth() });
  }

  /** Resolve ChatGPT/Codex OAuth credentials used by the search_web tool. */
  private async resolveSearchWebAuth(): Promise<SearchWebAuth> {
    const provider = "openai-codex";
    await this.authStore.load();
    const credential = await this.authStore.read(provider);
    if (credential?.type !== "oauth") {
      throw new Error("search_web requires ChatGPT/Codex OAuth credentials. Run /login openai-codex first.");
    }

    const model = this.models.getModels(provider)[0];
    if (!model) {
      throw new Error("search_web could not resolve an OpenAI Codex model for OAuth refresh.");
    }

    const auth = await this.models.getAuth(model);
    const accessToken = auth?.auth.apiKey;
    if (!accessToken) {
      throw new Error("search_web requires ChatGPT/Codex OAuth credentials. Run /login openai-codex first.");
    }

    const refreshed = await this.authStore.read(provider);
    const accountId =
      (refreshed?.type === "oauth" ? getOpenAICodexAccountId(refreshed) : undefined) ??
      extractOpenAICodexAccountId(accessToken);
    if (!accountId) {
      throw new Error("search_web credentials are missing a ChatGPT account id. Run /login openai-codex again.");
    }

    return { accessToken, accountId };
  }

  private resolveTransportForModel(model: Model<any>): Transport {
    return this.transportOverride ?? getDefaultTransportForModel(model);
  }

  private withRuntimeStreamOptions(options: SimpleStreamOptions | undefined): SimpleStreamOptions | undefined {
    if (!this.apiKey) return options;
    return { ...options, apiKey: this.apiKey };
  }

  /**
   * Copy externally mutable status fields back into the core Agent before a run.
   * A future HTTP server can update the status store, then call this method to
   * make the next turn use the modified transcript and prompt state.
   */
  async applyStatusToAgent(): Promise<void> {
    if (!this.systemPromptOverride) {
      const dynamicPrompt = await buildSystemPrompt({
        cwd: this.cwd,
        guidelines: this.guidelines,
        extraContextFiles: this.extraContextFiles,
      });
      this.agent.state.systemPrompt = dynamicPrompt;
      this.status.update((draft) => {
        draft.systemPrompt = dynamicPrompt;
      });
    } else {
      this.agent.state.systemPrompt = this.systemPromptOverride;
    }

    const snapshot = this.status.getSnapshot();
    this.agent.state.model = this.model;
    this.agent.state.messages = snapshot.messages;
    this.agent.state.thinkingLevel = snapshot.thinkingLevel;
    this.agent.state.tools = [...this.tools];
  }

  private handleAgentEvent(event: AgentEvent): void {
    const nextPhase = event.type === "agent_end" ? "idle" : this.status.getSnapshot().phase;
    this.syncFromAgent(nextPhase, event.type);

    if (event.type === "turn_end" && event.message.role === "assistant" && event.message.errorMessage) {
      this.setLastError(event.message.errorMessage);
    }
  }

  private syncFromAgent(phase: "idle" | "streaming" | "aborting" | "error", currentEvent: string): void {
    this.status.update((draft) => {
      draft.phase = phase;
      draft.model = modelToStatus(this.agent.state.model);
      draft.thinkingLevel = this.agent.state.thinkingLevel;
      draft.systemPrompt = this.agent.state.systemPrompt;
      draft.messages = [...this.agent.state.messages];
      draft.streamingMessage = this.agent.state.streamingMessage;
      draft.pendingToolCallIds = [...this.agent.state.pendingToolCalls];
      draft.lastError = this.agent.state.errorMessage;
      draft.currentEvent = currentEvent;
    });
  }
}

function getDefaultTransportForModel(model: Model<any>): Transport {
  // OpenAI Codex can use WebSocket when transport is "auto"; prefer HTTP SSE
  // by default for OpenAI-family models unless callers explicitly override it.
  return model.provider === "openai" || model.provider === "openai-codex" ? "sse" : "auto";
}

function isContinuableMessage(message: AgentMessage): boolean {
  const role = getMessageRole(message);
  return role === "user" || role === "toolResult";
}

function isFailedAssistantMessage(message: AgentMessage | undefined): boolean {
  if (!message || !isRecord(message) || message.role !== "assistant") return false;
  return message.stopReason === "error" || message.stopReason === "aborted" || typeof message.errorMessage === "string";
}

function getMessageRole(message: AgentMessage): string | undefined {
  return isRecord(message) && typeof message.role === "string" ? message.role : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getOpenAICodexAccountId(credentials: Record<string, unknown>): string | undefined {
  const accountId = credentials.accountId;
  return typeof accountId === "string" && accountId.length > 0 ? accountId : undefined;
}

function extractOpenAICodexAccountId(accessToken: string): string | undefined {
  const payload = decodeJwtPayload(accessToken);
  const auth = payload?.["https://api.openai.com/auth"];
  if (!auth || typeof auth !== "object") return undefined;
  const accountId = (auth as Record<string, unknown>).chatgpt_account_id;
  return typeof accountId === "string" && accountId.length > 0 ? accountId : undefined;
}

function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
  try {
    const payload = token.split(".")[1];
    if (!payload) return undefined;
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}
