import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { AgentMessage } from "@chiwanpark/pi-squared-protocol";
import WebSocket from "ws";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPiSquaredServer } from "../src/http-server.js";
import { SessionStore } from "../src/session-store.js";

const SECRET = "test-secret";

const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function createAssistantToolCallMessage(): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "pwd" } }],
    api: "openai-responses",
    provider: "openai",
    model: "gpt-test",
    usage: ZERO_USAGE,
    stopReason: "toolUse",
    timestamp: Date.now(),
  };
}

function createAssistantTextMessage(): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "running a tool" }],
    api: "openai-responses",
    provider: "openai",
    model: "gpt-test",
    usage: ZERO_USAGE,
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function createToolResultMessage(): AgentMessage {
  return {
    role: "toolResult",
    toolCallId: "call-1",
    toolName: "bash",
    content: [{ type: "text", text: "ok" }],
    isError: false,
    timestamp: Date.now(),
  };
}

interface TestServer {
  baseUrl: string;
  wsBaseUrl: string;
  sessionsDir: string;
  server: Server;
}

let currentServer: TestServer | null = null;

async function startTestServer(): Promise<TestServer> {
  const sessionsDir = await mkdtemp(join(tmpdir(), "pi-squared-server-"));
  const { server } = createPiSquaredServer({ secret: SECRET, store: new SessionStore(sessionsDir) });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Expected TCP server address.");
  }

  const port = (address as AddressInfo).port;
  currentServer = {
    baseUrl: `http://127.0.0.1:${port}`,
    wsBaseUrl: `ws://127.0.0.1:${port}`,
    sessionsDir,
    server,
  };

  return currentServer;
}

async function stopTestServer(testServer: TestServer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    testServer.server.close((error) => {
      if (error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    });
  });
  await rm(testServer.sessionsDir, { recursive: true, force: true });
}

async function readJsonl(filePath: string): Promise<unknown[]> {
  const contents = await readFile(filePath, "utf8");
  return contents
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as unknown);
}

function connectWebSocket(url: string, secret = SECRET): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const webSocket = new WebSocket(url, {
      headers: secret.length === 0 ? {} : { authorization: `Bearer ${secret}` },
    });

    webSocket.once("open", () => resolve(webSocket));
    webSocket.once("error", reject);
  });
}

async function sendInvalidWebSocketMessage(
  url: string,
  message: unknown,
): Promise<{ receivedMessages: unknown[]; closeCode: number }> {
  return await new Promise((resolve, reject) => {
    const webSocket = new WebSocket(url, { headers: { authorization: `Bearer ${SECRET}` } });
    const receivedMessages: unknown[] = [];
    const timeout = setTimeout(() => {
      webSocket.terminate();
      reject(new Error("Timed out waiting for invalid WebSocket message rejection."));
    }, 2_000);

    webSocket.on("open", () => {
      webSocket.send(JSON.stringify(message));
    });
    webSocket.on("message", (data) => {
      receivedMessages.push(JSON.parse(data.toString()) as unknown);
    });
    webSocket.on("close", (code) => {
      clearTimeout(timeout);
      resolve({ receivedMessages, closeCode: code });
    });
    webSocket.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

async function sendWebSocketMessages(url: string, messages: unknown[]): Promise<unknown[]> {
  return await new Promise((resolve, reject) => {
    const webSocket = new WebSocket(url, { headers: { authorization: `Bearer ${SECRET}` } });
    const receivedMessages: unknown[] = [];
    const timeout = setTimeout(() => {
      webSocket.terminate();
      reject(new Error("Timed out waiting for WebSocket acknowledgements."));
    }, 2_000);

    webSocket.on("open", () => {
      for (const message of messages) {
        webSocket.send(JSON.stringify(message));
      }
    });
    webSocket.on("message", (data) => {
      const payload = JSON.parse(data.toString()) as unknown;
      receivedMessages.push(payload);

      const recordedCount = receivedMessages.filter(
        (message) =>
          typeof message === "object" && message !== null && "type" in message && message.type === "recorded",
      ).length;

      if (recordedCount === messages.length) {
        clearTimeout(timeout);
        webSocket.close();
        resolve(receivedMessages);
      }
    });
    webSocket.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

beforeEach(async () => {
  await startTestServer();
});

afterEach(async () => {
  if (currentServer !== null) {
    await stopTestServer(currentServer);
    currentServer = null;
  }
});

describe("pi-squared server", () => {
  it("responds to health checks without a secret", async () => {
    if (currentServer === null) {
      throw new Error("Test server was not started.");
    }

    const response = await fetch(`${currentServer.baseUrl}/health`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: "ok" });
  });

  it("does not expose HTTP APIs for agent sessions", async () => {
    if (currentServer === null) {
      throw new Error("Test server was not started.");
    }

    const createResponse = await fetch(`${currentServer.baseUrl}/sessions`, {
      method: "POST",
      headers: { authorization: `Bearer ${SECRET}` },
      body: JSON.stringify({ sessionId: "session-1" }),
    });
    const messageResponse = await fetch(`${currentServer.baseUrl}/sessions/session-1/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${SECRET}` },
      body: JSON.stringify({ role: "assistant", content: "hello" }),
    });

    expect(createResponse.status).toBe(404);
    expect(messageResponse.status).toBe(404);
  });

  it("records WebSocket messages sent to the session endpoint", async () => {
    if (currentServer === null) {
      throw new Error("Test server was not started.");
    }

    const responses = await sendWebSocketMessages(`${currentServer.wsBaseUrl}/sessions/session-1`, [
      createAssistantToolCallMessage(),
    ]);

    expect(responses).toContainEqual(expect.objectContaining({ type: "connected", sessionId: "session-1" }));
    expect(responses).toContainEqual(
      expect.objectContaining({ type: "recorded", sessionId: "session-1", received: 1 }),
    );

    const records = await readJsonl(join(currentServer.sessionsDir, "session-1.jsonl"));
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      sessionId: "session-1",
      message: { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "bash" }] },
      connectionId: expect.any(String),
    });
  });

  it("rejects WebSocket connections without the secret", async () => {
    if (currentServer === null) {
      throw new Error("Test server was not started.");
    }

    await expect(connectWebSocket(`${currentServer.wsBaseUrl}/sessions/session-2`, "")).rejects.toThrow();
  });

  it("rejects WebSocket messages that are not AgentMessage values", async () => {
    if (currentServer === null) {
      throw new Error("Test server was not started.");
    }

    const result = await sendInvalidWebSocketMessage(`${currentServer.wsBaseUrl}/sessions/session-2`, {
      type: "tool_observation",
      output: "ok",
    });

    expect(result.closeCode).toBe(1003);
    expect(result.receivedMessages).toContainEqual(
      expect.objectContaining({
        type: "error",
        error: expect.objectContaining({ code: "invalid_agent_message" }),
      }),
    );
  });

  it("records WebSocket messages with a connection id", async () => {
    if (currentServer === null) {
      throw new Error("Test server was not started.");
    }

    const responses = await sendWebSocketMessages(`${currentServer.wsBaseUrl}/sessions/session-2`, [
      createAssistantTextMessage(),
      createToolResultMessage(),
    ]);

    expect(responses).toContainEqual(expect.objectContaining({ type: "connected", sessionId: "session-2" }));
    expect(responses).toContainEqual(
      expect.objectContaining({ type: "recorded", sessionId: "session-2", received: 2 }),
    );

    const records = await readJsonl(join(currentServer.sessionsDir, "session-2.jsonl"));
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      sessionId: "session-2",
      message: { role: "assistant", content: [{ type: "text", text: "running a tool" }] },
    });
    expect(records[1]).toMatchObject({
      sessionId: "session-2",
      message: { role: "toolResult", content: [{ type: "text", text: "ok" }] },
    });

    for (const record of records) {
      expect(record).toMatchObject({ connectionId: expect.any(String) });
    }
  });
});
