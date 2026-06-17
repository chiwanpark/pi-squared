# @chiwanpark/pi-squared-server

Server for collecting pi-squared agent session messages.

## Configuration

The server requires a shared secret before it starts:

```sh
export PI_SQUARED_SERVER_SECRET="change-me"
```

Optional environment variables:

- `PI_SQUARED_SERVER_HOST` (default: `0.0.0.0`)
- `PI_SQUARED_SERVER_PORT` or `PORT` (default: `8787`)
- `PI_SQUARED_SESSIONS_DIR` (default: `./sessions`)

## Development

```sh
pnpm --filter @chiwanpark/pi-squared-server dev
```

## API

- `GET /health` - health check; does not require the secret.
- `WS /sessions/:sessionId` - open an agent WebSocket connection and send each agent event as one JSON text message.

The server creates/touches `:sessionId.jsonl` when the WebSocket connects, validates each WebSocket message as an `AgentMessage` from `@chiwanpark/pi-squared-protocol`, records valid messages to that file, and replies with `connected` / `recorded` acknowledgements.

WebSocket handshakes accept either `Authorization: Bearer <secret>` or `X-Pi-Squared-Secret: <secret>`.
