import type { Model } from "@earendil-works/pi-ai";
import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";

export type AgentPhase = "idle" | "streaming" | "aborting" | "error";

export interface ModelStatus {
  provider: string;
  id: string;
  name: string;
  contextWindow: number;
}

export type NoticeLevel = "info" | "warn" | "error";

export interface AgentNotice {
  level: NoticeLevel;
  message: string;
  /** Optional epoch ms at which the notice was raised. */
  at: number;
}

export interface AgentStatusSnapshot {
  sessionId: string;
  phase: AgentPhase;
  model: ModelStatus;
  thinkingLevel: ThinkingLevel;
  systemPrompt: string;
  messages: AgentMessage[];
  streamingMessage: AgentMessage | undefined;
  pendingToolCallIds: string[];
  lastError: string | undefined;
  lastNotice: AgentNotice | undefined;
  currentEvent: string | undefined;
  updatedAt: number;
}

export type AgentStatusListener = (snapshot: AgentStatusSnapshot) => void;

export function modelToStatus(model: Model<any>): ModelStatus {
  return {
    provider: model.provider,
    id: model.id,
    name: model.name,
    contextWindow: model.contextWindow,
  };
}

export interface CreateStatusOptions {
  sessionId: string;
  model: Model<any>;
  thinkingLevel: ThinkingLevel;
  systemPrompt: string;
}

export function createInitialStatus(options: CreateStatusOptions): AgentStatusSnapshot {
  return {
    sessionId: options.sessionId,
    phase: "idle",
    model: modelToStatus(options.model),
    thinkingLevel: options.thinkingLevel,
    systemPrompt: options.systemPrompt,
    messages: [],
    streamingMessage: undefined,
    pendingToolCallIds: [],
    lastError: undefined,
    lastNotice: undefined,
    currentEvent: undefined,
    updatedAt: Date.now(),
  };
}

function cloneSnapshot(snapshot: AgentStatusSnapshot): AgentStatusSnapshot {
  return {
    ...snapshot,
    model: { ...snapshot.model },
    messages: [...snapshot.messages],
    pendingToolCallIds: [...snapshot.pendingToolCallIds],
    lastNotice: snapshot.lastNotice ? { ...snapshot.lastNotice } : undefined,
  };
}

export class AgentStatusStore {
  private snapshot: AgentStatusSnapshot;
  private readonly listeners = new Set<AgentStatusListener>();

  constructor(initialSnapshot: AgentStatusSnapshot) {
    this.snapshot = cloneSnapshot(initialSnapshot);
  }

  getSnapshot(): AgentStatusSnapshot {
    return cloneSnapshot(this.snapshot);
  }

  replace(nextSnapshot: AgentStatusSnapshot): void {
    this.snapshot = cloneSnapshot({ ...nextSnapshot, updatedAt: Date.now() });
    this.emit();
  }

  update(mutator: (draft: AgentStatusSnapshot) => void): void {
    const draft = cloneSnapshot(this.snapshot);
    mutator(draft);
    draft.updatedAt = Date.now();
    this.snapshot = draft;
    this.emit();
  }

  subscribe(listener: AgentStatusListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }
}
