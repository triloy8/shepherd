<h1 align="center">🐕 Shepherd 🐑</h1>

Shepherd runs Codex and Claude conversations through Discord and a private web UI.
Both surfaces use the same core for workspaces, conversation routing, approvals, user questions,
model settings, and host operations. Run either surface or both in one process.

You can send text and images, follow agent activity, approve actions, answer questions, switch
conversations, and manage the host without opening a terminal for each turn.
Provider adapters use `codex app-server` and the Claude Agent SDK behind the same application interface.

For existing installations, rename common policy settings before deploying this branch;
see [provider configuration](.docs/provider-abstraction.md#configuration-and-persistence).

## Features

- Create and resume conversations in GitHub checkouts or local directories.
- Stream responses, separate progress from final answers, and display tool activity.
- Watch plans, reasoning summaries and command output as they stream; finished commands
  keep their output and exit code.
- See delegated agents' work inside the step that started them, including background agents.
- Send PNG, JPEG, GIF, and WebP images and view generated images.
- Render Mermaid diagrams in web responses and draft previews using fenced `mermaid` code blocks, with source viewing and copying.
- Steer an active turn with a follow-up or interrupt it.
- Answer structured agent questions with choices or custom text; blocking questions wait for your submission.
- Rename, fork, archive, restore, compact, and roll back conversations.
- Select models and reasoning effort; inspect context usage and account limits.
- Discover skills, reload them, and enable or disable them.
- Restart Shepherd or deploy a branch with build and test validation; both wait for
  running work to finish.

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
supplied launcher and boot setup. Docker files are available as
[`Dockerfile`](Dockerfile) and [`compose.yaml`](compose.yaml) for compatible hosts.

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

`SHEPHERD_POLICY` sets what agents may do. A policy is three restrictions: where the
agent may write files (`none`, `workspace`, `any`), whether it may use the network
(`none`, `any`), and whether risky actions wait for approval (`risky`, `none`). The presets:

| `SHEPHERD_POLICY` | writes | network | review |
| --- | --- | --- | --- |
| `bypass` (common template) | any | any | none |
| `review` | any | any | risky |
| `workspace` | workspace | any | risky |
| `read_only` | none | any | risky |
| `provider_default` (unset) | each agent's own configuration | | |

Each agent declares native modes and the restrictions each guarantees. Shepherd runs a
conversation in the least restrictive mode that stays within the policy, so a policy never
makes an agent less restricted. For example, under `workspace` Codex uses its
workspace-write sandbox, which also blocks the network, and Claude uses plan mode, which
makes no changes. An agent with no mode within the policy is refused rather than run
looser. Create, resume and fork all apply the policy, and API requests may pass their own
`policy`. Shepherd prints a notice at startup and with `--check-config` for each installed
agent that cannot apply the policy exactly, and fails to start when the default agent would
refuse every conversation.

`SHEPHERD_APPROVAL_MODE` and `SHEPHERD_SANDBOX_MODE` were replaced by `SHEPHERD_POLICY`;
Shepherd refuses to start while either is set. `bypass` + `unrestricted` becomes
`SHEPHERD_POLICY=bypass`, and `review_sensitive` + `workspace_write` becomes
`SHEPHERD_POLICY=workspace`.

Choose **Codex** or **Claude** in the web UI's new-conversation dialog. The choice
belongs to the conversation; resume and fork preserve it. Codex is the default
unless `SHEPHERD_DEFAULT_PROVIDER=claude` is set; the dialog preselects the default and
Discord's `!newthread` uses it when no agent is named. Core/API callers can pass
`provider: "claude"` in `CreateThreadRequest`.
Model backend configuration stays in the provider’s native settings.

`CODEX_SUBAGENTS=disabled` and `CLAUDE_SUBAGENTS=disabled` stop conversations from
starting subagents; both default to `enabled`. Codex receives `agents.enabled=false`
(with `features.multi_agent_v2=false`, which would otherwise override it), which removes
the subagent tools even from models that turn them on themselves; `features.multi_agent=false`
alone does not. Claude has its `Agent` tool removed. Restart Shepherd after changing either.
Claude skills that run in a forked context still run as a subagent.

Claude defaults to subscription authentication (`CLAUDE_AUTH_MODE=subscription`).
Use your Claude Pro or Max account. On the machine running Shepherd, authenticate
with Claude Code as the same operating-system user that runs Shepherd. A saved
login is read from that user's Claude configuration directory; set
`CLAUDE_CONFIG_DIR` if you use a separate directory.

For setup from a phone, connect to the host over SSH and run `claude setup-token`
with an installed Claude Code CLI. Open the authorization link on your phone,
complete sign-in, and paste any browser login code back into the SSH terminal.
Store the resulting token in `envs/common.env` in Shepherd's launch directory:

```env
CLAUDE_AUTH_MODE=subscription
CLAUDE_CODE_OAUTH_TOKEN=your_token_here
```

Restart Shepherd after changing authentication. Keep the token private; do not
commit it. Shepherd includes the SDK executable, but has no web sign-in screen
and does not install a `claude` command on your PATH. See the official
[subscription guidance](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)
and [token instructions](https://code.claude.com/docs/en/authentication#generate-a-long-lived-token).

Subscription mode disables API keys, bearer tokens, API-key helpers, and cloud
provider environment selection for Claude queries, including model discovery.
It preserves the host environment for other providers. There is no automatic
fallback to API billing if the subscription login is missing or expired.
To use API credentials instead, explicitly set `CLAUDE_AUTH_MODE=api` and configure
authentication using the [SDK quickstart](https://code.claude.com/docs/en/agent-sdk/quickstart).

New Claude conversations default to **Opus 5.5 with medium effort**.
`CLAUDE_MODEL` and `CLAUDE_EFFORT` override those defaults. Resumed conversations
and forks recover the model from Claude's transcript, but effort uses the requested
override or the current host default because Claude does not record it. Conversation
model/effort controls apply individual overrides. There is no global default editor
in the web UI.

Optional shared environment settings are:

```env
CLAUDE_MODEL=claude-opus-5-5
CLAUDE_EFFORT=medium
# disabled removes the Agent tool, so conversations cannot start subagents:
# CLAUDE_SUBAGENTS=enabled
# Optional override of the SDK's bundled executable:
# CLAUDE_EXECUTABLE=/absolute/path/to/claude
```

Claude conversations are Claude Code sessions: Shepherd lists, reads, renames and archives
them through the Agent SDK and keeps no copy. Preserve Claude's own storage (`CLAUDE_CONFIG_DIR`,
`~/.claude` by default) to resume after restarting. Sessions started in Claude Code appear in
Shepherd's conversation list too. `SHEPHERD_CLAUDE_STATE_DIR` is no longer read; conversations
saved only in Shepherd's former copy, which never reached Claude, are not migrated.
The compiled Shepherd binary includes the SDK executable for the build host.

Shepherd application tools return media as `{ type: "image" | "audio", data, mimeType }`,
with standard padded base64 data and a matching MIME type. The shared tool registry
validates these results. Codex's adapter builds data URLs; Claude's MCP bridge emits
MCP media blocks. Remote URLs are not supported as application tool media results.
User message attachments and provider-managed external MCP tools use separate paths.

Claude supports text and image messages, streaming, follow-up input, interruption,
approvals, structured questions (including multiple selections), model/effort selection, stored history, rename, archive, resume, fork,
and Shepherd dynamic tools through MCP. `SHEPHERD_POLICY` applies to both providers:
`bypass` runs Claude with permission bypass; `review` uses Claude's `default` permission mode,
which asks through Shepherd before tools its rules do not allow; `workspace` and `read_only`
use plan mode, which makes no changes; `provider_default` sets no mode, so Claude applies the
`defaultMode` from its user, project, or local settings.
Claude has no sandbox in Shepherd. With `bypass`, Claude can run any command and
edit any file the Shepherd host user can, without a prompt. Codex with `bypass`
runs with full access. Run Claude conversations on an isolated host or container, or use
`review` when Claude should ask first. No Claude mode blocks the network, so a policy with
`network: none` refuses Claude conversations.
See the [SDK permission modes](https://code.claude.com/docs/en/agent-sdk/permissions).
Manual compaction, turn revert, audio/file input, and skill management controls
are unavailable for Claude. Claude loads its own configured project skills.
The sidebar **Usage & limits** panel has a discovered agent selector. It opens on the
selected conversation provider and shows account allowances shared across
conversations. Claude reports native subscription usage and reset times; unknown
or stale values are identified. Banked resets remain Codex-only.
The web UI uses provider capabilities to disable or hide unsupported operations.

Provider bindings are saved in `~/.shepherd/providers`, or
`SHEPHERD_PROVIDER_STATE_DIR` when set. Keep this directory with the providers’
native session storage when moving a host. Existing thread IDs remain
stable. Claude background tasks keep their SDK process alive after a turn ends
and count as runtime activity. A later response from background work is saved
as a new turn. Model, effort, working-directory, or permission changes wait until
background tasks finish. See [Architecture](.docs/architecture.md) for dependency
boundaries and the [provider abstraction](.docs/provider-abstraction.md) design
for the shared conversation model.

Install the shared GitHub and browser skills using the
[skills installation guide](.docs/shared-skills-location.md). That guide also
covers the private GitHub identity and repository policy. Claude conversations
also need `~/.claude/skills` to be a symbolic link to the shared skills
directory; see [Claude Code discovery](.docs/shared-skills-location.md#claude-code-discovery).

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
3. Use **Model and effort** and **Conversation context** below the composer for
   settings and usage. Open **Conversation menu** for skills, fork, archive, and
   compact; select the conversation title to rename it. Use **Revert from here**
   beside Copy under a user message to remove that turn and all later turns.
   Files are not changed.
4. Select an existing conversation in the sidebar to resume it directly.

Conversations are listed by most recent update. The list refreshes after selected
turn activity, when you return to the page, and every 30 seconds while visible.
Manual refresh shows a busy state. Loading older list pages pauses automatic
refresh until you manually return to the newest page. **Active** means not archived,
not necessarily running.

Use **Load earlier messages** within the transcript to read older turns. Text and
image drafts survive switching conversations within the page, but not a reload.
Web accepts up to four images, 5 MiB each and 10 MiB combined.

When Shepherd shows **Waiting for your answer**, select or enter answers and choose
**Submit answers**, or explicitly **Skip questions**. No option is chosen automatically.
Pending questions return after a reload, but unsubmitted question-answer drafts do not.
See [answering questions](.docs/user-questions.md) for desktop/mobile examples and
blocking versus nonblocking behavior.

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

Question cards offer **Submit answers** to open a Discord modal and **Skip questions**
to decline answering. Modals support up to five nonsecret, single-selection questions;
enter exact option labels or custom text when offered. Secret questions, multiple-selection
questions, and larger forms direct you to the web UI.

Use `!help` for the command list:

| Task | Commands |
| --- | --- |
| Surface status and listening | `!status`, `!listen [open\|mentions]`, `!pause`, `!resume`, `!detach` |
| Project and new conversation | `!repo [project]`, `!newthread [provider]`, `!providers` |
| List conversations | `!threads`, `!threads loaded`, `!threads archived` |
| Select and inspect | `!thread [id]`, `!threadread [id]` |
| Rename and fork | `!threadname <name>`, `!fork [id]` |
| Archive and restore | `!archive [id]`, `!unarchive <id>` |
| Stored history | `!history [thread-id]`, `!history items <turn-id> [thread-id]` |
| Model and effort | `!models`, `!model`, `!model set <id>`, `!effort`, `!effort set <level>`, `!effort default`, `!effort clear` |
| Usage | `!context`, `!limits [provider]` |
| Skills | `!skills [reload]`, `!skill enable <name-or-path>`, `!skill disable <name-or-path>` |
| Turn and context controls | `!interrupt`, `!compact [id]` |
| Host lifecycle | `!restart`, `!deploy`, `!deploy branch <name>`, `!deploy status` |

`!rollback` is retired and returns a notice directing users to the web revert action.

## Restart and deployment

Use Discord commands or **Host controls** in the web sidebar. These operations affect
all surfaces. Either may be started while agents work: a restart, and a deploy once it
validates, waits for active turns, background tasks, pending approvals and pending user
questions to finish. New turns are refused meanwhile, while interrupts and approvals keep
working. If the work has not finished after 30 minutes, Shepherd keeps running and accepts
new turns again.

Deploy requires a clean checkout. It fetches `origin/main` by default, or the
selected branch, checks out the fetched commit, and runs:

```bash
bun install --frozen-lockfile
bun run check
bun run check:config
bun test --timeout 30000
```

If validation fails after changing commits, Shepherd attempts to restore the previous
checkout and dependencies and rebuild its UI. Validation failure on the current
commit leaves it selected without reinstalling or rebuilding it. Successful deployment
requests a restart through the supervisor. The default timeout is 30 minutes per
deployment command; override it with `SHEPHERD_DEPLOY_COMMAND_TIMEOUT_MS`.

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
| `bun run build:bin` | Compile the server with UI assets and the bundled Claude executable at `release/shepherd` |

After updating protocol schemas, generate both formats:

```bash
codex app-server generate-ts --out ./schemas
codex app-server generate-json-schema --out ./schemas
```

## Code layout

Listed from composition down to the shared contracts. Core and providers are
independent layers; their allowed dependencies are defined in the architecture guide.

| Path | Responsibility |
| --- | --- |
| `server/main.ts`, `server/runtime/` | Composition: wires surfaces, core and providers; process lifecycle |
| `server/adapters/discord/` | Discord input, commands, rendering, and delivery |
| `server/adapters/web/` | Built-in UI serving, private HTTP API, and SSE events |
| `ui/` | React, TypeScript, and Tailwind UI built with Vite |
| `server/adapters/webhook/`, `server/signals/` | Local signal ingress and registered signal kinds |
| `server/adapters/shared/` | Presentation helpers surfaces share: body parsing, answer streaming, paging, image loading |
| `server/core/` | Conversations, workspaces, signals, lifecycle and surface services, in sub-layers; surfaces use it only through `surface_api.ts` |
| `server/providers/` | Native Codex and Claude adapters, and support they share |
| `server/ports/` | The provider port: what core needs from an agent |
| `server/config/`, `server/storage/`, `envs/` | Configuration loading, provider identity bindings, and templates |
| `shared/protocol/`, `schemas/` | Application contracts and generated provider schemas |
| `deploy/` | Host setup, supervisors, and optional networking setup |

Adapters own transport and presentation. Shared behavior belongs in the core; one surface
does not call another surface's command handlers. See [Architecture](.docs/architecture.md)
for the layers and the tests that enforce them.

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

- [Codex parity matrix](.docs/codex-parity-matrix.md)
- [Claude parity matrix](.docs/claude-parity-matrix.md)
- [Surface parity matrix](.docs/surface-parity-matrix.md)
- [Surface selection and lifecycle](.docs/surface-launch.md)
- [Web API and private access](.docs/web-api.md)
- [Web UI reference](.docs/web-ui.md)
- [Answering questions and examples](.docs/user-questions.md)
- [Host deployment](deploy/README.md)
- [Shared skills installation](.docs/shared-skills-location.md)
- [Architecture](.docs/architecture.md)
- [Documentation index](.docs/README.md)
