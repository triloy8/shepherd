# Adapter To Core Refactor Map

The right way to think about this is not "move code out of Discord" in the abstract, but "define the core domains that Discord is currently impersonating."

Here is the refactor map.

## Target Boundary

After the refactor:

- `server/adapters/discord/*` should own Discord transport, parsing, rendering, and interactions
- `server/core/*` should own application behavior, state, routing, workflow policy, and workspace/session orchestration

A simple rule:

- if the logic would still exist for Slack, web, CLI, or a future HTTP API, it belongs in core
- if the logic only exists because Discord has mentions, buttons, message edits, or chunk limits, it stays in the adapter

## Big Core Domains To Extract

### 1. Surface State And Binding

Today the adapter owns channel-local state like active thread and selected repo target.

Move into core:

- surface -> thread binding
- surface -> project/workspace target binding
- surface-scoped defaults and preferences
- persistence policy for those bindings later if needed

Likely module:

- `server/core/surface_state_service.ts`

Core responsibilities:

- `getSurfaceState(adapter, surfaceId)`
- `bindSurfaceToThread(adapter, surfaceId, threadId)`
- `setSurfaceProject(adapter, surfaceId, target)`
- `clearSurfaceState(adapter, surfaceId)`

This replaces the adapter-managed `repoByChannel` concept with a generic surface state model.

### 2. Project Target Resolution

Right now Discord owns repo slug parsing, local path parsing, GitHub resolution, and target semantics.

Move into core:

- parse user-supplied project target
- validate target
- resolve `owner/repo` vs `~` vs `~/path`
- normalize into one canonical project target object

Likely module:

- `server/core/project_target_service.ts`

Core types:

- `GithubProjectTarget`
- `LocalProjectTarget`
- `ProjectTarget`

Core API:

- `resolveProjectTarget(input: string): Promise<ProjectTarget>`
- `describeProjectTarget(target): string`

The Discord adapter should only collect the raw user input string and pass it down.

### 3. Workspace Provisioning

This is one of the biggest extractions. `cwd` selection, cloning, reusing workspaces, creating per-session folders, and local workspace behavior are not Discord concerns.

Move into core:

- provision workspace for new session
- provision workspace for resume/fork
- clone or reuse repo workspaces
- generate workspace ids
- return `cwd` for thread creation/resume/fork

Likely module:

- `server/core/workspace_provisioner.ts`

Core API:

- `provisionWorkspaceForSurface(adapter, surfaceId, mode)`
- `provisionWorkspaceForProject(target, intent)`
- `ensureWorkspace(target, sessionId)`

This should absorb:

- `ensureWorkspaceForSession`
- `createSessionWorkspace`
- repo clone rules
- local path workspace rules

The output should just be:

- `workspaceId`
- `cwd`
- maybe metadata like `sourceProject`

### 4. Surface Conversation Orchestrator

Today `bot.ts` owns too much control flow around thread lifecycle.

Move into core:

- create new thread for a surface
- bind existing thread to a surface
- resume/fork thread with proper workspace selection
- clear current thread
- ensure active thread exists

Likely module:

- `server/core/surface_conversation_orchestrator.ts`

Core API:

- `ensureSurfaceThread(adapter, surfaceId)`
- `createSurfaceThread(adapter, surfaceId)`
- `resumeSurfaceThread(adapter, surfaceId, threadId)`
- `forkSurfaceThread(adapter, surfaceId, sourceThreadId)`
- `bindSurfaceThread(adapter, surfaceId, threadId)`
- `clearSurfaceThread(adapter, surfaceId)`

This module should depend on:

- `ConversationService`
- `SurfaceStateService`
- `WorkspaceProvisioner`

That gets most thread lifecycle policy out of Discord.

### 5. Turn Routing Policy

This is another major seam. The adapter currently decides whether an inbound message becomes a new turn or steering input.

Move into core:

- determine action from normalized inbound message context
- `submit` vs `steer` vs ignore vs command
- active-turn policy
- "pending model applies on next turn" behavior
- future queueing/interrupt policy

Likely module:

- `server/core/turn_routing_policy.ts`

Core input:

- surface info
- thread state
- normalized user message
- whether input was direct-addressed
- whether input is a control command

Core output:

- `ignore`
- `submitTurn`
- `steerTurn`
- `runControlAction`

The adapter should not know the business rules. It should only know transport facts:

- message text
- mention present or not
- user/channel ids

### 6. Control Action Layer

`commands.ts` is really a surface-specific shell over app functionality. The command parsing is Discord-specific; the action semantics are not.

Split it into:

- adapter layer: parse `!models`, `!thread`, `!repo`
- core layer: execute named actions and return structured results

Likely module:

- `server/core/control_actions_service.ts`

Actions:

- thread actions
- model actions
- context actions
- skills actions
- project actions
- archive/rollback/compact actions
- approval actions if needed later

Core API:

- `executeAction(surfaceContext, actionRequest): Promise<ActionResult>`

Then Discord owns only:

- parse text command into `ActionRequest`
- render `ActionResult` into Discord text

This is one of the cleanest extractions because it decouples product semantics from one text-command surface.

### 7. Skill Resolution Policy

Right now Discord owns name-to-path resolution, ambiguity errors, and matching rules.

Move into core:

- resolve skill identifier from name/path
- scope-aware disambiguation
- canonical error model

Likely module:

- `server/core/skill_resolution_service.ts`

That way every surface gets the same semantics.

### 8. Approval Workflow Service

The rendering should stay in Discord, but the approval lifecycle semantics should become more explicit in core.

Move into core:

- approval records/state machine
- lookup by thread/surface/session
- expiration rules later
- multi-surface applicability later
- normalized approval result model

Likely module:

- `server/core/approval_workflow_service.ts`

This can initially wrap what `SessionManager` and `ApprovalsStore` already do, but make the concept explicit.

### 9. Render-State Reduction

This one should be handled carefully. Discord-specific chunking stays in the adapter, but the higher-level event interpretation can move into core.

Split:

- core: reduce thread events into a generic response stream state
- adapter: render that state into Discord messages

Likely modules:

- `server/core/response_stream_reducer.ts`
- adapter keeps `discord_message_delivery.ts`

Core should own:

- phase transitions
- commentary/final boundaries
- item-level stream grouping
- stable logical message segments

Discord should own:

- `> ` quote formatting if desired
- chunking to 1900/2000 chars
- edit/send strategy
- buttons/components

This is optional in a first pass, but it is the correct long-term direction.

## Recommended Extraction Order

Do this in phases so the refactor stays survivable.

### Phase 1: Lowest-risk extractions

Move pure business logic first.

1. Extract `ProjectTargetService`
2. Extract `SkillResolutionService`
3. Extract `ControlActionsService` result models
4. Keep Discord command parsing, but make it call core services

Effect:

- `commands.ts` shrinks without changing runtime architecture too much

### Phase 2: Thread/workspace orchestration

Move the large policy chunk.

1. Extract `WorkspaceProvisioner`
2. Extract `SurfaceStateService`
3. Extract `SurfaceConversationOrchestrator`

Effect:

- `bot.ts` stops owning repo/workspace/thread orchestration

### Phase 3: Input routing policy

Move submit/steer/new-thread behavior.

1. Define `NormalizedSurfaceInput`
2. Extract `TurnRoutingPolicy`
3. Adapter only converts Discord event -> normalized input -> action

Effect:

- adapter becomes a frontend, not workflow owner

### Phase 4: Stream/render boundary

Only after the earlier structure is stable.

1. Extract `ResponseStreamReducer`
2. Keep Discord delivery and chunking in adapter

Effect:

- easier to add other surfaces later without duplicating stream behavior

## What Files I Would Expect At The End

Core additions:

- `server/core/surface_state_service.ts`
- `server/core/project_target_service.ts`
- `server/core/workspace_provisioner.ts`
- `server/core/surface_conversation_orchestrator.ts`
- `server/core/turn_routing_policy.ts`
- `server/core/control_actions_service.ts`
- `server/core/skill_resolution_service.ts`
- `server/core/approval_workflow_service.ts`
- `server/core/response_stream_reducer.ts` later

Discord adapter after cleanup:

- `server/adapters/discord/bot.ts`
- `server/adapters/discord/commands.ts`
- `server/adapters/discord/interactions.ts`
- `server/adapters/discord/message_renderer.ts`
- maybe `server/adapters/discord/delivery.ts`

And those adapter files should mostly do:

- receive Discord events
- normalize inputs
- call core services
- render results/events back to Discord

## What Should Stay In Discord

Keep these in the adapter:

- mention parsing
- Discord channel/type checks
- Discord button IDs and interactions
- Discord message chunking and edit/send logic
- Discord markdown quirks
- Discord-specific approval button layout
- Discord-specific command syntax parsing

Do not move those.

## What Should Definitely Move Out

These are the current smells:

- `repoByChannel`
- repo target parsing
- workspace creation/provisioning
- clone/reuse policy
- create/resume/fork/bind orchestration
- active-turn routing policy
- model-next-turn semantics
- skill identifier resolution
- app command semantics

Those are all core concepts.

## A Good Intermediate End State

If you want a practical target before full cleanup, aim for this:

- Discord adapter sends `NormalizedSurfaceEvent` into core
- core returns either:
  - `ControlActionResult`
  - `TurnAction`
  - `RenderedSurfaceEvent` later
- Discord adapter only converts those into Discord UX

That would already be a large improvement without overengineering.

## Design Principle For Every Extraction

For each candidate piece, ask:

- Can this logic be used unchanged by Slack/web/CLI?
- Does it define product behavior rather than Discord behavior?
- Does it require Discord SDK objects to exist?

If the answers are:

- yes
- yes
- no

then it belongs in core.
