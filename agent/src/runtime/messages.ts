import type { AgentMessage } from "@earendil-works/pi-agent-core";

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null;
}

function contentBlockToText(block: unknown): string {
  if (!isRecord(block)) return "";

  switch (block.type) {
    case "text":
      return typeof block.text === "string" ? block.text : "";
    case "thinking":
      return typeof block.thinking === "string" ? `<thinking>\n${block.thinking}\n</thinking>` : "";
    case "image":
      return typeof block.mimeType === "string" ? `[image: ${block.mimeType}]` : "[image]";
    case "toolCall":
      return typeof block.name === "string" ? `[tool call: ${block.name}]` : "[tool call]";
    default:
      return "";
  }
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
  return content.map(contentBlockToText).filter(Boolean).join("\n");
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

export function isAssistantError(message: AgentMessage): boolean {
  return (
    isRecord(message) &&
    message.role === "assistant" &&
    typeof message.errorMessage === "string" &&
    message.errorMessage.length > 0
  );
}
