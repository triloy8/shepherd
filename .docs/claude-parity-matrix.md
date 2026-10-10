# Claude parity matrix

Reviewed: 2026-10-10 against `e092e6e` on `feat/multiple-agent-providers`.
Installed baseline: `@anthropic-ai/claude-agent-sdk` **0.3.296**, bundled/native
Claude Code **2.1.296**. This is an inventory of Shepherd's Claude adapter and
subscription support, not a complete inventory of every SDK export or a promise
of support for all Claude Code terminal commands.

See the [Codex parity matrix](codex-parity-matrix.md) for app-server RPC coverage,
the [surface parity matrix](surface-parity-matrix.md) for Discord/web workflows,
and the [provider architecture audit](../docs/architecture/providers.md) for
dependency boundaries. Setup instructions are in the [README](../README.md).

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
desktop viewports. No live response/tool execution or live quota-exhaustion
test has been recorded for this branch. Installed types are the source of truth
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
| Account identity/plan in the web UI | Missing | SDK exposes `accountInfo()`, but Shepherd has no Claude account panel. The host verification above is not a UI feature. |
| Choose different Claude accounts per conversation | Missing | Provider selection is per conversation; Claude credentials come from the host process and configuration. |

For subscription availability, see Anthropic's dated
[SDK subscription guidance](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan).
For saved logins and token setup, see
[Claude Code authentication](https://code.claude.com/docs/en/authentication).
The subscription support page currently permits usage against subscription
limits; SDK overview/quickstart pages still contain more restrictive third-party
login guidance. This matrix records implemented behavior and the verified host
login, not a blanket approval for distributing a subscription login product.

## Conversations, history, and lifecycle

| Capability | Status | What Shepherd does / limit |
| --- | --- | --- |
| Select Claude for a new conversation | Implemented | Web Agent picker and core/API `provider: "claude"`. Codex remains the default. Discord has no Claude creation picker. |
| Preserve provider identity | Implemented | Explicit persistent thread/provider binding; resume and fork retain the provider. No in-place provider migration. |
| Start a Claude session | Implemented | SDK `query()` with a native session ID. Shepherd records its thread metadata before the native transcript is materialized. |
| Continue across turns | Implemented | Keeps the query/input stream open; resumes the native session when a query must restart. |
| Resume after process restart | Implemented | Uses saved native ID and cwd. Preserve both Shepherd snapshots/provider bindings and Claude's native transcripts. Interrupted saved turns remain interrupted. |
| Fork | Implemented | SDK `forkSession()` for materialized sessions; a fresh ID for a thread not yet materialized. Rejects a source with an in-progress turn; overrides do not mutate the source. |
| Rename, archive, restore | Implemented | Shepherd metadata operations. They do not constitute a wrapper for every native Claude session mutation API. |
| Stored thread listing/filtering/pagination | Partial | Lists Shepherd-created snapshots, with name/preview search, cwd/archive/provider/source filters and sorting. Does not import arbitrary existing CLI sessions. Listings are live views, not a frozen snapshot. |
| Loaded conversation listing | Implemented | Application-owned loaded sessions; catalog discovery queries are also closed on shutdown. |
| Read turns/items and replay history | Implemented | Normalized persisted turns/items and pagination. Native session storage remains needed for continued model context. |
| Detach from a surface | Implemented | Releases surface attachment without stopping agent work. |
| Background work | Partial | Tracks non-ambient background task counts using snapshots or older task edges; retains the query and records later root responses/questions as wake turns. No task-management dashboard. |
| Change model/cwd/policy/effort | Partial | Restarts/resumes the query when needed. Settings changes wait for background work; cwd changes wait for active work. |
| Shutdown / query failure | Implemented | Closes owned queries, settles pending approvals, records interrupted/failed turns and clears runtime activity. |
| Manual context compaction | Unsupported | Hidden in capability-aware web controls; adapter rejects the operation. Native automatic context management is separate. |
| Conversation revert | Unsupported | No Claude translation of Shepherd's turn-based revert operation. |
| File checkpointing / file rewind | Missing | SDK facilities are not enabled or wrapped. Neither fork nor conversation history implies file rollback. |
| Ephemeral threads | Unsupported | Adapter rejects the request. |
| Durable native transcript import/export | Missing | No general session import/export interface or external-storage implementation. |

## Input, execution, approvals, and questions

| Capability | Status | What Shepherd does / limit |
| --- | --- | --- |
| Text and image-only prompts | Implemented | Converts shared input into SDK user messages; text is optional for image prompts. |
| Image input | Partial | Inline PNG/JPEG/GIF/WebP data URLs and HTTP(S) image URLs. Surface image limits still apply; local file references and provider file IDs are not supported Claude inputs. |
| Audio, generic files, skill/mention input parts | Unsupported | Rejected by Claude input translation. A native tool reading a file is a separate operation. |
| Follow-up / steering | Implemented | Pushes another user message into the same query stream; validates the active turn ID. |
| Interrupt | Partial | Calls SDK `interrupt()`. If queued steering would survive, closes the query because the public SDK does not expose queued-message cancellation. |
| Root assistant text streaming | Implemented | Maps text deltas into shared assistant-text events. |
| Assistant commentary/final output | Partial | Root messages with tool use are marked commentary; other root text is final. Nested subagent text is not a separate transcript. |
| Tool execution | Native | Uses Claude's built-in tools under its native agent loop. Host permissions and native configuration apply. |
| Tool activity/results | Partial | Root tool calls are recorded as shared activity; Bash is command activity, Edit/Write are file changes, other tools are MCP/tool activity. Not a detailed native terminal or diff viewer. |
| Shepherd dynamic tools | Implemented | Exposes the registry through an in-process MCP server; preserves namespace, arguments, result media, and originating turn identity. Rejects results after that turn ends. |
| External MCP configuration | Native | Claude can load native configuration. No Shepherd MCP server-management, OAuth, resource browser, or elicitation form control. |
| Tool permission decisions | Partial | `canUseTool` requests translate to allow once, deny, and session-scoped suggested permission updates when available. No arbitrary permission-rule editor. |
| Never-prompt tool policy | Implemented | Explicit bypass mode with permission flag. Structured user questions still use their own answer callback. |
| Other shared approval policies | Partial | Maps to Claude's default native permission mode. Does not reproduce every Codex policy distinction; granular policy objects are rejected. |
| Restricted sandbox modes | Unsupported | Only unset or `danger-full-access` is accepted. Tool approvals do not create an OS sandbox; isolation belongs to the host. |
| `AskUserQuestion` | Implemented | Maps native questions to stable shared question IDs, validates answers, and returns answers keyed by original question text. |
| Multiple selections | Implemented | Web checkboxes return distinct selections as an array. Discord directs multiple-selection requests to the web form. |
| Custom answers, skip, abort, expiry | Implemented | Custom answers are allowed; skip denies the native question callback. Cancellation and completed/interrupted turns expire pending requests. |
| Secret-question semantics | Missing | Claude translation sets `isSecret=false`; it does not claim native secret-field support. |

## Models, settings, extensions, and presentation

| Capability | Status | What Shepherd does / limit |
| --- | --- | --- |
| Model discovery and selection | Implemented | SDK `supportedModels()` translated into the shared paginated model catalog; web model picker and routed model controls. Actual model availability is plan-dependent. |
| Reasoning effort | Partial | Passes native effort settings; model catalog supplies supported levels. Thread metadata defaults to high. Not every model supports every level. |
| Base/developer instructions | Partial | Appended to the Claude Code preset system prompt. No separate Claude developer-message role is created. |
| User/project/local configuration | Native | Conversation queries load `settingSources: ["user", "project", "local"]`. Shepherd supplies its own per-query permission and subscription credential policy. |
| Native skills, commands, agents, hooks, plugins | Native | Native configuration can make extensions available to Claude. No claim that Shepherd exposes the complete CLI command vocabulary or manages installed extensions. |
| List/reload/enable/disable skills | Unsupported | Adapter's skill catalog/config methods reject calls; web controls are hidden. Native skill loading is a separate capability. |
| Custom subagent definitions / agent management | Missing | No shared definition/control API or distinct nested-agent transcript. Native agent/background behavior may still occur. |
| SDK hooks configured by Shepherd | Missing | No application hook registration API. The permission callback is implemented separately. |
| Structured JSON output schemas | Missing | No exposed SDK `outputFormat` configuration. |
| Web response formatting | Implemented | Shared Markdown, tables, code highlighting, math, and Mermaid rendering applies to normalized Claude text. |
| Generated/viewed image artifact presentation | Partial | Shared MCP tool results can contain media, but Claude root tool records do not produce the dedicated `imageView`/image-generation events used by the scoped artifact viewer. Image input previews are separate. |
| Raw thinking / native diagnostic event UI | Missing | No full rendering of thinking blocks, all native system events, or the raw SDK message union. |
| Compiled executable | Implemented | Standalone Shepherd embeds the platform SDK executable; `CLAUDE_EXECUTABLE` can override it. Installing Shepherd does not install a `claude` CLI command on PATH. |

## Subscription limits and usage

| Capability | Status | What Shepherd does / limit |
| --- | --- | --- |
| Account allowance scope | Native | Shared by the Claude account across its conversations and other Claude surfaces. Provider selection does not create a per-conversation allowance. |
| Turn token usage | Partial | Maps SDK result usage into last/total input, cache, output and available model-usage thinking values. These values are not a subscription usage percentage. |
| Cumulative conversation accounting | Partial | Snapshot stores the latest mapped result; it does not implement a separate durable lifetime-cost ledger across resumed SDK queries. |
| Context-window percentage | Missing | Adapter does not populate the shared `modelContextWindow` field, so the UI cannot calculate a reliable percentage. Token figures alone do not prove remaining context. |
| Subscription `rate_limit_event` | Missing | Installed SDK types expose status, optional utilization/reset times, window type and overage fields. Claude's consume loop currently ignores this event. |
| Five-hour / weekly / model-specific allowance display | Missing | No provider/account snapshot store, Claude limits endpoint, or Claude limits UI. Optional or absent utilization must never be displayed as zero usage. |
| Limit warning/rejection and reset-time UI | Missing | No structured rate-limit presentation. Generic SDK result/transport errors still fail the turn through the normal error path. |
| Refresh account limits | Unsupported | Claude `readAccountRateLimits()` rejects the current Codex-shaped contract. SDK model discovery is not a quota refresh. |
| Cost / subscription charges / extra usage controls | Missing | No Claude billing or overage control. SDK token/cost telemetry must not be presented as the user's subscription invoice. |
| Banked resets / spend a reset | Unsupported | Claude does not implement Codex reset credits or the reset RPC. |
| Current sidebar Usage & limits | Codex only | Both the endpoint and UI use the host Codex control session, regardless of the selected conversation. Its copy identifies the Codex account. It is not Claude quota reporting. |

Claude's account-wide usage scope is described in
[usage and length limits](https://support.claude.com/en/articles/11647753-how-do-usage-and-length-limits-work).
The SDK fields above were checked in the installed `sdk.d.ts`; their optional
values and event-driven delivery do not guarantee a complete fresh account
snapshot before a conversation runs.

## Gaps and maintenance

Account limits are the next proposed architectural area, not implemented work:
use a provider/account-level service distinct from conversation context. Normalize
native events inside the Claude adapter, aggregate them outside conversations,
and show unavailable/stale data explicitly. Keep Codex reset actions provider-specific.
Do not claim automatic API fallback or automatic account switching.

Review this matrix when the SDK version or adapter behavior changes. Preserve the
difference between implemented controls, native configuration, missing translation,
and live verification. Account credentials, tokens, authorization codes, email,
and host-specific account identifiers must not appear in examples or evidence.

Primary implementation sources:
[session](../server/providers/claude/session.ts),
[authentication](../server/providers/claude/authentication.ts),
[questions](../server/providers/claude/questions.ts),
[MCP bridge](../server/providers/claude/mcp_bridge.ts),
[background tasks](../server/providers/claude/background_tasks.ts),
[capabilities](../server/providers/capabilities.ts),
[snapshot storage](../server/storage/claude_thread_store.ts),
[provider assembly](../server/runtime/provider_services.ts),
[SDK overview](https://code.claude.com/docs/en/agent-sdk/overview).

Regression evidence:
[session tests](../tests/claude_session.test.ts),
[authentication tests](../tests/claude_authentication.test.ts),
[background tests](../tests/claude_background_tasks.test.ts),
[architecture tests](../tests/architecture_boundaries.test.ts).
