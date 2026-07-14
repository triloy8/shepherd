# Codex App-Server Schema Parity Matrix

Status legend:
- `Implemented`: wrapped and exposed in Shepherd API flow.
- `Partial`: method exists, but Shepherd exposes only a subset of schema fields/behavior.
- `Missing`: no wrapper/exposed API yet.

Generated baseline:
- Codex version: `codex-cli 0.144.4`
- Refresh commands:
  - `codex app-server generate-ts --out ./schemas`
  - `codex app-server generate-json-schema --out ./schemas`

Legacy note:
- Rows marked as legacy reflect Shepherd wrappers that still exist in code but are no longer present in the current generated app-server schema and should be deprecated.

## Client Request Methods

| Method | Status | Scope Recommendation | Notes |
|---|---|---|---|
| `initialize` | Implemented | Core | Internal handshake |
| `thread/start` | Partial | Core | Missing `serviceTier`, `approvalsReviewer`, `sessionStartSource`, and `threadSource`; other generated fields are exposed |
| `thread/resume` | Partial | Core | Missing `serviceTier` and `approvalsReviewer`; other generated fields are exposed |
| `thread/fork` | Partial | Core | Missing `lastTurnId`, `serviceTier`, `approvalsReviewer`, `ephemeral`, and `threadSource`; other generated fields are exposed |
| `thread/archive` | Implemented | Core | |
| `thread/delete` | Missing | Maybe Later | Destructive thread lifecycle path; useful if Shepherd adds stronger thread management UX |
| `thread/unarchive` | Implemented | Core | |
| `thread/name/set` | Implemented | Core | |
| `thread/goal/set` | Missing | Maybe Later | Goal management path not exposed by current Discord flow |
| `thread/goal/get` | Missing | Maybe Later | Useful for richer thread diagnostics if goal state is surfaced |
| `thread/goal/clear` | Missing | Maybe Later | Goal management path not exposed by current Discord flow |
| `thread/metadata/update` | Missing | Maybe Later | Useful for richer repo/thread metadata, but not required for current Discord flow |
| `thread/compact/start` | Implemented | Core | |
| `thread/shellCommand` | Missing | Out of Scope (for now) | Terminal-oriented thread helper; Shepherd should route requests, not become a shell command surface |
| `thread/approveGuardianDeniedAction` | Missing | Maybe Later | Useful if Shepherd exposes richer guardian/approval review workflows |
| `thread/rollback` | Implemented | Core | |
| `thread/list` | Implemented | Core | Filter surface intentionally narrowed |
| `thread/loaded/list` | Implemented | Core | |
| `thread/read` | Implemented | Core | `includeTurns` supported |
| `thread/inject_items` | Missing | Maybe Later | Potentially useful for advanced thread mutation/replay workflows; not needed for current Discord flow |
| `thread/unsubscribe` | Missing | Maybe Later | Useful for lifecycle cleanup/stream controls; not required for current correctness |
| `hooks/list` | Missing | Maybe Later | Useful for admin diagnostics, but hook management is not part of the current Discord surface |
| `marketplace/add` | Missing | Out of Scope (for now) | Marketplace mutation path |
| `marketplace/remove` | Missing | Out of Scope (for now) | Marketplace mutation path |
| `marketplace/upgrade` | Missing | Out of Scope (for now) | Marketplace mutation path |
| `turn/start` | Partial | Core | Supports the generated input variants plus `approvalPolicy`, `model`, and resolved `cwd`; missing client message ID, approval reviewer, sandbox policy, service tier, effort, summary, personality, output schema, and image detail |
| `turn/interrupt` | Implemented | Core | |
| `turn/steer` | Implemented | Core | Exposed through Discord mention steering of active turns |
| `review/start` | Missing | Out of Scope (for now) | Could be future advanced feature |
| `model/list` | Implemented | Core | Wrapped in core and exposed via Discord `!models`/`!model` |
| `modelProvider/capabilities/read` | Missing | Maybe Later | Useful for model diagnostics and richer model selection UX |
| `skills/list` | Implemented | Core | Wrapped in core and exposed via Discord `!skills` |
| `skills/extraRoots/set` | Missing | Maybe Later | Could support richer skill root configuration; current flow only passes per-request extra roots |
| `skills/config/write` | Implemented | Core | Wrapped in core and exposed via Discord `!skill enable|disable` |
| `plugin/list` | Missing | Out of Scope (for now) | Plugin management is outside Shepherd's current Discord/admin surface |
| `plugin/installed` | Missing | Out of Scope (for now) | Plugin inventory surface is outside Shepherd's current Discord/admin surface |
| `plugin/read` | Missing | Out of Scope (for now) | |
| `plugin/skill/read` | Missing | Out of Scope (for now) | Plugin skill inspection is outside Shepherd's current Discord/admin surface |
| `plugin/install` | Missing | Out of Scope (for now) | High-risk mutation path |
| `plugin/uninstall` | Missing | Out of Scope (for now) | High-risk mutation path |
| `plugin/share/save` | Missing | Out of Scope (for now) | Plugin sharing mutation path |
| `plugin/share/updateTargets` | Missing | Out of Scope (for now) | Plugin sharing mutation path |
| `plugin/share/list` | Missing | Out of Scope (for now) | Plugin sharing is outside Shepherd's current Discord/admin surface |
| `plugin/share/checkout` | Missing | Out of Scope (for now) | Plugin sharing retrieval path is outside Shepherd's current Discord/admin surface |
| `plugin/share/delete` | Missing | Out of Scope (for now) | Plugin sharing mutation path |
| `fs/readFile` | Missing | Out of Scope (for now) | Shepherd should not become a general remote file API |
| `fs/writeFile` | Missing | Out of Scope (for now) | High-risk mutation path |
| `fs/createDirectory` | Missing | Out of Scope (for now) | High-risk mutation path |
| `fs/getMetadata` | Missing | Out of Scope (for now) | |
| `fs/readDirectory` | Missing | Out of Scope (for now) | |
| `fs/remove` | Missing | Out of Scope (for now) | High-risk mutation path |
| `fs/copy` | Missing | Out of Scope (for now) | High-risk mutation path |
| `fs/watch` | Missing | Out of Scope (for now) | File watching would make Shepherd a general remote file/session API |
| `fs/unwatch` | Missing | Out of Scope (for now) | File watching lifecycle path |
| `mcpServer/oauth/login` | Missing | Out of Scope (for now) | |
| `mcpServerStatus/list` | Missing | Out of Scope (for now) | |
| `mcpServer/resource/read` | Missing | Out of Scope (for now) | MCP resource browsing is outside Shepherd's current Discord/admin surface |
| `mcpServer/tool/call` | Missing | Out of Scope (for now) | MCP tool invocation proxy is outside Shepherd's current Discord/admin surface |
| `config/mcpServer/reload` | Missing | Out of Scope (for now) | |
| `config/read` | Missing | Maybe Later | Useful for admin introspection |
| `config/value/write` | Missing | Out of Scope (for now) | High-risk mutation path |
| `config/batchWrite` | Missing | Out of Scope (for now) | High-risk mutation path |
| `configRequirements/read` | Missing | Maybe Later | Useful alongside config/read |
| `command/exec` | Missing | Out of Scope (for now) | Shepherd should route, not become a terminal proxy |
| `command/exec/write` | Missing | Out of Scope (for now) | Interactive terminal control sub-surface of `command/exec` |
| `command/exec/terminate` | Missing | Out of Scope (for now) | Interactive terminal control sub-surface of `command/exec` |
| `command/exec/resize` | Missing | Out of Scope (for now) | Interactive terminal control sub-surface of `command/exec` |
| `feedback/upload` | Missing | Out of Scope (for now) | |
| `fuzzyFileSearch` | Missing | Out of Scope (for now) | |
| `app/list` | Missing | Out of Scope (for now) | |
| `experimentalFeature/list` | Missing | Out of Scope (for now) | |
| `permissionProfile/list` | Missing | Maybe Later | Useful for admin diagnostics and richer sandbox/permission UX |
| `experimentalFeature/enablement/set` | Missing | Out of Scope (for now) | Feature flag mutation path |
| `externalAgentConfig/detect` | Missing | Out of Scope (for now) | |
| `externalAgentConfig/import` | Missing | Out of Scope (for now) | |
| `externalAgentConfig/import/readHistories` | Missing | Out of Scope (for now) | External-agent migration history is outside Shepherd's current Discord/admin surface |
| `account/read` | Missing | Maybe Later | Useful for diagnostics |
| `account/rateLimits/read` | Implemented | Core | Exposed via Discord `!limits` |
| `account/rateLimitResetCredit/consume` | Missing | Out of Scope (for now) | Account quota mutation path |
| `account/usage/read` | Missing | Maybe Later | Useful for account diagnostics if Shepherd adds admin reporting |
| `account/workspaceMessages/read` | Missing | Maybe Later | Useful for account/workspace diagnostics |
| `account/login/start` | Missing | Out of Scope (for now) | |
| `account/login/cancel` | Missing | Out of Scope (for now) | |
| `account/logout` | Missing | Out of Scope (for now) | |
| `account/sendAddCreditsNudgeEmail` | Missing | Out of Scope (for now) | Billing/account email action |
| `getConversationSummary` | Missing | Maybe Later | Legacy compatibility method absent from the generated JSON-schema request union; useful as a lightweight diagnostics/read path |
| `gitDiffToRemote` | Missing | Maybe Later | Legacy compatibility method absent from the generated JSON-schema request union; useful for repo diagnostics and review workflows |
| `getAuthStatus` | Missing | Maybe Later | Legacy compatibility method absent from the generated JSON-schema request union; useful for support and account diagnostics |
| `windowsSandbox/setupStart` | Missing | Out of Scope (for now) | Platform-specific |
| `windowsSandbox/readiness` | Missing | Out of Scope (for now) | Platform-specific |

## Notification Coverage

| Notification | Current Handling | Scope Recommendation |
|---|---|---|
| `error` | Typed events (`session.error`; context limits use `session.limit.context`) | Core |
| `thread/status/changed` | Typed event (`thread.status.changed`) | Core |
| `thread/started` | Generic | Maybe Later |
| `thread/deleted` | Generic | Maybe Later |
| `thread/name/updated` | Typed event (`thread.name.updated`) | Core |
| `thread/goal/updated` / `thread/goal/cleared` | Generic | Maybe Later |
| `thread/settings/updated` | Generic | Maybe Later |
| `thread/tokenUsage/updated` | Partial; mapped to typed bridge event (`thread.tokenUsage.updated`) and cached for Discord `!context` | Core |
| `thread/archived` / `thread/unarchived` | Typed events (`thread.archived`, `thread.unarchived`) | Core |
| `thread/closed` | Generic | Maybe Later |
| `thread/compacted` | Generic | Maybe Later |
| `skills/changed` | Generic | Maybe Later |
| `turn/started` | Generic | Maybe Later |
| `turn/completed` | Typed event (`turn.completed`) | Core |
| `turn/diff/updated` | Generic | Maybe Later |
| `turn/plan/updated` | Generic | Maybe Later |
| `hook/started` / `hook/completed` | Generic | Out of Scope (for now) |
| `item/started` / `item/completed` | Internal phase tracking only; otherwise generic | Core |
| `item/autoApprovalReview/started` / `item/autoApprovalReview/completed` | Generic | Maybe Later |
| `rawResponseItem/completed` | Generic; legacy compatibility notification absent from the generated JSON-schema notification union | Maybe Later |
| `item/agentMessage/delta` | Partially interpreted via text delta | Core |
| `item/plan/delta` | Partially interpreted via text delta | Maybe Later |
| `command/exec/outputDelta` | Partially interpreted via text delta | Out of Scope (for now) |
| `process/outputDelta` / `process/exited` | Generic | Out of Scope (for now) |
| `item/commandExecution/outputDelta` | Partially interpreted via text delta | Maybe Later |
| `item/commandExecution/terminalInteraction` | Generic | Maybe Later |
| `item/fileChange/outputDelta` | Partially interpreted via text delta | Maybe Later |
| `item/fileChange/patchUpdated` | Generic | Maybe Later |
| `serverRequest/resolved` | Generic | Maybe Later |
| `item/mcpToolCall/progress` | Generic | Out of Scope (for now) |
| `mcpServer/oauthLogin/completed` | Generic | Out of Scope (for now) |
| `mcpServer/startupStatus/updated` | Generic | Out of Scope (for now) |
| `account/updated` / `account/rateLimits/updated` | Generic; `account/rateLimits/read` is wrapped separately | Maybe Later |
| `app/list/updated` | Generic | Out of Scope (for now) |
| `remoteControl/status/changed` | Generic | Out of Scope (for now) |
| `externalAgentConfig/import/progress` | Generic | Out of Scope (for now) |
| `externalAgentConfig/import/completed` | Generic | Out of Scope (for now) |
| `fs/changed` | Generic | Out of Scope (for now) |
| `item/reasoning/summaryTextDelta` | Partially interpreted via text delta | Maybe Later |
| `item/reasoning/summaryPartAdded` | Generic | Maybe Later |
| `item/reasoning/textDelta` | Partially interpreted via text delta | Maybe Later |
| `model/rerouted` | Generic | Maybe Later |
| `model/verification` | Generic | Maybe Later |
| `turn/moderationMetadata` | Generic | Maybe Later |
| `model/safetyBuffering/updated` | Generic | Maybe Later |
| `warning` / `guardianWarning` | Generic | Maybe Later |
| `deprecationNotice` / `configWarning` | Generic | Maybe Later |
| `fuzzyFileSearch/sessionUpdated` / `fuzzyFileSearch/sessionCompleted` | Generic | Out of Scope (for now) |
| `thread/realtime/started` / `thread/realtime/itemAdded` | Generic | Out of Scope (for now) |
| `thread/realtime/transcript/delta` / `thread/realtime/transcript/done` | Delta partially interpreted via generic text-delta handling; done notification is generic | Out of Scope (for now) |
| `thread/realtime/outputAudio/delta` / `thread/realtime/sdp` | Generic | Out of Scope (for now) |
| `thread/realtime/error` / `thread/realtime/closed` | Generic | Out of Scope (for now) |
| `windows/worldWritableWarning` / `windowsSandbox/setupCompleted` | Generic | Out of Scope (for now) |
| `account/login/completed` | Generic | Out of Scope (for now) |

## Shared Protocol Type Parity

| Area | Status | Notes |
|---|---|---|
| Thread lifecycle DTOs | Good | Added and expanded in `shared/protocol/requests.ts` |
| Rich thread object typing | Partial | `ReadThreadResponse`/`RollbackThreadResponse` now use `ThreadRecord`; deeper nested typing still open |
| Rich resume/fork/start options | Partial | Major override fields supported; still not full schema parity |
| Notification DTO parity | Partial | Key thread lifecycle notifications now typed; broader item/model/realtime notifications still reduced |
| Context telemetry DTOs | Partial | Added `ThreadTokenUsage`/`ReadThreadTokenUsageResponse`; `thread/tokenUsage/updated` is typed and cached, while broader telemetry notifications remain reduced |
| Generated schema baseline coverage | Partial | Refreshed against `codex-cli 0.144.4`: 90 TypeScript request methods (87 in the JSON-schema union plus 3 legacy compatibility methods) and 69 TypeScript notifications (68 in the JSON-schema union plus 1 legacy compatibility notification); Shepherd intentionally leaves most platform-admin surfaces unwrapped |
