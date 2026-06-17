import type { AgentMessage } from "../src/index.js";
import { isAgentMessage } from "../src/index.js";

const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

describe("isAgentMessage", () => {
  it("accepts user messages", () => {
    const message: AgentMessage = { role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 };

    expect(isAgentMessage(message)).toBe(true);
  });

  it("accepts assistant messages with tool calls", () => {
    const message: AgentMessage = {
      role: "assistant",
      content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "pwd" } }],
      api: "openai-responses",
      provider: "openai",
      model: "gpt-test",
      usage: ZERO_USAGE,
      stopReason: "toolUse",
      timestamp: 1,
    };

    expect(isAgentMessage(message)).toBe(true);
  });

  it("accepts tool result messages", () => {
    const message: AgentMessage = {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "bash",
      content: [{ type: "text", text: "ok" }],
      isError: false,
      timestamp: 1,
    };

    expect(isAgentMessage(message)).toBe(true);
  });

  it("rejects non-agent messages", () => {
    expect(isAgentMessage({ type: "tool_observation", output: "ok" })).toBe(false);
  });
});
