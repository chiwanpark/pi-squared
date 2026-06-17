import type { AgentMessage } from "@earendil-works/pi-agent-core";

const STOP_REASONS = new Set(["stop", "length", "toolUse", "error", "aborted"]);

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || isString(value);
}

function isOptionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === "boolean";
}

function isTextContent(value: unknown): boolean {
  return isRecord(value) && value.type === "text" && isString(value.text) && isOptionalString(value.textSignature);
}

function isThinkingContent(value: unknown): boolean {
  return (
    isRecord(value) &&
    value.type === "thinking" &&
    isString(value.thinking) &&
    isOptionalString(value.thinkingSignature) &&
    isOptionalBoolean(value.redacted)
  );
}

function isImageContent(value: unknown): boolean {
  return isRecord(value) && value.type === "image" && isString(value.data) && isString(value.mimeType);
}

function isToolCall(value: unknown): boolean {
  return (
    isRecord(value) &&
    value.type === "toolCall" &&
    isString(value.id) &&
    isString(value.name) &&
    isRecord(value.arguments) &&
    isOptionalString(value.thoughtSignature)
  );
}

function isUserContent(value: unknown): boolean {
  return (
    isString(value) || (Array.isArray(value) && value.every((block) => isTextContent(block) || isImageContent(block)))
  );
}

function isAssistantContent(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every((block) => isTextContent(block) || isThinkingContent(block) || isToolCall(block))
  );
}

function isToolResultContent(value: unknown): boolean {
  return Array.isArray(value) && value.every((block) => isTextContent(block) || isImageContent(block));
}

function isUsage(value: unknown): boolean {
  return (
    isRecord(value) &&
    isFiniteNumber(value.input) &&
    isFiniteNumber(value.output) &&
    isFiniteNumber(value.cacheRead) &&
    isFiniteNumber(value.cacheWrite) &&
    isFiniteNumber(value.totalTokens) &&
    isRecord(value.cost) &&
    isFiniteNumber(value.cost.input) &&
    isFiniteNumber(value.cost.output) &&
    isFiniteNumber(value.cost.cacheRead) &&
    isFiniteNumber(value.cost.cacheWrite) &&
    isFiniteNumber(value.cost.total)
  );
}

function isUserMessage(value: UnknownRecord): boolean {
  return value.role === "user" && isUserContent(value.content) && isFiniteNumber(value.timestamp);
}

function isAssistantMessage(value: UnknownRecord): boolean {
  return (
    value.role === "assistant" &&
    isAssistantContent(value.content) &&
    isString(value.api) &&
    isString(value.provider) &&
    isString(value.model) &&
    isOptionalString(value.responseModel) &&
    isOptionalString(value.responseId) &&
    (value.diagnostics === undefined || Array.isArray(value.diagnostics)) &&
    isUsage(value.usage) &&
    isString(value.stopReason) &&
    STOP_REASONS.has(value.stopReason) &&
    isOptionalString(value.errorMessage) &&
    isFiniteNumber(value.timestamp)
  );
}

function isToolResultMessage(value: UnknownRecord): boolean {
  return (
    value.role === "toolResult" &&
    isString(value.toolCallId) &&
    isString(value.toolName) &&
    isToolResultContent(value.content) &&
    typeof value.isError === "boolean" &&
    isFiniteNumber(value.timestamp)
  );
}

export function isAgentMessage(value: unknown): value is AgentMessage {
  if (!isRecord(value)) {
    return false;
  }

  return isUserMessage(value) || isAssistantMessage(value) || isToolResultMessage(value);
}

export function assertAgentMessage(value: unknown): AgentMessage {
  if (!isAgentMessage(value)) {
    throw new Error("Expected an AgentMessage.");
  }

  return value;
}

export type { AgentMessage };
