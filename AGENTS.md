# AGENTS.md

The rules any coding agents working on this project should follow. This repository contains several projects running "pi-squared", which is an interactive coding agent.

### Common Rules

These rules should be applied for all subprojects in this repository.

- Before implement a code snippet, function, or method, search the similar approach in the codebase. Do not add duplicated codes.
- Use pnpm as a package manager for Node.js projects in this repository.
- Before you conclude you complete the task requested, run lint and unit and integration tests for each project:
  - Node.js project: `pnpm lint`, `pnpm format:check`, and `pnpm test`.
- Never import `@earendil-works/pi-coding-agent` project. Just refer it as the reference implementation.
