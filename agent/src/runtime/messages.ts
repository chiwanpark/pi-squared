import type { AgentMessage } from "@earendil-works/pi-agent-core";

type UnknownRecord = Record<string, unknown>;

export interface MessageMarkdownBlock {
  kind: "thinking" | "message";
  text: string;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null;
}

const MISSING_REASONING_PLACEHOLDER = "[reasoning content not provided]";

function contentBlockToText(block: unknown, options?: { includeThinkingTags?: boolean }): string {
  if (!isRecord(block)) return "";

  switch (block.type) {
    case "text":
      return typeof block.text === "string" ? block.text : "";
    case "thinking": {
      if (typeof block.thinking !== "string") return "";
      const thinking = formatThinkingText(block.thinking);
      return options?.includeThinkingTags ? `<thinking>\n${thinking}\n</thinking>` : thinking;
    }
    case "image":
      return typeof block.mimeType === "string" ? `[image: ${block.mimeType}]` : "[image]";
    case "toolCall":
      return "";
    default:
      return "";
  }
}

function formatThinkingText(text: string): string {
  return text.replace(/^[ \t]*<!--[ \t]*-->[ \t]*$/gm, MISSING_REASONING_PLACEHOLDER);
}

export function createUserMessage(text: string): AgentMessage {
  return {
    role: "user",
    content: [{ type: "text", text }],
    timestamp: Date.now(),
  };
}

export function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => contentBlockToText(block, { includeThinkingTags: true }))
    .filter(Boolean)
    .join("\n");
}

export function messageRole(message: AgentMessage): string {
  return isRecord(message) && typeof message.role === "string" ? message.role : "custom";
}

export function messageToText(message: AgentMessage): string {
  if (!isRecord(message)) return "";

  switch (message.role) {
    case "user":
    case "toolResult":
      return contentToText(message.content);
    case "assistant": {
      const text = contentToText(message.content);
      if (typeof message.errorMessage === "string" && message.errorMessage.length > 0) {
        return text.length > 0 ? `${text}\n\nError: ${message.errorMessage}` : `Error: ${message.errorMessage}`;
      }
      return text;
    }
    default:
      if (typeof message.content === "string" || Array.isArray(message.content)) {
        return contentToText(message.content);
      }
      return JSON.stringify(message);
  }
}

export function messageToMarkdownBlocks(message: AgentMessage): MessageMarkdownBlock[] {
  if (!isRecord(message)) return [{ kind: "message", text: "" }];

  if (message.role !== "assistant") {
    return [{ kind: "message", text: messageToText(message) }];
  }

  const thinking: string[] = [];
  const body: string[] = [];

  if (Array.isArray(message.content)) {
    for (const block of message.content) {
      if (!isRecord(block)) continue;
      const text = contentBlockToText(block);
      if (!text) continue;
      if (block.type === "thinking") thinking.push(text);
      else body.push(text);
    }
  } else if (typeof message.content === "string") {
    body.push(message.content);
  }

  if (typeof message.errorMessage === "string" && message.errorMessage.length > 0) {
    body.push(`Error: ${message.errorMessage}`);
  }

  return [
    ...(thinking.length > 0 ? [{ kind: "thinking" as const, text: thinking.join("\n\n") }] : []),
    ...(body.length > 0 ? [{ kind: "message" as const, text: body.join("\n\n") }] : []),
  ];
}

export function isAssistantError(message: AgentMessage): boolean {
  return (
    isRecord(message) &&
    message.role === "assistant" &&
    typeof message.errorMessage === "string" &&
    message.errorMessage.length > 0
  );
}
