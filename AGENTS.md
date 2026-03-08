# AGENTS.md

## Shepherd

Use these repo-specific rules when working in `shepherd`.

- When dependencies need to be installed or refreshed, use `bun install`.
- When generating or updating schemas, run both commands:
  - `codex app-server generate-ts --out ./schemas`
  - `codex app-server generate-json-schema --out ./schemas`
