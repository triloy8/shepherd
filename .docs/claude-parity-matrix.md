# Claude parity matrix

Implementation reviewed: 2026-10-31 against `0475c5e` on `main`.
SDK/native baseline: `@anthropic-ai/claude-agent-sdk` **0.3.296**, bundled/native
Claude Code **2.1.296** (recorded 2026-10-10; installed versions and the saved
`claude.ai` login reconfirmed 2026-10-31). This is an inventory of Shepherd's Claude adapter and
subscription support, not a complete inventory of every SDK export or a promise
of support for all Claude Code terminal commands.

See the [Codex parity matrix](codex-parity-matrix.md) for app-server RPC coverage,
the [surface parity matrix](surface-parity-matrix.md) for Discord/web workflows,
[Architecture](architecture.md) for dependency boundaries, and the
[provider abstraction](provider-abstraction.md) implemented shared boundary. Setup instructions are in the [README](../README.md).

## Status and evidence

- **Implemented**: Shepherd has a concrete adapter path or surface control.
- **Partial**: supported with the stated input, presentation, or lifecycle limit.
- **Native**: Claude can load or run it; Shepherd has no dedicated management
  control. This does not imply a live test of that feature.
- **Missing**: Shepherd does not translate or expose the SDK feature.
- **Unsupported**: the adapter explicitly rejects the operation.

Implementation status and verification are separate. Controlled SDK-stream tests
cover adapter behavior; they do not prove live model responses. Host checks
confirmed a saved Claude Pro login and SDK account recognition. Native model
discovery and credential isolation passed. Browser screenshots confirmed the
provider picker, Claude details, and capability-filtered menu on phone and
desktop viewports. Those checks were recorded for the earlier provider branch. Live use between
2026-10-29 and 2026-10-31 (thread-watch and swarm testing, Haiku, Sonnet and Opus)
exercised responses, tool execution, Shepherd's MCP application tools, permission
requests under the `default` profile answered through the web API, interrupts, and
resume with history after host restarts. Quota exhaustion was not retested. Installed types are the source of truth
for event fields; upstream documentation and subscription rules can change.

## Authentication and account scope

| Capability | Status | What Shepherd does / limit |
| --- | --- | --- |
| Claude subscription authentication | Implemented | `CLAUDE_AUTH_MODE=subscription` is the default. Uses the CLI user's saved login or `CLAUDE_CODE_OAUTH_TOKEN`. Actual model access and allowance are controlled by the account's plan. |
| Saved Claude Pro login | Implemented | Verified through `claude auth status` and native SDK `accountInfo()`. Shepherd must run as the logged-in OS user, with the same Claude configuration directory. |
| Alternate account configuration directory | Implemented | Inherits `CLAUDE_CONFIG_DIR`; configuration is host-wide, not selected per conversation. |
| Long-lived subscription token | Implemented | Inherits `CLAUDE_CODE_OAUTH_TOKEN`, including values loaded from `envs/common.env`. Token generation is the external `claude setup-token` command. |
| Subscription preference over inherited API credentials | Implemented | Adapter-local environment/settings clear API keys, bearer tokens, API-key helpers, alternate API URLs/profile selection, and configured cloud-selection flags for queries. Does not modify the host environment or Codex credentials. |
| Explicit API authentication | Implemented | `CLAUDE_AUTH_MODE=api` passes the configured environment through. API/backend authentication is external setup; it does not use the Pro subscription allowance. |
| Phone authorization | Partial | CLI login runs on the box; authorization can happen in the phone browser. The browser code must return to that CLI. No Shepherd web sign-in or credential-entry control. |
| Login/logout/token renewal in Shepherd | Missing | Use Claude Code's external authentication tools. Shepherd does not own an OAuth flow or implement token refresh itself. |
| Account identity/plan in the web UI | Partial | Claude selection shows the reported plan, falling back to the authentication label; it does not display the signed-in flag. Email, native account IDs and credentials are not exposed. No account-switching control. |
| Choose different Claude accounts per conversation | Missing | Provider selection is per conversation; Claude credentials come from the host process and configuration. |

For subscription availability, see Anthropic's dated
[SDK subscription guidance](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan).
For saved logins and token setup, see
[Claude Code authentication](https://code.claude.com/docs/en/authentication).
The 2026-10-10 review recorded subscription-limit support on the support page
and more restrictive third-party login guidance in the SDK overview/quickstart.
That external guidance was not reverified in this implementation audit. This matrix records implemented behavior and the verified host
login, not a blanket approval for distributing a subscription login product.

## Conversations, history, and lifecycle

| Capability | Status | What Shepherd does / limit |
| --- | --- | --- |
| Select Claude for a new conversation | Implemented | Web Agent picker, Discord `!newthread claude`, and core/API `provider: "claude"`. Codex is the default unless `SHEPHERD_DEFAULT_PROVIDER=claude`. |
| Preserve provider identity | Implemented | Explicit persistent thread/provider binding; resume and fork retain the provider. No in-place provider migration. |
| Start a Claude session | Implemented | SDK `query()` with a session ID Shepherd chooses, which is the conversation ID. A rename or archive requested before Claude creates the session is applied once it exists. |
| Continue across turns | Implemented | Keeps the query/input stream open; resumes the native session when a query must restart. |
| Resume after process restart | Implemented | A conversation that never had a turn is not stored yet and cannot be resumed; open a new one. Reads the session and its workspace through the SDK (`getSessionInfo`, `getSessionMessages`) and resumes it with the model Claude last used. Preserve Claude's storage and Shepherd's provider bindings. Claude does not record the policy profile or effort, so a resumed conversation runs within the requested policy or the host's, with the requested or host effort. |
| Fork | Implemented | SDK `forkSession()` for materialized sessions, searching every project directory because a thread's workspace can move after its transcript was written; a fresh ID for a thread not yet materialized. Overrides apply to the fork only. |
| Rename, archive, restore | Implemented | SDK `renameSession()` sets the session title; archiving sets the session tag to `archived` (`tagSession()`), which replaces any other tag on that session. |
| Stored thread listing/filtering/pagination | Implemented | SDK `listSessions()`: every Claude Code session, including ones started outside Shepherd, with title/prompt search, cwd/archive filters and sorting. |
| Loaded conversation listing | Implemented | Application-owned loaded sessions; catalog discovery queries are also closed on shutdown. |
| Read turns/items and replay history | Implemented | Decoded from Claude's transcript (`getSessionMessages`) with the same decoder as the live stream, so live items equal history items. A turn is a prompt and its responses, identified by the prompt's ID; steered input (`isQueuedCommand`) joins its turn; an interruption marker ends a turn as interrupted; a background-task notification starts a turn without a user message, marked `trigger: "background"`, named by the task run (`origin.runId`, the live `task_notification` `run_id`) so live and history agree; notifications that arrive together wake one turn. Assistant text before a tool call or thinking block is interim; text that ends a response is the final answer. The transcript records no turn failures, so a failed turn reads as completed after a reload. Forks copy the main transcript only, so a fork's copies of earlier turns lack their subagent items. Subagent text, thinking and tool calls (live with `forwardSubagentText`, stored via `listSubagents`/`getSubagentMessages`) join their delegation as items with `parentItemId`; a subagent's text is always interim. Because transcripts record no results, history orders the conversation's own items and each subagent's items as live did, but interleaves the two by time. |
| Detach from a surface | Implemented | Releases surface attachment without stopping agent work. |
| Background work | Partial | Tracks non-ambient background task counts using snapshots or older task edges; retains the query and records later root responses/questions as wake turns. No task-management dashboard. |
| Change model/cwd/policy/effort | Partial | Restarts/resumes the query when needed. Settings changes wait for background work; cwd changes wait for active work. |
| Shutdown / query failure | Implemented | Closes owned queries, settles pending approvals, records interrupted/failed turns and clears runtime activity. |
| Manual context compaction | Unsupported | Disabled in capability-aware web controls; the session omits the method and core rejects the operation. Native automatic context management is separate. |
| Automatic context compaction | Supported | Claude compacts on its own; the summary it continues from is a "Context compacted" step of the running turn, live and in history. A stored session begins at its last compaction, so earlier turns are not shown. |
| Conversation revert | Unsupported | No Claude translation of Shepherd's turn-based revert operation. |
| File checkpointing / file rewind | Missing | SDK facilities are not enabled or wrapped. Neither fork nor conversation history implies file rollback. |
| Ephemeral threads | Unsupported | Shared thread requests expose no ephemeral field; API validation rejects it. |
| Durable native transcript import/export | Missing | No general session import/export interface or external-storage implementation. |

## Input, execution, approvals, and questions

| Capability | Status | What Shepherd does / limit |
| --- | --- | --- |
| Text and image-only prompts | Implemented | Converts shared input into SDK user messages; text is optional for image prompts. |
| Image input | Partial | Inline PNG/JPEG/GIF/WebP data URLs and HTTP(S) image URLs. Surface image limits still apply; local file references and provider file IDs are not supported Claude inputs. |
| Audio, local image/audio files, skill input parts | Unsupported | Rejected by Claude input translation. A native tool reading a file is a separate operation. |
| Follow-up / steering | Implemented | Pushes another user message into the same query stream; validates the active turn ID. |
| Interrupt | Partial | Calls SDK `interrupt()`. If queued steering would survive, closes the query because the public SDK does not expose queued-message cancellation. |
| Root assistant text streaming | Implemented | Maps text deltas into shared assistant-text events. |
| Assistant interim/final output | Partial | Text before tool use or thinking is interim; text remaining when a response ends is final. Subagent text is always interim and nests under its delegation. |
| Tool execution | Native | Uses Claude's built-in tools under its native agent loop. Host permissions and native configuration apply. |
| Tool activity/results | Partial | Root tool calls are recorded as shared activity; Bash is a command; Edit/MultiEdit/Write/NotebookEdit are file changes; WebSearch/WebFetch are web activity; Agent/Task are delegation; Shepherd's MCP tools are application tools; other `mcp__` tools are MCP tools; remaining built-in tools (Read, Grep, TodoWrite, …) are built-in tools with their main argument. History keeps the tool name and the bounded arguments an activity is described from. Of tool results, only a Bash command's output is kept, its last 4,096 JavaScript string code units plus a truncation marker when needed, with the exit code Claude reports on a failure; other tools' results stay out. Full native SDK transcripts remain adapter-owned; surfaces do not decode native tool envelopes. No structured diff viewer. |
| Shepherd dynamic tools | Implemented | Exposes the registry through an in-process MCP server; preserves namespace, arguments, result media, and originating turn identity. Rejects results after that turn ends, including calls from background work between turns. Tools registered after the SDK process starts are picked up by reopening it before the next turn; while background tasks run, the process is kept and new tools wait. |
| External MCP configuration | Native | Claude can load native configuration. No Shepherd MCP server-management, OAuth, resource browser, or elicitation form control. |
| Tool permission decisions | Partial | `canUseTool` requests translate to allow once, deny, and session-scoped suggested permission updates when available. No arbitrary permission-rule editor. |
| Never-prompt tool policy | Implemented | Explicit bypass mode with permission flag. Structured user questions still use their own answer callback. No sandbox applies: commands and file changes run with the Shepherd host user's full access. |
| Policy profiles | Supported | `bypassPermissions` (writes any, network any, no review), `default` (asks before any action Claude's permission rules have not already allowed) and `plan` (no changes). Without a profile, no permission mode is passed and Claude's configured `defaultMode` applies. Claude's session does not record the profile, so every bootstrap states it. |
| Network restriction | Unsupported | No Claude mode blocks the network, so a policy with `network: none` refuses Claude conversations rather than running them with network access. Tool approvals do not create an OS sandbox; isolation belongs to the host. |
| `AskUserQuestion` | Implemented | Maps native questions to stable shared question IDs, validates answers, and returns answers keyed by original question text. |
| Multiple selections | Implemented | Web checkboxes return distinct selections as an array. Discord directs multiple-selection requests to the web form. |
| Custom answers, skip, abort, expiry | Implemented | Custom answers are allowed; skip denies the native question callback. Cancellation and completed/interrupted turns expire pending requests. |
| Secret-question semantics | Missing | Claude translation omits `isSecret` (treated as false); it does not claim native secret-field support. |

## Models, settings, extensions, and presentation

| Capability | Status | What Shepherd does / limit |
| --- | --- | --- |
| Model discovery and selection | Implemented | SDK `supportedModels()` translated into the shared paginated model catalog; web model picker and routed model controls. New conversations default to explicit `claude-opus-5-5`; `CLAUDE_MODEL` overrides it. Catalog exposes resolved model IDs and retains native aliases as hidden compatibility entries. Reading the native catalog starts a short-lived CLI process, so one runtime-wide copy per Claude login is reused for 10 minutes, then served while it refreshes in the background for up to 24 hours. Only the first lookup after startup, a login change, or expiry waits for the CLI. Lists from running conversations are not reused, because a project folder's `availableModels` setting can narrow them. Actual model availability is plan-dependent. |
| Reasoning effort | Partial | Passes native effort settings; model catalog supplies supported levels. New conversation metadata defaults to medium; `CLAUDE_EFFORT` overrides it. Claude does not record effort, so resumed conversations and forks use the requested effort or the host default. No global default editor in Shepherd. Not every model supports every level. |
| Instructions | Native | Shepherd selects the `claude_code` preset system prompt and adds no custom instructions; configured `CLAUDE.md` files apply. |
| User/project/local configuration | Native | Conversation queries load `settingSources: ["user", "project", "local"]`. Shepherd supplies its own per-query permission and subscription credential policy. |
| Native skills, commands, agents, hooks, plugins | Native | Native configuration can make extensions available to Claude. No claim that Shepherd exposes the complete CLI command vocabulary or manages installed extensions. |
| List/reload/enable/disable skills | Unsupported | Session omits skill catalog/config methods; core rejects calls and web controls are disabled. Native skill loading is a separate capability. |
| Custom subagent definitions / agent management | Missing | No shared definition/control API. Native subagents are enabled by default; `CLAUDE_SUBAGENTS=disabled` adds `Agent` to SDK `disallowedTools`. Their stored transcripts are merged into shared history under the delegation. |
| SDK hooks configured by Shepherd | Missing | No application hook registration API. The permission callback is implemented separately. |
| Structured JSON output schemas | Missing | No exposed SDK `outputFormat` configuration. |
| Web response formatting | Implemented | Shared Markdown, tables, code highlighting, math, and Mermaid rendering applies to normalized Claude text. |
| Generated/viewed image artifact presentation | Partial | Shared MCP tool results can contain media, but Claude root tool records do not produce the dedicated `imageView`/image-generation events used by the scoped artifact viewer. Image input previews are separate. |
| Reasoning and plan history | Partial | Root thinking blocks are saved as `reasoning` items with `form: "summary"`: Shepherd starts Claude with `--thinking-display summarized`, since thinking text is otherwise omitted, and these models return a summary of their thinking (the first 8,000 JavaScript string code units plus an omission notice when truncated; redacted thinking is skipped), and an `ExitPlanMode` plan is saved as a `plan` item before its tool activity. Thinking streams live as `reasoning` deltas under the item ID history records it with; plans appear when their tool call arrives. |
| Native diagnostic event UI | Missing | No UI for all native system events or the raw SDK message union. |
| Compiled executable | Implemented | Standalone Shepherd embeds the platform SDK executable; `CLAUDE_EXECUTABLE` can override it. Installing Shepherd does not install a `claude` CLI command on PATH. |

## Subscription limits and usage

| Capability | Status | What Shepherd does / limit |
| --- | --- | --- |
| Account allowance scope | Native | Shared by the Claude account across its conversations and other Claude surfaces. Provider selection does not create a per-conversation allowance. |
| Turn token usage | Partial | `last` is the final model request of the turn (from stream usage), so it reflects context fill rather than the turn aggregate. `total` maps SDK model usage. Cache reads and writes are reported separately. Reasoning output is `null` (not reported) for `last`, and for `total` unless every model row reports thinking tokens. These values are not a subscription usage percentage. |
| Cumulative conversation accounting | Partial | Live results report totals for the running query. A resumed conversation reports the last request's usage from its transcript and no total. There is no durable lifetime-cost ledger. |
| Context-window percentage | Implemented | `contextWindow` comes from the SDK model usage for the conversation model, so the web UI shows the shared context percentage. |
| Subscription `rate_limit_event` | Implemented | Native adapter forwards allowance events to one host account collector. Maps status, optional utilization/reset times and extra usage flags. Account lookup and observation cannot block or fail a turn. |
| Five-hour / weekly / model/app-specific allowance display | Implemented | Selecting Claude in the existing Usage & limits panel displays normalized allowance rows. Supports canonical server rows and legacy five-hour/weekly/model fields. Missing utilization is “Usage unavailable”; reported zero is retained. |
| Limit warning/rejection and reset-time UI | Implemented | Displays reported utilization and reset times; normalized event status is not rendered separately. Labels old values, failed refreshes and passed resets as “Last known data”; never calculates zero usage from a reset time. Generic SDK result/transport errors still use the normal turn error path. |
| Refresh account limits | Partial | New host account reader uses the SDK experimental structured usage control, without a model prompt. This unstable method is isolated and validated in the Claude adapter; unsupported/failed reads retain event observations and report stale/unavailable data. Claude has no Codex-shaped `readAccountRateLimits()` method. |
| Extra usage status | Partial | Shows enabled/disabled/unknown and reported percentage. Active/status fields and observation age remain in the shared data rather than separate UI labels. Read-only: no enable/disable, billing changes, invoices or monetary estimates. |
| Cost / subscription charges / extra usage controls | Missing | No Claude billing or overage control. SDK token/cost telemetry must not be presented as the user's subscription invoice. |
| Banked resets / spend a reset | Unsupported | Claude does not implement Codex reset credits or the reset RPC. |
| Current sidebar Usage & limits | Implemented | An Agent selector in the same panel. Opens on the selected conversation provider, except pending reset recovery. Both allowances are host account data; provider choice does not allocate quota to a conversation. Reset actions appear only on Codex. |

Claude's account-wide usage scope is described in
[usage and length limits](https://support.claude.com/en/articles/11647753-how-do-usage-and-length-limits-work).
The SDK fields above were checked in the installed `sdk.d.ts`. The experimental
structured usage read was verified with a signed-in Pro account on 2026-10-10
using SDK `0.3.296` and Claude Code `2.1.296`, without submitting a model prompt.
Availability still depends on the login and installed native version. A setup-token
login may not expose account usage; failed reads return an explanatory message.
Reads coalesce across browsers, cache for 30 seconds and cap manual refreshes at
one per five seconds. Each native read has a ten-second timeout and closes its
process. Window and extra usage observations become stale after 120 seconds;
windows also become stale when their reported reset time passes. Credential or
account changes discard old allowance data. No credentials or account identifiers
are returned in the account limits response.

## Gaps and maintenance

Account limits use a provider/account-level service distinct from conversation
context. Native interpretation stays inside the Claude adapter. The account reader
is shared by all Claude sessions and its processes close on runtime shutdown.
Remaining gaps include billing controls, a stable public SDK usage contract,
and a dedicated task-management interface. Discord `!limits claude` renders the shared
allowance windows and extra usage status. Context-window capacity reporting is implemented
when the SDK provides the model window, as recorded above. Do not claim
automatic API fallback or automatic account switching.

Review this matrix when the SDK version or adapter behavior changes. Preserve the
difference between implemented controls, native configuration, missing translation,
and live verification. Account credentials, tokens, authorization codes, email,
and host-specific account identifiers must not appear in examples or evidence.

Primary implementation sources:
[session](../server/providers/claude/session.ts),
[authentication](../server/providers/claude/authentication.ts),
[account limits adapter](../server/providers/claude/account_limits.ts),
[shared account port](../server/ports/provider_services.ts),
[questions](../server/providers/claude/questions.ts),
[MCP bridge](../server/providers/claude/mcp_bridge.ts),
[background tasks](../server/providers/claude/background_tasks.ts),
[capabilities](../server/providers/claude/capabilities.ts),
[transcript decoder](../server/providers/claude/transcript.ts),
[native sessions](../server/providers/claude/native_sessions.ts),
[provider assembly](../server/runtime/provider_services.ts),
[SDK overview](https://code.claude.com/docs/en/agent-sdk/overview).

Regression evidence:
[session tests](../tests/claude_session.test.ts),
[account limits tests](../tests/claude_account_limits.test.ts),
[account API tests](../tests/web_settings.test.ts),
[authentication tests](../tests/claude_authentication.test.ts),
[background tests](../tests/claude_background_tasks.test.ts),
[architecture tests](../tests/architecture_boundaries.test.ts).
