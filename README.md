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
   - `CODEX_APPROVAL_POLICY` (optional, default `on-request`)
   - `CODEX_SANDBOX` (optional: `read-only` | `workspace-write` | `danger-full-access`)
2. Run:
   - `bun run dev:discord` (Bun watch runtime)
   - or `bun run start:discord`

Bot commands:
- `!help` show commands
- `!newthread` create a fresh thread and set as active for this channel
- `!limits` show account rate-limit windows and credits
- `!context` show context usage for the active thread in this channel
- `!skills [reload]` list discovered local skills (optionally force reload)
- `!skills remote [enabled=true|false] [scope=example|workspace-shared|all-shared|personal] [surface=chatgpt|codex|api|atlas]` list remote skills
- `!skill export <hazelnutId>` export a remote skill by id
- `!skill enable <path>` enable a skill by path
- `!skill disable <path>` disable a skill by path
- `!threads` list active stored threads
- `!threads loaded` list loaded threads in memory
- `!threads archived` list archived threads
- `!thread` show current active thread
- `!thread <id>` switch active thread (auto-resume if needed)
- `!threadname <name>` set current thread name
- `!threadread [id]` show thread metadata and preview
- `!fork [id]` fork the current (or provided) thread and switch
- `!archive [id]` archive current (or provided) thread
- `!unarchive <id>` unarchive a thread
- `!rollback <numTurns> [id]` rollback thread history
- `!compact [id]` compact thread context
- `!interrupt` interrupt the active turn for this channel's current thread
- any normal message sends a turn to Shepherd

Guild message behavior:
- Shepherd only processes guild channels/threads (DMs are ignored)
- Non-command messages are processed only when the bot is mentioned (`@Shepherd`)
- Mentioning the bot while a turn is active steers that in-flight turn instead of starting a new turn

HTTP skills endpoints:
- `GET /api/skills`
- `GET /api/skills/remote`
- `POST /api/skills/remote/export` with `{ "hazelnutId": "..." }`
- `POST /api/skills/config` with `{ "path": "...", "enabled": true|false }`

Environment variables:

- `HOST` (default `127.0.0.1`)
- `PORT` (default `8787`)
- `CODEX_MODEL` (default `gpt-5.3-codex`)
- `CODEX_APPROVAL_POLICY` (optional, default `on-request`; used as the shared default approval policy)
- `CODEX_SANDBOX` (optional: `read-only` | `workspace-write` | `danger-full-access`; used as the shared default sandbox)

Runtime env files are loaded from `envs/`:

- `envs/common.env` shared keys
- `envs/http.env` HTTP adapter keys
- `envs/discord.env` Discord adapter keys
- `envs/*.env.example` templates you can copy to `.env`
