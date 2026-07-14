<div align="center">

# 🐕 Shepherd 🐑

</div>

Shepherd is an opinionated application layer around `codex app-server`.

It packages the parts that sit above the raw app-server bridge: surface lifecycle, workspace targeting, command semantics, routing policy, approvals, and event delivery.

The goal is a reusable core that can back multiple surfaces. Discord is the current canary in the coal mine: the first serious adapter proving that architecture under real constraints. Other adapters may be added later, but the core application flow is intended to stay the same.

Today, the shipped adapter is Discord.

## 🎯 What It Does

Shepherd treats an external surface as a long-lived Codex surface. It binds a surface to an active thread and workspace target, coordinates thread lifecycle operations like create, resume, fork, switch, archive, rollback, and compaction, provisions workspaces from GitHub or local paths, and exposes shared control actions such as model selection, context reads, limits, and skill management.

In the current Discord adapter, that shows up as channel-scoped threads, per-channel repo selection, workspace provisioning, mention-driven turns, approval handling, and thread-level operational controls.

> [!NOTE]
> Non-command messages are ignored unless the bot is mentioned.

## 🧱 Architecture

- `shared/protocol`: request, event, approval, and user-input contracts
- `server/core`: the application and runtime core around `codex app-server`
- `server/adapters/discord`: Discord transport, parsing, rendering, delivery, and interactions
- `server/config`: env loading
- `envs`: local runtime config and example env files
- `schemas`: generated protocol schemas
- `.codex/skills`: vendored Codex skills used by Shepherd

The architectural split is intentional:

- `server/core/*` owns reusable policy, action semantics, state, and orchestration
- `server/adapters/discord/*` owns Discord-specific transport and presentation concerns

> [!NOTE]
> If you want the detailed rationale, start with [.docs/END-STATE-ARCHITECTURE.md](.docs/END-STATE-ARCHITECTURE.md).

## ⚙️ Setup

1. Clone the repository:

```bash
git clone <repo-url>
```

2. Install dependencies:

```bash
bun install
```

3. Create local env files from the examples:

```bash
cp envs/common.env.example envs/common.env
cp envs/discord.env.example envs/discord.env
```

4. Fill in at least:

- `DISCORD_BOT_TOKEN` in `envs/discord.env`
- optionally `CODEX_MODEL` in `envs/common.env`
- optionally `CODEX_APPROVAL_POLICY` in `envs/common.env`
- optionally `CODEX_SANDBOX` in `envs/common.env`

5. Start the Discord adapter:

```bash
bun run dev
```

`bun run dev` typechecks the server and then launches the Discord adapter. Use `bun run start`
to launch without the typecheck step, `bun run check` for typechecking only, and `bun test`
for the test suite.

## 🔧 Runtime Configuration

Shepherd loads env files from `envs/` in this order:

- `envs/common.env`
- `envs/discord.env`

Supported keys:

- `DISCORD_BOT_TOKEN`: required
- `CODEX_MODEL`: optional. If unset, the runtime falls back to `gpt-5.3-codex`
- `CODEX_APPROVAL_POLICY`: optional. Common value: `on-request`
- `CODEX_SANDBOX`: optional. One of `read-only`, `workspace-write`, or `danger-full-access`

The committed `.example` files are the templates intended for public use.

## 💬 Current Adapter: Discord

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

## ⌨️ Commands

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
