import { mkdir, appendFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentMessage } from "@chiwanpark/pi-squared-protocol";
import { HttpError } from "./errors.js";

const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface AppendMetadata {
  connectionId: string | null;
}

export interface RecordedAgentMessage {
  receivedAt: string;
  sessionId: string;
  connectionId: string | null;
  message: AgentMessage;
}

export function isValidSessionId(sessionId: string): boolean {
  return SESSION_ID_PATTERN.test(sessionId);
}

export class SessionStore {
  private readonly writeQueues = new Map<string, Promise<void>>();

  constructor(private readonly rootDir: string) {}

  async createSession(sessionId: string): Promise<void> {
    this.assertValidSessionId(sessionId);
    await mkdir(this.rootDir, { recursive: true });
    await appendFile(this.filePathFor(sessionId), "", { flag: "a" });
  }

  async appendMessage(
    sessionId: string,
    message: AgentMessage,
    metadata: AppendMetadata,
  ): Promise<RecordedAgentMessage> {
    this.assertValidSessionId(sessionId);
    await mkdir(this.rootDir, { recursive: true });

    const record: RecordedAgentMessage = {
      receivedAt: new Date().toISOString(),
      sessionId,
      connectionId: metadata.connectionId,
      message,
    };

    const line = `${JSON.stringify(record)}\n`;
    const previousWrite = this.writeQueues.get(sessionId) ?? Promise.resolve();
    const nextWrite = previousWrite.then(() => appendFile(this.filePathFor(sessionId), line, { flag: "a" }));
    const queuedWrite = nextWrite.catch(() => undefined);

    this.writeQueues.set(sessionId, queuedWrite);

    try {
      await nextWrite;
    } finally {
      if (this.writeQueues.get(sessionId) === queuedWrite) {
        this.writeQueues.delete(sessionId);
      }
    }

    return record;
  }

  filePathFor(sessionId: string): string {
    this.assertValidSessionId(sessionId);
    return join(this.rootDir, `${sessionId}.jsonl`);
  }

  private assertValidSessionId(sessionId: string): void {
    if (!isValidSessionId(sessionId)) {
      throw new HttpError(
        400,
        "invalid_session_id",
        "Session ID must start with an alphanumeric character and contain only letters, numbers, '.', '_', or '-'.",
      );
    }
  }
}
