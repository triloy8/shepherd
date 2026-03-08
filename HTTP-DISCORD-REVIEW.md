# HTTP vs Discord Adapter Parity Review

Assumptions for this review:

- the bundled HTTP UI is deprecated
- the HTTP adapter is local-only for now
- auth concerns for the HTTP adapter are intentionally out of scope

## Summary

The HTTP adapter is not far behind the Discord adapter on core Codex protocol coverage.

Most of the remaining gap is in surface semantics and operator workflow:

- Discord has repo selection and workspace provisioning
- Discord has channel-to-thread binding and surface-level routing behavior
- HTTP is mostly a thread-centric API surface and leaves that orchestration to the caller

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

## Remaining Gaps

### 1. Surface Routing

Discord has first-class surface routing behavior.

It binds a Discord channel to a default thread and can switch that binding over time.
HTTP has no equivalent adapter-level concept. It exposes thread endpoints, but clients must track the active thread themselves.

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

- normal channel messages can target the bound thread
- mentions can steer an active turn instead of starting a fresh one

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
- skills inspection and management
- fork / archive / unarchive / rollback / compact

HTTP route coverage exists for most thread, skills, approvals, and account operations, but not for the repo/workspace layer above them.

Relevant files:

- `server/adapters/discord/commands.ts`
- `server/adapters/http/server.ts`
- `server/adapters/http/routes/threads.ts`
- `server/adapters/http/routes/skills.ts`
- `server/adapters/http/routes/account.ts`

## Concrete Parity Direction

If true adapter parity is the goal, the next useful step is not more raw thread endpoints.

The next useful step is a small HTTP surface-session layer that can model what Discord already does:

- set/get active thread for a caller-defined surface/session
- set/get repo target or cwd template
- create/resume/fork using stored surface context
- optional auto-steer policy for active turns

That would close most of the meaningful gap between the adapters without depending on the deprecated HTTP UI.
