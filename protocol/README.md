# @chiwanpark/pi-squared-protocol

Shared protocol types and runtime validators for pi-squared servers, executors, and clients.

## AgentMessage

`AgentMessage` is the transcript payload shared by the server, executor, and client. It is the union of user, assistant, and tool-result messages from `@earendil-works/pi-agent-core`.

A user message:

```json
{
  "role": "user",
  "content": [{ "type": "text", "text": "List the files in this repository." }],
  "timestamp": 1783650601000
}
```

An assistant message containing a tool call:

```json
{
  "role": "assistant",
  "content": [
    {
      "type": "toolCall",
      "id": "call_01",
      "name": "bash",
      "arguments": { "command": "ls" }
    }
  ],
  "api": "openai-responses",
  "provider": "openai",
  "model": "gpt-5.1-codex",
  "usage": {
    "input": 120,
    "output": 15,
    "cacheRead": 0,
    "cacheWrite": 0,
    "totalTokens": 135,
    "cost": {
      "input": 0,
      "output": 0,
      "cacheRead": 0,
      "cacheWrite": 0,
      "total": 0
    }
  },
  "stopReason": "toolUse",
  "timestamp": 1783650602000
}
```

The corresponding tool result:

```json
{
  "role": "toolResult",
  "toolCallId": "call_01",
  "toolName": "bash",
  "content": [{ "type": "text", "text": "README.md\nprotocol\nserver" }],
  "isError": false,
  "timestamp": 1783650603000
}
```

Use `isAgentMessage(value)` or `assertAgentMessage(value)` before accepting an untrusted payload.

## Session

A session is represented as a tree of `SessionEntry` values. `SessionEntry` is a discriminated union selected by its `type` field. Every entry has these fields:

| Field       | Type             | Description                                                                |
| ----------- | ---------------- | -------------------------------------------------------------------------- |
| `type`      | string           | Entry discriminator.                                                       |
| `id`        | string           | UUIDv7 identifier for the entry.                                           |
| `timestamp` | string           | ISO timestamp at which the entry was created.                              |
| `parentId`  | string or `null` | UUIDv7 identifier of the parent session entry, or `null` for a root entry. |

A root `SessionBeginEntry` has a `null` parent; a forked session begin entry points to the entry from which it was forked.

The entry variants are:

| Type                    | Additional fields                         | Meaning                                                                              |
| ----------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------ |
| `session_begin`         | `cwd: string`                             | A session started or was forked.                                                     |
| `message`               | `message: AgentMessage`                   | An agent message was added.                                                          |
| `model_change`          | `provider: string`, `model: string`       | The active model changed.                                                            |
| `thinking_level_change` | `thinkingLevel: string`                   | The reasoning level changed.                                                         |
| `compaction`            | `summary: string`, `keptEntityId: UUIDv7` | Earlier context was summarized; `keptEntityId` identifies the first retained entity. |
| `metadata`              | `title: string`, `favorite: boolean`      | Session metadata changed.                                                            |

The following JSON array illustrates a linear session. Each value in the array is a separate `SessionEntry` protocol message:

```json
[
  {
    "type": "session_begin",
    "id": "019f49dc-4440-7000-8000-000000000001",
    "timestamp": "2026-07-10T02:30:00.000Z",
    "parentId": null,
    "cwd": "/workspace/pi-squared"
  },
  {
    "type": "message",
    "id": "019f49dc-4828-7000-8000-000000000002",
    "timestamp": "2026-07-10T02:30:01.000Z",
    "parentId": "019f49dc-4440-7000-8000-000000000001",
    "message": {
      "role": "user",
      "content": [{ "type": "text", "text": "Refactor the protocol package." }],
      "timestamp": 1783650601000
    }
  },
  {
    "type": "model_change",
    "id": "019f49dc-4c10-7000-8000-000000000003",
    "timestamp": "2026-07-10T02:30:02.000Z",
    "parentId": "019f49dc-4828-7000-8000-000000000002",
    "provider": "openai",
    "model": "gpt-5.1-codex"
  },
  {
    "type": "thinking_level_change",
    "id": "019f49dc-4ff8-7000-8000-000000000004",
    "timestamp": "2026-07-10T02:30:03.000Z",
    "parentId": "019f49dc-4c10-7000-8000-000000000003",
    "thinkingLevel": "high"
  },
  {
    "type": "compaction",
    "id": "019f49dc-53e0-7000-8000-000000000005",
    "timestamp": "2026-07-10T02:30:04.000Z",
    "parentId": "019f49dc-4ff8-7000-8000-000000000004",
    "summary": "The user requested a protocol refactor and selected an OpenAI model.",
    "keptEntityId": "019f49dc-4828-7000-8000-000000000002"
  },
  {
    "type": "metadata",
    "id": "019f49dc-57c8-7000-8000-000000000006",
    "timestamp": "2026-07-10T02:30:05.000Z",
    "parentId": "019f49dc-53e0-7000-8000-000000000005",
    "title": "Protocol refactor",
    "favorite": true
  }
]
```

Use `isSessionEntry(value)` or `assertSessionEntry(value)` to validate entries received over a network or loaded from storage. Validation includes each UUID version/variant, ISO timestamp syntax, discriminator-specific fields, and nested agent messages.

## Exports

- `AgentMessage`, `isAgentMessage(value)`, and `assertAgentMessage(value)`
- `SessionEntry` and its six entry interfaces:
  - `SessionBeginEntry`
  - `SessionMessageEntry`
  - `ModelChangeEntry`
  - `ThinkingLevelChangeEntry`
  - `CompactionEntry`
  - `SessionMetadataEntry`
- `isSessionEntry(value)` and `assertSessionEntry(value)`
- `isUuidV7(value)` and `isIsoTimestamp(value)`
