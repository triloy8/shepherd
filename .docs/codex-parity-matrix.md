# Codex parity matrix

This document inventories the Codex app-server protocol only. For Claude Agent
SDK and subscription coverage, see the [Claude parity matrix](claude-parity-matrix.md).
For Discord and web controls, see the [surface parity matrix](surface-parity-matrix.md).
Implementation notes reviewed: 2026-10-31 against `0475c5e` on `main`. The
generated inventory was reverified the same day: both schema formats were
regenerated with `codex-cli 0.160.1` and every method, server request and
notification name was compared with the tables below. Generated schemas are not
committed (`schemas/` is ignored); regenerate them to repeat the check.

Unmapped notifications marked `Private` stay inside the adapter and are not
published as generic application events.

Status legend:

- `Implemented`: wrapped and exposed in Shepherd API flow.
- `Partial`: method exists, but Shepherd exposes only a subset of schema fields/behavior.
- `Missing`: no wrapper/exposed API yet.
- `Incompatible`: existing Shepherd call is absent from this provider baseline.
- `Removed`: provider method was removed and Shepherd no longer invokes it.

Generated baseline:

- Codex version: `codex-cli 0.160.1`
- Last refreshed: `2026-10-09`; inventory reverified `2026-10-31` (no differences)
- Implementation notes reviewed: `2026-10-04`; user-input handling reviewed
  `2026-10-09` against `7e30d66` ([PR #88](https://github.com/triloy8/shepherd/pull/88))
- Refresh commands:
  - `codex app-server generate-ts --out ./schemas`
  - `codex app-server generate-json-schema --out ./schemas`
- Experimental verification commands (separate inventory, including dynamic tools):
  - `codex app-server generate-ts --experimental --out <temporary-directory>`
  - `codex app-server generate-json-schema --experimental --out <temporary-directory>`

Legacy note:

- The legacy-named `execCommandApproval` and `applyPatchApproval` server requests
  remain in the 0.160.1 generated schema and are supported directly. They are
  not Shepherd compatibility shims. The three legacy client methods and two
  legacy notification names listed below are inventory entries, not dedicated
  wrappers or translations.

## Client Request Methods

| Method | Status | Scope Recommendation | Notes |
|---|---|---|---|
| `initialize` | Implemented | Core | Native request and notification envelopes are decoded inside the adapter; `experimentalApi` is enabled for dynamic tools. One process serves every thread, history read and account request; notifications and server requests are routed by `threadId`, notifications without one reach every session, and requests for a thread no session runs are refused. If the process exits, every session reports it and the next use starts a new process |
| `thread/start` | Partial | Core | Adapter encodes shared model, effort, workspace, the policy profile's sandbox and approval settings, and registered dynamic tools. `developerInstructions`, `baseInstructions`, and `ephemeral` are not exposed, so configured instructions apply. Raw SDK config/backend/style/analytics selectors are private native settings; no public pass-through. Missing `serviceTier`, `approvalsReviewer`, `sessionStartSource`, and `threadSource` |
| `thread/resume` | Partial | Core | Shared typed overrides only; effort maps to native configuration privately. Missing `serviceTier`, `approvalsReviewer`, and `excludeTurns` |
| `thread/fork` | Partial | Core | Shared typed overrides only; native fields are not exposed wholesale. Missing `lastTurnId`, `serviceTier`, `approvalsReviewer`, `ephemeral`, `threadSource`, and `excludeTurns` |
| `thread/archive` | Implemented | Core | |
| `thread/delete` | Missing | Maybe Later | Destructive thread lifecycle path; useful if Shepherd adds stronger thread management UX |
| `thread/unarchive` | Implemented | Core | |
| `thread/name/set` | Implemented | Core | |
| `thread/goal/set` | Missing | Maybe Later | Goal management path not exposed by current Discord flow |
| `thread/goal/get` | Missing | Maybe Later | Useful for richer thread diagnostics if goal state is surfaced |
| `thread/goal/clear` | Missing | Maybe Later | Goal management path not exposed by current Discord flow |
| `thread/attachment/add` | Missing | Maybe Later | Adds a durable thread attachment; separate from prompt image input |
| `thread/attachment/list` | Missing | Maybe Later | Lists durable thread attachments |
| `thread/attachment/remove` | Missing | Maybe Later | Removes a durable thread attachment |
| `thread/metadata/update` | Missing | Maybe Later | Useful for richer repo/thread metadata, but not required for current Discord flow |
| `thread/section/move` | Missing | Maybe Later | Moves a thread into, within, or out of a server-owned section ordering |
| `thread/compact/start` | Implemented | Core | |
| `thread/shellCommand` | Missing | Out of Scope (for now) | Terminal-oriented thread helper; Shepherd should route requests, not become a shell command surface |
| `thread/approveGuardianDeniedAction` | Missing | Maybe Later | Useful if Shepherd exposes richer guardian/approval review workflows |
| `thread/rollback` (removed) | Removed | Core | No longer invoked; Discord command returns a retirement notice; web uses turn-based revert |
| `thread/revert` | Implemented | Core | Explicit `beforeTurnId` cutoff; web Revert from here under persisted user messages; preserves response pagination cursors and resets history; does not revert local file changes |
| `thread/list` | Partial | Core | Shared filters cover archived state, workspaces, search, creation/update sorting, and direction. Native source/backend/database filters stay private. Provider cursors are opaque and catalog merging is generic; hosted-only `originators` is not exposed |
| `threadSection/list` | Missing | Maybe Later | Useful if Shepherd adds section-based thread organization UX |
| `threadSection/create` | Missing | Maybe Later | Section management is not exposed by the current Discord flow |
| `threadSection/update` | Missing | Maybe Later | Section management is not exposed by the current Discord flow |
| `threadSection/delete` | Missing | Maybe Later | Destructive section-management path; not exposed by the current Discord flow |
| `thread/loaded/list` | Implemented | Core | |
| `thread/read` | Implemented | Core | `includeTurns` supported, though the generated schema now recommends metadata-only reads plus paginated turn/item listing |
| `thread/turns/list` | Implemented | Core | Wrapped with cursors, direction, and items view; Discord `!history` uses five-turn summary pages |
| `thread/items/list` | Partial | Core | Wrapped with string cursors, direction, and optional turn filter; the new object item-anchor cursor is not exposed; Discord history Items buttons and `!history items` show paginated excerpts with Read buttons for message text/activity summaries |
| `thread/inject_items` | Missing | Maybe Later | Potentially useful for advanced thread mutation/replay workflows; not needed for current Discord flow |
| `thread/unsubscribe` | Implemented | Core | A stopped session releases its thread so the shared process stops sending its notifications. Codex subscribes the process's one client, so a session releases a thread only while it still runs it; a session that has since resumed the thread keeps it subscribed |
| `hooks/list` | Missing | Maybe Later | Useful for admin diagnostics, but hook management is not part of the current Discord surface |
| `marketplace/add` | Missing | Out of Scope (for now) | Marketplace mutation path |
| `marketplace/remove` | Missing | Out of Scope (for now) | Marketplace mutation path |
| `marketplace/upgrade` | Missing | Out of Scope (for now) | Marketplace mutation path |
| `turn/start` | Partial | Core | Supports URL/local image, audio, text, and skill input (application `image_file`/`audio_file` encode to `localImage`/`localAudio`); mention input and text elements are not exposed; missing the new image `fileId` variant. Supports `model`, `effort` (Discord `!effort`), and the thread workspace as `cwd`; the policy profile is set on `thread/start`/`resume`/`fork`, not per turn; missing disabled plugin IDs, client message ID, turn trigger, tool output, approval reviewer, sandbox policy, thread/turn service tiers, configurable summary, personality, and output schema; every turn requests reasoning summaries with `summary: "auto"` |
| `turn/interrupt` | Implemented | Core | |
| `turn/steer` | Partial | Core | Exposed through Discord mention steering of active turns; missing client message ID |
| `review/start` | Missing | Out of Scope (for now) | Could be future advanced feature |
| `model/list` | Implemented | Core | Wrapped in core and exposed via Discord `!models`/`!model` |
| `modelProvider/capabilities/read` | Missing | Maybe Later | Useful for model diagnostics and richer model selection UX |
| `skills/list` | Implemented | Core | Wrapped in core and exposed via Discord `!skills` with local five-entry pages; the API returns the full inventory without cursors |
| `skills/extraRoots/set` | Missing | Maybe Later | Required for extra skill roots; the removed `skills/list.perCwdExtraUserRoots` compatibility field is no longer exposed |
| `skills/config/write` | Partial | Core | Wrapped in core and exposed via Discord `!skill enable|disable`; supports path selection but not the generated name selector |
| `plugin/list` | Missing | Out of Scope (for now) | Plugin management is outside Shepherd's current Discord/admin surface |
| `plugin/installed` | Missing | Out of Scope (for now) | Plugin inventory surface is outside Shepherd's current Discord/admin surface |
| `plugin/reconcile` | Missing | Out of Scope (for now) | Plugin reconciliation is outside Shepherd's current Discord/admin surface |
| `plugin/read` | Missing | Out of Scope (for now) | |
| `plugin/skill/read` | Missing | Out of Scope (for now) | Plugin skill inspection is outside Shepherd's current Discord/admin surface |
| `plugin/install` | Missing | Out of Scope (for now) | High-risk mutation path |
| `plugin/uninstall` | Missing | Out of Scope (for now) | High-risk mutation path |
| `plugin/share/save` | Missing | Out of Scope (for now) | Plugin sharing mutation path |
| `plugin/share/updateTargets` | Missing | Out of Scope (for now) | Plugin sharing mutation path |
| `plugin/share/list` | Missing | Out of Scope (for now) | Plugin sharing is outside Shepherd's current Discord/admin surface |
| `plugin/share/checkout` | Missing | Out of Scope (for now) | Plugin sharing retrieval path is outside Shepherd's current Discord/admin surface |
| `plugin/share/delete` | Missing | Out of Scope (for now) | Plugin sharing mutation path |
| `app/read` | Missing | Out of Scope (for now) | App detail inspection is outside Shepherd's current Discord/admin surface |
| `app/list` | Missing | Out of Scope (for now) | |
| `app/installed` | Missing | Out of Scope (for now) | Installed app inventory is outside Shepherd's current Discord/admin surface |
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
| `experimentalFeature/list` | Missing | Out of Scope (for now) | |
| `permissionProfile/list` | Missing | Maybe Later | Useful for admin diagnostics and richer sandbox/permission UX |
| `experimentalFeature/enablement/set` | Missing | Out of Scope (for now) | Feature flag mutation path |
| `externalAgentConfig/detect` | Missing | Out of Scope (for now) | |
| `externalAgentConfig/import` | Missing | Out of Scope (for now) | |
| `externalAgentConfig/import/recordHistory` | Missing | Out of Scope (for now) | Records results for an externally completed agent-config import |
| `externalAgentConfig/import/readHistories` | Missing | Out of Scope (for now) | External-agent migration history is outside Shepherd's current Discord/admin surface |
| `account/gatewayOAuth/read` | Missing | Maybe Later | Reads gateway OAuth status |
| `account/gatewayOAuth/login` | Missing | Out of Scope (for now) | Explicit gateway authorization; initialize also adds `explicitGatewayOauth` |
| `account/gatewayOAuth/cancel` | Missing | Out of Scope (for now) | Cancels gateway authorization |
| `account/read` | Missing | Maybe Later | Useful for diagnostics |
| `account/rateLimits/read` | Partial | Core | Discord `!limits` and web sidebar Usage & limits render normalized allowance windows from all returned buckets; web also renders typed banked reset count/details. Does not send `supportsLunaReserve` or `excludeResetCreditDetails`; does not preserve native top-level `ordinaryUsageAllowed`, `accountId`, and `rateLimitUpsell`; window labels use native `limitName`, falling back to a humanized `limitId`; `ordinaryUsageAllowed` is derived from normalized window utilization |
| `account/rateLimitResetCredit/consume` | Implemented | Core | Shared wrapper/control and web `POST /api/limits/reset` / Use reset per credit. Count-only/capped inventories retain Use available reset. Requires `idempotencyKey`; optional `creditId`. Native outcomes `reset`, `alreadyRedeemed`, `nothingToReset`, `noCredit` map to shared `reset`, `already_redeemed`, `nothing_to_reset`, `no_credit`. UI refreshes limits after every known outcome and retains the same request key and selected credit ID after an unknown outcome, including across reload in the same tab. No Discord command |
| `account/usage/read` | Missing | Maybe Later | Useful for account diagnostics if Shepherd adds admin reporting; generated params now optionally scope usage to a `threadId` |
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

## Client Notifications

| Notification | Status | Notes |
|---|---|---|
| `initialized` | Implemented | Sent once after the `initialize` response, before any other request (`app_server.ts`) |

## Server Request Handling

| Method | Current Handling | Scope Recommendation |
|---|---|---|
| `item/commandExecution/requestApproval` | Typed approval choices and generated decision response | Core |
| `item/fileChange/requestApproval` | Typed approval choices and generated decision response | Core |
| `execCommandApproval` | Typed legacy approval response, including structured denial reasons | Core (Legacy) |
| `applyPatchApproval` | Typed legacy approval response, including structured denial reasons | Core (Legacy) |
| `item/tool/requestUserInput` | Typed thread/turn identity and question validation; pending web forms and Discord text modals; exact question-ID answer response or explicit empty-map skip; honors blocking/nonblocking requests | Core |
| `mcpServer/elicitation/request` | Explicit JSON-RPC unsupported response; Shepherd has no form/URL elicitation surface | Maybe Later |
| `item/permissions/requestApproval` | Explicit JSON-RPC unsupported response; Discord buttons cannot return permission profiles | Maybe Later |
| `item/tool/call` | Typed identity/JSON validation and explicit registered-tool dispatch; stale turns, wrong threads, and unknown tools are rejected | Core (Experimental) |
| `account/chatgptAuthTokens/refresh` | Explicit JSON-RPC unsupported response; authentication is owned by the Codex installation | Out of Scope (for now) |
| `attestation/generate` | Explicit JSON-RPC unsupported response; no client attestation provider is configured | Out of Scope (for now) |

## Notification Coverage

| Notification | Current Handling | Scope Recommendation |
|---|---|---|
| `error` | Typed nested error decoding (`session.error`; context limits use `session.limit.context`); `willRetry: true` diagnostics stay in the server log | Core |
| `thread/status/changed` | Typed event (`thread.status.changed`) | Core |
| `thread/attachment/updated` | Private | Maybe Later |
| `account/gatewayOAuth/changed` | Private | Out of Scope (for now) |
| `thread/started` | Private | Maybe Later |
| `thread/deleted` | Private | Maybe Later |
| `thread/name/updated` | Typed event (`thread.name.updated`) | Core |
| `thread/goal/updated` / `thread/goal/cleared` | Private | Maybe Later |
| `thread/environment/connected` / `thread/environment/disconnected` | Private | Maybe Later |
| `thread/settings/updated` | Private | Maybe Later |
| `thread/tokenUsage/updated` | Partial; mapped to typed bridge event (`thread.tokenUsage.updated`) and cached for Discord `!context` | Core |
| `thread/archived` / `thread/unarchived` | Typed events (`thread.archived`, `thread.unarchived`) | Core |
| `thread/closed` | Private | Maybe Later |
| `thread/reverted` | Typed event (`thread.reverted`); web invalidates history and event replay | Core |
| `thread/compacted` | Private | Maybe Later |
| `thread/queue/changed` | Private | Maybe Later |
| `project/changed` / `thread/project/updated` | Private | Maybe Later |
| `skills/changed` | Private | Maybe Later |
| `turn/started` | Private | Maybe Later |
| `turn/completed` | Typed event; failed completion payloads emit `turn.failed` with the generated error message | Core |
| `turn/diff/updated` | Private | Maybe Later |
| `turn/plan/updated` | Private | Maybe Later |
| `hook/started` / `hook/completed` | Private | Out of Scope (for now) |
| `item/started` / `item/completed` | Decoded with the history decoder into `item.started` / `item.completed`; tracks message phase for deltas | Core |
| `item/autoApprovalReview/started` / `item/autoApprovalReview/completed` | Private | Maybe Later |
| `autoApprovalReview/strictReviewRequired` | Private | Maybe Later |
| `rawResponseItem/completed` | Private; legacy compatibility notification absent from the generated JSON-schema notification union | Maybe Later |
| `rawResponse/completed` | Private; legacy compatibility notification absent from the generated JSON-schema notification union | Maybe Later |
| `item/agentMessage/delta` | `item.delta` on the `message` channel | Core |
| `item/plan/delta` | `item.delta` on the `plan` channel; surfaces build the running plan and replace it with the completed item | Partial |
| `command/exec/outputDelta` | Private | Out of Scope (for now) |
| `process/outputDelta` / `process/exited` | Private | Out of Scope (for now) |
| `item/commandExecution/outputDelta` | `item.delta` on the `output` channel; surfaces show the completed item | Partial |
| `item/commandExecution/terminalInteraction` | Private | Maybe Later |
| `item/fileChange/outputDelta` | `item.delta` on the `output` channel; surfaces show the completed item | Partial |
| `item/fileChange/patchUpdated` | Private | Maybe Later |
| `serverRequest/resolved` | Matches pending permission and user-input request IDs, removes the native request, and emits `approval.expired` | Core |
| `item/mcpToolCall/progress` | Private | Out of Scope (for now) |
| `mcpServer/oauthLogin/completed` | Private | Out of Scope (for now) |
| `mcpServer/startupStatus/updated` | Private | Out of Scope (for now) |
| `mcpServer/event/stream/notification` | Private | Out of Scope (for now) |
| `account/updated` / `account/rateLimits/updated` | Private; `account/rateLimits/read` is wrapped separately | Maybe Later |
| `app/list/updated` | Private | Out of Scope (for now) |
| `remoteControl/status/changed` | Private | Out of Scope (for now) |
| `externalAgentConfig/import/progress` | Private | Out of Scope (for now) |
| `externalAgentConfig/import/completed` | Private | Out of Scope (for now) |
| `fs/changed` | Private | Out of Scope (for now) |
| `item/reasoning/summaryTextDelta` | `item.delta` on the `reasoning` channel with `form: "summary"` and `part` from `summaryIndex`; surfaces show it as a running step until the item completes. Codex writes no summaries unless asked, so every `turn/start` sends `summary: "auto"`; the model may still write none | Implemented |
| `item/reasoning/summaryPartAdded` | Private | Maybe Later |
| `item/reasoning/textDelta` | Private; history keeps summaries, not raw reasoning | Out of Scope (for now) |
| `model/rerouted` | Private | Maybe Later |
| `model/verification` | Private | Maybe Later |
| `modelProvider/authRecoveryStarted` / `modelProvider/authRecoveryCompleted` | Private | Maybe Later |
| `turn/moderationMetadata` | Private | Maybe Later |
| `model/safetyBuffering/updated` | Private | Maybe Later |
| `warning` / `guardianWarning` | Private | Maybe Later |
| `deprecationNotice` / `configWarning` | Private | Maybe Later |
| `fuzzyFileSearch/sessionUpdated` / `fuzzyFileSearch/sessionCompleted` | Private | Out of Scope (for now) |
| `thread/realtime/started` / `thread/realtime/itemAdded` | Private | Out of Scope (for now) |
| `thread/realtime/item/started` / `thread/realtime/item/transcript/delta` / `thread/realtime/item/completed` | Private | Out of Scope (for now) |
| `thread/realtime/transcript/delta` / `thread/realtime/transcript/done` | Private; neither notification maps to an application text delta | Out of Scope (for now) |
| `thread/realtime/outputAudio/delta` / `thread/realtime/sdp` | Private | Out of Scope (for now) |
| `thread/realtime/error` / `thread/realtime/closed` | Private | Out of Scope (for now) |
| `windows/worldWritableWarning` / `windowsSandbox/setupCompleted` | Private | Out of Scope (for now) |
| `account/login/completed` | Private | Out of Scope (for now) |

## Shared Protocol Type Parity

| Area | Status | Notes |
|---|---|---|
| Thread lifecycle DTOs | Good | Includes shared list filters, opaque pagination cursors, and provider-neutral execution policies; native approval values stay in the adapter |
| Rich thread object typing | Partial | `ReadThreadResponse`/`RevertThreadResponse` use `ThreadRecord`; only declared shared fields survive adapter decoding; generated `originator`, project assignment, agent-message delivery, and environment fields are omitted |
| Rich resume/fork/start options | Partial | Major override fields supported; pagination controls and several newer override fields remain unwrapped |
| Notification DTO parity | Partial | Key lifecycle and nested error notifications are decoded; project, queue, auth-recovery, MCP event-stream, and broader item/model/realtime notifications remain private |
| Account usage/reset DTOs | Partial | Typed reset summary/details, consume params, and validated outcomes are exposed through shared controls and web. Native buckets are decoded into typed allowance windows; raw bucket payloads and broader native account metadata stay private |
| User-input request/response DTOs | Partial | `UserQuestionRequest` preserves identity, questions, `isBlocking`, `isOther`, `isSecret`, `multiSelect`, and options; answers use question-ID maps of string arrays. One nonempty answer per single-answer question; distinct arrays for multiselect; deprecated `autoResolutionMs` is not used for a client timer |
| Context telemetry DTOs | Partial | Added `ThreadTokenUsage`/`ReadThreadTokenUsageResponse`; `thread/tokenUsage/updated` is typed and cached, while broader telemetry notifications remain reduced |
| Generated schema baseline coverage | Partial | The inventory baseline is `codex-cli 0.160.1`: 107 TypeScript request methods (104 in the JSON-schema union plus 3 legacy compatibility methods), 10 server requests, and 85 TypeScript notifications (83 in the JSON-schema union plus 2 legacy compatibility notifications); Shepherd intentionally leaves most platform-admin surfaces unwrapped. New attachment and gateway OAuth methods remain unwrapped; removed rollback is retired in favor of implemented revert |


## Refresh to 0.160.1

Both schema formats were regenerated with the installed `codex-cli 0.160.1`.
Fresh output was compared recursively with fresh output from the retained
`0.160.0` binary: all 1,048 default generated files are identical. All 1,315
experimental generated files are also identical between these versions. There
are no schema additions, removals, or field changes in this refresh; existing
implementation notes still apply and no Shepherd request migration is required.

All default request and notification method names were checked against the
matrix: 107 TypeScript client methods / 104 JSON methods, 10 server requests,
and 85 TypeScript notifications / 83 JSON notifications. The differences are
the legacy compatibility entries documented above.

The experimental inventory is separate: it adds 63 client methods and one
server request (`currentTime/read`), with no additional notification names.
Shepherd advertises dynamic tools and handles `item/tool/call`; it does not
implement the other experimental client methods or `currentTime/read` (unknown
server requests receive an explicit JSON-RPC unsupported response). These are
not part of the default inventory counts.

The previous `0.160.0` refresh also found identical default and experimental
output compared with `0.159.2`.

## Structured user questions

`item/tool/requestUserInput` is a server **request**, not a notification. Shepherd
keeps its original JSON-RPC ID pending through the shared decision lifecycle and
responds only after an explicit submission or skip. `isBlocking` controls whether
Codex waits for the answer; a missing flag is treated as blocking for older requests.
Shepherd does not start a timer from deprecated `autoResolutionMs`. If Codex resolves
a request itself, `serverRequest/resolved` removes it and expires its form.

Submission uses `{ answers: { [questionId]: { answers: [text] } } }`. Shepherd
requires one nonempty answer for each single-answer question and one or more
distinct answers for multiselect (at most 100, each at most 16,000 characters),
rejects extra IDs, and restricts
answers to offered option labels when custom text is not allowed. Explicit skip
returns `{ answers: {} }`. Invalid submissions leave the request pending for retry;
resolved, interrupted/completed-turn, and stopped-session questions cannot accept
stale responses. Answers are not copied into pending decision records or events.

Web supports selectable options, custom/free text, multiple questions, and masked
secret fields and multiselect checkboxes. Discord offers text modals for up to five
nonsecret single-answer questions;
secret, multiselect, or larger requests direct users to the web UI. MCP elicitation remains
unsupported. Ordinary assistant prose does not create a question request.

Coverage: `tests/user_questions.test.ts` verifies wire responses, validation,
lifecycle cleanup, API errors, waiting indicators, secret fields, and Discord
modals. Firefox fixture checks verified pending state, reload recovery, custom
submission and its exact HTTP payload. These are not live Codex completion tests.
See the [question guide](user-questions.md) and [surface matrix](surface-parity-matrix.md).

## Banked reset coverage

`account/rateLimits/read` can return `rateLimitResetCredits.availableCount` and
`credits` detail rows with `id`, `resetType`, `status`, `grantedAt`, `expiresAt`,
`title`, and `description`. A null summary means unavailable; null detail rows
mean only the count is known. An empty array means details were fetched with no
available credits. Rows may be capped, so the available count is authoritative;
`expiresAt: null` means the credit does not expire.

Shepherd decodes the reset summary in the Codex adapter and preserves it through
`limits.read` shared controls and the web API. The sidebar Usage & limits panel
shows the count and available details; conversation settings retain only context
telemetry. Discord renders allowance windows and extra usage, but no banked reset inventory.

The shared consume wrapper is exposed through `POST /api/limits/reset` and per-credit
Use reset buttons. Count-only/capped details retain a provider-selected
fallback. The UI disables duplicate submission, reports each validated provider
outcome, and rereads limits after a known result. If the result is unknown, it
saves the request key and selected credit ID in session storage and retries that
same logical request; it does not automatically redeem another reset. Provider
redemption support already existed in the previous baseline; this change adds
Shepherd's control. No real banked reset was consumed during validation.

Sources: [generated provider documentation](https://learn.chatgpt.com/docs/app-server#6-rate-limits-chatgpt),
[session bridge](../server/providers/codex/session.ts),
[session manager](../server/core/conversation/session_manager.ts),
[shared controls](../server/core/surface/control_actions_service.ts),
[web limits route](../server/adapters/web/api.ts),
[Discord commands](../server/adapters/discord/commands.ts), and
[web limits rendering](../ui/src/components/UsageLimits.tsx).

## Previous changes in 0.159.2

Compared with freshly generated 0.154.0 schemas, this baseline adds six client
methods and two notifications, removes `thread/rollback`, and leaves the ten
server request methods unchanged. The removed method is listed above for tracking
but is excluded from the 107-method inventory count.

Additional protocol changes not yet fully exposed by Shepherd:

- Item history supports object anchor cursors and per-item `startedAtMs` /
  `completedAtMs` timestamps; current controls use string continuation cursors.
- Image inputs and raw tool-result images can reference uploaded file IDs.
- `turn/start` adds `disabledPluginIds`; start/resume/fork responses and thread
  settings report that saved list. The schema notes it does not yet filter plugin
  capabilities. Resume also reports effective `collaborationMode`.
- Models add `availableAccessPrograms`; personality selection is deprecated and
  `supportsPersonality` is always false. Model IDs remain runtime catalog data,
  not schema constants. A live query after updating includes `gpt-6.1-sol` with
  medium effort; Shepherd now defaults new conversations to that model/effort.
- MCP discovery adds `serverName`, `httpOrigin`, and `serverCapabilities`;
  resource reads add an explicit hosted app/account target. MCP items add
  `mcpAppUi` presentation metadata. These are not embedded-app UI support.
- Plugin details add an onboarding skill; app configuration adds tool exposure
  exclusions. Managed requirements add provider definitions and allowed login
  methods and revise Windows sandbox fields.
- Error info adds `flexUnavailable` and `tooManyDenials`; turn errors may also
  describe interrupted turns. Plans add `promax`; feedback adds `promptHash`.

Experimental schemas were also regenerated in a temporary directory to verify
that `thread/start.dynamicTools` and `item/tool/call` remain available. Generated
files under `schemas/` are intentionally ignored by Git. The surface matrix tracks
the web turn-based revert action and Discord rollback retirement. Other provider
additions alone do not create new Discord or web controls.

## Deployment version

Ubuntu setup, Docker, and Compose default to `codex-cli 0.160.1`, matching this
inventory. Both schema generation commands were rerun with that exact CLI.
Operators can override `CODEX_VERSION` during installation, but that selects a
different protocol baseline. Updating the checkout alone does not upgrade an
already-installed host CLI; rerun `deploy/ubuntu/setup.sh` as the deployment
user. Schema generation itself does not update the CLI; this refresh used the
already-installed `0.160.1` binary. Already-running processes retain their old
binary until restarted. Generated files under `schemas/` remain intentionally
ignored by Git.
