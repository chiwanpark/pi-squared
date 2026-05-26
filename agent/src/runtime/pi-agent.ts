import { Agent, type AgentEvent, type AgentMessage, type ThinkingLevel } from "@earendil-works/pi-agent-core";
import { getEnvApiKey, type Model, type Transport } from "@earendil-works/pi-ai";
import { getOAuthApiKey, getOAuthProvider } from "@earendil-works/pi-ai/oauth";
import { randomUUID } from "node:crypto";

import { AuthStore } from "./auth-store.js";
import { createUserMessage } from "./messages.js";
import { AgentStatusStore, createInitialStatus, modelToStatus, type NoticeLevel } from "./status-store.js";

export interface PiSquaredAgentRuntimeOptions {
  model: Model<any>;
  apiKey?: string;
  systemPrompt?: string;
  thinkingLevel?: ThinkingLevel;
  transport?: Transport;
  sessionId?: string;
  authStore?: AuthStore;
}

export const DEFAULT_SYSTEM_PROMPT = [
  "You are pi-squared, an interactive coding assistant running in a terminal.",
  "Be concise, practical, and honest about limitations.",
  "You do not have tools in this first implementation, so ask the user to paste relevant files or command output when needed.",
].join("\n");

export class PiSquaredAgentRuntime {
  readonly agent: Agent;
  readonly status: AgentStatusStore;
  readonly authStore: AuthStore;

  private model: Model<any>;
  private apiKey: string | undefined;
  private readonly sessionId: string;

  constructor(options: PiSquaredAgentRuntimeOptions) {
    this.authStore = options.authStore ?? new AuthStore();
    this.model = this.applyOAuthModelTransforms(options.model);
    this.apiKey = options.apiKey;
    this.sessionId = options.sessionId ?? randomUUID();

    const thinkingLevel = options.thinkingLevel ?? "off";
    const systemPrompt = options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;

    this.status = new AgentStatusStore(
      createInitialStatus({
        sessionId: this.sessionId,
        model: this.model,
        thinkingLevel,
        systemPrompt,
      }),
    );

    this.agent = new Agent({
      initialState: {
        model: this.model,
        thinkingLevel,
        systemPrompt,
        messages: [],
        tools: [],
      },
      getApiKey: (provider) => this.resolveApiKey(provider),
      sessionId: this.sessionId,
      transport: options.transport ?? "auto",
    });

    this.agent.subscribe((event) => {
      this.handleAgentEvent(event);
    });
  }

  get isBusy(): boolean {
    return this.agent.state.isStreaming;
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

    this.applyStatusToAgent();
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

    const transformed = this.applyOAuthModelTransforms(model);
    this.model = transformed;
    this.agent.state.model = transformed;
    this.status.update((draft) => {
      draft.model = modelToStatus(transformed);
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
    this.agent.state.systemPrompt = systemPrompt;
    this.status.update((draft) => {
      draft.systemPrompt = systemPrompt;
      draft.currentEvent = "system_prompt_replace";
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

  /**
   * Resolve an API key for a provider, preferring OAuth credentials from the
   * auth store (refreshing if expired), then the runtime override, then env.
   */
  async resolveApiKey(provider: string): Promise<string | undefined> {
    await this.authStore.load();
    const oauthProvider = getOAuthProvider(provider);
    if (oauthProvider) {
      const credentials = this.authStore.getAllOAuth();
      if (credentials[provider]) {
        try {
          const result = await getOAuthApiKey(provider, credentials);
          if (result) {
            const stored = credentials[provider];
            if (stored && stored.access !== result.newCredentials.access) {
              await this.authStore.setOAuth(provider, result.newCredentials);
            }
            return result.apiKey;
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.setNotice(`OAuth refresh failed for ${provider}: ${message}`, "error");
        }
      }
    }
    const storedKey = this.authStore.getApiKey(provider);
    if (storedKey) return storedKey;
    return this.apiKey ?? getEnvApiKey(provider);
  }

  /**
   * Apply OAuth-driven model transformations (e.g. github-copilot baseUrl).
   */
  private applyOAuthModelTransforms(model: Model<any>): Model<any> {
    const oauthProvider = getOAuthProvider(model.provider);
    if (!oauthProvider?.modifyModels) return model;
    const credentials = this.authStore.getOAuth(model.provider);
    if (!credentials) return model;
    const [transformed] = oauthProvider.modifyModels([model], credentials);
    return transformed ?? model;
  }

  /**
   * Copy externally mutable status fields back into the core Agent before a run.
   * A future HTTP server can update the status store, then call this method to
   * make the next turn use the modified transcript and prompt state.
   */
  applyStatusToAgent(): void {
    const snapshot = this.status.getSnapshot();
    this.agent.state.model = this.model;
    this.agent.state.messages = snapshot.messages;
    this.agent.state.thinkingLevel = snapshot.thinkingLevel;
    this.agent.state.systemPrompt = snapshot.systemPrompt;
    this.agent.state.tools = [];
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
