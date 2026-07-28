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

Mentioned messages may include PNG, JPEG, GIF, or WebP attachments up to 10 MiB.
Shepherd downloads and validates those images before submitting them to Codex
as inline image input.

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
> For detailed design and maintenance references, start with the
> [.docs index](.docs/README.md).

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

> [!WARNING]
> The checked-in `envs/common.env.example` defaults to `CODEX_APPROVAL_POLICY=never`
> and `CODEX_SANDBOX=danger-full-access`. That is intentional for unattended
> operation, but it also means Shepherd can run commands and modify files without
> approval prompts. Review those values before running Shepherd against any repo
> or machine you care about.

5. Start the Discord adapter:

```bash
bun run dev
```

`bun run dev` typechecks the server and then launches the Discord adapter. Use `bun run start`
to launch without the typecheck step, `bun run check` for typechecking only, and `bun test`
for the test suite.

## Rooted Android Deployment

The Android deployment runs Shepherd directly in an Ubuntu chroot hosted by
Termux and supervises it with tmux. See [deploy/README.md](deploy/README.md) for
installation, authentication, startup, and Termux:Boot instructions. The
Docker files remain available as an optional deployment for compatible Linux
kernels.

## 🔧 Runtime Configuration

Shepherd loads env files from `envs/` in this order:

- `envs/common.env`
- `envs/discord.env`

Supported keys:

- `DISCORD_BOT_TOKEN`: required
- `SHEPHERD_DISCORD_STREAMING`: optional boolean, default `false`. Discord
  provides live typing, tool activity, and completed commentary, then sends
  the final answer once. Enabling this adds one editable final-answer preview.
- `CODEX_MODEL`: optional. If unset, the runtime falls back to `gpt-5.3-codex`
- `CODEX_APPROVAL_POLICY`: optional. Default in the example file: `never`
- `CODEX_SANDBOX`: optional. One of `read-only`, `workspace-write`, or `danger-full-access`

> [!WARNING]
> `CODEX_APPROVAL_POLICY=never` disables approval prompts. Combined with
> `CODEX_SANDBOX=danger-full-access`, this is effectively a yolo mode.
> Use it only when that trust boundary is acceptable.

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
- `!restart`
- `!deploy`

## Remote restart and deployment

`!restart` posts the current channel's `!repo` and `!thread` recovery commands,
then gracefully exits. The deployment supervisor starts the same checkout again.

`!deploy` requires a clean deployment checkout. It fetches the latest
`origin/main`, checks out that exact commit, and runs:

```bash
bun install --frozen-lockfile
bun run check
bun test
```

Each Git, install, build, and test command has a 30-minute timeout by default.
Set `SHEPHERD_DEPLOY_COMMAND_TIMEOUT_MS` to a positive number of milliseconds
to override that limit.

If validation fails, Shepherd restores the prior commit and dependencies and
stays online. If validation succeeds, it posts the same recovery commands and
gracefully restarts. Both commands refuse to proceed while a turn or approval is
active. After Shepherd reconnects, copy the posted commands to resume the Codex
thread; Shepherd does not persist channel bindings itself.
