import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAssistantMessageEventStream, type AssistantMessage, type Model } from "@earendil-works/pi-ai";

import { AuthStore } from "../src/runtime/auth-store.js";
import { getDefaultModelForProvider } from "../src/runtime/model-resolver.js";
import { PiSquaredAgentRuntime } from "../src/runtime/pi-agent.js";

async function createAuthStore(): Promise<{ authStore: AuthStore; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "pi2-runtime-"));
  return { authStore: new AuthStore({ filePath: join(dir, "auth.json") }), dir };
}

describe("PiSquaredAgentRuntime", () => {
  let dirs: string[];

  beforeEach(() => {
    dirs = [];
  });

  afterEach(async () => {
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function createRuntime(provider: string, transport?: "sse" | "websocket" | "websocket-cached" | "auto") {
    const { authStore, dir } = await createAuthStore();
    dirs.push(dir);
    const options: ConstructorParameters<typeof PiSquaredAgentRuntime>[0] = {
      model: getDefaultModelForProvider(provider),
      authStore,
    };
    if (transport) options.transport = transport;
    return new PiSquaredAgentRuntime(options);
  }

  it.each(["openai", "openai-codex"])("uses SSE by default for %s models", async (provider) => {
    const runtime = await createRuntime(provider);

    expect(runtime.agent.transport).toBe("sse");
  });

  it("keeps automatic transport by default for non-OpenAI models", async () => {
    const runtime = await createRuntime("anthropic");

    expect(runtime.agent.transport).toBe("auto");
  });

  it("respects explicit transport overrides", async () => {
    const runtime = await createRuntime("openai-codex", "websocket");

    expect(runtime.agent.transport).toBe("websocket");
  });

  it("updates the default transport when the model changes", async () => {
    const runtime = await createRuntime("anthropic");

    runtime.setModel(getDefaultModelForProvider("openai-codex"));

    expect(runtime.agent.transport).toBe("sse");
  });

  it("continues a failed assistant turn by retrying from the previous user message", async () => {
    const runtime = await createRuntime("anthropic");
    let calls = 0;

    runtime.agent.streamFn = (model) => {
      calls += 1;
      const stream = createAssistantMessageEventStream();
      const failed = calls === 1;
      const message = createAssistantMessage(
        model,
        failed ? "" : "done",
        failed ? "error" : "stop",
        failed ? "timeout" : undefined,
      );

      stream.push({ type: "start", partial: message });
      if (failed) stream.push({ type: "error", reason: "error", error: message });
      else stream.push({ type: "done", reason: "stop", message });
      return stream;
    };

    await runtime.prompt("do it");

    expect(runtime.status.getSnapshot().lastError).toBe("timeout");
    expect(runtime.messages.map((message) => message.role)).toEqual(["user", "assistant"]);

    await runtime.continueLast();

    expect(calls).toBe(2);
    expect(runtime.status.getSnapshot().lastError).toBeUndefined();
    expect(runtime.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect((runtime.messages[1] as AssistantMessage).stopReason).toBe("stop");
  });
});

function createAssistantMessage(
  model: Model<any>,
  text: string,
  stopReason: AssistantMessage["stopReason"],
  errorMessage?: string,
): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    ...(errorMessage === undefined ? {} : { errorMessage }),
    timestamp: Date.now(),
  };
}
