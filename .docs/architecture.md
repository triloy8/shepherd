# Architecture

Shepherd connects surfaces (the web UI, Discord and a local webhook) to coding agents
(Codex and Claude) through one core. The code is stratified: protocol at the bottom, then
ports, then providers and core side by side, then the surfaces, and composition on top
wiring them together. Every import points down, and tests enforce it.

## Layers

| Layer | Paths | May import |
| --- | --- | --- |
| Composition | `server/main.ts`, `server/runtime/`, `server/surface_definitions.ts` | everything: it wires the concretes |
| Surfaces | `server/adapters/{discord,web,webhook}/`, `ui/src/` (protocol only) | surface support, core API, ports, config, protocol |
| Surface support | `server/adapters/shared/` | core API, ports, protocol |
| Core API | `server/core/surface_api.ts` | core, ports, protocol |
| Core: surface | `server/core/surface/` | the core sub-layers below, ports, protocol |
| Core: signals, lifecycle | `server/core/signals/`, `server/core/lifecycle/` | conversation, common, ports, protocol |
| Core: conversation, workspace | `server/core/conversation/`, `server/core/workspace/` | common, ports, protocol |
| Core: common | `server/core/common/` | ports, protocol |
| Signals | `server/signals/` | core signals, protocol |
| Providers | `server/providers/{claude,codex}/` | provider support, ports, protocol |
| Provider support | `server/providers/shared/` | ports, protocol |
| Storage, config | `server/storage/`, `server/config/` | ports and protocol; protocol |
| Ports | `server/ports/` | protocol |
| Protocol | `shared/protocol/` | nothing |

Providers and core never import each other: both depend on the provider port, and
composition registers the providers. Surfaces reach core only through its front door,
`core/surface_api.ts`, so the rest of core is internal.

## Protocol

`shared/protocol/` holds the contracts every layer shares, with no dependencies of its own:

- `requests.ts`: API requests and history records. A turn's items (`HistoryItem`) are user
  and assistant messages, plans, reasoning (with its `form`), typed activities and images;
  an item a subagent produced names its delegation in `parentItemId`.
- `events.ts`: `BridgeEvent`s. Items stream as `item.started`, `item.delta` (channels
  `message`, `plan`, `reasoning`, `output`) and `item.completed` with the canonical item.
- `activity.ts`: the activity union (command, file change, tool, web, delegation, image,
  wait, other), the bounded command `result`, and every label surfaces show.
- `item_stream.ts`: the rules all surfaces share for streamed plans and reasoning and for
  which messages answer a turn.
- `execution_policy.ts`: the three restrictions (`writes`, `network`, `review`), presets,
  and resolution to a provider's least restrictive profile within them.
- `approvals.ts`, `user_questions.ts`, `provider_capabilities.ts`, `validation.ts` and the
  rest: approval choices, structured questions, capabilities and request validation.

## Ports

`server/ports/` is the provider port: what core needs from an agent.

- `provider_session.ts`: a `Provider` per agent (history, catalog, `openSession`) and the
  `ThreadSession` it opens to run one thread (turns, steering, interrupts, approvals,
  workspace changes, compaction, skills).
- `provider_services.ts`: registration, account reading and resets, and thread ownership.
- `provider_tools.ts`: application tools an agent can call (the signal callback).
- `event_bus.ts`: the replaying event bus sessions publish on.

## Providers

Everything native lives here; nothing above names a provider.

- **Codex** (`providers/codex/`): one shared `codex app-server` process
  (`app_server.ts`) serves every thread, history read and account request, routing each
  thread's notifications to the session running it. `session.ts` drives a thread over
  JSON-RPC; `history.ts` and `history_presentation.ts` decode native items for live
  delivery and history alike; `policy.ts` maps policy profiles to sandbox and approval
  settings.
- **Claude** (`providers/claude/`): `session.ts` drives one Claude Agent SDK query per
  conversation; `transcript.ts` is the one decoder for the live stream and for stored
  sessions, so live items equal history items. History, rename, archive and fork use
  Claude's own sessions (`history.ts`, `native_sessions.ts`); subagent transcripts join
  their delegation. `permissions.ts` maps profiles to permission modes, and
  `mcp_bridge.ts` exposes application tools.
- **Provider support** (`providers/shared/`): approval choice tokens.

See [provider adapters](provider-abstraction.md) for the complete boundary, and the
[Codex](codex-parity-matrix.md) and [Claude](claude-parity-matrix.md) parity matrices.

## Core

Core's sub-layers, lowest first:

- **`common/`**: `action_error.ts` (expected application failures, such as
  `restart_pending`, that surfaces present) and `image_media.ts`.
- **`conversation/`**: the heart of Shepherd.
  - `session_manager.ts` owns sessions from allocation to stop, learns each thread's
    state from its events, checks capabilities, resolves execution policy, and pauses
    new turns while a restart drains.
  - `conversation_service.ts` is the conversation API over it, and
    `conversation_routing_service.ts` binds surfaces to threads.
  - `approvals.ts` stores pending approvals and questions. `dynamic_tool_registry.ts`
    registers application tools. `provider_directory.ts` and
    `provider_thread_catalog.ts` resolve thread owners and list stored threads across
    providers.
- **`workspace/`**: project targets (`owner/repo`, `~/path`) and workspace provisioning.
- **`signals/`**: the signal registry, the dispatcher (bounded queueing, coalescing,
  per-thread serialization), callback routes, the executor that starts a signal's
  turn, and thread watches that signal a conversation when the ones it watches finish.
- **`lifecycle/`**: `deployment_service.ts` (Git checkout, validation, rollback) and
  `runtime_lifecycle_orchestrator.ts` (restart and deploy: validate, drain, restart).
- **`surface/`**: what surfaces act through. Surface state (project binding, listening
  mode), snapshots and recovery plans, surface and control actions, turn routing
  (`submit` or `steer`), thread orchestration, and the surface contract
  (`surface_adapter.ts`, `surface_application_context.ts`, `conversation_ports.ts`).
- **`surface_api.ts`**: the front door, exporting exactly what surfaces may use.

Control actions return structured `ActionFailure`s for expected prerequisite failures;
orchestration throws `ApplicationActionError`. Surfaces render these codes in their own
words. Unexpected errors reach the surface's error boundary.

## Surface support

`server/adapters/shared/` holds presentation helpers surfaces share, using core only
through its front door:

- `response_stream_reducer.ts` follows a turn's streamed answer for surfaces that post one.
- `history_page_service.ts` and `skills_page_service.ts` page history and skills with
  cursor navigation; they return plain data with no transport formatting.
- `generated_image.ts` loads generated images; `body.ts` parses bounded HTTP bodies.

## Surfaces

- **Web** (`adapters/web/`): the private loopback `/api` (`api.ts`), its server and asset
  serving (`server.ts`, `ui_assets.ts`), the bounded SSE feed (`event_feed.ts`), history
  presentation with scoped image URLs (`history.ts`, `images.ts`) and host controls
  (`host_controls.ts`). Live items are presented exactly as history presents them.
- **UI** (`ui/src/`): React, built by Vite, importing only the protocol. `chat-state.ts`
  reconciles history, live deltas and canonical completion; `timeline.ts` groups work and
  answers; `use-conversation.ts` owns reconnects and history refresh.
- **Discord** (`adapters/discord/`): `bot.ts` (client and listeners), `message_ingress.ts`
  (attention policy, attachments), `commands.ts` (`!` commands), `thread_event_handler.ts`
  (progress lines and answer delivery through the stream reducer), `stream_delivery.ts`,
  `chunking.ts` and `message_renderer.ts` (message editing and formatting), and
  `interactions.ts` (buttons and question forms).
- **Webhook** (`adapters/webhook/server.ts`): loopback `POST /signals/:routeId` callbacks.

See [web API](web-api.md), [web UI](web-ui.md) and the
[surface parity matrix](surface-parity-matrix.md).

## Composition

- `server/main.ts` loads configuration and starts one surface host for the selected
  surfaces (`surface_definitions.ts`).
- `runtime/surface_host.ts` owns the Shepherd runtime, signal runtime, per-surface
  application contexts, health and orderly shutdown; `process_lifecycle.ts` owns process
  signals.
- `runtime/shepherd_runtime.ts` builds the conversation service and the lifecycle
  orchestrator, and implements restart, quiescing and the new-turn pause.
- `runtime/provider_services.ts` installs Codex and Claude; `provider_registration.ts`
  checks each provider's capabilities against the methods it implements;
  `provider_thread_identity.ts` scopes thread IDs where a provider needs it.
- `runtime/surface_runtime.ts` assembles a surface's application context;
  `signal_runtime.ts` wires signals, callback routes, thread watches and the webhook
  listener.
- `config/` parses the environment (`SHEPHERD_POLICY`, surfaces, signals);
  `storage/thread_provider_directory.ts` persists thread owners.

See [surface launch](surface-launch.md) for selection, startup and shutdown.

## Runtime flows

### A message becomes a turn

1. The surface receives input (an HTTP request, or a Discord message past its attention
   policy) and hands it to turn routing through the core API.
2. Turn routing submits a new turn, or steers the running one.
3. The conversation service starts it on the thread's provider session, within the
   thread's execution policy profile.

### Events reach the surfaces

1. The provider session publishes `BridgeEvent`s; each item it completes live is the record
   history returns.
2. The web surface presents each item as history does and streams it over SSE; the UI
   folds work and shows answers.
3. Discord posts progress lines for the conversation's own steps and delivers the answer
   through the stream reducer; an interrupted turn posts a partial response.

### Structured questions

The provider asks (a Codex `item/tool/requestUserInput`, or Claude's `AskUserQuestion`
through `canUseTool`) and emits `approval.requested` with typed questions. Core stores a
pending record; the surface renders a form and submits the answers, which core validates
before the session answers exactly once. Expiry and turn end clear pending records. See
[answering questions](user-questions.md).

### Signals

During a turn the agent asks for a callback URL and gives it to a detached operation. The
operation posts to the webhook; core validates, queues and coalesces the signal, then
starts a turn on the originating conversation, whose surface receives it as usual. See
[signal callbacks](volatile-webhook-signals.md).

A conversation can also watch other conversations it delegated work to. Core observes
their turns and sends the same kind of signal to the watcher when one ends or waits for
a decision, with no callback involved. See [thread watches](thread-watch.md).

### Restart and deploy

1. A surface requests a restart or deploy through the lifecycle orchestrator.
2. A deploy validates the target first (install, build, configuration check, tests) and
   rolls back on failure.
3. The orchestrator pauses new turns and waits for running turns, background tasks and
   pending approvals, reporting what it waits for; after 30 minutes it gives up and
   resumes new turns.
4. Once idle, the runtime quiesces every surface, runs shutdown hooks, stops the provider
   sessions and exits for the supervisor to start the new code.

## Checks that keep this true

- `tests/architecture_layers.test.ts` fails on any import that points up the layers.
- `tests/provider_neutral_layers.test.ts` fails if a provider name or adapter import
  appears in core, ports, surfaces, the protocol or the UI.
- `tests/architecture_boundaries.test.ts` checks deeper import forms and keeps provider
  wire vocabulary out of shared code.
- `tests/adapter_ports.typecheck.ts` (compiled by `bun run check`) keeps the capability
  interfaces surfaces receive from widening.
- Each provider's tests check that items completed live equal the history it returns, and
  the browser suite (`tests/browser/`) exercises the web UI against a fixture host.
