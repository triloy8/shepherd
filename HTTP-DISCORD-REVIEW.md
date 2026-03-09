# HTTP vs Discord Adapter Parity Review

Assumptions for this review:

- the bundled HTTP UI still exists in the codebase, even if product direction treats it as secondary
- the HTTP adapter is local-only for now
- auth concerns for the HTTP adapter are intentionally out of scope

## Summary

The HTTP adapter is not far behind the Discord adapter on core Codex protocol coverage.

Most of the remaining gap is in workspace orchestration, surface-session ergonomics, and a few Discord-only operator features:

- Discord has repo selection and workspace provisioning
- Discord exposes a command-driven operator workflow around an active channel thread
- HTTP still exposes mostly explicit thread endpoints, even though the core now contains adapter-agnostic surface routing primitives

## What Is Already At Parity

Both adapters expose or can drive:

- thread creation
- thread resume
- thread fork
- thread archive / unarchive
- thread rename
- thread compact
- thread rollback
- thread list / loaded list / read
- turn submit
- turn interrupt
- turn steer
- approval listing and decision submission
- local skills listing
- remote skills listing
- remote skill export
- skill config writes
- account rate limits
- thread event streaming
- active-thread behavior at the client layer

HTTP also has a real client-side active-thread concept today through the bundled UI and HTTP client helpers.
That does not mean HTTP has adapter-level surface-session APIs, but it does mean the old framing of HTTP as purely stateless and thread-centric is now too narrow.

## Remaining Gaps

### 1. Surface Routing

Discord has first-class surface routing behavior at the adapter layer.

It binds a Discord channel to a default thread and can switch that binding over time.
HTTP still has no equivalent HTTP-facing surface-session API. It exposes thread endpoints, and HTTP clients must still track the active thread themselves.

However, this is no longer a Discord-only concept in the core.
The current shared conversation layer already exposes generic surface routing and subscription primitives:

- `getSurfaceThread`
- `bindSurfaceToThread`
- `resolveSurfaceThread`
- `createSurfaceThread`
- `submitSurfaceInput`
- surface-scoped event subscriptions

So the real remaining gap is not that routing only exists for Discord.
The real gap is that HTTP does not currently publish this capability as an adapter/API concept.

Relevant files:

- `server/core/conversation_service.ts`
- `server/core/conversation_routing_service.ts`
- `server/adapters/discord/bot.ts`
- `server/adapters/http/server.ts`

### 2. Repo Selection and Workspace Provisioning

Discord supports selecting a repo or local workspace root and then provisioning a per-session workspace before create/resume/fork.

That behavior includes:

- `!repo <owner>/<repo>`
- local targets like `~` or `~/path`
- GitHub clone into `~/.agent-workspaces`
- creating per-session workspace directories

HTTP has no equivalent repo/workspace management endpoint.
An HTTP client must provide `cwd` itself and manage any repo clone/setup flow externally.

Relevant files:

- `server/adapters/discord/commands.ts`
- `server/adapters/discord/bot.ts`

### 3. Conversation-Style Auto Routing

Discord has adapter behavior for choosing how input should be routed:

- mentions can steer an active turn instead of starting a fresh one
- commands can create, bind, resume, or fork the active thread for a channel

That said, the older description that "normal channel messages can target the bound thread" is no longer accurate.
The current bot ignores messages that are neither `!` commands nor bot mentions.

HTTP exposes the primitives:

- `POST /api/threads/:id/turns`
- `POST /api/threads/:id/turns/steer`
- `POST /api/threads/:id/turns/interrupt`

But HTTP does not provide the same adapter-level policy for deciding when to submit vs steer, or which thread is currently active for a surface/session.

Relevant files:

- `server/adapters/discord/bot.ts`
- `server/adapters/http/routes/turns.ts`

### 4. Operator Ergonomics

Discord still provides a richer operator-facing interface out of the box.

Through commands it exposes:

- repo selection
- active thread inspection/switching
- archived/loaded thread views
- context usage
- rate limits
- model inspection and thread-scoped model override
- skills inspection and management
- fork / archive / unarchive / rollback / compact

HTTP route coverage exists for most thread, skills, approvals, and account operations, but not for the repo/workspace layer above them.
HTTP also does not currently expose the same model-management operations that Discord now exposes through `!models`, `!model`, and `!model set`.

Relevant files:

- `server/adapters/discord/commands.ts`
- `server/adapters/http/server.ts`
- `server/adapters/http/routes/threads.ts`
- `server/adapters/http/routes/skills.ts`
- `server/adapters/http/routes/account.ts`

## Testing Reality

The shared surface-subscription behavior is covered by targeted tests, and Discord command behavior has focused tests.
That gives reasonable confidence in the current routing and command claims.

The HTTP adapter itself is much less directly covered.
There are no route-level tests here exercising the HTTP server or validating parity claims end to end.

So any parity statement about HTTP should be treated as a code-reading conclusion unless explicit HTTP adapter tests are added.

## Concrete Parity Direction

If true adapter parity is the goal, the next useful step is not more raw thread endpoints.

The next useful step is a small HTTP surface-session layer that can model what Discord already does:

- set/get active thread for a caller-defined surface/session
- set/get repo target or cwd template
- create/resume/fork using stored surface context
- optional auto-steer policy for active turns
- optional model inspection / model override endpoints if operator parity matters

That would close most of the meaningful gap between the adapters without depending on the deprecated HTTP UI.
