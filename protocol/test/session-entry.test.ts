import { assertSessionEntry, isIsoTimestamp, isSessionEntry, isUuidV7, type SessionEntry } from "../src/index.js";

const ROOT_ID = "0197f73a-8b00-7000-8000-000000000001";
const CHILD_ID = "0197f73a-8b00-7000-8000-000000000002";
const TIMESTAMP = "2026-07-10T02:30:00.000Z";

const COMMON_FIELDS = {
  id: CHILD_ID,
  timestamp: TIMESTAMP,
  parentId: ROOT_ID,
};

describe("isSessionEntry", () => {
  it.each<SessionEntry>([
    {
      type: "session_begin",
      id: ROOT_ID,
      timestamp: TIMESTAMP,
      parentId: null,
      cwd: "/workspace/pi-squared",
    },
    {
      type: "message",
      ...COMMON_FIELDS,
      message: { role: "user", content: "hello", timestamp: 1 },
    },
    {
      type: "model_change",
      ...COMMON_FIELDS,
      provider: "openai",
      model: "gpt-test",
    },
    {
      type: "thinking_level_change",
      ...COMMON_FIELDS,
      thinkingLevel: "high",
    },
    {
      type: "compaction",
      ...COMMON_FIELDS,
      summary: "Earlier work was summarized.",
      keptEntityId: ROOT_ID,
    },
    {
      type: "metadata",
      ...COMMON_FIELDS,
      title: "Protocol refactor",
      favorite: true,
    },
  ])("accepts $type entries", (entry) => {
    expect(isSessionEntry(entry)).toBe(true);
    expect(assertSessionEntry(entry)).toBe(entry);
  });

  it.each([
    { type: "session_begin", ...COMMON_FIELDS },
    { type: "message", ...COMMON_FIELDS, message: { role: "user", content: "hello" } },
    { type: "model_change", ...COMMON_FIELDS, provider: "openai" },
    { type: "thinking_level_change", ...COMMON_FIELDS, thinkingLevel: 1 },
    { type: "compaction", ...COMMON_FIELDS, summary: "summary", keptEntityId: "not-a-uuid" },
    { type: "metadata", ...COMMON_FIELDS, title: "title", favorite: "yes" },
    { type: "unknown", ...COMMON_FIELDS },
  ])("rejects invalid entries", (entry) => {
    expect(isSessionEntry(entry)).toBe(false);
  });

  it("rejects entries with invalid common fields", () => {
    expect(
      isSessionEntry({
        type: "session_begin",
        id: "0197f73a-8b00-4000-8000-000000000001",
        timestamp: TIMESTAMP,
        parentId: null,
        cwd: "/workspace",
      }),
    ).toBe(false);
    expect(
      isSessionEntry({
        type: "session_begin",
        id: ROOT_ID,
        timestamp: "July 10, 2026",
        parentId: null,
        cwd: "/workspace",
      }),
    ).toBe(false);
  });

  it("throws when asserting an invalid entry", () => {
    expect(() => assertSessionEntry(null)).toThrow("Expected a SessionEntry.");
  });
});

describe("session field validators", () => {
  it("validates UUIDv7 values", () => {
    expect(isUuidV7(ROOT_ID)).toBe(true);
    expect(isUuidV7("0197f73a-8b00-7000-7000-000000000001")).toBe(false);
    expect(isUuidV7("0197f73a-8b00-4000-8000-000000000001")).toBe(false);
  });

  it("validates ISO timestamps", () => {
    expect(isIsoTimestamp(TIMESTAMP)).toBe(true);
    expect(isIsoTimestamp("2026-07-10T11:30:00+09:00")).toBe(true);
    expect(isIsoTimestamp("2026-02-30T02:30:00Z")).toBe(false);
    expect(isIsoTimestamp("2026-07-10")).toBe(false);
  });
});
