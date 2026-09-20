# 🐕 Shepherd 🐑

Shepherd runs Codex conversations through Discord and a private web UI.
Both surfaces use the same core for workspaces, conversation routing, approvals,
model settings, and host operations. Run either surface or both in one process.

You can send text and images, follow agent activity, approve actions, switch
conversations, and manage the host without opening a terminal for each turn.
Shepherd uses `codex app-server` to run the agent.

## Features

- Create and resume conversations in GitHub checkouts or local directories.
- Stream responses, separate progress from final answers, and display tool activity.
- Send PNG, JPEG, GIF, and WebP images and view generated images.
- Steer an active turn with a follow-up or interrupt it.
- Rename, fork, archive, restore, compact, and roll back conversations.
- Select models and reasoning effort; inspect context usage and account limits.
- Discover skills, reload them, and enable or disable them.
- Restart Shepherd or deploy a branch with build and test validation.

The [surface parity matrix](.docs/surface-parity-matrix.md) lists support and
limitations for Discord and web. Their interfaces differ: Discord binds channels
to conversations; web gives each selected conversation its own transcript.

## Requirements

Install these on the host:

- Bun and Git.
- Codex CLI, authenticated for the account that runs Shepherd.
- GitHub CLI (`gh`), authenticated when using GitHub projects or deployment.
- A process supervisor for remote restart/deploy. The supplied launcher uses tmux.

The [Ubuntu setup script](deploy/ubuntu/setup.sh) installs host dependencies and
pins a Codex CLI version. See the [deployment guide](deploy/README.md) for the
supplied service and boot setup. Docker files are available under `deploy/` for
compatible hosts.

## Setup

```bash
git clone https://github.com/triloy8/shepherd.git
cd shepherd
bun install
cp envs/common.env.example envs/common.env
```

Authenticate under the same host account that will run Shepherd:

```bash
codex login
gh auth login
```

Edit `envs/common.env` to select the surfaces:

```env
SHEPHERD_SURFACES=discord,web
```

Use `discord` or `web` to run only one. If unset, the selection defaults to
Discord. Copy and configure only the selected adapters' environment files.

The common template sets `CODEX_APPROVAL_POLICY=never` and
`CODEX_SANDBOX=danger-full-access`: commands and file changes can run without
approval prompts. To use approval requests and a workspace-limited sandbox,
set these explicitly:

```env
CODEX_APPROVAL_POLICY=on-request
CODEX_SANDBOX=workspace-write
```

Install the shared GitHub and browser skills using the
[skills installation guide](.docs/shared-skills-location.md). That guide also
covers the private GitHub identity and repository policy.

### Discord

```bash
cp envs/discord.env.example envs/discord.env
```

Set `DISCORD_BOT_TOKEN`. Enable the bot's Message Content intent and grant
`View Channel`, `Send Messages`, `Read Message History`, and `Attach Files`
in the channels it will use.

Guild channels start in mention-only mode. Direct messages accept conversation
input unless paused. Use `!listen open` after attaching a conversation to accept
all human text and image messages in a dedicated channel.

### Web

```bash
cp envs/web.env.example envs/web.env
```

The UI and API share `http://127.0.0.1:8788` by default. The listener always binds
to loopback. Local browser origins are allowed automatically.

For remote access, connect the host and client to the tailnet and configure
private Tailscale Serve. Put its exact HTTPS origin in `SHEPHERD_WEB_ORIGINS`
(no path or trailing slash). Follow the [private web setup](.docs/web-api.md#private-access-and-trust)
for the Serve commands and access settings.

Web has no application login or token. Clients that can reach it have operator
access. Use private Serve and tailnet access rules; do not expose it through
Funnel or a public proxy. Deployment does not enable Serve or change the selected
surfaces. Configuration changes take effect when Shepherd restarts.

### Build and start

```bash
bun run check:config
bun run build
bun run start
```

Configuration validation checks selected settings without connecting to Discord
or Codex. `bun run start` starts the host using the existing UI build.
`bun run dev` builds and starts in one command.

For supervised operation, use the [deployment guide](deploy/README.md).
A foreground process started with `bun run start` will not restart itself after
it exits.

## Using conversations

### Projects and workspaces

Choose a project when creating a conversation:

| Project input | Workspace |
| --- | --- |
| `owner/repo` | GitHub checkout at `~/.agent-workspaces/<repo>/<threadId>` |
| `~` | Local directory at `~/.agent-workspaces/local/<threadId>` |
| `~/path` | The specified local directory |

Resuming an existing conversation uses its saved working directory. It does not
require selecting the project again. If that directory is missing or unavailable,
restore it before resuming; Shepherd does not silently create a replacement.
A loaded conversation retains its current workspace.

### Web workflow

1. Select **New conversation**, choose a project, and create it.
2. Send a message or attach images. Follow-ups steer the active turn.
3. Use settings for models, effort, usage, and skills; use conversation actions
   for rename, fork, archive, compact, and rollback.
4. Select an existing conversation in the sidebar to resume it directly.

Conversations are listed by most recent update. The list refreshes after selected
turn activity, when you return to the page, and every 30 seconds while visible.
Manual refresh shows a busy state. Loading older list pages pauses automatic
refresh until you manually return to the newest page. **Active** means not archived,
not necessarily running.

Use **Load earlier messages** within the transcript to read older turns. Text and
image drafts survive switching conversations within the page, but not a reload.
Web accepts up to four images, 5 MiB each and 10 MiB combined.

### Discord workflow

```text
!repo owner/repo
!newthread
!listen open
```

Then send text or images. `!pause` stops conversation input while leaving commands
available; `!resume` restores listening. `!detach` removes the channel binding
without stopping the agent or archiving the conversation. `!thread <id>` attaches
an existing conversation in its saved workspace.

Discord accepts supported images up to 10 MiB each. Audio attachments are not
supported. Final-answer token streaming is off by default; typing, activity, and
completed commentary provide progress feedback. Set
`SHEPHERD_DISCORD_STREAMING=true` to enable an editable final-answer preview.

Use `!help` for the command list:

| Task | Commands |
| --- | --- |
| Surface status and listening | `!status`, `!listen [open\|mentions]`, `!pause`, `!resume`, `!detach` |
| Project and new conversation | `!repo [project]`, `!newthread` |
| List conversations | `!threads`, `!threads loaded`, `!threads archived` |
| Select and inspect | `!thread [id]`, `!threadread [id]` |
| Rename and fork | `!threadname <name>`, `!fork [id]` |
| Archive and restore | `!archive [id]`, `!unarchive <id>` |
| Stored history | `!history [thread-id]`, `!history items <turn-id> [thread-id]` |
| Model and effort | `!models`, `!model`, `!model set <id>`, `!effort [set <level\|default>]` |
| Usage | `!context`, `!limits` |
| Skills | `!skills [reload]`, `!skill enable <name-or-path>`, `!skill disable <name-or-path>` |
| Turn and context controls | `!interrupt`, `!compact [id]`, `!rollback <numTurns> [id]` |
| Host lifecycle | `!restart`, `!deploy`, `!deploy branch <name>`, `!deploy status` |

## Restart and deployment

Use Discord commands or the web **Host controls** panel. These operations affect
all surfaces. Active turns and pending approvals block restart/deployment.

Deploy requires a clean checkout. It fetches `origin/main` by default, or the
selected branch, checks out the fetched commit, and runs:

```bash
bun install --frozen-lockfile
bun run check
bun run check:config
bun test --timeout 30000
```

Validation failure triggers restoration of the previous checkout and dependencies
and a rebuild of its UI. Successful deployment requests a restart through the
supervisor. The default timeout is 30 minutes per deployment command; override it
with `SHEPHERD_DEPLOY_COMMAND_TIMEOUT_MS`.

Web displays running and checkout commits separately and attempts to resume the
selected conversation after a web-initiated restart. Discord posts recovery
commands. Conversation bindings, event replay buffers, and pending host-operation
records are not a durable restart journal. After an unrelated restart, you may
need to resume your stored conversation manually.

## Configuration and development

Shared settings belong in `envs/common.env`; adapter settings belong in
`envs/discord.env` or `envs/web.env`. Process environment variables take precedence,
then common settings, then the selected adapter's settings. Disabled adapter files
are not loaded. See the committed [environment templates](envs/) for available keys.

| Command | Purpose |
| --- | --- |
| `bun run check:config` | Validate selected runtime configuration without connecting |
| `bun run build` | Typecheck/build the UI and compile the server |
| `bun run check` | Build and check test contracts |
| `bun run test` | Run tests with a 30-second per-test timeout |
| `bun run dev` | Build and start the host |
| `bun run dev:ui` | Start the Vite UI development server |
| `bun run build:bin` | Build the launcher at `release/shepherd` |

After updating protocol schemas, generate both formats:

```bash
codex app-server generate-ts --out ./schemas
codex app-server generate-json-schema --out ./schemas
```

## Code layout

| Path | Responsibility |
| --- | --- |
| `server/core/` | Shared policy, actions, conversation state, workspaces, and orchestration |
| `server/runtime/` | Surface assembly and process lifecycle |
| `server/adapters/discord/` | Discord input, commands, rendering, and delivery |
| `server/adapters/web/` | Built-in UI serving, private HTTP API, and SSE events |
| `ui/` | React, TypeScript, and Tailwind UI built with Vite |
| `server/adapters/http/` | Shared bounded HTTP body parsing |
| `server/adapters/webhook/`, `server/signals/` | Local signal ingress and registered signal kinds |
| `shared/protocol/`, `schemas/` | Application contracts and generated provider schemas |
| `server/config/`, `envs/` | Runtime configuration loading and templates |
| `deploy/` | Host setup, supervisors, and optional networking setup |

Adapters own transport and presentation. Shared behavior belongs in the core;
one surface does not call another surface's command handlers.

## Local signals

The optional loopback signal webhook lets detached local services notify a bound
conversation. The agent requests a callback URL immediately before launching the
service. Signals are queued in memory and do not steer an active human turn.
Callback routes and queued signals are lost on restart.

The webhook is separate from the web UI and is not a registered user surface.
It is unauthenticated and must stay local. See the
[signal contract](.docs/volatile-webhook-signals.md) for configuration, payloads,
route lifetime, and delivery behavior.

## Documentation

- [Surface parity matrix](.docs/surface-parity-matrix.md)
- [Surface selection and lifecycle](.docs/surface-launch.md)
- [Web API and private access](.docs/web-api.md)
- [Web UI reference](.docs/web-ui.md)
- [Host deployment](deploy/README.md)
- [Shared skills installation](.docs/shared-skills-location.md)
- [Architecture](.docs/architecture.md)
- [Documentation index](.docs/README.md)
