# Provider adapters

Shepherd has one application boundary for agent providers. The web UI and Discord
use the same conversation service, shared records, and controls. Codex and Claude
are native implementations behind that boundary. There is one HTTP API at `/api`;
there is no parallel provider API, compatibility facade, or alternative transcript renderer.

## Ownership

- `server/ports/provider_session.ts` defines execution, history, and catalog operations.
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

To add another provider, implement the session port, supply its capabilities and account
reader, and register its factory and ownership resolver at composition. Core and
surface code do not need another provider branch. Provider IDs and model IDs are opaque strings. Discord uses `!providers` for discovery,
with optional provider IDs on `!newthread` and `!limits`; omitted IDs retain existing defaults.

## Execution and presentation

Both adapters emit the existing application `BridgeEvent` stream. Assistant deltas
carry `kind: "assistant_text"`; core and UI never infer their meaning from an SDK method.
Assistant messages carry an optional phase: `interim` progress text or the `final` answer.
Codex maps its OpenAI response phases; Claude marks text before a tool call as interim.
Native notifications stay private. User-facing failures, activities, completed messages,
images, token usage, and background task counts have shared representations. Token counts
that a provider does not report (Codex cache writes, Claude per-request reasoning) are `null`
rather than zero.

Adapters decode stored history before returning it. History records contain application
message content, activities, and image artifacts; web/Discord do not decode native tool
records. Native tool arguments, transport envelopes, and arbitrary thread properties do
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

An approval exposes a prompt, descriptive detail, a kind, and labeled choices. Choice
values are random, request-scoped tokens. Their shared intent is allow, deny, answer,
or cancel. Native reply strings, permission amendments, RPC IDs, and SDK callbacks stay
inside the adapter. Surfaces send the selected token unchanged.

Core validates ownership, pending state, the offered token, and question answers before
claiming a decision. Invalid answers remain retryable. Duplicate replies cannot apply
twice. Terminal turns and native cancellation expire pending interactions. Answers do
not enter approval decision records or event replay. Questions use the existing form;
multiple-choice questions use checkboxes, and secret answers use masked fields.

Discord uses bounded opaque button handles so long thread/choice IDs fit its platform
limit. Its modal handles supported single-answer forms; secret, multi-select, or large
forms direct the user to the web UI.

## Capabilities and account reporting

Unsupported operations are absent from the session port implementation, and the shared
capability descriptor controls their availability. Claude does not provide fake skill,
compact, revert, or reset methods. Core rejects unavailable operations consistently.
Model and effort options come from the selected provider's catalog.

Every account reader returns `ProviderAccountLimits`: account metadata, allowance
windows, extra usage, optional spend controls, optional reset credits, freshness, and
availability. Missing provider data stays unknown. Reset requests use a shared outcome
format and retain the same idempotency key during recovery, scoped by provider.

Claude subscription allowances come from SDK observations and a bounded account read;
API-billed accounts explicitly report subscription allowances as not applicable.
Codex translates its allowance groups and banked credits inside its account adapter.
Neither account reporting nor opening the usage panel sends a user conversation prompt.

## Configuration and persistence

Common policy is configured with `SHEPHERD_APPROVAL_MODE` (`provider_default`,
`review_sensitive`, `review_untrusted`, `bypass`) and `SHEPHERD_SANDBOX_MODE`
(`read_only`, `workspace_write`, `unrestricted`). Model/authentication settings remain
provider-specific inside their adapters. An unavailable sandbox is rejected rather than
silently changing execution privileges.

The shared configuration no longer reads `CODEX_APPROVAL_POLICY` or `CODEX_SANDBOX`.
For existing installations, rename those common settings before redeployment:
`never` → `bypass`, `on-request` → `review_sensitive`, `untrusted` → `review_untrusted`;
`danger-full-access` → `unrestricted`, `workspace-write` → `workspace_write`,
`read-only` → `read_only`. There is no runtime alias or API translator.

Approval and sandbox modes use these same application values throughout core, ports,
and HTTP. Native policy names are encoded and decoded inside adapters. `provider_default`
uses native defaults for a new conversation and inherits the saved mode on resume, fork,
and continuation. Host defaults apply at creation; ordinary surface messages do not
override the saved mode. `review_sensitive` uses
the provider's normal permission review; `review_untrusted` reviews actions according to
its trust model and is currently supported only by Codex. `bypass` suppresses permission
review but retains explicit user questions. None of these modes promises review of every
action. The misleading `review_all` environment value is rejected; use `review_untrusted`
for the previous trust-based behavior. Existing `bypass`/`unrestricted` installations need
no further environment edits.

Shared thread requests offer model, effort, instructions, workspace, sandbox, approval
mode, and optional ephemeral lifetime. `instructions` are added to the provider's default
instructions and never replace them; Codex receives them as developer instructions and
Claude appends them to its preset system prompt. Raw SDK `config`, backend overrides, deprecated
personality selectors, analytics service names, and native database/source filters are
not public fields. Their native configuration remains provider-owned. Unknown request
fields are rejected, not ignored. Model backend configuration belongs in the provider's
native settings. List sorting uses creation or update time across every provider.

Descriptors advertise approval modes, sandbox modes, input kinds,
image-detail controls, and ephemeral-thread support, alongside operation capabilities.
Core checks these before bootstrap, submit, or steer, and adapters enforce them for direct
calls. Claude currently accepts plain text and URL/base64 image inputs; it does not claim
local-file, audio, skill-reference, or image-detail support. Model/effort
options continue to come from each provider's catalog. Thread state includes its provider
and capabilities, so surfaces do not guess support from identity. Registration rejects a
session whose capabilities differ from its descriptor or whose advertised operations
have no implementation, and stops it before initialization. Shared events form a
discriminated union: each event name requires its application payload at the session port
and adapter emitter. Raw native envelopes cannot be published through that contract.

Loaded-thread discovery queries every registered provider, including threads loaded
outside Shepherd, and persists their owners. Stored-thread listing always merges through
application pagination, even for one provider; shared cursors retain forward and backward
positions and validate the listing filters. Native cursor compatibility paths are removed.
Discord list controls keep these opaque cursors in a bounded, expiring server-side map so
button IDs stay within Discord limits.

Thread ownership is persisted independently of UI handles using arbitrary provider IDs.
For an unbound stored conversation, registered adapters identify ownership from native
records; exactly one match is required and the binding is then persisted. Unknown or
ambiguous identities fail rather than guessing a default provider or inspecting an ID
prefix in shared code. Existing bindings remain immutable. Claude snapshots retain the common approval mode
across resume/fork/restart. Older snapshots without this optional field use the provider
default unless a mode is explicitly supplied. Provider-native transcripts remain adapter-owned. Web navigation
handles and SSE replay are volatile; persisted history is the recovery source. Reconnecting
never automatically resends a prompt.

## Verification

Architecture tests forbid provider dependencies and fixed provider identities in core
and shared contracts. Contract checks forbid native account/notification fields at the
session boundary. Adapter tests cover native codecs, permission responses, cancellation,
questions, model catalogs, history, SDK process ownership, and account limits.

Shared workflow tests register an unrelated provider without a native compatibility
session and resume it after restart through production registration and file storage. Web tests retain origin checks, bounded streams, pagination, mutation locks,
image safety, settings, approvals, and conversation management. Firefox checks exercise
desktop and mobile presentation using an isolated local fixture. These fixture checks do
not establish successful live-provider sandbox execution or remote deployment health.
