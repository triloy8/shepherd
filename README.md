# Shepherd

Shepherd is an opinionated application shell around `codex app-server`.

Its goal is not to be a Discord product. The goal is to provide a reusable application core for long-lived Codex surfaces: policy, action semantics, state, orchestration, and runtime wiring around the app-server bridge.

Discord is the current canary in the coal mine: the first serious adapter proving the architecture under real surface constraints. Other adapters may be added later, but the core application flow is intended to remain the same.

Today, the shipped adapter is Discord. Through that adapter, Shepherd currently provides:

- channel-scoped conversation threads
- per-channel repo selection
- automatic workspace provisioning for new and forked threads
- approval and sandbox policy forwarding
- model inspection and per-thread model switching
- local skill discovery and enable/disable controls

## What It Does

At a system level, Shepherd can:

- treat an external surface as a long-lived Codex conversation surface
- bind a surface to an active thread and workspace target
- coordinate thread lifecycle across create, resume, fork, switch, archive, rollback, and compaction flows
- provision a workspace for a thread from either GitHub or a local path
- expose shared control actions like model selection, context reads, limits, and skill management
- stream events and approvals back to the active surface

In the current Discord adapter, that means Shepherd can:

- bind each channel or thread to an active Codex conversation thread
- route commands and mentioned messages into Codex
- clone a GitHub repo into an isolated workspace for a thread
- point a channel at a local workspace root instead of GitHub
- show context usage and Codex account rate-limit windows
- list available models and queue a model change for the next turn
- inspect, enable, and disable local skills for the active thread

> [!NOTE]
> Non-command messages are ignored unless the bot is mentioned.

## Architecture

- `shared/protocol`: request, event, approval, and user-input contracts
- `server/core`: the application and runtime core around `codex app-server`
- `server/adapters/discord`: Discord transport, parsing, rendering, delivery, and interactions
- `server/config`: env loading
- `envs`: local runtime config and example env files
- `schemas`: generated protocol schemas

The architectural split is intentional:

- `server/core/*` owns reusable policy, action semantics, state, and orchestration
- `server/adapters/discord/*` owns Discord-specific transport and presentation concerns

> [!NOTE]
> If you want the detailed rationale, start with [.docs/END-STATE-ARCHITECTURE.md](/home/tadhiel/shepherd/.docs/END-STATE-ARCHITECTURE.md).

## Setup

1. Install dependencies:

```bash
bun install
```

2. Create local env files from the examples:

```bash
cp envs/common.env.example envs/common.env
cp envs/discord.env.example envs/discord.env
```

3. Fill in at least:

- `DISCORD_BOT_TOKEN` in `envs/discord.env`
- optionally `CODEX_MODEL` in `envs/common.env`
- optionally `CODEX_APPROVAL_POLICY` in `envs/common.env`
- optionally `CODEX_SANDBOX` in `envs/common.env`

4. Start the Discord adapter:

```bash
bun run dev:discord
```

Other package scripts exist, but they are still in flux. `bun run dev:discord` is the main tested path.

## Runtime Configuration

Shepherd loads env files from `envs/` in this order:

- `envs/common.env`
- `envs/discord.env`

Supported keys:

- `DISCORD_BOT_TOKEN`: required
- `CODEX_MODEL`: optional. If unset, the runtime falls back to `gpt-5.3-codex`
- `CODEX_APPROVAL_POLICY`: optional. Common value: `on-request`
- `CODEX_SANDBOX`: optional. One of `read-only`, `workspace-write`, or `danger-full-access`

The committed `.example` files are the templates intended for public use.

## Current Adapter: Discord

The normal flow is:

1. Set the repo or workspace target for the channel with `!repo`
2. Start a new Codex thread with `!newthread`
3. Mention the bot to send turns into that thread
4. Use thread, model, skill, and context commands as needed

Repo targets supported by `!repo`:

- `!repo owner/repo`: GitHub repo, cloned into `~/.agent-workspaces/<repo>/<threadId>`
- `!repo ~`: local ephemeral workspace root under `~/.agent-workspaces/local/<threadId>`
- `!repo ~/path`: existing local path

If a channel has no repo selected, thread creation fails until `!repo` is set.

## Commands

- `!help`
- `!newthread`
- `!repo`
- `!repo <owner>/<repo>`
- `!repo ~`
- `!repo ~/path`
- `!limits`
- `!models`
- `!model`
- `!model set <id>`
- `!context`
- `!skills [reload]`
- `!skill enable <name-or-path>`
- `!skill disable <name-or-path>`
- `!threads`
- `!threads loaded`
- `!threads archived`
- `!thread`
- `!thread <id>`
- `!threadname <name>`
- `!threadread [id]`
- `!fork [id]`
- `!archive [id]`
- `!unarchive <id>`
- `!rollback <numTurns> [id]`
- `!compact [id]`
- `!interrupt`
