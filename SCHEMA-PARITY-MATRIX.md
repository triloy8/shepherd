# Codex App-Server Schema Parity Matrix

Status legend:
- `Implemented`: wrapped and exposed in Shepherd API flow.
- `Partial`: method exists, but Shepherd exposes only a subset of schema fields/behavior.
- `Missing`: no wrapper/exposed API yet.

## Client Request Methods

| Method | Status | Scope Recommendation | Notes |
|---|---|---|---|
| `initialize` | Implemented | Core | Internal handshake |
| `thread/start` | Partial | Core | Supports major overrides (`approvalPolicy`, instructions, config, cwd, sandbox, model/provider, personality, ephemeral, serviceName); still not full schema parity |
| `thread/resume` | Partial | Core | Supports key overrides (`approvalPolicy`, instructions, config, cwd, sandbox, model/provider, personality); still not full schema parity |
| `thread/fork` | Partial | Core | Supports key overrides (`approvalPolicy`, instructions, config, cwd, sandbox, model/provider); still not full schema parity |
| `thread/archive` | Implemented | Core | |
| `thread/unarchive` | Implemented | Core | |
| `thread/name/set` | Implemented | Core | |
| `thread/compact/start` | Implemented | Core | |
| `thread/rollback` | Implemented | Core | |
| `thread/list` | Implemented | Core | Filter surface intentionally narrowed |
| `thread/loaded/list` | Implemented | Core | |
| `thread/read` | Implemented | Core | `includeTurns` supported |
| `thread/unsubscribe` | Missing | Maybe Later | Useful for lifecycle cleanup/stream controls; not required for current correctness |
| `turn/start` | Partial | Core | Uses text input path; no richer turn controls |
| `turn/interrupt` | Implemented | Core | |
| `turn/steer` | Implemented | Core | Exposed through Discord mention steering of active turns |
| `review/start` | Missing | Out of Scope (for now) | Could be future advanced feature |
| `model/list` | Implemented | Core | Exposed via Discord `!models` |
| `skills/list` | Implemented | Core | Wrapped in core and exposed via Discord `!skills` |
| `skills/remote/list` | Implemented | Core | Wrapped in core and exposed via Discord `!skills remote` |
| `skills/remote/export` | Implemented | Core | Wrapped in core and exposed via Discord `!skill export` |
| `skills/config/write` | Implemented | Core | Wrapped in core and exposed via Discord `!skill enable|disable` |
| `mcpServer/oauth/login` | Missing | Out of Scope (for now) | |
| `mcpServerStatus/list` | Missing | Out of Scope (for now) | |
| `config/mcpServer/reload` | Missing | Out of Scope (for now) | |
| `config/read` | Missing | Maybe Later | Useful for admin introspection |
| `config/value/write` | Missing | Out of Scope (for now) | High-risk mutation path |
| `config/batchWrite` | Missing | Out of Scope (for now) | High-risk mutation path |
| `configRequirements/read` | Missing | Maybe Later | Useful alongside config/read |
| `command/exec` | Missing | Out of Scope (for now) | Shepherd should route, not become a terminal proxy |
| `feedback/upload` | Missing | Out of Scope (for now) | |
| `fuzzyFileSearch` | Missing | Out of Scope (for now) | |
| `app/list` | Missing | Out of Scope (for now) | |
| `experimentalFeature/list` | Missing | Out of Scope (for now) | |
| `externalAgentConfig/detect` | Missing | Out of Scope (for now) | |
| `externalAgentConfig/import` | Missing | Out of Scope (for now) | |
| `account/read` | Missing | Maybe Later | Useful for diagnostics |
| `account/rateLimits/read` | Implemented | Core | Exposed via Discord `!limits` |
| `account/login/start` | Missing | Out of Scope (for now) | |
| `account/login/cancel` | Missing | Out of Scope (for now) | |
| `account/logout` | Missing | Out of Scope (for now) | |
| `windowsSandbox/setupStart` | Missing | Out of Scope (for now) | Platform-specific |

## Notification Coverage

| Notification | Current Handling | Scope Recommendation |
|---|---|---|
| `thread/status/changed` | Typed event (`thread.status.changed`) | Core |
| `thread/name/updated` | Typed event (`thread.name.updated`) | Core |
| `thread/tokenUsage/updated` | Partial | Core |
| `thread/archived` / `thread/unarchived` | Typed events (`thread.archived`, `thread.unarchived`) | Core |
| `thread/closed` | Generic | Maybe Later |
| `turn/diff/updated` | Generic | Maybe Later |
| `turn/plan/updated` | Generic | Maybe Later |
| `item/agentMessage/delta` | Partially interpreted via text delta | Core |
| `item/commandExecution/outputDelta` | Generic | Maybe Later |
| `item/fileChange/outputDelta` | Generic | Maybe Later |
| `item/mcpToolCall/progress` | Generic | Out of Scope (for now) |
| `model/rerouted` | Generic | Maybe Later |
| realtime thread notifications | Generic | Out of Scope (for now) |

## Shared Protocol Type Parity

| Area | Status | Notes |
|---|---|---|
| Thread lifecycle DTOs | Good | Added and expanded in `shared/protocol/requests.ts` |
| Rich thread object typing | Partial | `ReadThreadResponse`/`RollbackThreadResponse` now use `ThreadRecord`; deeper nested typing still open |
| Rich resume/fork/start options | Partial | Major override fields supported; still not full schema parity |
| Notification DTO parity | Partial | Key thread lifecycle notifications now typed; broader item/model/realtime notifications still reduced |
| Context telemetry DTOs | Partial | Added `ThreadTokenUsage`/`ReadThreadTokenUsageResponse`; richer typed notification payload mapping still open |
