# Provider adapters

Shepherd has one application boundary for agent providers. The web UI and Discord
use the same conversation service, shared records, and controls. Codex and Claude
are native implementations behind that boundary. There is one HTTP API at `/api`;
there is no parallel provider API, compatibility facade, or alternative transcript renderer.

## Ownership

- `server/ports/provider_session.ts` defines a `Provider` (one per installed agent: conversation
  history, provider-wide model discovery, and `openSession`) and the `ThreadSession` it opens to
  run one thread (execution, events, approvals, and that conversation's compact, revert, catalog
  and skills). Core never opens a session to read history or list models. A provider reaches a
  thread one of its sessions is running through that session. Codex runs one app-server process
  for every thread, history read and account request, and routes each thread's notifications and
  requests to the session running it; Claude reads Claude's sessions directly.
- `server/ports/provider_services.ts` defines registration, account reporting, optional resets,
  session creation, and persisted thread ownership.
- `shared/protocol/` defines application input, messages, activities, images, questions,
  approval choices, settings, capabilities, and account limits.
- `server/core/` owns routing, lifecycle, pagination, model/effort state, approval validation,
  and shared action semantics. It does not import provider implementations or inspect provider names.
- `server/providers/` owns native transports, request construction, history decoding,
  permission replies, quota formats, authentication, and provider-specific defaults.
- `server/runtime/provider_services.ts` assembles registrations and persistence. This is
  where installed providers are named; clients discover them through descriptors.

To add another provider, implement the provider and thread session ports, supply its capabilities, optionally supply an account
reader, and register its factory and ownership resolver at composition. Core and
surface code do not need another provider branch. Provider IDs and model IDs are opaque strings. Discord uses `!providers` for discovery,
with optional provider IDs on `!newthread` and `!limits`; omitted IDs use the configured
default agent. Composition names the default explicitly (`SHEPHERD_DEFAULT_PROVIDER`, Codex
when unset) and registration rejects an unregistered default; descriptors mark it with
`isDefault`, so neither core nor clients infer it from registration order.

## Execution and presentation

Both adapters emit application `BridgeEvent` records. Core owns a separate bounded stream for surface delivery and replay, after applying capability checks. A turn's items stream
live as the same `HistoryItem` records history returns: `item.started` for items that take
time (a running tool, an image being generated), `item.delta` for streamed text, and
`item.completed` with the canonical item. Each adapter decodes live and stored items with one
decoder, so the item completed live equals the item history later returns; tests check this for
both adapters. Deltas name their `channel` (`message`, `plan`, `reasoning`, `output`); only
`message` text is part of an assistant message, and core and UI never infer meaning from an SDK
method. `shared/protocol/item_stream.ts` holds the rules every surface shares: how plan and
reasoning deltas build their item until the canonical item replaces it, and which messages answer
a turn (those marked final, or else the last unphased one). Output deltas are a running step's
latest output. A finished command keeps the end of what it printed, bounded to 4 KB by
`commandResult`, and its exit code when the provider reports one, as `result`: Codex records
both, and Claude records its Bash output and a failed command's exit code. Reasoning items state their `form`: Codex keeps raw reasoning private and sends `summary`
reasoning; Claude returns summaries of its thinking, also `summary`. `full` is for a provider
that exposes reasoning itself. `tests/provider_neutral_layers.test.ts`
fails if a provider name or an adapter import appears in core, ports, surfaces, shared protocol or UI.
Assistant messages carry an optional phase: `interim` progress text or the `final` answer.
Codex maps its OpenAI response phases; Claude marks text before a tool call as interim.
An item a subagent produced names its delegation activity in `parentItemId`. It belongs to the
turn holding that delegation, even when a background subagent finishes after the turn ends. A
subagent's text is its own progress and never the conversation's answer: core ignores it for
replies, web nests it inside the delegation step, and Discord leaves it out of progress lines.
Native notifications stay private. User-facing failures, items, token usage, and background
task counts have shared representations. Token counts that a provider does not report are `null`, including input, output and total counts. The most recent request and cumulative breakdowns can each be absent (`last: null` / `total: null`); reporting a cumulative total does not require inventing a last-request measurement.

Unknown assistant message phases remain valid. Discord uses the last unphased message
as the answer when no explicit final message exists, matching application history;
completed text is canonical, including an explicitly empty string. Previously reported phases
remain known when later events omit them. Empty canonical output also clears an existing
Discord streaming preview. An explicit null token-usage event clears cached measurements.

History item identities are scoped to their turn. Browser reconciliation and rendering use
both the turn and item identity, so repeated native IDs do not overwrite earlier messages.
Null turn IDs in events refer to the current turn; delayed events from an earlier turn must
carry its ID. Signal automation applies the same current-turn rule when waiting for completion.
Browser turn lookups require own properties, and optimistic messages carry explicit state rather
than reserving a native item-ID prefix. Deltas without item IDs belong to the pending message,
which may start anonymous. Its first identified delta or completion supplies the canonical identity, and
an unambiguous history snapshot can identify it before completion. A previously established
item cannot claim a later anonymous message merely because their text matches. Known message
phases remain available for subsequent canonical updates throughout the turn. Identifying an anonymous
interim stream binds its existing text without prematurely delivering its prefix.

Adapters decode stored history before returning it. History records are a discriminated
union of application item types (`user_message`, `assistant_message`, `plan`, `reasoning`,
`activity`, `image`, `other`) with `in_progress`/`completed`/`interrupted`/`failed` turn
status; web/Discord do not decode native tool records. Codex decodes its thread items in
its adapter. Provider transcripts are authoritative: Shepherd keeps no copy of a conversation.
Claude history is read from its session transcript through the SDK and decoded by
`server/providers/claude/transcript.ts`, the same decoder the live stream uses. Activities
are described from a bounded subset of tool arguments; tool results are not part of history. User message history has a
content part for every application input kind (`text`, `image`, `image_file`, `audio`, `audio_file`,
`skill`); `attachment` is only for provider content with no application counterpart, such as
Codex connector mentions, and keeps an indicator and available name/path in the web UI. The web
labels audio but never sends its URL or bytes to the browser. Activities
(`shared/protocol/activity.ts`) describe what an action does by its target: `command`
(command, cwd), `file_change` (paths), `tool` (source `application`/`mcp`/`builtin`, server,
name, main argument), `web` (query or URL), `delegation`, `image`, `wait`, and `other` (a
title for lifecycle steps such as context compaction). Each adapter classifies its own tools
and extracts these fields (Claude's `Bash` is a `command`, `Agent`/`Task` are `delegation`,
`Read` is a `builtin` tool targeting its path), and uses `other` rather than adding a
provider-specific kind; a new kind belongs in the shared contract only when surfaces present it
differently. Surfaces write every activity title and detail from these fields with
`describeActivity`, so an activity reads the same whichever agent ran it. Native tool arguments,
tool results, transport envelopes, and arbitrary thread properties do
not cross the boundary. Application input kinds (`text`, `image`, `image_file`, `audio`,
`audio_file`, `skill`) are encoded into Codex's wire format inside the Codex adapter; Codex
text elements and connector mentions are not part of the shared contract. Claude converts
the same application inputs into SDK content blocks.

The chat layout, composer, folded work, Markdown, image presentation, scrolling, and
recent-first turn pagination retain the restored main UI behavior. New-conversation
provider selection and the Usage & limits agent selector remain the requested additions.
Provider consolidation does not introduce a new history/loading workflow. Existing
menu/revert/attachment buttons consume capability flags: unsupported controls are disabled
without changing layout, and flags reset when switching conversations.

## Approvals and questions

Question answer state uses own-property lookups for opaque IDs, including multiselect values.
The web UI offers Skip only when a cancellation choice is supplied and disables answer submission
when no answer intent is offered.

A permission request names the `activity` it would allow and the agent's own `reason`, when
it gives one; surfaces write the prompt from the activity with `describePermission`. A question
carries its form (`userInput`) instead. Both offer labeled choices. Choice
values are opaque tokens and may recur in different requests. Their shared intent is allow, deny, answer,
or cancel. Native reply strings, permission amendments, RPC IDs, and SDK callbacks stay
inside the adapter. Surfaces send the selected token unchanged.

Core validates ownership, pending state, the offered token, and question answers before
claiming a decision. Invalid answers remain retryable. Duplicate replies cannot apply
twice. Terminal turns and native cancellation expire pending interactions. Answers do
not enter approval decision records or event replay. Questions use the existing form;
multiple-choice questions use checkboxes, and optional secret answers use masked fields. Masking is presentation only; it does not encrypt answers. A provider declaring `questions: false` cannot deliver a question to live subscribers or replay. Core uses the offered cancel/deny token to resolve the native request; if cancellation is unavailable or fails, it stops the unusable session and reports failure.

Discord uses bounded opaque button handles so long thread/choice IDs fit its platform
limit. Its modal handles supported single-answer forms; secret, multi-select, or large
forms direct the user to the web UI.

Core records permission ownership by session and active turn, expires pending questions
and permissions when that turn ends, and publishes application expiry events for live
delivery and replay. A delayed terminal event does not expire a known newer turn's requests.

## Capabilities and account reporting

Unsupported operations are absent from the session port implementation, and the shared
capability descriptor controls their availability. Claude does not provide fake skill,
compact, revert, or reset methods. Core rejects unavailable operations consistently.
`shared/protocol/provider_capabilities.ts` is the shared provider contract. Descriptors
and attached thread state expose the same flags. Creation/resumption, turn submission,
history access, approvals, and event delivery form the required session baseline.
Individual item history remains required because Discord’s turn drill-down pages use it. Provider-managed loaded-thread discovery is optional; core already lists its own managed sessions. Skill discovery receives one effective conversation workspace (`workspacePath`) and an optional `refresh` preference. Native multi-directory and cache-reload parameters stay inside adapters.

Optional operations are negotiated independently:

| Area | Fields |
| --- | --- |
| Active turns | `steer`, `interrupt` |
| Thread management | `rename`, `archive`, `unarchive`, `fork`, `compact`, `revert` |
| Workspace | `workspaceChange` (changing an existing thread's workspace) |
| Models | `modelCatalog`, `modelSelection`, `effortSelection` |
| Skills | `skills` (discovery), `skillConfig` (configuration writes) |
| Interaction and transport | `questions` (core fails question requests from providers that do not declare it), `inputKinds`, `imageDetail` |
| Execution policy | `policyProfiles` |
| Account service | `accountReset`; registration rejects a mismatch with the account reader's `reset` method |

False means unsupported, including when a method exists. Optional methods may be
omitted when their flag is false. Registration checks descriptor/session agreement,
advertised method presence. Model discovery, model selection, and effort selection are independent capabilities.

Optional catalog metadata is compared after applying its documented defaults: omitted
scope is conversation-scoped and omitted authority is false. Skill configuration writes
to explicit paths do not require discovery; resolving a skill name still requires its catalog.
The web skill mutation accepts an exact path independently of its extension or separators. Discord
also accepts `!skill enable --path <path>` and `!skill disable --path <path>` for explicit writes.
Provider, model, effort and single-thread values in Discord preserve internal spaces and case.
Positional history IDs containing spaces are quoted, for example `!history items "native turn" "app thread"`.
Quoted arguments support escaped matching quotes and backslashes; malformed boundaries do not
execute an action.
Core checks flags before execution and pending-state changes. Clients use them to
disable unavailable actions; server validation remains authoritative. A catalog can be read-only when selection flags are false. Without a catalog,
model metadata stays unknown
and adapter input checks still apply. When discovery is available, model and effort options come from the attached conversation's session catalog. Provider-wide discovery comes from the provider. Without discovery, selection controls accept opaque values and the adapter validates them; unsupported native selections remain retryable. An unreported current/default model does not block ordinary turns or settings reads. `supportedEfforts: null` means unreported, while an empty array means no supported levels. Hidden models are excluded from normal catalogs unless explicitly requested; hidden entries remain available for explicit-ID validation. Provider effort strings are case-sensitive and preserved unchanged.

`shared/protocol/model_capabilities.ts` defines model input modalities and effort
options. Every model catalog row implements this contract; provider capabilities
continue to describe adapter transports and operations. Both constraints apply:
a model supporting audio does not make an adapter support audio.

`inputModalities: null` means the adapter has no model metadata, while `[]` means
no supported modalities. Codex preserves its native model modalities, using its
documented text/image compatibility default only for older catalogs with the field
absent. Claude's SDK does not report modalities, so they remain unknown. Unknown
model metadata leaves input validation to the adapter and never grants additional
adapter support. Effort values come from the model catalog rather than model names.

Claude's optional SDK effort fields follow the same distinction: unreported levels stay
unknown, while explicit disabled support or an explicitly empty list means unsupported.
Unknown metadata does not clear an inherited effort override.

Core initializes every session before using history, discovery or bootstrap. Conversation
catalog requests carry the application thread ID; composition translates it to the native
ID. Bootstrap validation uses the newly created/resumed/forked identity. When effort
selection is unsupported, model changes leave effort management to the adapter and clear
the previously reported effort from application state only after a successful turn start.

Providers declare `modelCatalogScope`: provider-wide catalogs can validate selections before bootstrap, while conversation-specific catalogs validate after the adapter establishes its effective workspace. Omitted scope means conversation-specific. `modelCatalogAuthoritative: true` promises an exhaustive list of selectable IDs; omitted/false means advisory discovery, so unlisted IDs are validated by the adapter. The installed adapters declare provider-wide, authoritative discovery. Ordinary turns can preserve a provider-reported model even when its metadata is no longer listed. Native adapters validate bootstrap selections themselves; core checks advertised constraints before publishing a live session. Effort-only resume/fork requests use the saved/effective model.
Turn submission validates known selected or explicitly overridden models against the attached session; steering
uses the current model even when another model is pending. Known unsupported text, image and audio inputs
are rejected before execution. Unsupported explicit/pending effort stays retryable;
when switching models, incompatible inherited effort uses the new model's advertised
default. If no supported default exists, the adapter is told to clear effort. A turn starts
with one `TurnSettings` object (`model`, `effort`); an omitted field keeps
the thread's value, `effort: null` clears it, and a string selects one. The workspace is not
a turn setting: it changes only through `setCwd`, and each adapter runs turns in its own
current workspace. Codex forwards the explicit null; Claude reopens its SDK session without
an effort override. Settings expose separate current and next model capabilities,
and the browser uses the appropriate set to gate image attachments.

Core learns a thread's state from its adapter's events, never by reading adapter fields:
`turn.started` and `turn.completed`/`turn.failed` give the running turn,
`thread.status.changed` the background task count, and `thread.settings.changed` the model,
effort, workspace and policy profile the thread now runs with. Bootstrap reports the
initial settings; every turn start and workspace change publishes `thread.settings.changed`.
A pending model or effort selection is settled when the adapter reports applying it, so a
failed start leaves it pending and retryable, and a selection made while a turn starts
survives.

Account reporting is optional at registration. Descriptors expose `accountReporting`; the web UI does not query an absent reader, and unsupported API/Discord reads report an unavailable operation rather than fabricated account data. Unknown login state is `signedIn: null`. Every installed account reader returns `ProviderAccountLimits`: account metadata, allowance
windows, extra usage (both Codex credits and Claude overage), optional reset credits
(currently Codex only), freshness, and availability. A section a provider lacks is reported
empty or null. Missing provider data stays unknown. Shared fields are added only when an
installed provider reports them; the earlier `spendControls` list was removed because no
provider filled it. Reset requests use a shared outcome
format and retain the same idempotency key during recovery, scoped by provider.

Claude subscription allowances come from SDK observations and a bounded account read;
API-billed accounts explicitly report subscription allowances as not applicable.
Codex translates its allowance groups and banked credits inside its account adapter.
Neither account reporting nor opening the usage panel sends a user conversation prompt.

## Configuration and persistence

An execution policy (`shared/protocol/execution_policy.ts`) is three restrictions, each
ordered from strictest: `writes` (`none`, `workspace`, `any`), `network` (`none`, `any`)
and `review` (`risky`, `none`). Each provider declares `policyProfiles`: its native modes
and the restrictions each guarantees. Codex declares its sandbox × approval combinations
(its workspace-write and read-only sandboxes block the network); Claude declares
`bypassPermissions`, `default` and `plan`. Core resolves a policy to the least restrictive
profile within it on every restriction, and refuses a provider with none, so a policy never
loosens execution. Among equally loose profiles the first declared wins.

`SHEPHERD_POLICY` (`bypass`, `review`, `workspace`, `read_only`, or `provider_default`)
sets the host policy; `provider_default` applies none, so each agent keeps its own
configured mode. Create, resume and fork apply the requested policy or the host policy:
Claude's session does not record Shepherd's mode, so every bootstrap states it rather than
some providers inheriting a saved mode. Adapters receive the resolved profile ID, or null
for the agent's own defaults, and report the profile they run with at bootstrap and in
`thread.settings.changed`; Codex reads it back from its response and reports none for
settings no profile describes, such as a workspace sandbox with network access. Thread
state reports the profile and its restrictions. Turns do not change a thread's policy.
Startup and `--check-config` print a notice for each installed agent that cannot apply
the host policy exactly, and fail when the default agent would refuse every conversation.
`SHEPHERD_APPROVAL_MODE` and `SHEPHERD_SANDBOX_MODE` were replaced; Shepherd refuses to
start while either is set. Bypass suppresses permission review but retains explicit user
questions. No mode promises review of every action.

Shared thread requests offer model, effort, workspace, and policy. They
carry no instructions and no ephemeral lifetime: no surface sent either, Codex's
`developerInstructions` may replace configured developer instructions rather than add to
them, and ephemeral threads are Codex-only. Each agent keeps its own configured
instructions. Raw SDK `config`, backend overrides, deprecated
personality selectors, analytics service names, and native database/source filters are
not public fields. Their native configuration remains provider-owned. Unknown request
fields are rejected, not ignored. Model backend configuration belongs in the provider's
native settings. List sorting uses creation or update time across every provider.

Descriptors advertise policy profiles, input kinds and image-detail controls, alongside
operation capabilities.
Core checks these before bootstrap, submit, or steer, and adapters enforce them for direct
calls. Claude currently accepts plain text and URL/base64 image inputs; it does not claim
local-file, audio, skill-reference, or image-detail support. Model/effort
options are discovered where available; otherwise the adapter validates opaque selections. Thread state includes its provider
and capabilities, so surfaces do not guess support from identity. When a registered
provider is registered, composition rejects it if its capabilities differ from the
descriptor or an advertised history or provider-wide discovery operation has no
implementation, and checks `accountReset` against the account reader. When the provider
opens a session, composition rejects the session the same way for its thread operations
and stops it before initialization. Shared events form a
discriminated union: each event name requires its application payload at the session port
and adapter emitter. Raw native envelopes cannot be published through that contract.

Loaded-thread discovery lists Shepherd's live sessions and adds threads from providers
that report threads loaded outside Shepherd (the optional `listLoadedThreads` port
method; Codex implements it, Claude does not), persisting their owners. Stored-thread listing always merges through
application pagination, even for one provider; shared cursors retain forward and backward
positions and validate the listing filters. Native cursor compatibility paths are removed. Turn and
item pages use opaque provider cursors: `nextCursor` is required, while `backwardsCursor` is
optional (Codex returns one; Claude returns null). Surfaces page back by revisiting forward
cursors they already received, so they never depend on it.
Discord list controls keep these opaque cursors in a bounded, expiring server-side map so
button IDs stay within Discord limits.

Thread ownership is persisted independently of UI handles using arbitrary provider IDs.

Default-provider configuration accepts the same opaque IDs as registration, including
namespaced and Unicode identities. Composition rejects a default that is not registered.

Web resume accepts bounded opaque application identities, including scoped identities,
without interpreting them as filesystem paths. Registered ownership and the saved
workspace determine recovery; identity spelling never supplies a workspace path.

Registrations expose provider-local thread IDs by default. Composition translates them to stable, provider-scoped application IDs across execution, stored/loaded history, native ownership discovery, event delivery/replay, nested question targets, and application tool calls. Existing installed adapters explicitly use `threadIdentity: "application"` to preserve deployed globally unique IDs. Adapters opting into application identities must guarantee global uniqueness and avoid the reserved `shepherd-thread:` namespace. Provider-local approval IDs may be reused after resolution. Core assigns an immutable application
handle to each request occurrence, keeps prior occurrences retired, and translates decisions back to
the native ID only for the owning session. Discord buttons, HTTP decisions and replay use these
application handles. Duplicate request events do not create another occurrence. Provider approval
follow-ups carrying reused IDs must identify their request with `requestEventId` (the originating
`approval.requested` event ID), or a `turnId` that uniquely identifies the occurrence. Ambiguous
uncorrelated follow-ups are ignored; host decisions complete their captured application occurrence.
For an unbound stored conversation, registered adapters identify ownership from native
records; exactly one match is required and the binding is then persisted. Unknown or
ambiguous identities fail rather than guessing a default provider or inspecting an ID
prefix in shared code. Existing bindings remain immutable. Claude's session does not record
the policy profile, so resume and fork run within the requested policy or the host's. Provider-native transcripts remain adapter-owned. Web navigation
handles and SSE replay are volatile; persisted history is the recovery source. Reconnecting
never automatically resends a prompt.

## Verification

Architecture tests forbid provider dependencies and fixed provider identities in core
and shared contracts, forbid adapters from importing core services, and reject Codex wire
values (such as `agentMessage`, `inputText`, `final_answer`) and field names (such as
`modelProvider`, `cachedInputTokens`, `developerInstructions`) in shared contracts, core,
surfaces, and the UI. Contract checks forbid native account/notification fields at the
session boundary and native item, input, tool-output, and metadata shapes in shared types. Adapter tests cover native codecs, permission responses, cancellation,
questions, model catalogs, history, SDK process ownership, and account limits.

Shared workflow tests register an unrelated provider without a native compatibility
session and resume it after restart through production registration and file storage. Web tests retain origin checks, bounded streams, pagination, mutation locks,
image safety, settings, approvals, and conversation management. Firefox checks exercise
desktop and mobile presentation using an isolated local fixture. These fixture checks do
not establish successful live-provider sandbox execution or remote deployment health.

### Workspace requirement

Provider sessions represent local coding agents. `ThreadBootstrapInfo.cwd` is
required for create, resume and fork and contains the adapter's effective local
workspace, including its resolved defaults or saved workspace. Core rejects missing
or blank workspaces before registering a session and keeps it current from
`thread.settings.changed`. An omitted request `cwd` asks the adapter to resolve its workspace; it does
not request a workspace-free thread. Historical listing metadata may be incomplete,
but a live bootstrapped thread must satisfy this requirement.

Opaque thread identities use stable, bounded directory hashes; existing UUID directory names stay unchanged. Surfaces name a new conversation's workspace after its thread when the provider can
move a thread into a workspace after creation (`workspaceChange`). A provider without
that capability gets its workspace provisioned first, under a generated name, and starts
the thread there; forks follow the same rule. Setting a thread's workspace to its current
value is not a workspace change, so resuming in the saved workspace never requires it.

Workspace provisioning checks fork support before creating directories or cloning. Failed bootstrap and partial-clone attempts remove only dedicated directories exclusively created for that attempt. Existing workspaces and configured shared project roots are preserved. Once a thread bootstraps successfully, its workspace remains available for recovery even if surface binding fails.

Account reset support comes only from `ProviderCapabilities.accountReset`; the account snapshot reports counts and individual-credit availability. Installed-provider metadata, config notices, and runtime factories come from one composition table, and the config-notice helper accepts arbitrary registrations without starting sessions.
