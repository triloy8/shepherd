# Shepherd

This repository is now focused on the Discord bot path:

- `shared/protocol`: canonical event/request/approval contracts
- `server/core`: surface workflow, session runtime, approval lifecycle, and event bus
- `server/adapters/discord`: Discord transport, commands, interactions, and rendering
- `envs`: runtime environment templates

## Run (dev)

1. `bun install`
2. `bun run build`
3. `bun run dev`

## Run (production-like)

1. `bun run build`
2. `bun run serve`
3. Optional single executable: `bun run build:bin` then run `./release/shepherd-discord`

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
- non-command messages are processed only when the bot is mentioned

Guild message behavior:
- Shepherd only processes guild channels/threads (DMs are ignored)
- Non-command messages are processed only when the bot is mentioned (`@Shepherd`)
- Mentioning the bot while a turn is active steers that in-flight turn instead of starting a new turn

Environment variables:

- `CODEX_MODEL` (default `gpt-5.3-codex`)
- `CODEX_APPROVAL_POLICY` (optional, default `on-request`; used as the shared default approval policy)
- `CODEX_SANDBOX` (optional: `read-only` | `workspace-write` | `danger-full-access`; used as the shared default sandbox)

Runtime env files are loaded from `envs/`:

- `envs/common.env` shared keys
- `envs/discord.env` Discord adapter keys
- `envs/*.env.example` templates you can copy to `.env`
