# Codex Bridge (Hard Refactor)

This repository has been refactored into a clean architecture split:

- `shared/protocol`: canonical event/request/approval contracts
- `server/core`: session runtime, approval lifecycle, event bus
- `server/adapters/http`: HTTP + SSE transport adapter
- `ui/solid`: Solid UI entrypoint, styles, controller, presentation, and services

## Run (dev)

1. `npm install`
2. `npm run dev:http` (HTTP bridge server)
3. `npm run dev` (Solid app)

## Run (production-like)

1. `npm run build`
2. `npm run start:http`

Environment variables:

- `HOST` (default `127.0.0.1`)
- `PORT` (default `8787`)
- `CODEX_MODEL` (default `gpt-5.3-codex`)
