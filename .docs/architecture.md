# Architecture

This document describes the current ownership boundaries between Shepherd's
Discord and webhook adapters, application core, and runtime core.

Reviewed against the code on 2026-09-13.

## Boundary

The adapter paths are split along this rule:

- `server/adapters/discord/*` owns Discord transport, Discord event parsing, Discord rendering, and Discord delivery/runtime glue
- `server/adapters/webhook/*` owns loopback HTTP parsing, route validation, limits, and response mapping; callbacks are unauthenticated
- `server/core/*` owns reusable policy, action semantics, state, and orchestration
- `server/runtime/*` assembles shared services and owns process lifecycle; it may wire ingress adapters but must not depend on Discord
- `shared/protocol/*` owns data contracts and validation, with no adapter dependencies

## Core Model

The core is easiest to understand as two layers:

- `Application Core`
  Owns application behavior. This is where the four main buckets live:
  policy, action semantics, state, and orchestration.
- `Runtime Core`
  Owns session/runtime infrastructure such as conversation routing, session management,
  Codex/app-server bridging, approvals plumbing, and event fanout.

Application services build on the runtime infrastructure. Adapters use those services instead of reconstructing workflows or prerequisites.

### Application Core

Inside the application core, the main buckets are:

- `policy`
  Chooses what should happen.
- `action semantics`
  Defines what user/operator actions mean.
- `state`
  Owns authoritative app state and state transitions.
- `orchestration`
  Coordinates multi-step workflows across services.

These roles describe ownership within core; they do not require separate directory layers.

## Core Modules

### 1. Policy

These modules decide what should happen, what inputs are valid, and how ambiguous cases are resolved.

- `server/core/project_target_service.ts`
  Policy + normalization for repo/project targets such as `owner/repo`, `~`, and `~/path`.
- `server/core/skill_resolution_service.ts`
  Policy + resolution for skill names and paths with shared ambiguity behavior.
- `server/core/turn_routing_policy.ts`
  Owns normalized surface-input classification and `submit` vs `steer` policy.

These are functional modules, not just abstractions. If they make the wrong decision, Shepherd behaves incorrectly.

### 2. Action Semantics

These modules define what an operator action means after the adapter parses the surface syntax.

- `server/core/control_actions_service.ts`
  Owns action semantics for repo, model, effort, skill, thread, limits, and context controls.
- `server/core/surface_actions_service.ts`
  Owns normalized listening and detach actions.
- `server/core/action_error.ts`
  Defines structured application failures, leaving surface instructions to adapters.

This is the application command layer. Discord parses commands like `!repo` or `!model`, but this service decides what those commands actually do.

### 3. State

These modules own authoritative state or state transitions that other layers should not reimplement.

- `server/core/surface_state_service.ts`
  Owns surface-scoped project binding and listening-mode state.
- `server/core/response_stream_reducer.ts`
  Owns logical streamed-response state transitions from `BridgeEvent`s.

These are also functional modules. They are the source of truth for those state transitions.

### 4. Orchestration

These modules coordinate multi-step workflows across policy, state, and lower-level services.

- `server/core/workspace_provisioner.ts`
  Owns workspace provisioning and `cwd` selection.
- `server/core/surface_conversation_orchestrator.ts`
  Owns create/bind/resume/fork/switch/ensure thread orchestration for a surface.
- `server/core/turn_routing_service.ts`
  Owns active-turn lookup plus `submitTurn`/`steerTurn` dispatch.
- `server/core/runtime_lifecycle_orchestrator.ts`
  Owns restart/deploy eligibility, deployment sequencing, runtime quiescing,
  recovery announcement ordering, and shutdown requests.
- `server/core/signal_dispatcher.ts`
  Owns bounded in-memory queuing, coalescing, per-thread serialization, and
  signal-turn sequencing.

These are the workflow modules. They do not just expose interfaces; they execute coordinated behavior that spans multiple underlying operations.

## Shared list and history pages

Two application services supply plain data to adapters:

- `server/core/skills_page_service.ts` loads a thread's skills inventory and
  selects a local page. `selectSkillsPage` can also page an inventory already
  fetched by a caller. Skills and discovery errors retain their cwd, original
  metadata, and ordering. An empty or shrunken inventory clamps to a valid page.
- `server/core/history_page_service.ts` loads turn summaries or turn items from
  the paginated Codex APIs. It owns cursor navigation and the original thread
  context, including returning from a turn's items to the parent turn page.

Both accept a caller-selected page size; five entries is the Discord adapter's
choice. Their return values preserve full source data, with no Markdown,
truncation, components, user IDs, button IDs, or Discord imports.

History starts with `initialHistoryPage(threadId, pageSize)`. Pass the returned
state to `loadHistoryPage(conversation, state)`; its `first`, `previous`, and
`next` fields contain complete navigation requests. Previous navigation reuses
a visited forward cursor rather than reversing direction through an inclusive
anchor. `openHistoryTurn(page.request, turnId)` carries the parent turn page;
`returnToHistoryTurns(itemsPage.request)` restores it. Turn lists are newest
first, while item lists are chronological. Returned API cursors and raw records
remain available to callers.

For example, a future adapter can load these without importing Discord:

```ts
import { loadSkillsPage } from "../core/skills_page_service.js";
import {
  initialHistoryPage,
  loadHistoryPage,
  openHistoryTurn,
} from "../core/history_page_service.js";

const skills = await loadSkillsPage(conversation, {
  threadId, page: 1, pageSize: 20,
});
const history = await loadHistoryPage(conversation, initialHistoryPage(threadId, 20));
if (history.next) {
  const older = await loadHistoryPage(conversation, history.next);
}
const items = await loadHistoryPage(conversation, openHistoryTurn(history.request, turnId));
```

The adapter must still authenticate callers, authorize thread access, validate
transport input, and retain or protect navigation state. The page services
validate page numbers and cursor continuity, but are not HTTP endpoints or an
authorization boundary. Navigation state has no core persistence or expiry.

Discord's `history_pagination.ts` is now a renderer and transport wrapper:
`loadHistoryPage` delegates to core, while `buildHistoryPage` renders an already
loaded page. It retains requester checks through the interaction handler,
bounded expiring control IDs, message excerpts, Read buttons, and Discord-sized
text pages. Skills command and button handlers use the shared loader, then pass
its result to `buildSkillsListPage` for rendering.

This extraction adds no web adapter, network listener, or new Codex API method.

## Runtime Core

These files are also in `server/core/*`, but they are better understood as runtime infrastructure than as part of the four application buckets:

- `server/core/conversation_service.ts`
  Surface-facing conversation API over the lower runtime stack.
- `server/core/conversation_routing_service.ts`
  Surface/thread route resolution and default-thread binding infrastructure.
- `server/core/session_manager.ts`
  Session lifecycle, thread/session lookup, event subscription, and session bookkeeping.
- `server/core/codex_session.ts`
  The stdio-backed Codex/app-server bridge.
- `server/core/event_bus.ts`
  In-process pub/sub for thread/session events.
- `server/core/signal_registry.ts`
  Versioned signal-kind registration, envelope parsing, payload validation, and
  trusted target/input resolution.
- `server/core/conversation_signal_executor.ts`
  Resolves live surface bindings and bridges dispatcher work into Codex turns.
- `server/core/approvals.ts`
  Approval record storage and approval lifecycle support.
- `server/core/deployment_service.ts`
  Git checkout update, dependency validation, and rollback infrastructure used
  by runtime deployment orchestration.
- `server/core/codex_rpc_mapper.ts`
  Mapping layer for Codex/app-server RPC shapes.
- `server/core/types.ts`
  Shared runtime types.
- `server/runtime/shepherd_runtime.ts`
  Shared conversation, quiescing, restart, and adapter-shutdown lifecycle.

So the simplest mental model is:

- `Application Core` = policy, action semantics, state, orchestration
- `Runtime Core` = routing, sessions, bridge, approvals, event infrastructure

## Discord Adapter Modules

### Bootstrap and registration

- `server/adapters/discord/bot.ts`
  Starts the client, loads environment, builds the Discord runtime, and registers Discord listeners.

### Command handling

- `server/adapters/discord/commands.ts`
  Parses Discord text commands and formats Discord replies. Semantics are delegated into core services.

### Message ingress

- `server/adapters/discord/message_ingress.ts`
  Applies mention/open/paused attention policy before attachment downloads, then handles normalization, command delegation, and routing handoff.

### Surface runtime composition

- `server/adapters/discord/surface_runtime.ts`
  Supplies the Discord adapter name to shared surface composition; `CommandContext` aliases the core `SurfaceApplicationContext`.

### Thread event runtime

- `server/adapters/discord/thread_event_handler.ts`
  Handles thread-event runtime on the Discord side: reducer integration, flush scheduling, approval rendering, and event-line delivery.

### Delivery and rendering

- `server/adapters/discord/chunking.ts`
  Owns Discord-aware chunk planning, including character and soft-line limits,
  long-line splitting, and fenced-code-block balancing.
- `server/adapters/discord/stream_delivery.ts`
  Applies the chunk plan and owns Discord message edit/send reconciliation.
- `server/adapters/discord/message_renderer.ts`
  Owns Discord-specific text formatting and approval button id encoding.
- `server/adapters/discord/interactions.ts`
  Owns Discord button interaction handling.

## Webhook Signal Modules

- `server/adapters/webhook/server.ts`
  Exposes routed `POST /signals/:routeId` callbacks and `GET /health` through a
  bounded loopback-only Bun HTTP server.
- `server/signals/research_state_changed.ts`
  Defines the first typed signal kind and its bounded research-inspection input.
- `server/config/signal_environment.ts`
  Loads stable opt-in listener, body-limit, and queue configuration.
- `server/core/dynamic_tool_registry.ts`
  Advertises and dispatches explicitly registered app-server dynamic tools.
- `server/core/signal_route_registry.ts`
  Owns bounded, expiring, process-local callback routes.
- `server/core/signal_route_service.ts`
  Converts trusted `item/tool/call` context into a callback URL.

## Main Runtime Flows

### Message ingress

1. `bot.ts` receives `messageCreate`
2. `message_ingress.ts` applies the surface listening mode before downloading attachments, then sanitizes/normalizes accepted input
3. `commands.ts` handles Discord command syntax if applicable
4. `turn_routing_service.ts` executes routing using core policy
5. `ConversationService` and lower layers talk to Codex/app-server

### Thread events back to Discord

1. `ConversationService` emits thread events
2. `surface_runtime.ts` wires those events to the Discord thread-event handler
3. `thread_event_handler.ts` feeds events into `response_stream_reducer.ts`
4. `stream_delivery.ts` updates Discord messages
5. `message_renderer.ts` handles event/approval text formatting

### Local webhook signals

1. During a live turn, Codex calls `shepherd.get_signal_callback` for a registered kind and version
2. App-server sends `item/tool/call`; Shepherd validates the active thread and turn, captures its live surface, and returns a fresh opaque URL
3. Codex passes that URL to the detached producer as a CLI argument
4. The producer posts a typed envelope to `POST /signals/:routeId`
5. The webhook adapter applies availability, route, content-type, size, and payload checks
6. `signal_dispatcher.ts` queues or coalesces the signal in memory without steering an active turn
7. `conversation_signal_executor.ts` verifies the captured thread, workspace, and surface, then starts a Codex turn
8. The existing surface subscription delivers Codex events and the final response to Discord

### Runtime restart and deployment

1. `commands.ts` parses `!restart` or `!deploy` and supplies Discord announcement callbacks
2. `runtime_lifecycle_orchestrator.ts` checks Codex activity and coordinates the workflow
3. Before its first asynchronous progress callback, the deploy branch claims an
   in-process lifecycle lock that rejects concurrent deploy and restart requests
4. The deploy branch delegates Git/Bun validation, command timeouts, and
   rollback to `deployment_service.ts`
5. The orchestrator asks the lifecycle port in `ShepherdRuntime` to quiesce all ingress
6. After a final activity check, the orchestrator awaits the Discord recovery announcement
7. `ShepherdRuntime` runs registered signal/adapter shutdown hooks, stops Codex sessions, then exits for the external supervisor to restart

## What Still Lives In `bot.ts`

What remains in `server/adapters/discord/bot.ts` is mostly legitimate adapter work:

- Discord client construction
- Discord configuration validation
- supported-channel filtering
- event listener registration
- adapter health and resource cleanup

## Practical Outcome

Core owns the following reusable behavior:

- project target resolution
- skill resolution
- normalized action semantics and prerequisites
- workspace provisioning
- thread orchestration policy
- input routing policy
- stream reduction state machine
- skills inventory page selection
- history fetching and cursor navigation

The adapter still owns:

- Discord SDK interaction
- Discord-specific parsing/rendering
- Discord delivery mechanics
- Discord adapter lifecycle

That is the intended end state from the historical
[adapter-to-core refactor map](archive/adapter-to-core-refactor-map.md).

## Application failures

Control actions identify their target with `surfaceId` and return structured
`ActionFailure` values for expected prerequisite and selection failures. Core
orchestration throws `ApplicationActionError` when a prerequisite prevents a
workflow from starting. Adapters render these codes and their data; Discord's
`action_error.ts` owns command hints and Markdown, including effort validation
and unavailable-model guidance. Unexpected infrastructure
errors still propagate to the adapter's error boundary.

## Surface action entry points

`server/runtime/surface_runtime.ts` assembles an adapter-scoped
`SurfaceApplicationContext` from the same state service, workspace provisioner,
and conversation orchestrator for every surface. The shared host supplies
the selected adapter name. Callers supply workspace infrastructure and an event
sink; no Discord types are involved in shared composition.

- `executeControlAction` handles repo, model, effort, skills, and thread controls.
- `executeSurfaceAction` handles listening reads/transitions and detach.
- History and skills page services remain dedicated read APIs.
- `RuntimeLifecycleOrchestrator` remains the process restart/deploy API.

Explicitly selecting open listening requires an attached thread. The application action rejects
missing bindings before mutation, and the orchestrator enforces the same rule
for direct callers, including resume when its saved mode is open. A lost binding
leaves the paused state intact until a thread is attached. Detach removes the binding and subscription and resets
listening state while retaining the project selection and Codex thread.
Discord still maps mentions, direct messages, command syntax, and result data
into its own interaction and presentation conventions.

## Signal runtime composition

`server/runtime/signal_runtime.ts` owns signal registration, callback routes,
dynamic-tool registration, dispatching, and the webhook listener lifecycle. It
is registered for cleanup by the host; repeated start/stop calls do not create
additional listeners or repeat cleanup. Listener startup remains explicit so
an application can connect its delivery surfaces before accepting callbacks.
The default registry contains the research signal; alternate compositions may
supply their own registry. Surfaces supply a `beforeExecute` delivery hook.
Discord uses that hook for its research notice and reply target, and retains
its existing best-effort notice-delivery behavior.


## Maintenance checks

`tests/architecture_boundaries.test.ts` checks static imports, re-exports,
import types, literal dynamic imports/requires, and command hints in core
string literals. Core and protocol cannot
import adapters or runtime composition; shared runtime cannot import Discord.
Surface action tests exercise identical transitions through Discord and a
synthetic terminal adapter, without connecting either transport. Keep those
checks alongside behavior tests when adding application primitives.

This is an internal TypeScript API, not a new network API. Transport parsing,
caller authorization, and delivery remain adapter responsibilities. Existing
runtime diagnostics and dedicated page reads can call their core services
directly; identical behavior does not require routing every read through one
dispatcher. Authentication policy remains proposed in `future-implementations.md`.

## Host composition

`createHostRuntime` in `server/runtime/host_runtime.ts` assembles the process
runtime, deployment service, and GitHub workspace ports. Shared runtime config
is parsed by `server/config/runtime_environment.ts`; invalid sandbox names and
nonpositive deployment timeouts fail before startup. The launcher loads isolated
configuration for each selected adapter, which parses only its transport settings. GitHub execution
uses argument arrays and the configured host checkout directory.

## Status and recovery data

`surface_snapshot_service.ts` provides binding and status snapshots without
Markdown or command syntax. Status retains current and pending model values,
configured listening mode, and active-turn identity. Discord derives its DM
presentation from the configured mode. Recovery plans contain ordered project,
thread, and open-listening actions; they do not persist state or execute it.
Paused surfaces retain the existing recovery behavior (no automatic open), and
an unbound surface is never instructed to enable open listening.

## Adapter capability interfaces

`conversation_ports.ts` defines application reads/controls and the narrower
list/approval interaction interface. Shared surface composition exposes a
bound capability object rather than the entire `ConversationService` instance;
process shutdown, tool registration, raw surface binding, and turn submission
are absent from that object. Message ingress receives only the turn-routing
interface. Runtime composition retains the complete service for assembly.

`bun run check` compiles `tests/adapter_ports.typecheck.ts` as well as the server.
Its negative type assertions detect accidental widening of these boundaries.
Runtime tests verify method binding and omission of process-level capabilities.
These interfaces guide implementation; they are not a security sandbox.


## Selected surface startup

`server/main.ts` is the sole process entrypoint. It loads shared configuration,
prepares selected surface definitions, and creates one `surface_host.ts` host.
That host owns one Shepherd runtime and signal runtime, adapter-scoped application
contexts, health reporting, and orderly cleanup. Adapters receive bound ingress,
interaction and application capabilities rather than the raw runtime. Process
signals live in `process_lifecycle.ts`; adapters never install exit handlers.

The root registry in `server/surface_definitions.ts` imports only selected
transports. Shared runtime selection validates those definitions without importing
Discord itself. Signal
presentation is dispatched to its target adapter; a delivery error does not
cancel signal execution. Exclusive thread binding remains enabled, so multiple
adapters running does not imply simultaneous attachment to the same thread.
See [surface launch](surface-launch.md) for the operational contract.
