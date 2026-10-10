# Provider abstraction

## Status and decisions

Proposed on 2026-10-10 and revised after the design audit, for implementation on
[PR #90](https://github.com/triloy8/shepherd/pull/90)
(`feat/multiple-agent-providers`). This is the target contract, not a description
of shipped behavior. [Architecture](architecture.md) describes the current code.
Update maintained references with each landed workflow; archive this proposal
when the migration is complete.

The goal is a completely provider-neutral application boundary. Choosing Claude
or Codex changes the adapter and available capabilities, not the conversation,
interaction, rendering, history, or account-limit model. A third adapter must not
require provider-specific branches in core or surfaces.

Decisions:

- Native protocols, SDK types, credentials, native response values, and legacy
  snapshot decoding belong to `server/providers/<id>/`.
- Codex history stays in app-server. Its adapter projects native history on read;
  Shepherd does not persist a second Codex transcript.
- Live and recovered items use the same typed model. Recoverable information is
  preserved; unavailable and transient information is declared explicitly.
- Interaction option IDs are Shepherd-issued opaque tokens. Native replies stay
  private in an adapter-owned token-to-response map.
- Optional ports define application capabilities. Security and input constraints
  are declared separately, validated by core, and enforced by the adapter.
- Web API v2 gets a temporary v1 translation boundary for the current browser.
  The translation is surface compatibility code, not the application model.
- Attachment extraction from existing Claude snapshots is deferred. The generic
  protocol carries asset references now; private legacy storage can remain inline.

## Problem and scope

PR #90 introduces two providers, but shared history still uses Codex item names.
Claude stores root tools as `mcpToolCall` records; surfaces interpret native item
names and approval methods. Completed tool rows lose output and diffs. Stream
consumers now use the neutral assistant-text kind, with native-method fallbacks
for older events. Account limits still use two response shapes.

This design replaces those leaks across the whole boundary, including creation,
bootstrap, settings, catalogs, thread reads, revert responses, lists, inputs,
interactions, live events, and history. It retains explicit provider bindings,
shared routing, structured questions, and context/token telemetry.

Non-goals: changing existing thread IDs, switching provider within a conversation,
context handoff, filesystem rollback, a general execution graph, event sourcing,
a durable command receipt log, and a Shepherd-owned Codex transcript. Nesting and
background correlation below are presentation/lifecycle relations, not a new
agent orchestration engine.

## Ownership and invariants

```text
Surfaces -> core -> provider ports and shared/protocol
Provider adapters -> provider ports and shared/protocol
Storage -> storage ports and shared/protocol
Runtime composition -> core, adapters, storage
```

1. Core and surfaces never decode native payloads or branch on provider identity,
   tool names, native item names, native approval values, or native RPC methods.
   Provider selection and lookup use an injected registry. Display labels may
   contain native tool names as opaque text; they are not discriminators.
2. Adapters normalize both native history and native events using the same
   mapper. Neither adapter imitates another provider's wire format.
3. Public IDs are opaque. Native IDs and credential/account identifiers remain
   private. Item identity is stable within a thread across reads and restarts.
4. A capability promises a Shepherd operation with documented semantics. An
   adapter may implement rename/archive using its metadata store. It must not
   claim sandboxing, permission enforcement, or file rollback it cannot provide.
5. Unsupported operations or settings fail before work starts. The adapter also
   validates them when called directly. Missing ports are never methods that throw.
6. Persisted and live projections have the same discriminated union and available
   semantic fields. Missing provider data is null or explicitly incomplete;
   adapters never invent exit codes, timestamps, diffs, or recovered plan steps.
7. All generic output is bounded after serialization. Truncation is visible and
   does not change the original input submitted to the model or the native context.
8. Diagnostic raw frames stay adapter-local and out of ordinary conversation
   events. Recoverable warnings and final errors use typed neutral events.

## Registry, inputs, requests, and records

`ProviderId` is a validated registry key, not a closed `"codex" | "claude"` union.
The runtime registers descriptors, session factories, history access, model
catalogs, account readers, and shutdown hooks. Public provider enumeration returns
`{ id, displayName, capabilities }`; picker options come from this enumeration.
Neither UI nor core contains a provider switch. Bindings remain immutable and
legacy prefix recognition remains confined to runtime composition.

New neutral `ConversationInput` replaces native-shaped `UserInput` at the port:

```ts
type ProviderId = string; // validated against the injected registry
type InputPart =
  | { type: "text"; text: string }
  | { type: "asset"; assetId: string; media: "image" | "audio" | "file" }
  | { type: "skill"; name: string; referenceId: string }
  | { type: "mention"; name: string; referenceId: string };
type ConversationInput = InputPart[];
interface ThreadSettings {
  cwd: string;
  model: string | null;
  effort: string | null;
  approvalMode: ApprovalMode;
  sandboxMode: SandboxMode;
}
interface ThreadRecord {
  id: string;
  provider: ProviderId;
  name: string | null;
  preview: BoundedText;
  cwd: string;
  createdAt: number | null; // epoch seconds
  updatedAt: number | null;
  archived: boolean;
}
interface ThreadBootstrapInfo {
  thread: ThreadRecord;
  sessionId: string;
  settings: ThreadSettings;
  capabilities: ProviderCapabilities;
}
```

Asset IDs resolve through a generic asset port. It supplies authorized, bounded
media bytes to the selected adapter and scoped URLs to surfaces. It does not
expose arbitrary remote fetches, host paths, native file IDs, or data URLs in
items/events. Reference IDs resolve through shared skill/mention ports; the
adapter alone builds native input annotations. Unsupported media/reference types
are rejected before submitting any part of a request. New input limits reject
oversized input; they never silently truncate a user's prompt or attachment.
Existing surface image limits remain unchanged.

Create/resume/fork requests contain a provider selection where applicable, cwd,
model, effort, approvalMode, sandboxMode, and instructions
`{ base: string | null, additional: string | null }`. The adapter documents how
instructions are combined; no shared contract claims a native developer role.
Resume/fork cannot change provider. Native config overrides, personality,
modelProvider, and ephemeral requests are removed in v2. Operational defaults
stay adapter-local; no opaque native configuration bag crosses the shared port.

Boundary migration inventory:

| Current boundary | Target |
| --- | --- |
| Create/resume/fork, bootstrap | Neutral settings and instructions above; no native model-provider field |
| `ThreadRecord`, stored summaries | Same metadata fields, including provider; no open index signature |
| `readThread(includeTurns)` | Metadata-only read plus paginated turns/items in v2; the v1 translator preserves `includeTurns` with bounded pagination or an explicit size error |
| Revert response | Neutral thread metadata plus existing opaque history cursors; caller fetches new history |
| Thread/model/effort state | Model and effort IDs from the neutral catalog; no `modelProvider` |
| Model summary | Display fields and supported effort IDs/default; remove `supportsPersonality` |
| Stored-thread filters | Provider IDs, cwd, archived, search, created/updated order; remove native `modelProviders`, `sourceKinds`, `useStateDbOnly`, and `recency_at` in v2 |
| Turn/item pages | Typed `ConversationTurn`/`ConversationItem` and opaque cursors, including size-limited partial item pages |
| User input and image decoration | Neutral input/asset references; scoped asset URLs are surface decorations |
| Limits/resets | Neutral DTO and optional reset port below |

The v1 translator explicitly supports existing built-in-client behavior. Native
filters without a neutral meaning are either translated inside the relevant
adapter compatibility entry point or rejected with a documented version error;
they are not forwarded into generic core as native settings. Inventory external
clients before removing v1, not before deciding the core model.

## Conversation items

New module: `shared/protocol/conversation_items.ts`.

```ts
type ItemStatus = "in_progress" | "completed" | "failed" | "interrupted" | "declined" | "unknown";
interface BoundedText {
  text: string;
  truncated: boolean;
  totalBytes: number | null; // original UTF-8 bytes, when known
}
interface ItemBase {
  id: string;
  turnId: string;
  parentItemId: string | null; // subagent containment only
  relatedItemIds: string[];   // e.g. a stop/monitor call targeting background work
  status: ItemStatus;
  startedAt: number | null;
  completedAt: number | null;
  error: BoundedText | null;
  recovery: "complete" | "partial" | "transient";
  unavailableFields: string[];
  omittedEntries: number;
  detailAsset: AssetReference | null; // optional full text/detail outside the preview
  version: { epoch: string; revision: number }; // runtime projection version
}
type ConversationItem = ItemBase & (
  | { type: "user_message"; content: HistoryInputPart[] }
  | { type: "assistant_message"; text: BoundedText; phase: "commentary" | "final_answer" | null }
  | { type: "reasoning"; summary: BoundedText[] }
  | { type: "plan"; text: BoundedText | null; steps: Array<{ text: BoundedText; status: "pending" | "in_progress" | "completed" }> }
  | { type: "command"; command: BoundedText; description: BoundedText | null; cwd: string | null;
      actions: Array<{ kind: "read" | "search" | "list" | "other"; path: string | null; query: BoundedText | null }>;
      output: BoundedText | null; exitCode: number | null; durationMs: number | null;
      execution: "foreground" | "background" | "unknown"; taskId: string | null }
  | { type: "file_change"; changes: Array<{ path: string; kind: "add" | "update" | "delete" | "move";
      movePath: string | null; diff: BoundedText | null; additions: number | null; deletions: number | null;
      applied: boolean | null }> }
  | { type: "file_read"; reads: Array<{ path: string; offset: number | null; limit: number | null }>; output: BoundedText | null }
  | { type: "search"; queries: BoundedText[]; paths: string[]; output: BoundedText | null }
  | { type: "web"; action: "search" | "open_page" | "find_in_page" | "other";
      queries: BoundedText[]; url: string | null; pattern: BoundedText | null; output: BoundedText | null }
  | { type: "tool"; source: "mcp" | "shepherd" | "provider"; server: string | null;
      name: string; input: BoundedText | null; output: BoundedText | null; assets: AssetReference[] }
  | { type: "subagent"; action: "spawn" | "wait" | "send" | "stop" | "resume" | "activity" | "other";
      description: BoundedText; prompt: BoundedText | null; report: BoundedText | null;
      agents: Array<{ id: string; threadId: string | null; status: ItemStatus; report: BoundedText | null }>;
      taskId: string | null }
  | { type: "image"; origin: "generated" | "viewed"; asset: AssetReference; prompt: BoundedText | null }
  | { type: "notice"; kind: "compaction" | "review" | "hook" | "wait" | "warning" | "other"; text: BoundedText }
);
type HistoryInputPart =
  | { type: "text"; text: BoundedText }
  | Exclude<InputPart, { type: "text" }>;
interface AssetReference {
  id: string;
  media: "image" | "audio" | "file";
  mimeType: string | null;
  name: string | null;
  availability: "available" | "unavailable";
}
```

`tool.input`/`output` are display text, not machine-readable native objects.
Surfaces never parse them. Unknown work becomes a `tool` with an opaque display
name and bounded available input/output, never a dropped record. Media results
use assets; they are not flattened into base64 or silently discarded.

One native call normally yields one item. Codex commands remain `command` items,
with semantic `actions` for friendly read/search summaries: output, status,
command, and exit information are preserved even for compound commands. Pure
native read/search tools use the corresponding item types. Adapters do not split
or merge unrelated records merely to make the two providers look identical.

`ConversationTurn` retains id, status, error, started/completed times, duration,
and an item page. Status includes completed/interrupted/failed/in_progress.
`itemsView` describes summary/full/not_loaded detail, not pagination completeness.
Each returned turn has `itemsNextCursor`; full detail can still require paging.
Items across turns return `{ turnId, item }` with forward/backward opaque cursors.
Omissions, unknown statuses, and unavailable timestamps are preserved explicitly.

### Identity and recoverability

Native item IDs map deterministically to public IDs; synthesized IDs are derived
from stable native identity plus a role/index, with distinct namespaces to avoid
collisions. Scope all lookups by thread. Forks retain historical item identity
inside the new thread; a global item key is `(threadId, itemId)`.

Recoverable fields use one mapper for live and history. If a timestamp is absent
from persisted native data, keep the canonical field null in both paths; UI
elapsed-time observations belong to runtime display state. Do not invent a
persisted timestamp from the time a history page is read.

An adapter declares recoverability per item, not per provider-specific renderer.
Codex `turn/plan/updated` produces a deterministic turn-plan item with
`recovery: "transient"` unless native history actually contains that plan state.
A native `plan` item is a separate text-plan item; never assume it contains the
update's steps. Transient items appear in an explicitly session-only work view;
they disappear on process restart and are not represented as durable history.
Partial recovered items mark unavailable fields, including older Claude results.

### Size limits and assets

All byte sizes below apply to UTF-8 JSON serialization, including escaping.
`boundText` respects Unicode boundaries, records original UTF-8 size, and uses
head/tail previews for output. Caps apply before persistence and publication.

| Value | Maximum |
| --- | --- |
| Entire serialized item | 48 KiB |
| Output/report/text/diff field | 16 KiB; command/tool outputs retain the last 2 KiB |
| Combined diffs per item | 24 KiB; counts computed before truncation |
| Tool input, prompt, command | 8 KiB each |
| Entire serialized interaction | 64 KiB |
| Bridge/SSE frame, including envelope and surface decoration | 96 KiB |
| History/list JSON response | 1 MiB |
| Delta text | 4 KiB; split on Unicode boundaries |
| Path, URL, ID, label; array entries | 4 KiB per string; at most 100 entries per array, also subject to aggregate budgets |

Array truncation records `omittedEntries`; text fields always use `BoundedText`.
If metadata alone exceeds an item budget, return a minimal typed summary with
unavailable fields and fetchable detail where supported. An interaction must
explain the full effect of each offered grant. If permission details cannot fit,
provide paged neutral detail and disable grant actions until available, or offer
only deny/cancel; never approve from a misleading truncated preview.

Large assistant/user history text has a bounded preview and an optional generic
full-text asset accessed through the asset port; the adapter may back it by
native storage. Assets preserve images and other large media outside events and
pages. Missing files or unsupported native retrieval give an unavailable asset,
not an arbitrary filesystem/remote fetch. Keep existing scoped image authorization.
Private legacy snapshots may still contain inline input images; public projection
registers stable asset IDs without sending the data URL back in a history page.

Limit at the item, collection, and encoded-frame levels. A page stops before its
byte budget and returns a continuation, including within a turn. It must progress
even when one native record is huge. The web adapter's final serialization check
remains a defense, but ordinary maximum-sized items/interactions must fit without
`event_too_large`. Core replay is byte-bounded as well as count-bounded.

Streaming accumulators keep bounded head/tail buffers and byte counts. Once a
field exceeds its preview budget, stop append deltas for that field and publish
bounded replacements, coalesced at most once per 100 ms. Subsequent chunks update
the retained tail. Final state contains the authoritative bounded preview. Never
accumulate unlimited output merely to truncate it at completion.

## Events, snapshots, and reconciliation

Use a discriminated `BridgeEvent` union with typed payloads, retaining opaque
event IDs, thread/session IDs, and timestamp. Each projection session has a fresh
epoch and monotonically increasing sequence. Item revisions are monotonic within
that epoch; they are not native revisions or a persisted Codex event log.

| Event | Payload/behavior |
| --- | --- |
| `item.started`, `item.updated`, `item.completed` | Full bounded `{ item }`; completed means a terminal work state |
| `item.delta` | `{ itemId, turnId, epoch, baseRevision, revision, field, index, offsetBytes, delta }`; index is required for reasoning summary blocks, null for text/output |
| `interaction.requested`, `.decided`, `.applied`, `.failed`, `.expired` | Neutral request/record IDs and lifecycle; never native responses or secret answers |
| `turn.started` | Turn ID |
| `turn.completed` | Turn ID and `status: "completed" \| "interrupted"`; turn closure does not close background work |
| `turn.failed` | Turn ID and typed bounded error |
| `thread.status.changed` | `{ activeTurnId, backgroundTaskCount, state: "idle" \| "active" \| "waiting" \| "error", waitingFor: "approval" \| "user_input" \| null }` |
| `thread.*`, token/context usage, `session.started` | Existing neutral meanings with typed payloads |
| `session.warning`, `session.error`, `session.limit.context` | Bounded neutral message, error code and retryable flag; no native method field |

Remove `turn.activity`, native `turn.notification`, completed-message and image
events; items replace them. Retry warnings never fail a turn. Final provider
errors retain the distinct session/turn/item scopes and do not mark unrelated
work failed. Retain revert history invalidation and handle recovery.

Each bridge envelope adds `epoch` and `sequence`. A generic core projection
assigns those values and item revisions in one serialized publication queue;
adapters supply normalized mutations, not independently competing revision clocks.
`GET /api/v2/conversations/:id/snapshot` atomically returns state, pending
interactions and the first history page with `{ epoch, throughSequence,
historyRevision }`. Further history pages retain that history revision. The core
queue owns snapshot assembly and lifecycle changes as well as items.
Native history supplies recovered terminal work; active work and session-only
overlays come from that projection. Hydration subscribes before
loading native history. If an overlapping native read cannot be ordered safely,
retry/reconcile with full item state or request resync; do not append buffered
deltas to native text that may already contain them. A native read never overwrites
newer known active projection state. No database lock is held across SDK waits.

Clients open the stream before fetching the snapshot, buffer events, apply the
snapshot, then replay only events after `throughSequence` in that epoch. Ignore
older/equal item revisions. Apply a delta only when baseRevision and byte offset
match; otherwise refresh the item/snapshot. Duplicate deltas are harmless.
Replacement events supersede streamed fragments. On epoch change, clear runtime
revisions/replay cursors and restore stable item IDs from history. History revision
changes invalidate removed turns and their pending pages so revert cannot restore
stale work. Unknown/expired cursors trigger this same generic recovery.

Text phases may be null while streaming. Completion sets the adapter's confirmed
phase; interruption must terminalize emitted text/work or mark state unknown.
These ordering/recovery requirements are contract-test gates for both adapters.

## Interactions

New module: `shared/protocol/interactions.ts`. Options express application intent;
they never contain native decision values or arbitrary provider response JSON.

```ts
type PermissionScope = "once" | "turn" | "session" | "persistent";
interface PermissionDetails {
  cwd: string | null;
  filesystem: Array<{ path: string; access: "read" | "write" }>;
  network: Array<{ host: string | null; access: "allow" | "deny" }>;
  commands: Array<{ match: BoundedText; scope: PermissionScope }>;
  explanation: BoundedText | null;
}
interface InteractionRequest {
  id: string;
  threadId: string;
  turnId: string | null;
  itemId: string | null;
  kind: "command" | "file_change" | "permissions" | "tool" | "user_input";
  title: string;
  item: ConversationItem | null;
  reason: BoundedText | null;
  permissions: PermissionDetails | null;
  options: Array<{
    id: string; // opaque Shepherd token, bound to this request/session
    label: string;
    intent: "allow" | "deny" | "cancel" | "submit" | "other";
    scope: PermissionScope | null;
    effect: PermissionDetails | null; // especially persistent rules and network amendments
  }>;
  questions: UserQuestionRequest | null;
}
interface InteractionReply {
  optionId: string;
  answers?: UserQuestionAnswers;
  reason?: string;
}
interface InteractionRecord extends InteractionRequest {
  sessionId: string;
  status: "pending" | "decided" | "applied" | "failed" | "expired";
  selectedOptionId: string | null;
  selectedIntent: "allow" | "deny" | "cancel" | "submit" | "other" | null;
  createdAt: string;
  updatedAt: string;
}
```

The adapter retains each token's exact native reply (string, object, grant, or
callback result). Core validates request/thread/session ownership, offered token,
question answers, and pending status before atomically claiming a decision. It
uses intent/scope, never substring matching on an option ID. Invalid answers leave
the request pending. Answers/reply secrets are not stored in records/events/logs.

The adapter validates again and resolves at most once. Withdrawal, abort, turn
end for turn-bound requests, and session shutdown expire pending requests. An
unbound background request must be assigned to a wake turn before being exposed.
Expired/decided requests cannot be resurrected by late SDK callbacks. Concurrent
surface decisions have one winner. Application failure records a failed outcome;
it does not authorize automatic retry of an uncertain native permission response.
An applied denial still has `selectedIntent: "deny"`; applied is delivery state.

Surfaces render command/diff and permission effects from shared fields. Persistent
changes are clearly distinguished from one-time grants. Discord must not infer
an approval default from provider IDs or silently select an allow option. If it
cannot present the request completely, it offers a link to the full form plus
explicit deny/cancel. Question skip is explicit; no preselected answer is submitted.

## Provider ports and capabilities

Required session operations remain initialization, thread start/resume, turn
start/interrupt, response delivery, cwd change, events, and shutdown. History and
catalog are provider services usable without a live conversation. Account reads
also stay outside sessions. Optional workflows use optional ports consistently.

```ts
interface ProviderSession {
  readonly provider: ProviderId;
  readonly sessionId: string;
  readonly events: AgentEvents;
  readonly activeTurnId: string | null;
  readonly backgroundTaskCount: number;
  initialize(): Promise<void>;
  startThread(request: CreateThreadRequest): Promise<ThreadBootstrapInfo>;
  resumeThread(threadId: string, request: ResumeThreadRequest): Promise<ThreadBootstrapInfo>;
  startTurn(input: TurnInput): Promise<string>;
  interruptTurn(turnId?: string): Promise<void>;
  respond(requestId: string, reply: InteractionReply): Promise<void>;
  setCwd(cwd: string): Promise<void>;
  stop(): Promise<void>;
  readonly steering?: { steer(input: ConversationInput, turnId: string): Promise<string> };
  readonly fork?: { fork(threadId: string, request: ForkThreadRequest): Promise<ThreadBootstrapInfo> };
  readonly compaction?: { compact(threadId: string): Promise<void> };
  readonly revert?: { revertBefore(threadId: string, turnId: string): Promise<RevertThreadResponse> };
}
interface TurnInput {
  input: ConversationInput;
  approvalMode?: ApprovalMode;
  model?: string;
  cwd?: string;
  effort?: string;
}
type ApprovalMode = "provider_default" | "review_sensitive" | "review_all" | "bypass";
type SandboxMode = "read_only" | "workspace_write" | "unrestricted";
interface ProviderCapabilities {
  fork: boolean;
  steering: boolean;
  compact: boolean;
  revert: boolean;
  skills: { list: boolean; configure: boolean };
  resets: boolean;
  questions: boolean;
  backgroundWork: boolean;
  inputKinds: Array<InputPart["type"]>;
  assetMedia: Array<AssetReference["media"]>;
  approvalModes: ApprovalMode[];
  sandboxModes: SandboxMode[];
}
```

`ProviderServices` owns history, models, optional skills discovery/configuration,
and an optional account reader with optional resets. Derive fork/steer/compact/
revert/skills/reset capability flags from actual ports. Descriptors also declare
supported input media/reference kinds, approval modes, sandbox modes, question
support, and background-work support. Per-model effort options remain catalog
information. Capabilities may narrow for session/account/model constraints; refresh
on settings change. Core and direct adapter calls reject unavailable settings.

Approval semantics: provider_default uses documented native behavior; review_sensitive
requires native permission checks for sensitive work; review_all promises a review
of every supported side-effecting tool; bypass disables interactive tool approval,
not user questions. Declare a mode only when enforceable. Native granular policy
objects are not generic approval modes. Existing `untrusted` and `on-request` v1
values are translated and documented per adapter; do not present them as identical
security guarantees. Unrestricted means no sandbox guarantee, not no permission
questions. Claude advertises only unrestricted sandboxing until a real constrained
execution boundary exists. Filesystem rollback is not implied by conversation revert.

## Background work and nesting

Adapters retain a private native-task-to-public-task/item map. A launch receipt
updates execution mode and taskId, not terminal status. Task completion, failure,
kill, or verified cancellation closes the work item, possibly after its originating
turn ends. Updates continue to carry the original turnId. A root response/question
between turns creates a wake turn; child progress alone does not manufacture one.

A generic reducer accepts later revisions for background items in completed turns.
Turn completion finalizes foreground work only. Shutdown/interruption explicitly
state which work was canceled and which outcome remains unknown. Restart loses
process-local tracking: recover native task state if available, otherwise mark
saved unfinished work interrupted/unknown with partial recovery; never claim a
background command succeeded merely because its launch call returned.

Ambient watchers are excluded from activity/restart guards. Non-ambient work and
pending interactions block settings changes/restart as appropriate. Queued steering
must not execute after a confirmed cancellation; use native cancellation when
available, otherwise close the transport and recover uncertain work explicitly.

Subagent containment uses parentItemId; control/monitor relations use relatedItemIds.
Multiple agents per collaboration call retain their individual identities/statuses.
Public nesting never depends on native thread prefixes. Parents absent from a
history page are loaded by item lookup or represented as unavailable ancestors;
children must not disappear because the parent is on another page.

## Account limits

Extend the current neutral DTO to carry both adapters' information. All fields
below are typed shared data; no native JSON escape hatch is allowed.

```ts
interface AccountLimitWindow {
  id: string;
  groupId: string | null;
  label: string;
  subtitle: string | null;
  durationMinutes: number | null;
  usedPercent: number | null;
  resetsAt: number | null;
  status: "available" | "warning" | "limited" | null;
  observedAt: number;
  stale: boolean;
}
interface ProviderAccountLimits {
  provider: ProviderId;
  account: { plan: string | null; authentication: "subscription" | "api" | "unknown"; signedIn: boolean };
  availability: "available" | "unavailable" | "not_applicable";
  source: "provider" | "events" | "none";
  checkedAt: number | null;
  stale: boolean;
  ordinaryUsageAllowed: boolean | null; // independent account-level permission
  windows: AccountLimitWindow[];
  extraUsage: {
    enabled: boolean | null; unlimited: boolean | null; balanceLabel: string | null;
    usedPercent: number | null; active: boolean | null;
    status: "available" | "warning" | "limited" | null;
    observedAt: number; stale: boolean;
  } | null;
  spendControls: Array<{
    id: string; label: string; limitLabel: string | null; usedLabel: string | null;
    remainingPercent: number | null; resetsAt: number | null;
    reached: boolean | null; observedAt: number; stale: boolean;
  }>;
  resets: { supported: boolean; availableCount: number | null; credits: ResetCredit[] | null };
  message: BoundedText | null;
}
interface ResetCredit {
  id: string; supported: boolean;
  status: "available" | "redeeming" | "redeemed" | "unknown";
  grantedAt: number | null; expiresAt: number | null;
  title: string | null; description: BoundedText | null;
}
interface ProviderLimitResets {
  list(): Promise<ProviderAccountLimits["resets"]>;
  consume(request: { idempotencyKey: string; creditId?: string }): Promise<{
    outcome: "reset" | "already_redeemed" | "nothing_to_reset" | "no_credit";
  }>;
}
```

Codex adapter mapping: primary/secondary windows retain duration, grouped bucket
IDs, model display label and distinct quota subtitle. Null/empty bucket maps fall
back to the single snapshot. planType maps to plan. ordinaryUsageAllowed stays
independent of percentages/windows; rateLimitReachedType supplies bounded display
explanation and known affected-window/credit states. Unknown affected scope never
marks every window limited by guesswork. Credits preserve enabled/unlimited/balance
information in extraUsage; individualLimit/spendControlReached map to spendControls.
Banked-reset native types map to supported booleans and neutral outcomes.

Claude adapter mapping: canonical rows keep supplied order/labels/groups; legacy
rows map to the same windows. Unreported durations/credit balances/spend controls
remain null/empty. Allowance events and failed experimental reads preserve stale
observations. ordinaryUsageAllowed remains null unless authoritatively reported.
No reset port means resets.supported=false, not a provider-name check in the UI.

Example neutral projections: an included five-hour window can have
`durationMinutes: 300, usedPercent: 42, status: "available"`, while an independently
reported `ordinaryUsageAllowed: false` still blocks ordinary usage. A reported
weekly window with unknown duration has `durationMinutes: null` and its known
percentage/reset time; unsupported resets have null count, not zero available.

`GET /api/v2/limits?provider=<registry-id>` returns this shape for every provider;
reset writes select the same registry ID and require its reset port. The shared
panel renders windows, credits, spend controls, and optional reset actions. Provider
tabs come from enumeration; Discord `!limits` defaults to the attached provider.

Readers are account-scoped, coalesce/cache bounded reads, observe native events,
and close on shutdown. Account/auth changes discard old data. No account IDs,
emails, credentials, or invoices enter the DTO. Missing values remain unknown;
reset time never implies zero usage or recovered permission. Reset UI stores the
selected provider, idempotency key, and credit ID for uncertain-outcome retries;
provider changes cannot retarget a pending redemption. Refresh after a known
outcome; never infer new limits. Catalog lookup failure cannot hide usage/reset data.

## Adapter mapping requirements

Only this section and adapter-local code/fixtures discuss native schemas. Shared
contracts above contain no provider-specific discriminator or response value.

### Codex

| Native input | Neutral mapping |
| --- | --- |
| userMessage / agentMessage | user_message / assistant_message; input assets normalized; confirmed phase retained |
| reasoning | Indexed bounded summaries; raw content stays private; preserve summaryIndex on deltas |
| plan / turn/plan/updated | Separate recoverable text plan / transient turn checklist; distinct deterministic IDs |
| commandExecution | command with full execution metadata and all bounded commandActions; never reclassify away output/exit code |
| fileChange / patch updates | file_change with proposed/applied state where known; bounded diffs and pre-truncation counts |
| mcpToolCall / dynamicToolCall | tool with bounded input/output, errors and generic media assets; source distinguishes MCP/Shepherd/other provider tools |
| webSearch | web preserving queries, URL and find pattern |
| collabAgentToolCall / subAgentActivity | subagent action and all known target states; unknown parent/report is explicit |
| imageGeneration / imageView | image backed by authorized asset port |
| compaction / review / hook / sleep | Typed notice, with known recoverability |
| functionCallOutput | Standalone tool output item. Merge only with proven correlation; page boundaries never justify dropping unmatched output |
| New native item | Bounded fallback tool, available fields and assets, with diagnostic native type kept private |

Command/file approval strings and compound execution/network policy amendment
objects are private replies selected by opaque tokens. Show exact rule/scope/effect
in neutral permissions. Multiple callbacks on one item retain separate request IDs,
including stdin review. Respect native offered choices when supplied. Permission
profile requests map requested filesystem/network access and turn/session grant
scope; grant only the requested subset. Question requests use shared questions.
Dynamic tool calls dispatch to the Shepherd registry. Unsupported elicitation,
authentication-refresh, or attestation requests receive native unsupported replies;
diagnostics remain private, but a resulting user-actionable failure is a neutral
warning/error, not silently hidden.

### Claude

The CLI emits one assistant message per content block. Text item identity combines
the API message ID and text-block index; live and recovered mapping use the same
rule. Pending text becomes commentary when tool use follows, and final_answer
when the response ends. Interrupted text is terminalized without inventing a final
answer. Thinking maps to bounded summaries; redacted thinking is not exposed.

| Native input | Neutral mapping |
| --- | --- |
| Bash / BashOutput | command with description, combined stdout/stderr and known status; absent numeric exit code/duration stays null. interrupted means interruption; timedOutAfterMs plus backgroundTaskId means auto-backgrounding, not timeout failure |
| TaskStop / Monitor | tool with relatedItemIds; task correlation uses private task map |
| Edit / Write | file_change from structuredPatch or gitDiff, including user-modified/staged state; staged=true does not mean applied |
| NotebookEdit | file_change from notebook_path and old/new cell source or original/updated notebook content; bounded generated diff, not nonexistent structuredPatch/gitDiff fields |
| MultiEdit on older CLI | Validate its actual shape separately or fall back to bounded tool; never assume FileEditOutput |
| Read | file_read with path, offset/limit and bounded available output |
| Grep / Glob | search with queries/paths and bounded matches; provider truncation also marks incomplete results |
| WebSearch / WebFetch and server web blocks | web with query/URL/pattern where available; detachedToolCall is continuing work, not completion |
| Agent / Task | subagent; completed report versus async_launched/remote_launched receipts handled separately, with task identity and later terminal updates |
| TodoWrite | plan with validated steps |
| TaskCreate/Update/List/Get | tool for now, with generic relations where known |
| AskUserQuestion | user_input interaction, no duplicate work item |
| MCP and other tools | tool with generic media assets and bounded fallback result |
| tool_progress / task events | Update neutral background/work state and known correlations; elapsed observations stay runtime display state |
| compact_boundary | notice |

Enable forwardSubagentText when supporting nested text; partial-message events
alone only supply root token streaming. Complete child messages use parent_tool_use_id
for containment. Unavailable nested history is explicit, not silently portrayed as
complete. Match tool_result and structured tool_use_result by actual tool identity;
validate per-tool unknown shapes and fall back to bounded text/assets. A launch or
detached receipt does not close work. Map task snapshots/run identities to reject
stale runs and exclude ambient watchers from activity.

canUseTool creates an interaction with shared command/file/permission details.
Suggested session rules get opaque tokens and session scope; unavailable persistent
choices are not offered. AskUserQuestion supports single/multiple selection,
explicit submit/cancel, and private callback translation. Bypass retains question
handling. Never expose callback results or native suggested-rule objects to surfaces.

## Storage migration and rollback

Generic storage reads/writes versioned neutral snapshots. Claude's adapter owns
`legacy_snapshot_mapper.ts`: the storage implementation returns version-tagged
raw legacy data through a private persistence port and does not interpret native
item names. Current unversioned snapshots are v1; v2 includes schemaVersion=2,
neutral items and completeness metadata. Runtime-only versions are reassigned in
the new projection epoch rather than treated as durable native revisions.

Reads never rewrite snapshots. Decode/validate an entire v1 snapshot in the adapter,
including mixed legacy/neutral records left by older transitional builds. Preserve
IDs, chronology, archived metadata, and native resume metadata. Legacy missing
structured results stay partial; do not infer successful edits from arguments.
Malformed/unsupported future versions fail clearly without overwriting the file;
listing skips unreadable entries with a bounded diagnostic as today.

On first successful mutation, preserve a v1 backup before writing a complete v2
snapshot to a temporary file and atomically replacing the snapshot. Write summary
metadata second and regenerate stale summaries safely. No partially converted file
is published. Keep backups through the rollback window. New v2-only threads require
a neutral-to-v1 adapter exporter before rolling back to an old binary; the old
binary must never read v2 directly. Stop ingress/work before rollback, export all
current metadata/history into verified v1 files, and preserve the v2 files. Native
transcripts, provider bindings, and assets are backed up with snapshots. If an export
cannot represent new detail, retain that detail in v2 and explicitly report the
loss in the older viewer; never lose native resume metadata or overwrite newer
turns with the original backup. Rollback is blocked if a safe resume export fails.

Attachment extraction is a later versioned migration. For now adapters register
stable generic asset references for inline legacy images and resolve them through
the authorized asset port with existing byte limits. Existing backing snapshots
must remain available; fork references have explicit source ownership. A private
asset manifest retains the backing locator across resume/fork and v2 saves; inline
assets backed by a v1 backup keep that backup beyond the rollback window until
extraction or another durable backing exists. Public items never contain those
native locators. Future
extraction must publish assets before snapshot references, validate hashes/MIME,
handle missing files and crash recovery, preserve fork references, and define
backup/garbage-collection rules. It must not restore large data URLs to item pages.

## Surfaces and compatibility

One neutral item renderer serves web history and live work. Commands expose
command/output/status, changes expose diffs/counts/applied state, tools expose
bounded details/assets, and nested work exposes reports and incomplete ancestors.
Session-only plans are visibly transient. Shared reducers handle item revisions,
background updates after turn end, and interaction intents/scopes.

Discord uses the same data: one-line item summaries with optional bounded output
attachments and a link to full details when available. Permission cards display
scope/effects; no raw-method labels. Provider selection and optional controls come
from registry enumeration/capabilities. No provider-specific rendering component
or native history-presentation helper remains in production surfaces.

Web v2 lives at `/api/v2`; bump both version and routing prefix. Add a stable
unversioned `/health` for protocol negotiation, returning supported API versions
and server instance identity; retain `/api/v1/health` during the transition.
New clients negotiate before reads/writes/streams and after instance change.
Unsupported versions disable mutations and offer reload while retaining drafts.
A reload requires an explicit warning that in-memory drafts will be lost.

The currently shipped browser has no version handshake. Therefore serve a
bounded v1 translator for one release, including old events, history, approvals,
limits, handle recovery, images and settings. It projects neutral data into the
old contract; native codecs are confined to adapter compatibility entry points.
It must never send v2 payloads on v1 streams. New grant types that v1 cannot safely
explain are shown as an explicit unsupported/full-form action with deny/cancel;
no fabricated permissive option. A later removal waits for negotiated clients and
an external-client inventory; old tabs then receive predictable upgrade errors.
Do not claim a new client handshake automatically upgrades an old bundle.

Runtime injects legacy codec ports into the web transport, so transport code
does not import native adapters or inspect their fields. Compatibility codecs
accept neutral data and encode the old Shepherd wire contract. Frozen v1 DTOs,
codecs and old-bundle tests have an explicit temporary boundary exception for
legacy names; v2 core and renderers have none. Remove that exception with v1.

SSE replay remains process-local. Restart changes epoch, invalidates handles and
cursors, and invokes neutral resume/history/interaction recovery. Test with an
actual old bundle, not only a mock version value. Preserve current origin checks,
scoped asset authorization, backpressure, and revert history revisions.

## Verification and implementation stages

Recorded sessions and deterministic synthetic frames complement each other.
Build recorders/harness before changing behavior. Record exact SDK/CLI/schema
versions, scenario, outbound requests, inbound frames, callbacks, and terminal
history reads so Codex recovery can be replayed without assuming a second stored
transcript. Strip credentials/account data and sanitize prompt text, tool args,
file contents/diffs, paths, URLs, and secret answers. Preserve identity/correlation
consistently. Review fixtures before commit; live recording is an explicit developer
workflow, not an automatic test that spends tokens or modifies a real workspace.

Contract cases run against every adapter according to its declared capabilities:
text/images, compound read commands, tool outputs/media, file edits, standalone
outputs, persistent permission options, questions/skip/multi-select, competing
answers, abort/withdrawal, steering/cancellation, crash/resume, fork, nested agents,
background launches/detached results/stale task runs, settings/restart guards,
unknown native items, absent metadata and malformed frames. Unsupported features
must fail before submission. Shared tests check semantic invariants, not identical
native event counts or unsupported fabricated behavior.

Recovery tests cover snapshot/replay overlap, duplicates, indexed reasoning,
delta gaps, epoch changes, history pagination/parent boundaries, revert races,
maximum escaped Unicode payloads, bounded accumulators, slow clients, and byte
budgets. Migration tests cover v1/v2/mixed records, malformed/future versions,
interrupted writes, stale summaries, retained asset references, rollback export,
and complete native resume metadata. Account tests cover both concrete mappings,
stale/auth-change behavior, unknown ordinary permission, catalog failures, and
uncertain reset retry/provider identity. Browser tests use old/new bundles against
v1/v2; Discord tests ensure no native name determines control behavior.

Each stage is a coherent commit on PR #90 and passes `bun test` and `bun run check`:

1. Add additive v2 types, registry descriptors, byte-budget helpers and replay
   harness with fixtures. Existing contracts continue serving current callers.
2. Implement one vertical text/history/asset projection path in each adapter,
   snapshot/watermark reconciliation, and the shared renderer behind v2 routing.
   Compare live and recovered semantic fields; keep v1 translation at the edge.
3. Migrate tools/files/plans/media and background/nesting with the mapping and
   bounds tests. Do not finalize background work on launch receipts.
4. Migrate interactions and neutral settings/input/catalog/optional ports,
   capability guards, opaque reply tokens, and permission-effect rendering.
5. Migrate account readers/reset workflows and registry-driven surface controls.
   Version Claude storage with verified rollback export; defer image extraction.
6. Switch the built-in client to negotiated v2; run old-client compatibility,
   restart, packaged executable, and complete regression checks. Update maintained
   docs throughout; then enforce final boundary rules and archive this proposal.
7. Remove temporary v1 translation only after the documented compatibility window,
   client inventory and upgrade tests pass. This removal can be a later release.

Boundary tests scan TS and TSX imports, exports, dynamic imports, and import types.
Only provider adapters import native SDKs/schemas or interpret native strings.
Core cannot import providers/storage/runtime; storage cannot import native codecs.
Surfaces import shared contracts and core ports only. Compatibility tests/fixtures
have a narrow explicit exception while v1 exists; production compatibility dispatch
still receives neutral types. Enforce no provider-name branches in reducers,
renderers, interaction decisions or account widgets. Registry composition and
provider selection are the intentional identity-based dispatch points.

## Acceptance examples and remaining product choices

- A command approval that remembers an execution rule exposes an opaque option,
  persistent scope and the exact neutral command match. Selecting it resolves the
  adapter's private compound reply; core never sees that object.
- A background command launches in turn A, turn A completes, and a later task
  notification completes the original item at a higher revision. The same renderer
  updates it without reopening A or knowing which provider launched it.
- History includes text already streamed through sequence 10. Replayed deltas up
  to 10 are discarded; an older replacement cannot undo the snapshot. A missing
  base revision requests recovery rather than duplicating answer text.
- Four large diffs produce a <=48 KiB item with original counts and visible
  truncation. Its full event stays <=96 KiB and reaches SSE as an item event.
- A standalone native tool output has a stable neutral tool item even when its
  producing call is absent or on another page.
- A provider with no reset/skill/fork port hides those actions and rejects direct
  calls through the same generic capability guards.

The contracts above are implementation decisions. Remaining choices are product
preferences: whether Discord should offer bounded output attachments by default,
and which full-text/asset retention policy to offer. External client inventory
controls v1 removal timing, not whether shared protocols are generic. Any change
to byte caps must re-run encoded-frame/page/accumulator tests.

## References

- Codex 0.160.1 generated normal/experimental schemas: ThreadItem, approval
  decisions/profiles, plan/reasoning notifications, and account-limit responses.
  Generate both TS and JSON schemas per [Codex parity matrix](codex-parity-matrix.md).
- Claude Agent SDK 0.3.296 types: SDK messages, tool_use_result, Options,
  BashOutput, AgentOutput, NotebookEditOutput, file results and task events.
- [Provider architecture audit](archive/provider-architecture-audit.md) and
  [Claude parity matrix](claude-parity-matrix.md) distinguish current support from
  this proposed contract and distinguish recorded/live evidence from mocks.
- T3 Code orchestration/provider documents reviewed in the original proposal at
  c77a7b7e are background context; Shepherd's contracts and acceptance tests above
  govern this implementation.
