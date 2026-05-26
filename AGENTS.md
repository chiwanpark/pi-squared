# AGENTS.md

The rules any coding agents working on this project should follow. This repository contains several projects running "pi-squared", which is an interactive coding agent.

### Common Rules

These rules should be applied for all subprojects in this repository.

- Before implement a code snippet, function, or method, search the similar approach in the codebase. Do not add duplicated codes.
- Before you conclude you complete the task requested, run lint and unit and integration tests for each project:
  - `agent`: `pnpm lint`, `pnpm format:check`, and `pnpm test`.
