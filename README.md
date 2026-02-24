# Agent (SolidJS + Bun)

This app is a SolidJS browser client for `codex app-server`.
It does not call `/v1/chat/completions`; it only talks to a local bridge that proxies Codex App Server JSON-RPC.

## What It Implements

- `initialize` -> `initialized`
- `thread/start`
- `turn/start`
- `turn/interrupt`
- Notification streaming over SSE (`/api/events`)
- Global approval policy selector in the UI header (`untrusted`, `on-failure`, `on-request`, `never`)
  propagated to both `thread/start` and `turn/start`
- Server request handling for:
  - `item/commandExecution/requestApproval`
  - `item/fileChange/requestApproval`
  - `item/tool/requestUserInput`
  - `item/tool/call`
  - `account/chatgptAuthTokens/refresh`
  - `applyPatchApproval`
  - `execCommandApproval`
- UI approval queue with decision submission:
  - Command decisions: `accept`, `acceptForSession`, `decline`, `cancel`
  - File change decisions: `accept`, `acceptForSession`, `decline`, `cancel`
  - Tool user input answers (`answers` map keyed by question id)

## Prerequisites

1. Install the Codex CLI so `codex app-server` is available on your PATH.
2. Make sure you are authenticated for Codex usage.

## Run

1. `bun install`
2. `bun run build`
3. `bun run serve`
4. Open `http://127.0.0.1:8787`

## Dev Mode (Vite + Bridge)

1. Start the bridge API: `bun run serve`
2. In a second terminal, start Vite: `bun run dev`
3. Open the Vite URL (usually `http://127.0.0.1:5173`)

`vite.config.ts` proxies `/api/*` to `http://127.0.0.1:8787`.

`bun run serve` starts `server/bridge.mjs`, which:
- spawns `codex app-server`
- proxies protocol calls via `/api/*`
- serves built static files from `dist/`

## Environment

- `PORT` (default `8787`)
- `HOST` (default `127.0.0.1`)
- `CODEX_MODEL` (default `gpt-5.3-codex`)
