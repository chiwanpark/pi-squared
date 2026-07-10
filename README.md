# pi-squared

Yet another pi-based coding agent.

## Architecture

pi-squared is being split into five components:

- **Server** manages multiple executors and clients, stores configuration, and records messages.
- **Server UI** provides a standalone SvelteKit-based administration console.
- **Executor** calls LLMs, runs tool calls, and reports messages and status to the server.
- **Client** sends user requests to the server and presents the resulting output.
- **Protocol** provides the shared types and runtime validators used by the other components.

See [`protocol/README.md`](protocol/README.md) for protocol definitions and JSON examples.

## Development

- `pnpm dev`: Run CLI in development mode.
- `pnpm lint`: Run the shared linter across the workspace.
- `pnpm format`: Run the shared formatter across the workspace.
- `pnpm build`: Build workspace projects.
- `pnpm test`: Run tests.
- `pnpm --filter @chiwanpark/pi-squared-protocol test`: Run shared protocol tests.
- `pnpm --filter @chiwanpark/pi-squared-server dev`: Run the server in development mode.
- `pnpm --filter @chiwanpark/pi-squared-server-ui dev`: Run the administration UI in development mode.
