<div align="center">

# 🐕 Shepherd 🐑

</div>

Shepherd is an opinionated application layer around `codex app-server`.

It packages the parts that sit above the raw app-server bridge: surface lifecycle, workspace targeting, command semantics, routing policy, approvals, and event delivery.

The goal is a reusable core that can back multiple surfaces and local ingress adapters. Discord is the current canary in the coal mine: the first serious surface proving that architecture under real constraints. Other adapters may be added later, but the core application flow is intended to stay the same.

Today, Shepherd ships a Discord surface and an opt-in localhost signal webhook.

## 🎯 What It Does

Shepherd treats an external surface as a long-lived Codex surface. It binds a surface to an active thread and workspace target, coordinates thread lifecycle operations like create, resume, fork, switch, archive, rollback, and compaction, provisions workspaces from GitHub or local paths, and exposes shared control actions such as model selection, context reads, limits, and skill management.

In the current Discord adapter, that shows up as channel-scoped threads, per-channel repo selection, workspace provisioning, configurable listening modes, approval handling, and thread-level operational controls.

> [!NOTE]
> Guild channels start in mention-only mode. After a thread is attached, use
> `!listen open` to treat every human message in that channel as Shepherd input.
> Direct messages are open by default, and `!pause` stops conversation input
> without disabling control commands.

Accepted messages may include PNG, JPEG, GIF, or WebP attachments up to 10 MiB.
Shepherd decides whether the message is addressed before downloading anything,
then validates accepted attachments and submits them to Codex as inline image
input. Audio attachments are rejected without downloading them because the
available Codex models do not accept audio; use device dictation to send speech
as text instead.

When Codex image generation produces a saved PNG, JPEG, GIF, or WebP artifact
up to 10 MiB, Shepherd validates and uploads the generated image back to the
Discord channel.

## 🧱 Architecture

- `shared/protocol`: request, event, approval, and user-input contracts
- `server/core`: the application and runtime core around `codex app-server`
- `server/adapters/discord`: Discord transport, parsing, rendering, delivery, and interactions
- `server/adapters/webhook`: loopback HTTP signal ingress
- `server/signals`: registered signal-kind definitions
- `server/runtime`: shared process composition and lifecycle
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

The Discord bot needs `View Channel`, `Send Messages`, `Read Message History`,
and `Attach Files` in every channel where Shepherd operates. Shepherd renders
text with Discord Components V2 and reports a delivery failure if the API
rejects a V2 payload. Generated-image delivery requires `Attach Files`.

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
- `SHEPHERD_SIGNAL_WEBHOOK_ENABLED`: optional boolean, default `false`
- `SHEPHERD_SIGNAL_WEBHOOK_HOST`: optional, default `127.0.0.1`; non-loopback binds are rejected
- `SHEPHERD_SIGNAL_WEBHOOK_PORT`: optional integer, default `8787`
- `SHEPHERD_SIGNAL_WEBHOOK_MAX_BODY_BYTES`: optional integer, default `65536`
- `SHEPHERD_SIGNAL_QUEUE_CAPACITY`: optional integer, default `100`

> [!WARNING]
> `CODEX_APPROVAL_POLICY=never` disables approval prompts. Combined with
> `CODEX_SANDBOX=danger-full-access`, this is effectively a yolo mode.
> Use it only when that trust boundary is acceptable.

The committed `.example` files are the templates intended for public use.

## Local signal webhook

When enabled, Shepherd advertises `shepherd.get_signal_callback` to new Codex
threads. Codex calls it immediately before launching a detached local service,
then passes the returned URL to that service with its `--signal-url` CLI
argument. Each call creates a fresh callback bound to the active Codex thread,
workspace, and Discord surface; no channel or thread ID is configured by the
producer.

The callback endpoint is intentionally unauthenticated and must not be proxied
or exposed beyond the trusted local host. The initial signal kind is
`research.state-changed`. A producer posts to the exact URL returned by the
tool:

```bash
curl --fail-with-body http://127.0.0.1:8787/signals/RETURNED_OPAQUE_ROUTE_ID \
  -H 'Content-Type: application/json' \
  --data '{
    "kind": "research.state-changed",
    "version": 1,
    "subject": {"type": "research-run", "id": "run-123"},
    "payload": {"state": "COMPLETE", "verified": true, "researchProject": "P001"}
  }'
```

The originating Discord conversation must remain attached when the callback is
created and delivered. Shepherd queues and coalesces signals only in memory,
never steers an active human turn, and uses that conversation's existing event
subscription to deliver the result.

`202 Accepted` means only that the current process accepted the signal; queued
signals and callback routes are intentionally lost on restart. Terminal
research states revoke their route after acceptance; otherwise routes expire
after 24 hours. `GET /health` reports whether the adapter is accepting work.

Dynamic tools are persisted when a thread is created. A thread created before
this feature was deployed must be replaced with `!newthread` once so its rollout
contains the callback tool. See
[the signal contract](.docs/volatile-webhook-signals.md) for the complete API,
failure semantics, and extension model.

## 💬 Current Adapter: Discord

Shepherd uses Discord Components V2 throughout the surface. Completed Codex
Markdown and commentary render as clean Text Displays, while channel status,
control confirmations, telemetry, model/skill/thread listings, approvals, turn
activity, lifecycle progress, warnings, and asynchronous failures use accented
Containers. Generated images use Media Galleries. Markdown-aware segmentation
preserves code fences and reply context across long answers. Components V2 is
the only outbound Discord message format; rejected payloads are reported as
delivery failures rather than silently downgraded to legacy content or embeds.
Thread and model listings use Codex cursors and show five entries per page with
Components V2 navigation controls; Shepherd does not cache list snapshots.
Local Codex file links are rendered as compact workspace-relative code paths
because Discord cannot open host-local filesystem links. Web links remain
clickable, and links inside inline or fenced code are preserved verbatim.

The normal flow is:

1. Set the repo or workspace target for the channel with `!repo`
2. Start a new Codex thread with `!newthread`
3. Keep the default mention-only mode, or run `!listen open` for a dedicated Shepherd channel
4. Send text or images; use device dictation when composing by voice
5. Use `!pause`, `!resume`, and the thread, model, skill, and context commands as needed

Listening modes are scoped to the Discord channel:

- **Mention-only** (guild default): commands and messages mentioning Shepherd are accepted.
- **Open**: every human text and image message is accepted.
- **Paused**: conversation input is ignored, but control commands remain available.

Direct messages behave as open surfaces unless paused. `!detach` removes the
channel-to-thread binding without archiving the Codex thread and resets the
channel to mention-only. Listening state is runtime state; restart and deploy
recovery instructions include `!listen open` when an open channel must be
restored.

Repo targets supported by `!repo`:

- `!repo owner/repo`: GitHub repo, cloned into `~/.agent-workspaces/<repo>/<threadId>`
- `!repo ~`: local ephemeral workspace root under `~/.agent-workspaces/local/<threadId>`
- `!repo ~/path`: existing local path

If a channel has no repo selected, thread creation fails until `!repo` is set.

## ⌨️ Commands

- `!help`
- `!status`
- `!listen [open|mentions]`
- `!pause`
- `!resume`
- `!detach`
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
- `!deploy branch <branch-name>`
- `!deploy status`

## Remote restart and deployment

`!restart` posts the current channel's `!repo`, `!thread`, and open-listening
recovery commands,
then gracefully exits. The deployment supervisor starts the same checkout again.

`!deploy` requires a clean deployment checkout. With no arguments it fetches
the latest `origin/main`; `!deploy branch <branch-name>` instead fetches that
remote branch for a preview deployment. Both forms check out the exact fetched
commit in detached mode and run:

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
gracefully restarts. Use `!deploy status` to inspect the current commit and any
locally fetched `origin` refs that point to it; Shepherd stores no deployment
provenance of its own. On the first startup after upgrading, it removes the
legacy `.git/shepherd-deployment.json` record.
After testing a preview branch, run bare `!deploy` to return to stable
`origin/main`. Deployment and restart refuse to proceed while a turn or approval
is active. After Shepherd reconnects, copy the posted commands to resume the
Codex thread; Shepherd does not persist channel bindings itself.
