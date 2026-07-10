import { isAgentMessage, type AgentMessage } from "./agent-message.js";
import { isRecord, isString, type UnknownRecord } from "./validation.js";

const UUID_V7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO_TIMESTAMP_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/;

export type SessionEntryType =
  "session_begin" | "message" | "model_change" | "thinking_level_change" | "compaction" | "metadata";

export interface SessionEntryBase<T extends SessionEntryType = SessionEntryType> {
  type: T;
  id: string;
  timestamp: string;
  parentId: string | null;
}

export interface SessionBeginEntry extends SessionEntryBase<"session_begin"> {
  cwd: string;
}

export interface SessionMessageEntry extends SessionEntryBase<"message"> {
  message: AgentMessage;
}

export interface ModelChangeEntry extends SessionEntryBase<"model_change"> {
  provider: string;
  model: string;
}

export interface ThinkingLevelChangeEntry extends SessionEntryBase<"thinking_level_change"> {
  thinkingLevel: string;
}

export interface CompactionEntry extends SessionEntryBase<"compaction"> {
  summary: string;
  keptEntityId: string;
}

export interface SessionMetadataEntry extends SessionEntryBase<"metadata"> {
  title: string;
  favorite: boolean;
}

export type SessionEntry =
  | SessionBeginEntry
  | SessionMessageEntry
  | ModelChangeEntry
  | ThinkingLevelChangeEntry
  | CompactionEntry
  | SessionMetadataEntry;

export function isUuidV7(value: unknown): value is string {
  return isString(value) && UUID_V7_PATTERN.test(value);
}

export function isIsoTimestamp(value: unknown): value is string {
  if (!isString(value)) {
    return false;
  }

  const match = ISO_TIMESTAMP_PATTERN.exec(value);
  if (!match) {
    return false;
  }

  const [, yearText, monthText, dayText, hourText, minuteText, secondText, offsetHourText, offsetMinuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const offsetHour = offsetHourText === undefined ? 0 : Number(offsetHourText);
  const offsetMinute = offsetMinuteText === undefined ? 0 : Number(offsetMinuteText);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();

  return (
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysInMonth &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59 &&
    offsetHour <= 23 &&
    offsetMinute <= 59
  );
}

function hasCommonFields(value: UnknownRecord): boolean {
  return (
    isString(value.type) &&
    isUuidV7(value.id) &&
    isIsoTimestamp(value.timestamp) &&
    (value.parentId === null || isUuidV7(value.parentId))
  );
}

export function isSessionEntry(value: unknown): value is SessionEntry {
  if (!isRecord(value) || !hasCommonFields(value)) {
    return false;
  }

  switch (value.type) {
    case "session_begin":
      return isString(value.cwd);
    case "message":
      return isAgentMessage(value.message);
    case "model_change":
      return isString(value.provider) && isString(value.model);
    case "thinking_level_change":
      return isString(value.thinkingLevel);
    case "compaction":
      return isString(value.summary) && isUuidV7(value.keptEntityId);
    case "metadata":
      return isString(value.title) && typeof value.favorite === "boolean";
    default:
      return false;
  }
}

export function assertSessionEntry(value: unknown): SessionEntry {
  if (!isSessionEntry(value)) {
    throw new Error("Expected a SessionEntry.");
  }

  return value;
}
