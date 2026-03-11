# End-State Architecture

Current refactor state as of commit `da8f3af` on `feat/discord-refactor`.

## Boundary

The Discord path is now split along this rule:

- `server/adapters/discord/*` owns Discord transport, Discord event parsing, Discord rendering, and Discord delivery/runtime glue
- `server/core/*` owns reusable state, policy, orchestration, routing, workspace behavior, and stream reduction

## Core Modules

### Project and skill resolution

- `server/core/project_target_service.ts`
  Resolves repo/project targets such as `owner/repo`, `~`, and `~/path`.
- `server/core/skill_resolution_service.ts`
  Resolves skill names and paths with shared ambiguity behavior.

### Control semantics

- `server/core/control_actions_service.ts`
  Owns command semantics for repo, model, skill, thread, limits, context, and related control actions.

### Surface and workspace orchestration

- `server/core/surface_state_service.ts`
  Owns surface-scoped project binding state.
- `server/core/workspace_provisioner.ts`
  Owns workspace provisioning and `cwd` selection.
- `server/core/surface_conversation_orchestrator.ts`
  Owns create/bind/resume/fork/switch/ensure thread orchestration for a surface.

### Input routing

- `server/core/turn_routing_policy.ts`
  Owns normalized surface-input classification and `submit` vs `steer` policy.
- `server/core/turn_routing_service.ts`
  Owns active-turn lookup plus `submitTurn`/`steerTurn` dispatch.

### Stream reduction

- `server/core/response_stream_reducer.ts`
  Owns logical streamed-response state transitions from `BridgeEvent`s.

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
