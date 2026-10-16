# Web API

The web surface serves the built-in UI and a private conversation API from the
same loopback listener. It runs alone or alongside Discord using the shared core.
It supports text and image input, conversation management and history, live events,
approvals, structured agent questions, model/effort settings, usage, skills, and host restart/deployment controls.
It does not expose arbitrary Codex RPC. See the [surface parity matrix](surface-parity-matrix.md)
for implemented features and differences between surfaces.

## Enable explicitly

Copy `envs/web.env.example` to `envs/web.env` and configure:

```env
SHEPHERD_WEB_PORT=8788
SHEPHERD_WEB_ORIGINS=
```

Set `SHEPHERD_SURFACES=discord,web` in `envs/common.env` (or `web` without Discord).
Run `bun run build` and `bun run check:config`, then restart through the normal
deployment flow.
Configuration validation does not connect or open a listener. Disabled web
configuration is not loaded. Invalid selected configuration or a port collision
fails host startup and cleans up all initialized adapters.

The listener is always `127.0.0.1`; there is no public bind option. Origins are a
comma-separated list of exact browser origins, including scheme and any port,
with no trailing slash or path. HTTPS is required except for loopback development
origins such as `http://localhost:3000`. Wildcards are rejected. The listener’s
actual loopback origins are automatically allowed for local UI use. Remote browser origins must be explicitly configured, including when
same-origin. Request Host must match a local or configured origin’s host;
forwarded headers do not override this. CORS is not authentication.

## Private access and trust

There is no application authentication or token. Network reachability grants full
operator access: listing stored threads, choosing workspaces, submitting agent
work under host policy, and answering approvals or user questions. Local processes on the host and
all clients allowed to reach the endpoint share this access and navigation state.
There is no per-user authorization or isolation.

Tailscale and its access policy are the remote access boundary. Restrict access
to the intended operator clients and expose the API only with private Serve,
never Funnel or a public reverse proxy. Shepherd does not verify Tailscale identity
headers or enforce tailnet policy itself. Browser origin checks reject disallowed
origins before any operation, but non-browser clients can omit or forge Origin;
these checks do not replace network access control.

For remote access, use an already authenticated Tailscale host and client. From
the host checkout, the managed Tailscale CLI can proxy the loopback API privately:

```bash
./deploy/ubuntu/tailscale.sh cli serve --bg http://127.0.0.1:8788
./deploy/ubuntu/tailscale.sh cli serve status
```

Use the HTTPS URL printed by Serve, and allow access only to the intended tailnet
members through tailnet policy. No API token is needed. Serve may
prompt to enable HTTPS for the tailnet. This is an explicit operator step:
Shepherd startup and `!deploy` do not configure Serve. Check existing Serve
configuration before assigning its root route. Do not enable Funnel for this API.
To remove this HTTPS listener, use `./deploy/ubuntu/tailscale.sh cli serve
--https=443 off` after checking status and ensuring no other route depends on it.
See [Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve) and
[CLI syntax](https://tailscale.com/docs/reference/tailscale-cli/serve).

A merge or redeploy alone leaves the existing Discord-only selection intact.
Tailscale authentication and daemon supervision remain independent of Shepherd's
lifecycle. Origin configuration changes take effect at the next host restart.

## HTTP contract

All paths below are relative to `/api`. JSON request bodies require
`Content-Type: application/json`. Unknown body fields are rejected. Shared
TypeScript response/event types are in `shared/protocol/web.ts` and its imported
protocol files. Error responses are `{ "error": { "code": "...", "message": "..." } }`.

| Method | Path | Body or result |
| --- | --- | --- |
| GET | `/health` | `{ ok: true }`; availability, not downstream readiness |
| GET | `/models?cursor=...&limit=100` | Provider catalog; optional `provider=<registered-id>` defaults to the configured default provider. Includes hidden model aliases and supports pagination. Conversation-scoped catalogs use the attached provider. |
| GET | `/providers` | Registered provider IDs, display names, `isDefault`, and capabilities |
| GET | `/limits?provider=<id>&refresh=true` | `ProviderAccountLimits` for any registered provider. Provider defaults to the configured default provider; refresh is optional. No conversation needed. |
| POST | `/limits/reset` | `{ provider, idempotencyKey, creditId? }` → `{ outcome }`; requires the provider’s reset capability. Query parameters are rejected. |
| GET | `/threads?cursor=...&limit=20&archived=false` | Stored thread summaries and pagination cursors; archived defaults to false |
| GET | `/conversations` | `{ conversations: [{ id, threadId, project }] }` |
| POST | `/conversations` | `{ project, provider? }` creates a thread (provider defaults to the configured default provider); `{ threadId }` resumes its saved workspace/provider; 201 with `{ id, threadId, project }` |
| GET | `/conversations/:id` | Handle summary plus `state` with active-turn/session state |
| DELETE | `/conversations/:id` | Detaches the handle and closes streams; `{ ok: true }` |
| POST | `/conversations/:id/rename` | `{ name }`; rename through shared controls, `{ ok: true }` |
| POST | `/conversations/:id/archive` | `{}`; archive and detach the web handle, `{ ok: true }` |
| POST | `/conversations/:id/fork` | `{}`; 201 with a new `WebConversation`; source remains attached |
| POST | `/threads/:threadId/unarchive` | `{}`; restore a stored conversation without attaching it |
| POST | `/conversations/:id/messages` | `{ text }`; returns `{ type: "submit" or "steer", threadId, turnId }` |
| POST | `/conversations/:id/interrupt` | `{ turnId? }`; `{ ok: true }` |
| GET | `/conversations/:id/turns?cursor=...&limit=20` | Full persisted turns and pagination cursors |
| GET | `/conversations/:id/settings` | `{ model, effort }`; current/pending settings and supported effort levels |
| GET | `/conversations/:id/models?cursor=...&limit=20` | Available model page with `data` and `nextCursor` |
| POST | `/conversations/:id/model` | `{ model }`; resolve model ID/name through shared controls; `{ ok: true }` |
| POST | `/conversations/:id/effort` | `{ effort }`; opaque effort string, `{ "mode": "default" }`, or `null` to clear; `{ ok: true }` |
| GET | `/conversations/:id/context` | `{ threadId, tokenUsage }`; telemetry may be null |
| GET | `/conversations/:id/approvals` | `{ approvals: [...] }` with choices/status and optional `userInput` question request |
| POST | `/conversations/:id/approvals/:approvalId` | `{ decision, reason?, answers? }`; `{ ok: true }` |
| GET | `/conversations/:id/events` | SSE stream; optional `Last-Event-ID` |

`project` is required only for new conversations and accepts the shared project-target
syntax (`owner/repo`, `~/path`, or `~`). Resume takes `threadId` and uses the saved
absolute working directory and provider; a provider override on resume is rejected.
A project override on resume is ignored; the saved workspace always wins. Loaded
threads retain their current cwd. Cold resume validates the saved directory without
creating or cloning a replacement; missing/invalid directories return 409
`workspace_unavailable`. The resumed handle's `project` displays its restored cwd.
The selector and expired-handle recovery resume directly without a project dialog.
Fork inherits the source handle's project target internally, including restored
absolute local workspace targets.

Messages follow the same submit/steer policy as Discord: a message during an
active turn steers it. HTTP completion acknowledges routing, not completion of
the agent's response. Use events/history to follow the result. There is no
idempotency key in the API: do not blindly retry a message after losing its HTTP
response; inspect state/history first. Competing mutations on one handle return
`409 conversation_busy`.

Approval IDs are URL-encoded path components. Choices carry opaque request-scoped tokens and shared allow/deny/answer/cancel intent. Send an exact `choices[].value`
from a pending approval. Invalid choices return 400 without consuming it; missing
approvals return 404; already-decided approvals return 409. Approvals must belong
to the handle's thread.

### Structured user questions

The existing approvals routes carry Codex `item/tool/requestUserInput` requests
and Claude `AskUserQuestion` callbacks through the same shared question contract.
Records include `userInput: { threadId, turnId, itemId, isBlocking, questions }`;
each question has `id`, `header`, `question`, `isOther`, optional `multiSelect` and `isSecret`, and nullable
`options: [{ label, description }]`. Use `status === "pending"` to decide whether
the request can still be answered. Submit to the record's `approvalId` using:

```json
{
  "decision": "<value of the offered answer choice>",
  "answers": {
    "provider": ["Select per conversation (Recommended)"],
    "notes": ["Remember my last choice."]
  }
}
```

Use exact question IDs and one nonempty string per question unless `multiSelect`
is true. Missing/false `multiSelect` means a single answer; true accepts 1–100
distinct nonempty strings in the answer array. Each string is at most 16,000
characters. Custom text is accepted for free-text questions or when `isOther`
is true; otherwise use an exact option label. Missing/extra IDs, empty answers,
and disallowed choices return `400 invalid_decision` without consuming the
request. The overall 64 KiB body limit still applies. Already answered or expired
requests return `409 approval_decided`. Cross-thread/missing IDs return
`404 approval_not_found`.

To explicitly skip, send the token from the offered choice with `intent: "cancel"`. Shepherd returns an empty
answer map to Codex or denies the Claude question callback, without selecting an
option. It does not interpret ordinary
chat messages as answers to this form. Submitted answer text is not copied into
approval records or bridge events.

Requests remain pending until submitted/skipped, the turn ends, the session
stops, Codex withdraws the request with `serverRequest/resolved`, or Claude aborts
the callback. The provider's `isBlocking` flag governs whether the agent waits;
Claude questions always block. Shepherd starts no answer timer.
Refresh the approvals snapshot on reconnect and after decision/lifecycle events.
Pending question records are process-local, not a durable journal. They count as
pending decisions for the existing conversation and host lifecycle guards.

See [question workflows and screenshots](user-questions.md) for the built-in UI
and Discord limits. MCP elicitation remains a separate unsupported request type.

Before the first user message, a newly created thread has no persisted history.
Its first turns page returns 200 with empty `data` and null pagination cursors.
This applies only to Codex's explicit not-yet-materialized thread response;
missing threads, invalid cursors and other backend failures remain errors.

## Event and restart recovery

Use streaming `fetch` to supply a saved `Last-Event-ID` explicitly, or native
EventSource for its automatic reconnection. Neither needs credentials. SSE has `id`, `event` and JSON `data` fields. Events are:

- `bridge`: the shared `BridgeEvent` union, including agent deltas, completion,
  errors and pending decision notifications, including `approval.expired` for
  withdrawn user questions.
- `signal`: a shared `SignalEnvelope` delivered to this surface.
- `reset`: `{ reason: "event_too_large" }`; reload state, history and approvals.

The server sends comment heartbeats every 15 seconds. Save the last processed
SSE ID and send it in `Last-Event-ID` on reconnect. IDs are opaque and scoped to
one conversation. A fresh stream replays retained events. Deduplicate bridge
messages by their event identity when combining them with an existing view.
An unknown/expired replay cursor returns `409 event_cursor_expired`: reconnect
without the cursor, refresh state/history/approvals and reconcile streamed events.
Open the stream before fetching the snapshot so intervening events can be buffered.
The stream is not a durable event log; history is the recovery source.

Browser disconnection does not interrupt agent work. Detaching a handle releases
its bindings, subscriptions and replay buffer; it does not archive, cancel or
stop the underlying provider session. Interrupt first if that is intended. A host
restart discards all handles and replay cursors. List stored threads and POST a
new handle using the desired thread ID after restart.

## Provider support

`GET /api/providers` returns capabilities for each registered agent. In addition to
questions, skills, fork, compact, revert and `accountReset`, descriptors advertise `steer`,
`interrupt`, `rename`, `archive`, `unarchive`, `workspaceChange`, `modelCatalog`,
`modelSelection`, `effortSelection`, `skillConfig`, `policyProfiles`, `inputKinds`, and
`imageDetail`. Input kinds are
`text`, `image` (URL or data URL), `image_file`, `audio`, `audio_file`, and `skill`.
Image inputs may set `detail` to `low`, `high`, or `full` (no downscaling) when
`imageDetail` is true; omit it to let the provider choose.
Thread state exposes the same session capabilities. `skills` controls discovery;
`skillConfig` controls configuration writes. A catalog can be read-only; model and effort
selection require a catalog. Flags describe adapter support, while
model capabilities constrain the selected model. Missing catalog metadata remains unknown.
Unsupported operations/settings produce `422 unsupported_provider_operation` before execution.
Create, resume and fork accept an optional `policy` of `{ writes, network, review }`
(see [provider adapters](provider-abstraction.md#configuration-and-persistence)); without one
the host's `SHEPHERD_POLICY` applies. Thread state reports `policy` as the provider profile
and its restrictions, or null when the agent uses its own defaults. Native policy spellings,
granular SDK policy objects, and the removed `approvalPolicy` and `sandbox` fields are rejected. Shared internal thread
requests use typed `effort` rather than a raw SDK configuration object. Native configuration,
model backend selectors, and native listing/database filters remain adapter-owned.

## Limits and failure handling

Request bodies are capped at 64 KiB and prompts at 32,768 characters. There are
at most 32 concurrent requests and 32 attached/provisional handles. Each handle
supports four SSE clients and retains up to 256 events or 128 KiB, whichever is
reached first. An event larger than that buffer becomes a reset notification.
Each stream has a bounded 256 KiB application queue; slow readers are disconnected
and can reconnect. Detached underlying sessions remain owned by the host until
shutdown, so handle limits are not a total session budget.

Pagination limits are 1–100. Limit exhaustion returns 429, shutdown returns 503,
and unclassified backend failures return a sanitized 502 with details in host
logs. Oversized requests may be rejected by Bun before application routing and
therefore are not guaranteed a JSON error body. All application responses use
`Cache-Control: no-store`.

Shutdown quiesces ingress, closes streams/listener and lets the shared host stop
all sessions, including sessions still initializing. A web adapter never stops
the other adapters itself. Tests cover browser-origin checks, route
validation, concurrent mutations, replay/backpressure, real loopback sockets,
shared host operation and pending-session cleanup. Live Codex credentials and a
remote tailnet connection are not required by these automated tests.

## Turn activity and images

How the browser presents these items is described in [Web UI](web-ui.md#transcript-work-and-images).

History items have an application `type`: `user_message` (with `content` parts `text`,
`image`, `image_file`, or `attachment`), `assistant_message` (with `text` and an optional
`phase` of `interim` or `final`), `plan`, `reasoning`, `activity`, `image`, or `other`.
Turn `status` is `completed`, `interrupted`, `failed`, or `in_progress`.
Activity items carry `status` (`started`, `completed` or `failed`) and a typed `activity`.
Image items carry `webImage: { url, prompt, name, path, kind }` instead of a server path.
Live turns stream the same items over SSE: `item.started` for items that take time,
`item.delta` for streamed text (`channel` is `message`, `plan`, `reasoning` or `output`; a
reasoning delta may name its summary `part`), and
`item.completed` with the canonical item. Live items are presented exactly as history presents
them, including the scoped image URL, so a reload shows what the live view showed. The browser
uses these fields for the work timeline and image previews; it does not request files by
filesystem path. Plan and reasoning deltas show as running steps until their item completes;
`output` shows the latest output of a running step and is not kept once the step completes,
because history records none.

`GET /conversations/:id/images/:assetId` serves only an artifact registered from a
provider image event or that conversation's stored history. IDs are opaque and
scoped to the attached conversation. Origin/host checks and the private network
boundary apply to images too. Responses are non-cacheable, with verified raster
MIME types and nosniff. PNG, JPEG, GIF and WebP files up to 10 MiB are supported by
the shared loader used for Discord. No SVG/HTML or arbitrary file endpoint exists.
Each handle retains at most 256 image references; detach/restart discards them.
Reloading the relevant history registers images again. Unknown references return
404; missing, oversized or unsupported files return sanitized 422 errors.

## Conversation settings

`GET /api/models` lists the selected/default provider’s normal model catalog, with cursor and limit pagination. Optional `includeHidden=true` also lists models omitted from the normal picker. Hidden does not mean forbidden: explicit model-ID validation includes hidden entries so saved selections remain usable. Duplicate or invalid boolean filters return 400.

Model and effort routes delegate to the same control service as Discord. They
queue changes for the next new turn and subsequent turns; steering an active
turn does not apply them. `settings` distinguishes current and pending values.
Effort choices/default belong to the pending model when present, otherwise the
current/default model. Changing the model does not silently rewrite an existing
effort override; select a compatible effort or clear it if necessary. An effort
string selects that exact provider value, including `default`. `{ "mode": "default" }`
resolves the model's advertised default; `null` queues an explicit clear. Settings
report `pendingEffortClear` to distinguish clearing from leaving effort unchanged.
Discord uses `!effort set <level>`, `!effort default`, and `!effort clear`.

Masked answers (`isSecret: true`) use password inputs; omitting the flag uses a normal answer field. Masking does not encrypt answers or change provider storage.

Unknown models and unsupported effort return 400 with stable error codes;
unavailable model metadata returns 409. Writes share the conversation mutation
lock with sending, interrupting and detaching (409 when busy). Malformed bodies
and extra fields are rejected. Unexpected backend failures remain sanitized 502
responses. A failed usage read does not prevent unrelated settings requests.

Model/effort overrides follow existing loaded-session lifetime rules; the web
surface adds no persistence or global defaults. `accountReset` in the provider descriptor is the sole operation-support flag; account `resets` contains availability counts and credits, not a second support flag. Account limits are provider data
and may be incomplete/unavailable. They are host account allowances shared across
conversations. Codex exposes reported usage buckets and banked reset counts/details.
The [Usage & limits panel](web-ui.md#usage-and-limits) presents both providers.


Claude returns the shared `ProviderAccountLimits` DTO: provider, account plan/auth
mode, availability, source, last check time, allowance windows, extra usage status
and a safe explanatory message. Each window has a reported percentage (nullable),
reset time (nullable), status (nullable), observation time and stale flag. Extra
usage has its own observation time and stale flag. No credentials, email or native
account IDs are exposed. API accounts report subscription limits as not applicable.

The Claude reader uses an experimental native SDK control with no model prompt,
project settings, tools or MCP servers. It coalesces reads across callers, caches
for 30 seconds, limits manual refreshes to one per five seconds and times out after
ten seconds. Native conversation events also update the same account snapshot. Failed
reads retain last reported values with stale labels. Unknown percentages remain
unknown; passed reset times never imply zero usage. Data older than 120 seconds
is stale. Account or credential changes discard the previous account snapshot.
Unknown, duplicate or malformed limits query parameters return 400.

Codex reset redemption uses `account/rateLimitResetCredit/consume`. The request key must
be non-empty (maximum 100 characters); an optional non-empty credit ID (maximum
256 characters) selects a particular reset. Without an ID, Codex selects the next
available reset. Shared outcomes are `reset`, `already_redeemed`, `nothing_to_reset`, and
`no_credit`. Read `/limits` after a known result. Retry an unknown result with the
same key; never generate a new key for the same attempt. Malformed bodies
and extra fields return 400; backend failures remain sanitized 502 responses.

## Conversation management

Rename accepts a non-empty trimmed name of at most 200 characters. Archive
uses the shared archive operation, then closes the handle's streams and removes
its web navigation state. It does not delete stored history. Restore uses the
opaque stored thread ID and does not require creating a web handle first.

Fork creates a new handle using the source handle's selected project and the
shared fork operation. It returns the new handle without detaching or changing
the source. Provisional handles are cleaned up on failure, and the normal
32-handle limit applies. The source's conversation mutation lock covers the fork.
Archive and fork return `409 conversation_active` while a turn or approval is
active; stop/resolve it first. Rename remains available during a turn. Restore
shares an existing handle's mutation lock when the thread is attached.

`archived` accepts only `true` or `false`; pagination remains independent for each
list view. There is no idempotency key for fork: after losing an HTTP response,
refresh the conversation list before retrying to avoid duplicate forks.

### Skills

The attached conversation exposes `GET /api/conversations/:id/skills` returning
`SkillsListResponse`: `{ workspacePath, skills, errors }`, where `workspacePath` is the
conversation's effective workspace, `skills` lists names, descriptions, paths, scopes and
effective enabled state, and `errors` lists skill files that could not be loaded. Workspace selection comes from the
shared conversation service, not a client-supplied directory.

Discovery is scoped to the conversation’s effective workspace; clients cannot override it with arbitrary directories. The provider port receives one `workspacePath` and an optional refresh preference, and returns `{ skills, errors }`; core adds the workspace. Codex's per-directory grouping is merged inside its adapter.

`POST /api/conversations/:id/skills-reload` with `{}` repeats discovery with
`refresh: true` and returns the same shape. `POST /api/conversations/:id/skills`
with `{ "path": "/absolute/skill/SKILL.md", "enabled": false }` uses the same shared
`skill.set-enabled` action as Discord and returns the resulting state, such as `{ "enabled": false }`.
The action also supports the shared name resolution semantics; the UI always sends
the listed path to distinguish duplicate names. Unknown/ambiguous names return 400.
Both writes share the conversation mutation lock and existing origin/host checks.

Skill configuration is shared provider configuration, not a per-conversation override.
Effective state can differ from the requested value. Reload discovery after changing
skill files; it does not install skills or restart the host.

### Compaction and revert

`POST /api/conversations/:id/compact` with `{}` starts compaction through the
shared `thread.compact` control action. `{ "ok": true }` means the start request
was accepted, not that compaction finished. Existing turn/activity events report
progress and failures.

`POST /api/conversations/:id/revert` with `{ "beforeTurnId": "turn-id" }`
removes that turn and all later turns through shared `thread.revert` and provider
`thread/revert`. `beforeTurnId` must be a non-empty string of at most 256 characters.
The attached thread is fixed by the conversation handle; clients cannot override it.
The provider validates that the turn belongs to that thread. This changes persisted
conversation history, not files, commands, or other side effects. Both history
mutation endpoints use the conversation mutation lock and reject active turns or
pending approvals with 409. The old `/rollback` route is removed and returns 404.

History responses include a per-handle `revision`. After each attempted upstream
revert, including a potentially ambiguous failure, the revision increments and
the event feed discards prior replay before publishing `reset` with reason
`history_changed`. Provider `thread/reverted` notifications also invalidate history for connected clients,
including changes initiated outside the web API. A notification received during the
local mutation supplies the same reset without duplicating it on completion.
History reads spanning that change return 409 `history_changed`.
Clients must replace cached history and pagination on reset/revision changes; merging
would retain removed turns. Old event cursors expire, triggering normal snapshot
recovery. The revision is navigation state, not persistent conversation metadata.

### Host lifecycle controls

`GET /api/host/battery` returns `WebHostBatteryResponse`: `{ battery: { percentage,
status } }`, or `{ battery: null }` when no system battery can be read. Percentage
is an integer from 0 to 100; status is `charging`, `discharging`, `full`,
`not-charging`, or `unknown`. This reads the Shepherd host's Linux/Android sysfs
power supplies, excludes supplies marked with Device scope, and requires neither
a conversation nor lifecycle controls. It follows the same origin checks as other
API routes.

`GET /api/host` returns `WebHostStatus`: web instance identity/start time, lifecycle
availability, the commit captured at host startup, current checkout status, and the
latest web-requested operation. Running and checkout commits can differ while a
validated deployment waits for restart. Startup commit may be unavailable outside a
Git checkout. Checkout status also reflects deployments started on other surfaces.

`POST /api/host/actions` accepts `{ "requestId": "unique-id", "action": "restart" }`
or `{ "requestId": "unique-id", "action": "deploy", "branch": "optional-preview" }`.
Omit branch to deploy stable main. The response is 202 with a `WebHostOperation`;
clients poll host status for starting, validating, restarting, and finished phases.
A finished operation may be a refusal or validation failure; read its message.
The shared runtime lifecycle orchestrator owns active-turn/approval guards,
validation, restoration on failure, quiescing, and restart. No shell command is
constructed by the web adapter.

Accepted operations survive client disconnects. Repeated request IDs with identical
inputs return the recorded operation; conflicting inputs return 409. The journal
retains at most 32 requests within the current web instance. It is not a persistent
restart/deployment audit log. Output is capped at 64,000 characters with an explicit
truncation marker; host logs contain full output. Existing private listener and
Host/Origin protections apply, and no conversation attachment is required.

After process restart, instance identity changes and operation records are gone.
Clients must re-read running/checkout state and must not automatically resend an
uncertain action. A reconnect alone is not proof of a successful deployment.

### Image input

`POST /api/conversations/:id/messages` accepts `{ "text": "Describe this", "images":
["data:image/png;base64,..."] }`. `images` is optional; text may be empty when at least
one image is attached. Inputs become the same shared text/image user-input records
used by Discord, for both new turns and steering an active turn.

The web contract allows up to four PNG/JPEG/GIF/WebP images, 5 MiB per image and
10 MiB decoded total. Strict base64 envelopes, declared MIME types, and raster
signatures are checked before forwarding. Remote image URLs, local file paths,
SVG, and unsupported formats are rejected. Image signatures share the same detector
as Discord input and generated-image loading. Signature detection does not fully
decode/re-encode the image.

Only the message route accepts the larger bounded JSON envelope needed for base64;
other route bodies remain capped at 64 KiB. The listener accommodates that larger
envelope, while the API limits concurrent message processing to two and uses the
existing per-conversation mutation lock. Oversized input returns 413; invalid image
content/count returns 400. No temporary upload files or separate public URLs are
created. Images are stored as part of provider conversation history.

User-message history preserves bounded valid inline images for previews. Unsupported
or remote image URLs become an unavailable-image placeholder, never a browser fetch.

Model catalog rows include the shared `ModelCapabilities` fields: `inputModalities`
(`text`, `image`, `audio`, or `null` when unreported), `supportedEfforts`, and
`defaultEffort`. `GET /api/conversations/:id/settings` also returns
`modelCapabilities.current` and `modelCapabilities.next`; these differ when a model
change is pending. The active turn continues to use the current model. Unsupported
model media returns HTTP 422 with `unsupported_model_input`; adapter restrictions
still return `unsupported_provider_operation`.

### Conversation list freshness

Stored conversation pages explicitly use `updated_at` descending, matching Discord
`!threads`, including archived and later pages. Active means not archived, not
currently running.

Stored-thread summaries include `provider` and `canUnarchive`; Restore is disabled
when the owning provider cannot unarchive. Stored and loaded listings can return
`unavailableProviders` with partial results. Stored-list cursors retain that notice
until the first page is reloaded, which retries the unavailable providers.

## Independent provider metadata

Provider descriptors expose `accountReporting`; a provider without an account reader returns an unsupported-operation error from `/limits`, and clients should omit reporting requests for it. `signedIn: null` means login state is unknown.

Conversation model discovery uses the attached session. Model/effort selection does not require discovery: clients can submit opaque selections to adapters without catalogs. Unknown current/default models remain null, `supportedEfforts: null` means effort metadata is unreported, and `effortOptionsKnown: false` distinguishes unknown options from a reported empty set. Known catalog constraints remain enforced. `modelCatalogAuthoritative` determines whether unlisted selections are rejected by shared controls; advisory catalogs also permit custom IDs in the picker. `modelCatalogScope` specifies whether bootstrap can validate before provider execution or needs the newly established conversation context.

Token input/output/total counts may be null. `last` and `total` token breakdowns may each be null; cumulative-only reports remain usable. Thread IDs exposed to clients are application identities, not native provider handles. Provider-local IDs are scoped at registration; approval IDs are scoped to their thread.
