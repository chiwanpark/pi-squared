import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";

import { contentToText, messageToMarkdownBlocks, messageToText } from "../src/runtime/messages.js";

describe("message rendering helpers", () => {
  it("omits tool call blocks from assistant markdown", () => {
    const message = {
      role: "assistant",
      content: [
        { type: "text", text: "I'll inspect the files." },
        {
          type: "toolCall",
          id: "call-1",
          name: "bash",
          arguments: { command: "ls", timeout: 1000 },
        },
      ],
      timestamp: Date.now(),
    } as unknown as AgentMessage;

    expect(messageToMarkdownBlocks(message)).toEqual([{ kind: "message", text: "I'll inspect the files." }]);
  });

  it("omits tool call blocks from plain text conversion", () => {
    const content = [
      { type: "text", text: "before" },
      { type: "toolCall", name: "bash", arguments: { command: "pwd" } },
      { type: "text", text: "after" },
    ];

    expect(contentToText(content)).toBe("before\nafter");
    expect(messageToText({ role: "assistant", content, timestamp: Date.now() } as unknown as AgentMessage)).toBe(
      "before\nafter",
    );
  });

  it("replaces empty reasoning placeholders from providers", () => {
    const message = {
      role: "assistant",
      content: [
        {
          type: "thinking",
          thinking: "**Checking the issue**\n\n<!-- -->",
        },
        { type: "text", text: "Done." },
      ],
      timestamp: Date.now(),
    } as unknown as AgentMessage;

    expect(messageToMarkdownBlocks(message)).toEqual([
      { kind: "thinking", text: "**Checking the issue**\n\n[reasoning content not provided]" },
      { kind: "message", text: "Done." },
    ]);
  });
});
