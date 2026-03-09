# Discord Adapter Review

## Scope

This document reviews the current Discord path in Shepherd, from Discord message ingress down to `codex app-server`, and back up through streaming events and approvals.

The goal is not parity with HTTP. The goal is to explain the actual Discord architecture as it exists today, identify the main abstraction choices, and judge whether those cuts are sound.

## High-Level Shape

The Discord path is layered like this:

1. Discord transport and presentation
2. Shepherd surface and workflow orchestration
3. Shepherd thread and session lifecycle management
4. `CodexSession` as the protocol bridge to `codex app-server`
5. Event propagation back up to Discord rendering and interactions

Concretely, the main files are:

- `server/adapters/discord/bot.ts`
- `server/adapters/discord/commands.ts`
- `server/core/conversation_service.ts`
- `server/core/session_manager.ts`
- `server/core/codex_session.ts`
- `server/core/codex_rpc_mapper.ts`

This is the right overall direction. Discord is not coupled directly to the app server. There is a real core boundary in between.

## End-to-End Flow

### 1. Discord ingress

`server/adapters/discord/bot.ts` is the Discord transport entrypoint.

It creates a `ConversationService` with routing options that are important to how Discord behaves:

- `autoCreateIfMissing: true`
- `defaultApprovalPolicy` from environment
- `defaultSandbox` from environment
- `exclusiveThreadBinding: true`

The bot only reacts to:

- `!` commands
- messages that mention the bot

Anything else is ignored. This is an important behavioral constraint. The adapter is not trying to make an entire channel implicitly conversational.

There are two ingress paths:

- normal Discord messages
- Discord component interactions, mainly approval buttons

Messages go through command parsing first. Button interactions go through the interaction handler.

### 2. Command parsing and Discord-local behavior

`server/adapters/discord/commands.ts` is the command and presentation layer for Discord.

This file defines a `CommandContext` that deliberately abstracts the rest of the system behind a small Discord-oriented interface:

- get active thread for a channel
- get or set repo and workspace target for a channel
- ensure/create/resume/fork/bind/clear the channel thread
- call into `ConversationService`

This is a useful cut. The command file does not need to know about `CodexSession`, JSON-RPC, or app-server notifications.

Commands handled here include:

- help and thread discovery
- new thread creation
- repo and workspace targeting
- thread switching and reading
- archive, unarchive, fork, rollback, compact, interrupt
- context reporting
- rate limits
- skills inspection and management
- model inspection and thread-scoped model overrides

If the input is not a recognized command, the handler falls back to regular conversational input. At that point it ensures a thread exists for the channel and returns control to `bot.ts` so the turn can be submitted.

The main Discord-specific choices live here and in `bot.ts`:

- command syntax
- channel-oriented active thread model
- mention behavior
- human-readable formatting
- chunking output to fit Discord limits

That is the right place for them.

### 3. Surface orchestration in core

`server/core/conversation_service.ts` is the main application boundary used by the Discord adapter.

This is the most important abstraction in the current design. Discord is modeled as a generic surface:

- adapter: `"discord"`
- surface ID: the Discord `channelId`

`ConversationService` owns:

- surface-to-thread binding
- surface event subscription and rebinding
- surface workspace target storage and materialization
- create/resume/fork from surface context
- surface-level submit logic, including submit-vs-steer behavior

This is a good architectural decision. It keeps Discord from becoming the owner of workflow policy.

The key methods are:

- `bindSurfaceToThread`
- `clearSurfaceBinding`
- `subscribeSurfaceEvents`
- `createSurfaceThread`
- `createSurfaceThreadFromContext`
- `resumeSurfaceThreadFromContext`
- `forkSurfaceThreadFromContext`
- `submitSurfaceTurn`
- `getSurfaceState`
- `setSurfaceWorkspaceTarget`

The most important behavior here is `submitSurfaceTurn`.

That method decides:

- whether the surface already has a thread
- whether a missing thread should be auto-created
- whether an explicit thread should be rebound or resumed first
- whether an active turn should be steered instead of starting a fresh turn

That is exactly the sort of coordination logic that should be above the adapter and above the raw session bridge.

### 4. Thread and session lifecycle management

`server/core/session_manager.ts` sits one layer below `ConversationService`.

This class owns loaded sessions and cached per-thread state:

- loaded `CodexSession`s by thread ID
- approvals store
- token usage by thread
- cwd by thread
- thread model state
- a separate control session for non-thread-bound reads such as list operations

This is a useful layer because it isolates session ownership from surface workflow.

`ConversationService` does not manage child processes directly. Discord definitely does not. Both rely on `SessionManager`.

`SessionManager` is responsible for:

- creating new sessions for new or forked threads
- resuming existing threads into loaded sessions
- caching cwd and model state
- submitting turns
- steering and interrupting turns
- listing and applying approvals
- exposing thread reads, lists, skills, models, and account state

This layer is doing real work, not just pass-through.

One important choice here is the use of a dedicated control session for operations like:

- thread list
- loaded thread list
- thread read
- account rate limits
- model list

That avoids forcing those operations through whichever thread session happens to be active. It is a sensible separation.

### 5. `CodexSession` as the app-server bridge

`server/core/codex_session.ts` is the protocol adapter to `codex app-server`.

This is where the process boundary lives.

For each loaded thread session, Shepherd spawns:

```text
codex app-server
```

Communication is line-delimited JSON over stdio.

This class is responsible for:

- spawning the child process
- running the JSON-RPC-style initialization handshake
- sending app-server requests
- receiving results and notifications
- translating app-server traffic into Shepherd `BridgeEvent`s
- correlating app-server approval requests with Shepherd approval IDs

Outbound requests include:

- `thread/start`
- `thread/resume`
- `thread/fork`
- `thread/archive`
- `thread/unarchive`
- `thread/name/set`
- `thread/compact/start`
- `thread/rollback`
- `thread/list`
- `thread/loaded/list`
- `thread/read`
- `account/rateLimits/read`
- `model/list`
- `skills/list`
- `skills/remote/list`
- `skills/remote/export`
- `skills/config/write`
- `turn/start`
- `turn/interrupt`
- `turn/steer`

Inbound traffic is split into three cases:

- app-server request to Shepherd
- response to a pending Shepherd request
- app-server notification

The most important app-server-to-Shepherd request path is approvals.

When the app server sends a request that requires a decision, `CodexSession`:

- generates a Shepherd `approvalId`
- stores the raw app-server request in memory
- maps it into a Shepherd `approval.requested` event

When the user clicks a Discord approval button, the flow comes back down through Shepherd and ultimately `CodexSession.applyApprovalDecision(...)` writes a JSON response envelope back to the app server.

That is a clean bridging model.

### 6. Event propagation back to Discord

The return path is event-driven all the way up.

`CodexSession` translates app-server notifications into normalized Shepherd events like:

- `turn.started`
- `turn.stream.delta`
- `turn.completed`
- `turn.failed`
- `approval.requested`
- `thread.name.updated`
- `thread.archived`
- `thread.unarchived`
- `thread.tokenUsage.updated`
- `session.error`
- `session.limit.context`

`SessionManager` listens to those events to maintain cached state:

- approvals are stored when `approval.requested` arrives
- token usage is cached when `thread.tokenUsage.updated` arrives

`ConversationService` then republishes thread events through surface subscriptions.

`bot.ts` subscribes the Discord channel surface to its active thread and renders the events back into Discord:

- streamed deltas are accumulated, phase-aware, chunked, and edited into Discord messages
- approvals are rendered as button rows
- thread and error events can be rendered as one-line status messages

This is why the Discord experience feels natural. Discord is operating as a long-lived event consumer, not polling for state.

## Communication Boundaries

There are several distinct boundaries in the design.

### Discord -> Shepherd adapter

The Discord boundary is the `discord.js` event model:

- message create events
- interaction create events

This is entirely adapter-local and should remain so.

### Discord adapter -> core

The adapter talks to core through `ConversationService`.

This is the most important boundary in the system because it is the one that protects Discord from becoming the place where application workflow logic accumulates.

This boundary is mostly good today.

### Core workflow -> session ownership

`ConversationService` delegates thread and session ownership to `SessionManager`.

This is a useful separation, although the line between the two is not as crisp as it could be.

### Shepherd -> `codex app-server`

`CodexSession` owns the child-process and JSON-RPC boundary.

This is the right place for:

- request/response correlation
- process lifecycle
- app-server notification handling
- approval request correlation

### Upstream payload normalization

`server/core/codex_rpc_mapper.ts` exists to tolerate payload-shape variation:

- thread IDs
- turn IDs
- text delta fields
- item IDs
- approval prompt and choice mapping

This is a healthy seam. It keeps upstream protocol variance from leaking through the rest of the codebase.

## Assessment of the Abstractions

### What is strong

The most important architectural decisions are good.

1. Discord does not talk to `codex app-server` directly.

That alone avoids a large class of coupling problems.

2. Discord uses `ConversationService`, not `SessionManager` or `CodexSession` directly.

That means the adapter is talking to Shepherd’s workflow layer, not its runtime internals.

3. Surface semantics live in core.

The move to treat a Discord channel as a generic surface is the correct generalization. It is the right foundation even if HTTP is ignored.

4. Session ownership is centralized.

`SessionManager` is the right place to own loaded sessions, approvals, token usage, cwd, and model state.

5. The app-server bridge is explicit.

`CodexSession` clearly marks the process and protocol boundary.

6. Event-driven flow is the default.

This matches Discord well and is a better fit for an agent runtime than polling-oriented coordination.

### What is weaker

The design is sound, but it still has some organic-growth texture.

1. `ConversationService` and `SessionManager` are not perfectly crisp.

The split is useful, but some workflow policy, cached thread state, and operational behavior are still distributed across both. The code reads as evolved rather than designed from a clean domain model in one pass.

2. There is a lot of in-memory coordination.

Important behavior depends on several maps and stores staying in sync:

- surface bindings
- surface subscriptions
- loaded sessions
- approvals
- token usage
- cwd cache
- model state
- Discord stream state

This is workable for a resident Discord bot, but it is still a fair amount of implicit statefulness.

3. `CodexSession` is carrying a lot.

It is not only a transport bridge. It also does:

- approval correlation
- event normalization
- delta extraction usage
- message phase tracking
- some error interpretation

That is still acceptable, but it makes `CodexSession` heavier than a thin protocol client.

4. The product shape is still visibly Discord-led.

Even after moving logic into core, the code still feels like the Discord path was the original real surface and the generalized workflow emerged from that path. That is not fatal, but it is visible.

## Judgment

The architecture is fundamentally good.

If the main question is whether the Discord path is built on sensible abstraction boundaries, the answer is yes.

The strongest parts are:

- Discord is kept out of app-server protocol details
- core owns surface workflow
- session ownership is centralized
- the app-server bridge is explicit and event-driven

The weaker parts are mostly about sharpness, not direction:

- the boundaries are good but not perfectly minimal
- there is still a lot of implicit in-memory coordination
- `CodexSession` is a fairly dense object

So the current Discord stack is not a mess. It is a solid architecture with some rough edges left from iterative evolution.

## Recommended Next Tightening Steps

If the goal is to improve this path further without changing its basic architecture, the highest-value steps are:

1. Tighten the contract between `ConversationService` and `SessionManager`.

Make the split more explicit:

- `ConversationService` owns surface workflow and policy
- `SessionManager` owns loaded-thread lifecycle and thread-scoped state

2. Reduce implicit in-memory coordination where practical.

The goal is not to remove state. The goal is to make its ownership more legible.

3. Keep `CodexSession` focused on the upstream protocol boundary.

Some of its normalization responsibilities may be fine where they are, but it should not quietly accumulate higher-level policy.

4. Continue treating Discord as a transport adapter, not the owner of operator workflow.

That is the best architectural instinct currently present in the codebase and should be preserved.

## Bottom Line

The Discord adapter is not the problem in this codebase.

It is actually the clearest demonstration of the system’s intended runtime model:

- long-lived surface
- active thread binding
- event-driven output
- approval loop
- core-managed workflow
- child-process bridge to `codex app-server`

The code already reflects that model reasonably well.

What remains is not a conceptual rewrite of Discord. It is mostly refinement of the seams around the core workflow and the app-server bridge.
