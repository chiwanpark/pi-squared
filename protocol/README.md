# @chiwanpark/pi-squared-protocol

Shared protocol types and runtime validators for pi-squared packages.

Currently exports:

- `AgentMessage` - the agent transcript message type.
- `isAgentMessage(value)` - runtime type guard for messages sent over the server WebSocket.
- `assertAgentMessage(value)` - assertion helper for the same protocol.
