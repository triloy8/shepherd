# End-State Architecture

Current refactor state as of commit `da8f3af` on `feat/discord-refactor`.

## Boundary

The Discord path is now split along this rule:

- `server/adapters/discord/*` owns Discord transport, Discord event parsing, Discord rendering, and Discord delivery/runtime glue
- `server/core/*` owns reusable policy, action semantics, state, and orchestration

## Core Model

The core is easiest to understand as two layers:

- `Application Core`
  Owns application behavior. This is where the four main buckets live:
  policy, action semantics, state, and orchestration.
- `Runtime Core`
  Owns session/runtime infrastructure such as conversation routing, session management,
  Codex/app-server bridging, approvals plumbing, and event fanout.

This matters because the refactor primarily changed the `Application Core` boundary. It moved reusable product behavior out of the Discord adapter without trying to redesign the lower-level runtime plumbing.

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

The refactor did not just move code out of Discord. It moved real ownership of behavior into these four application-core roles.

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
  Owns command semantics for repo, model, skill, thread, limits, context, and related control actions.

This is the application command layer. Discord parses commands like `!repo` or `!model`, but this service decides what those commands actually do.

### 3. State

These modules own authoritative state or state transitions that other layers should not reimplement.

- `server/core/surface_state_service.ts`
  Owns surface-scoped project binding state.
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

These are the workflow modules. They do not just expose interfaces; they execute coordinated behavior that spans multiple underlying operations.

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
- `server/core/approvals.ts`
  Approval record storage and approval lifecycle support.
- `server/core/codex_rpc_mapper.ts`
  Mapping layer for Codex/app-server RPC shapes.
- `server/core/types.ts`
  Shared runtime types.

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
  Handles mention sanitation, normalized-input delegation, command handling, and routing handoff.

### Surface runtime composition

- `server/adapters/discord/surface_runtime.ts`
  Composes the Discord surface runtime by wiring orchestrator/workspace/project behavior into a `CommandContext`.

### Thread event runtime

- `server/adapters/discord/thread_event_handler.ts`
  Handles thread-event runtime on the Discord side: reducer integration, flush scheduling, approval rendering, and event-line delivery.

### Delivery and rendering

- `server/adapters/discord/stream_delivery.ts`
  Owns Discord chunking and message edit/send reconciliation.
- `server/adapters/discord/message_renderer.ts`
  Owns Discord-specific text formatting and approval button id encoding.
- `server/adapters/discord/interactions.ts`
  Owns Discord button interaction handling.

## Main Runtime Flows

### Message ingress

1. `bot.ts` receives `messageCreate`
2. `message_ingress.ts` sanitizes/normalizes the message
3. `commands.ts` handles Discord command syntax if applicable
4. `turn_routing_service.ts` executes routing using core policy
5. `ConversationService` and lower layers talk to Codex/app-server

### Thread events back to Discord

1. `ConversationService` emits thread events
2. `surface_runtime.ts` wires those events to the Discord thread-event handler
3. `thread_event_handler.ts` feeds events into `response_stream_reducer.ts`
4. `stream_delivery.ts` updates Discord messages
5. `message_renderer.ts` handles event/approval text formatting

## What Still Lives In `bot.ts`

What remains in `server/adapters/discord/bot.ts` is mostly legitimate adapter work:

- Discord client construction
- environment/bootstrap
- supported-channel filtering
- event listener registration
- runtime composition
- shutdown wiring

## Practical Outcome

The Discord adapter no longer owns:

- project target resolution
- skill resolution
- command semantics
- workspace provisioning
- thread orchestration policy
- input routing policy
- stream reduction state machine

The adapter still owns:

- Discord SDK interaction
- Discord-specific parsing/rendering
- Discord delivery mechanics
- Discord runtime composition

That is the intended end state from `ADAPTER-TO-CORE-REFACTOR-MAP.md`.
