# Agent (Codex App Server Minimal Proto)

This app is a minimal browser client for `codex app-server`.
It does not call `/v1/chat/completions`; it only speaks to a local bridge that proxies Codex App Server JSON-RPC.

## What It Implements

- `initialize` -> `initialized`
- `thread/start`
- `turn/start`
- `turn/interrupt`
- Notification streaming over SSE (`/api/events`)

## Prerequisites

1. Install the Codex CLI so `codex app-server` is available on your PATH.
2. Make sure you are authenticated for Codex usage.

## Run

1. `bun install`
2. `bun run build`
3. `bun run serve`
4. Open `http://127.0.0.1:8787`

`bun run serve` starts `server/bridge.mjs`, which:
- spawns `codex app-server`
- proxies protocol calls via `/api/*`
- serves static files from this repo

## Environment

- `PORT` (default `8787`)
- `HOST` (default `127.0.0.1`)
- `CODEX_MODEL` (default `gpt-5.3-codex`)
