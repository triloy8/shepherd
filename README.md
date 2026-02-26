# Shepherd

This repository has been refactored into a clean architecture split:

- `shared/protocol`: canonical event/request/approval contracts
- `server/core`: session runtime, approval lifecycle, event bus
- `server/adapters/http`: HTTP + SSE transport adapter
- `ui/solid`: Solid UI entrypoint, styles, controller, presentation, and services

## Run (dev)

1. `bun install`
2. `bun run build` (build UI assets into `dist/`)
3. `bun run dev` (single Bun server binary entrypoint with watch mode)

## Run (production-like)

1. `bun run build`
2. `bun run serve`
3. Optional single executable: `bun run build:bin` then run `./release/shepherd`
4. Optional Discord bot executable: `bun run build:bin:discord` then run `./release/shepherd-discord`
5. Build both executables: `bun run build:bin:all`

## Discord Bot

1. Set env vars:
   - `DISCORD_BOT_TOKEN` (required)
   - `DISCORD_APPROVAL_POLICY` (optional, default `on-request`)
2. Run:
   - `bun run dev:discord` (Bun watch runtime)
   - or `bun run start:discord`

Bot commands:
- `!help` show commands
- `!newthread` create/reset channel thread mapping
- `!thread` show current mapped Shepherd thread
- any normal message sends a turn to Shepherd

Environment variables:

- `HOST` (default `127.0.0.1`)
- `PORT` (default `8787`)
- `CODEX_MODEL` (default `gpt-5.3-codex`)

Runtime env files are loaded from `envs/`:

- `envs/common.env` shared keys
- `envs/http.env` HTTP adapter keys
- `envs/discord.env` Discord adapter keys
- `envs/*.env.example` templates you can copy to `.env`
