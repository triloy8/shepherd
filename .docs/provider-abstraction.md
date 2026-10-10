# Provider abstraction

## Status and decisions

Proposed on 2026-10-10, revised after the design audit, and corrected after a
second audit (message-text limits, approval-mode mapping, replay sizing, scope
cuts), for implementation on [PR #90](https://github.com/triloy8/shepherd/pull/90)
(`feat/multiple-agent-providers`). This is the target contract, not a description
of shipped behavior. [Architecture](architecture.md) describes the current code.
Update maintained references with each landed workflow; archive this proposal
when the migration is complete.

Implementation has started with additive contracts in `shared/protocol/v2/`,
the `server/ports/provider_v2.ts` port, an identity-independent registry, neutral
default parsing, encoded-byte helpers, and process-local event ordering/replay.
The default parser lives in runtime composition (`provider_defaults.ts`), so
legacy native configuration aliases do not enter core.
The server exposes additive neutral projection and action ports at `/api/v2`.
Messages/images, steering/interruption, pending permissions/questions, settings,
model catalogs, skills, and account/reset controls are available through these
ports. Native replies remain in private adapter closures; public options are
opaque tokens with shared intents, scopes, and effects. Core validates ownership
and offered options; invalid answers remain pending, and the first valid reply
synchronously claims the request before native delivery. Answers are excluded
from snapshots and replay.

Native mappers cover text/input, Codex commands/diffs/plans/reasoning/images and
Claude reads/commands, with explicit partial tool fallbacks for other variants.
Protocol test consumers exercise snapshot/replay reconciliation. They are not
the shipped browser client.

The attempted default web cutover was reverted at the user's request because it
changed timeline presentation and introduced history pagination regressions.
The UI baseline was restored from main revision `b5797c1`. Its timeline and
recent-first turn history continue to use `/api/v1`. Two requested additions use
the neutral endpoints: new-conversation provider choice and the account usage
provider selector. Those choices come from runtime descriptors rather than a
fixed provider list. Settings and conversation actions retain the main UI. Its
existing “Load earlier messages” control is retained as part of that exact restore.
A future neutral client migration must preserve those behaviors and be validated
with long resumed conversations before becoming the default.

This remains an incomplete application migration. Discord and the built-in UI
use the old event/action contracts. Session creation/resume/fork and navigation/
host operations reuse existing application services. The final
`ProviderSession`/`ProviderServices` registry port is not yet the production
session owner: runtime assembles neutral sources/controls alongside legacy
sessions. Full background/nested-agent mapping and versioned Claude storage
remain pending. API retirement and negotiated bundle cutover are target work.
A third provider can use the neutral API but still needs the legacy lifecycle
interface until that final migration lands.

Synthetic and sanitized live fixtures cover text identity and recovery for both
adapters. The recorded Claude fixture includes a successful read. The recorded
Codex fixture includes a command that failed to initialize its host sandbox,
followed by a completed text answer; it proves failure/output recovery, not
successful sandboxed execution. See the [fixture guide](../tests/fixtures/provider-neutral/README.md).

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
- Web API v2 replaces v1 without a translator. No client outside this repository
  uses `/api/v1` or bridge events (`triloy8/shepherd-ui` is an archived, separate
  server; webhook producers use `/signals/:routeId`, which is unchanged). v1 routes
  answer with an upgrade-required error that the shipped UI already displays.
- Claude snapshots are versioned and converted when read. No rollback exporter:
  Claude exists only on PR #90 builds, and `main` has no Claude support to roll back to.
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
   Conversation message text (user and assistant) is not truncated for display
   within the message limit below.
8. Diagnostic raw frames stay adapter-local and out of ordinary conversation
   events. Recoverable warnings and final errors use typed neutral events.

## Registry, inputs, requests, and records

`ProviderId` is a validated registry key, not a closed `"codex" | "claude"` union.
The runtime registers descriptors, session factories, history access, model
catalogs, account readers, and shutdown hooks. Public provider enumeration returns
`{ id, displayName, capabilities, defaults }`; picker options come from this enumeration.
Neither UI nor core contains a provider switch. Bindings remain immutable and
legacy prefix recognition remains confined to runtime composition.

New neutral `ConversationInput` replaces native-shaped `UserInput` at the port:

```ts
type ProviderId = string; // validated against the injected registry
type InputMedia = "image" | "audio";
type InputPart =
  | { type: "text"; text: string }
  | { type: "asset"; assetId: string; media: InputMedia }
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
| `readThread(includeTurns)` | Metadata-only read plus paginated turns/items in v2 |
| Revert response | Neutral thread metadata plus existing opaque history cursors; caller fetches new history |
| Thread/model/effort state | Model and effort IDs from the neutral catalog; no `modelProvider` |
| Model summary | Display fields and supported effort IDs/default; remove `supportsPersonality` |
| Stored-thread filters | Provider IDs, cwd, archived, search, created/updated order; remove native `modelProviders`, `sourceKinds`, `useStateDbOnly`, and `recency_at` in v2 |
| Turn/item pages | Typed `ConversationTurn`/`ConversationItem` and opaque cursors, including size-limited partial item pages |
| User input and image decoration | Neutral input/asset references; scoped asset URLs are surface decorations |
| Limits/resets | Neutral DTO and optional reset port below |

Native-only filters and fields are removed from the shared contracts rather than
translated; the built-in client moves to v2 in the same change (see Surfaces and
compatibility).

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
  unavailableFields: ItemField[];          // typed per item variant, never free text
  omitted: Partial<Record<ArrayField, number>>; // entries dropped from each truncated array
  detailAsset: AssetReference | null; // optional full text/detail outside the preview
}
// Runtime projection versions travel on item events, not on stored items:
// item events carry { epoch, revision } beside the item (see Events).
type ConversationItem = ItemBase & (
  | { type: "user_message"; content: HistoryInputPart[] }
  | { type: "assistant_message"; text: MessageText; phase: "commentary" | "final_answer" | null }
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
/** Message text is complete up to the message limit; only larger text uses a preview plus full-text asset. */
type MessageText = BoundedText;
type HistoryInputPart =
  | { type: "text"; text: MessageText }
  | Exclude<InputPart, { type: "text" }>;
interface AssetReference {
  id: string;
  media: "image" | "audio" | "text" | "file";
  mimeType: string | null;
  name: string | null;
  availability: "available" | "unavailable";
}
```

Output assets include full-text answers and tool detail files. Input attachments
remain restricted to image/audio; output asset types do not advertise new input
capabilities. `inputKinds` and `inputMedia` describe accepted inputs separately.

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
| User/assistant message text | 256 KiB in aggregate across all text parts, including JSON escaping. Larger text uses a preview plus full-text asset. Input submission retains its separate rejection limits. |
| Entire serialized item, excluding message text | 48 KiB; a complete message item is at most 304 KiB |
| Output/report/reasoning/diff field | 16 KiB; command/tool outputs retain the last 2 KiB |
| Combined diffs per item | 24 KiB; counts computed before truncation |
| Tool input, prompt, command | 8 KiB each |
| Entire serialized interaction | 64 KiB |
| Bridge/SSE frame, including envelope and surface decoration | 96 KiB; 320 KiB for message item events |
| History/list JSON response | 1 MiB |
| Delta text | 4 KiB; split on Unicode boundaries |
| Path, URL, ID, label; array entries | 4 KiB per string; at most 100 entries per array, also subject to aggregate budgets |

Array truncation records a count per array in `omitted`; text fields always use
`BoundedText`. `ItemField` and `ArrayField` are literal unions generated from the
item variants, so an unknown field name is a type error.
If metadata alone exceeds an item budget, return a minimal typed summary with
unavailable fields and fetchable detail where supported. An interaction must
explain the full effect of each offered grant. If permission details cannot fit,
provide paged neutral detail and disable grant actions until available, or offer
only deny/cancel; never approve from a misleading truncated preview.

Message text above the 256 KiB message limit has a bounded preview and a generic
full-text asset accessed through the asset port; the adapter may back it by
native storage. Below that limit, history and events carry the complete text. Assets preserve images and other large media outside events and
pages. Missing files or unsupported native retrieval give an unavailable asset,
not an arbitrary filesystem/remote fetch. Keep existing scoped image authorization.
Private legacy snapshots may still contain inline input images; public projection
registers stable asset IDs without sending the data URL back in a history page.

Limit at the item, collection, and encoded-frame levels. A page stops before its
byte budget and returns a continuation, including within a turn. It must progress
even when one native record is huge. The web adapter's final serialization check
remains a defense, but ordinary maximum-sized items/interactions must fit without
`event_too_large`. Core replay is byte-bounded as well as count-bounded, and sized
from the frame cap: at least 4 MiB and 512 events per conversation, so a
reconnect after several maximum-size tool items still replays instead of forcing a
snapshot. Per-client send buffers hold at least four maximum-size frames (1.25 MiB),
up from today's 128 KiB replay and 256 KiB client limits in `event_feed.ts`.

Streaming accumulators keep bounded head/tail buffers and byte counts. Message text
streams by appended deltas up to the message limit; it never switches to head/tail
replacements, so a long answer is never shown with its middle removed. For
output/reasoning/diff fields, once a field exceeds its preview budget, stop append
deltas for that field and publish bounded replacements, coalesced at most once per 100 ms. Subsequent chunks update
the retained tail. Final state contains the authoritative bounded preview. Never
accumulate unlimited output merely to truncate it at completion.

## Events, snapshots, and reconciliation

Use a discriminated `BridgeEvent` union with typed payloads, retaining opaque
event IDs, thread/session IDs, and timestamp. Each projection session has a fresh
epoch and monotonically increasing sequence. Item revisions are monotonic within
that epoch; they are not native revisions or a persisted Codex event log.

| Event | Payload/behavior |
| --- | --- |
| `item.started`, `item.updated`, `item.completed` | Full bounded `{ item, revision }`; the envelope carries the epoch. Completed means a terminal work state |
| `item.delta` | `{ itemId, turnId, baseRevision, revision, field, index, offset, delta }`; `offset` counts UTF-16 code units, matching browser strings (byte counts are for budgets only); index is required for reasoning summary blocks, null for text/output |
| `interaction.requested`, `.decided`, `.applied`, `.failed`, `.expired` | Neutral request/record IDs and lifecycle; never native responses or secret answers |
| `turn.started` | Turn ID |
| `turn.completed` | Turn ID and `status: "completed" \| "interrupted"`; turn closure does not close background work |
| `turn.failed` | Turn ID and typed bounded error |
| `thread.status.changed` | `{ activeTurnId, backgroundTaskCount, state: "idle" \| "active" \| "waiting" \| "error", waitingFor: "approval" \| "user_input" \| null }` |
| `thread.capabilities.changed` | `{ capabilities: ProviderCapabilities }` when a settings, account, or model change narrows or widens what the conversation supports |
| `thread.*`, token/context usage, `session.started` | Existing neutral meanings with typed payloads |
| `session.warning`, `session.error`, `session.limit.context` | Bounded neutral message, error code and retryable flag; no native method field |

Remove `turn.activity`, native `turn.notification`, completed-message and image
events; items replace them. Retry warnings never fail a turn. Final provider
errors retain the distinct session/turn/item scopes and do not mark unrelated
work failed. Retain revert history invalidation and handle recovery.

Each bridge envelope adds `epoch` and `sequence`. A generic core projection
assigns those values and item revisions in one serialized publication queue;
adapters supply normalized mutations, not independently competing revision clocks.
`GET /api/v2/conversations/:id/snapshot` captures projection state, pending
interactions, and versioned overlays together as of `throughSequence`, with
`{ epoch, throughSequence, historyRevision }`. Each overlay includes
`{ item, revision }`; clients need that revision to apply the next delta.
Overlay pages use opaque cursors bound to this capture and stay within the page
budget. Expired captures require a fresh snapshot. Buffer events until all overlay
pages are loaded. The core queue owns capture and lifecycle changes.

Native history is fetched separately; a later SDK read is never described as
state through an earlier watermark. History supplies recovered terminal work;
active and session-only items come from versioned overlays, which take precedence
by item ID. An unversioned history item cannot be the base of a streamed delta.
Hydration subscribes before native reads and reconciles overlapping items with
authoritative full replacements, not buffered append deltas. If an overlapping
native read cannot be ordered safely, retry the read or request resync. History
pages retain their history revision; revert invalidates both history and overlay
cursors. No database lock is held across SDK waits. The stage-two assembler must
test native text ahead of the capture, completion during hydration, and revert
during pagination before exposing this endpoint.

Clients open the stream before fetching the snapshot, buffer events, apply the
snapshot, then replay only events after `throughSequence` in that epoch. Ignore
older/equal item revisions. Apply a delta only when baseRevision and offset
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
  createdAt: number; // epoch seconds, like every other shared timestamp
  updatedAt: number;
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
  inputMedia: Array<InputMedia>; // image/audio; separate from output/detail assets
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

Approval semantics: provider_default uses documented native behavior;
review_sensitive keeps native permission checks enabled, subject to configured
allow rules and the execution boundary; review_all promises a review of every
supported side-effecting tool not covered by an explicit prior grant; bypass
disables interactive tool approval, not user questions. Declare a mode only when
enforceable. Native granular policy objects are not generic approval modes. The
table maps native settings to these guarantees; it cannot weaken a shared
guarantee. Native recordings must establish the guarantee for commands, file
changes, MCP, and Shepherd tools before an adapter advertises review_all.
Unrestricted means no sandbox guarantee, not no permission
questions. Claude advertises only unrestricted sandboxing until a real constrained
execution boundary exists. Filesystem rollback is not implied by conversation revert.

Each adapter declares only verified modes. A mode not listed or not verified is
not offered, and a request for it fails before any work starts.

| Neutral mode | Codex (`AskForApproval`, `SandboxMode`) | Claude (SDK `permissionMode`) |
| --- | --- | --- |
| `provider_default` | Omit the policy and let the Codex configuration decide | `default` with loaded settings rules (same as `review_sensitive`) |
| `review_sensitive` | `on-request`: the model asks when it needs to leave the sandbox or judges an action risky; the sandbox does the enforcement | `default`: asks for any tool that loaded user, project, or local settings do not already allow |
| `review_all` | Candidate mapping: `untrusted`. Trusted read-only commands may run without review; all supported side-effecting tool categories must satisfy the guarantee in native contract tests before this mode is offered | Not offered until loaded allow-rules can be represented as explicit prior grants and all tool categories satisfy the guarantee |
| `bypass` | `never` | `bypassPermissions` with `allowDangerouslySkipPermissions`; `AskUserQuestion` still asks |
| `read_only` sandbox | `read-only` | Not offered |
| `workspace_write` sandbox | `workspace-write` | Not offered |
| `unrestricted` sandbox | `danger-full-access` | The only mode: no sandbox |

Codex granular policy objects stay adapter-local configuration. Claude's
`acceptEdits`, `plan`, `dontAsk`, and `auto` modes are not used. Canonical v2 defaults
are `SHEPHERD_APPROVAL_MODE` and `SHEPHERD_SANDBOX_MODE`; they take precedence over
legacy aliases. Existing `CODEX_APPROVAL_POLICY` (`untrusted`, `on-request`, `never`)
and `CODEX_SANDBOX` values translate to neutral values only when the corresponding
neutral variable is absent. These explicit defaults apply to either provider and
must pass capability validation; never silently downgrade an unsupported mode.
With no explicit defaults, use adapter-declared defaults and validate them. Each
registry descriptor includes neutral approval/sandbox defaults and validates them
against its capabilities during registration. A
restricted sandbox requested for an adapter without that capability fails before
work starts; the error names the unsupported mode. The additive parser exists now;
runtime configuration switches to it during the settings migration.

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
including stdin review (`kind: "writeStdin"`). Offer amendment choices only when
the request carries them: `proposedExecpolicyAmendment` becomes a persistent
command rule option and `proposedNetworkPolicyAmendments` become network options. Permission
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

## Storage versions

Claude snapshots exist only on builds of PR #90; `main` has no Claude support. So
storage uses a simple versioned format with no rollback exporter.

Generic storage reads/writes versioned neutral snapshots. Claude's adapter owns
`legacy_snapshot_mapper.ts`: the storage implementation returns version-tagged
raw legacy data through a private persistence port and does not interpret native
item names. Current unversioned snapshots are v1; v2 includes `schemaVersion: 2`,
neutral items and completeness metadata.

- Reads convert v1 in memory and never rewrite the file. The adapter decodes and
  validates the whole snapshot, including mixed legacy/neutral records from
  transitional builds, and preserves IDs, chronology, archived metadata, and
  native resume metadata. Missing structured results stay partial; successful
  edits are never inferred from arguments.
- The first mutation after a v1 read copies the v1 file to `<id>.v1.json` once,
  then writes the v2 snapshot through a temporary file and an atomic rename,
  followed by the summary file, as today.
- Malformed or newer-than-supported versions fail clearly without overwriting
  the file; listing skips unreadable entries with a bounded diagnostic as today.
- Running an older PR #90 build against v2 files is not supported. The `.v1.json`
  copies let a developer restore test threads by hand.

Inline images in v1 snapshots stay inline for now. The adapter registers stable
asset references for them and serves them through the authorized asset port with
the existing byte limits; history pages never return the data URLs. Extracting
them to files is a later, separately versioned change.

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
and server instance identity. `/api/v1/health` returns the upgrade error below.
New clients negotiate before reads/writes/streams and after instance change.
Unsupported versions disable mutations and offer reload while retaining drafts.
A reload requires an explicit warning that in-memory drafts will be lost.

The currently shipped browser has no version handshake, and no other client uses
v1 (see Status). So v2 has no v1 translator. Every `/api/v1/*` route, including the
event stream and `/api/v1/health`, answers `410` with error code `upgrade_required`
and the message "Shepherd was updated. Reload this page to continue; unsent drafts
in this tab will be lost." The shipped UI shows the server's message for unknown
error codes (`ui/src/api.ts`, `explainError`), so an old tab tells its user to
reload on its next request. The old bundle's event stream retries quietly; its
next action or host-status poll shows the message. No v1 DTOs or codecs remain in
production code, so v2 has no boundary-test exceptions for legacy names.

SSE replay remains process-local. Restart changes epoch, invalidates handles and
cursors, and invokes neutral resume/history/interaction recovery. Test the upgrade
message with the actual shipped bundle, not only a mock version value. Preserve current origin checks,
scoped asset authorization, backpressure, and revert history revisions.

## Verification and implementation stages

Recorded sessions and deterministic synthetic frames complement each other.
Build recorders/harness before changing behavior. Record exact SDK/CLI/schema
versions, scenario, outbound requests, inbound frames, callbacks, and terminal
history reads so Codex recovery can be replayed without assuming a second stored
transcript. Record against a throwaway fixture repository with synthetic content
(`tests/fixtures/workspace/`, copied to a temporary directory per run), so prompts,
tool arguments, diffs, and paths are safe to commit unchanged and the mapping tests
see real shapes. Strip only credentials, account identifiers, emails, and the
temporary directory prefix (replaced with a fixed placeholder). Review fixtures before commit; live recording is an explicit developer
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
interrupted writes, stale summaries, retained asset references, the one-time
`.v1.json` copy, and complete native resume metadata. Account tests cover both
concrete mappings,
stale/auth-change behavior, unknown ordinary permission, catalog failures, and
uncertain reset retry/provider identity. Browser tests run the new bundle against
v2 and check that the shipped bundle shows the upgrade message against v1 routes;
Discord tests ensure no native name determines control behavior.

Each stage is one or more coherent commits on PR #90, and each commit passes
`bun test` and `bun run check`:

1. Add additive v2 types, registry descriptors, byte-budget helpers and replay
   harness with fixtures. Existing contracts continue serving current callers.
2. Implement one vertical text/history/asset projection path in each adapter,
   snapshot/watermark reconciliation, and the shared renderer behind v2 routing.
   Compare live and recovered semantic fields.
3. Migrate tools/files/plans/media and background/nesting with the mapping and
   bounds tests. Do not finalize background work on launch receipts.
4. Migrate interactions and neutral settings/input/catalog/optional ports,
   capability guards, opaque reply tokens, and permission-effect rendering.
5. Migrate account readers/reset workflows and registry-driven surface controls.
   Version Claude storage (read-time conversion, one-time `.v1.json` copy); defer
   image extraction.
6. Switch the built-in client to negotiated v2 and replace v1 routes with the
   upgrade-required response; run the shipped-bundle upgrade check, restart,
   packaged executable, and complete regression checks. Update maintained docs
   throughout; then enforce final boundary rules and archive this proposal.

Boundary tests scan TS and TSX imports, exports, dynamic imports, and import types.
Only provider adapters import native SDKs/schemas or interpret native strings.
Core cannot import providers/storage/runtime; storage cannot import native codecs.
Surfaces import shared contracts and core ports only. Enforce no provider-name branches in reducers,
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
- A 60 KiB final answer streams by appended deltas and appears complete in the
  live view and after a reload; nothing is cut from its middle.
- A shipped-bundle tab open across the upgrade shows "Shepherd was updated. Reload
  this page" on its next request instead of misreading v2 data.
- A standalone native tool output has a stable neutral tool item even when its
  producing call is absent or on another page.
- A provider with no reset/skill/fork port hides those actions and rejects direct
  calls through the same generic capability guards.

The contracts above are implementation decisions. Remaining choices are product
preferences: whether Discord should offer bounded output attachments by default,
and which full-text/asset retention policy to offer. Any change to byte caps must
re-run encoded-frame/page/accumulator tests.

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
