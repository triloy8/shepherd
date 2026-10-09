# Web UI

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

All paths below are relative to `/api/v1`. JSON request bodies require
`Content-Type: application/json`. Unknown body fields are rejected. Shared
TypeScript response/event types are in `shared/protocol/web.ts` and its imported
protocol files. Error responses are `{ "error": { "code": "...", "message": "..." } }`.

| Method | Path | Body or result |
| --- | --- | --- |
| GET | `/health` | `{ ok: true, apiVersion: 1 }`; availability, not downstream readiness |
| GET | `/models?cursor=...&limit=100` | Account-wide model catalog; includes hidden quota aliases and supports pagination |
| GET | `/limits` | `{ rateLimits, rateLimitsByLimitId, rateLimitResetCredits }`; account-wide usage and banked resets |
| POST | `/limits/reset` | `{ idempotencyKey, creditId? }` → `{ outcome }`; redeem one banked reset |
| GET | `/threads?cursor=...&limit=20&archived=false` | Stored thread summaries and pagination cursors; archived defaults to false |
| GET | `/conversations` | `{ conversations: [{ id, threadId, project }] }` |
| POST | `/conversations` | `{ project }` creates a thread; `{ threadId }` resumes its saved workspace; 201 with `{ id, threadId, project }` |
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
| POST | `/conversations/:id/effort` | `{ effort }`; supported level or `default`; `{ ok: true }` |
| GET | `/conversations/:id/context` | `{ threadId, tokenUsage }`; telemetry may be null |
| GET | `/conversations/:id/approvals` | `{ approvals: [...] }` with choices/status and optional `userInput` question request |
| POST | `/conversations/:id/approvals/:approvalId` | `{ decision, reason?, answers? }`; `{ ok: true }` |
| GET | `/conversations/:id/events` | SSE stream; optional `Last-Event-ID` |

`project` is required only for new conversations and accepts the shared project-target
syntax (`owner/repo`, `~/path`, or `~`). Resume takes `threadId` and uses the saved
absolute working directory; a legacy `project` field on resume is ignored. Loaded
threads retain their current cwd. Cold resume validates the saved directory without
creating or cloning a replacement; missing/invalid directories return 409
`workspace_unavailable`. The resumed handle's `project` displays its restored cwd.
The selector and expired-handle recovery resume directly without a project dialog.
Fork inherits the source handle's project target internally, including restored
absolute local workspace targets.

Messages follow the same submit/steer policy as Discord: a message during an
active turn steers it. HTTP completion acknowledges routing, not completion of
the agent's response. Use events/history to follow the result. There is no
idempotency key in v1: do not blindly retry a message after losing its HTTP
response; inspect state/history first. Competing mutations on one handle return
`409 conversation_busy`.

Approval IDs are URL-encoded path components. Send an exact `choices[].value`
from a pending approval. Invalid choices return 400 without consuming it; missing
approvals return 404; already-decided approvals return 409. Approvals must belong
to the handle's thread.

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
stop the underlying Codex session. Interrupt first if that is intended. A host
restart discards all handles and replay cursors. List stored threads and POST a
new handle using the desired thread ID after restart.

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

Completed work remains collapsible even when a tool step failed. The work summary
shows the number of failed steps; expand it to inspect their details. Failed or
interrupted turns themselves retain expanded progress.

History items may include `webActivity` (the shared normalized activity payload)
or `webImage: { url, prompt, name, path, kind }`. Generated-image and viewed-image SSE events
(`turn.image.generated` and `turn.image.viewed`) include the same scoped asset URL
as `payload.url` and the file basename as `payload.name`. The browser uses these
fields for the work timeline and image previews; it does not request files by
filesystem path.

Completed Codex `imageView` items expose the existing local image, including
Playwright screenshots opened with `view_image`. Viewed images (`kind: "viewed"`)
are work artifacts: their previews are collapsed by default while working and fold
with completed work. Expand **Viewed image** to inspect them at full size.
Images explicitly embedded in assistant answers stay visible. Reloading history
restores the same behavior while source files remain available. Failed or unfinished view
items remain activity only; inspecting an image makes it visible to the web user.
Generated images appear immediately as assistant output, grouped with the following
final text under one Shepherd author label. Generation prompts live under a closed
**Generation details** disclosure. This also supports image-only responses and
history reload. Viewed work images use their filenames.

Assistant answers can embed registered images with Markdown, for example
`![Desktop view](/absolute/path/to/screenshot.png)`. The renderer resolves the exact
local source path (including URL-encoded paths) to its known conversation asset
URL. Plain links to registered images resolve to the same full-size asset. Images
remain inside the assistant message with their Markdown alt text as a caption.
Unregistered local paths, remote images, and arbitrary asset URLs remain image
placeholders; Markdown never registers or reads a new file. References to older
images work when their artifact metadata is loaded in the current conversation.

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

Model and effort routes delegate to the same control service as Discord. They
queue changes for the next new turn and subsequent turns; steering an active
turn does not apply them. `settings` distinguishes current and pending values.
Effort choices/default belong to the pending model when present, otherwise the
current/default model. Changing the model does not silently rewrite an existing
effort override; select a compatible effort if necessary. `default` resolves to
the model's advertised default, matching Discord.

Unknown models and unsupported effort return 400 with stable error codes;
unavailable model metadata returns 409. Writes share the conversation mutation
lock with sending, interrupting and detaching (409 when busy). Malformed bodies
and extra fields are rejected. Unexpected backend failures remain sanitized 502
responses. A failed usage read does not prevent unrelated settings requests.

Model/effort overrides follow existing loaded-session lifetime rules; the web
surface adds no persistence or global defaults. Account limits are provider data
and may be incomplete/unavailable. The sidebar **Usage & limits** panel exposes
all reported usage buckets and banked reset counts/details. Bucket titles use the
model catalog display name matched by `normalModelSlug`, then the provider's
`limitName`, then a humanized internal ID. When a model name and distinct quota
label are both present, the quota label is shown beneath the title. Optional
catalog failures leave usage and reset controls available. Conversation settings
retain context telemetry, which can be null before a turn.

Reset redemption uses `account/rateLimitResetCredit/consume`. The request key must
be non-empty (maximum 100 characters); an optional non-empty credit ID (maximum
256 characters) selects a particular reset. Without an ID, Codex selects the next
available reset. Outcomes are `reset`, `alreadyRedeemed`, `nothingToReset`, and
`noCredit`. Read `/limits` after a known result. Retry an unknown result with the
same key; never generate a new key for the same attempt. The built-in UI retains
both the request key and selected credit ID in session storage across reloads in
the same tab. Each available, unexpired, supported detail row has a **Use this
reset** button. While an outcome is unknown, only retrying that original attempt
is allowed. If details are count-only or capped, **Use next available reset**
lets Codex choose from its available inventory; the UI does not assume
an expiry ordering. Malformed bodies
and extra fields return 400; backend failures remain sanitized 502 responses.
Reset controls work without a selected conversation.

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

## Conversation management

**Conversation menu → Conversation actions** provides Rename, Fork conversation and
Archive conversation. Renaming updates the title and list. Forking selects the
new conversation while preserving the source, its handle and its draft. Archive
asks for confirmation, clears the local selection and detaches the web handle;
it does not delete history. Archive and fork are disabled during active work or
pending approvals, with the same check enforced by the API.

The sidebar has Active and Archived views. Archived rows offer Restore; restoring
returns to Active without automatically attaching the restored thread. Select it
to resume normally. Pagination and delayed responses are scoped to the chosen
view so switching filters cannot mix lists. The currently open conversation keeps
its title while browsing the other view. Other clients sharing an archived handle
will need to refresh and restore/resume it before sending again.

After an uncertain fork response, refresh the conversation list before retrying.
The UI does not automatically retry management writes. These controls use the
shared core thread operations; they add no separate conversation storage.

### Skills controls

Conversation settings includes a collapsible **Skills** section. It lists workspace
skills with descriptions, scope, effective enabled state, and expandable paths.
Filter by name, description, scope, or path; discovery errors remain visible even
when filtering. Enable/disable uses the exact listed path, so duplicate names in
different scopes remain distinct. Changes use the shared Discord control action and
can affect other conversations through shared Codex configuration.

**Reload skills** refreshes discovery after installation or file changes. The UI
reports effective-state overrides, distinguishes empty discovery from failure, and
requires reloading after a failed update before offering another toggle. Requests
from a closed settings panel cannot overwrite a newly opened panel. This adds no
skill installation, file editing, or per-conversation configuration semantics.

### Markdown diagrams

Assistant responses and draft previews render fenced `mermaid` code blocks as
diagrams, including flowcharts and sequence diagrams. **Show source** switches
to the original diagram code, and **Copy** copies that source in either view.

Incomplete, invalid, or oversized diagrams display their source instead. Rendering
is deferred briefly while text streams. Diagrams use the dark theme, fit the
transcript width, and scroll within their container on narrow screens. Diagram
links are disabled; SVG images isolate diagram styles from the surrounding UI.

### Answering agent questions

Structured Codex questions appear as a form in the selected transcript. Blocking
requests display **Waiting for your answer** and suppress the working/writing
indicators while the request is pending. Nonblocking requests display **Shepherd
has a question** while the agent continues working.

Select an option, choose **Write another answer** when custom text is allowed, or
fill a free-text field. Secret answers use a password input. No option is selected
automatically; **Submit answers** stays disabled until every question has a
nonempty answer. Multiple questions submit together. **Skip questions** explicitly
returns no answers, rather than accepting a recommended choice. Answer and skip
controls are disabled while disconnected or another write is busy.

Reload/reconnect restores pending questions from the API, but unsubmitted answer
drafts are not persisted. Submitted, skipped, withdrawn, interrupted/completed-turn,
and stopped-session requests disappear. A host restart does not restore pending
forms. Ordinary questions in assistant prose do not create interactive requests.
Pending questions use the same lifecycle guards as approvals.

See [desktop/mobile examples](user-questions.md) and the
[API answer contract](web-api.md#structured-user-questions). This feature was
reviewed on 2026-10-09 against `7e30d66` in
[PR #88](https://github.com/triloy8/shepherd/pull/88).

### Compact layout and navigation

The header has a sidebar toggle, a single-line conversation title, a connection
status dot, and **Conversation menu**. Tap the dot or choose **Conversation details**
to see connection state, project path, and thread ID. Settings, conversation actions,
and detach are in the same menu. Arrow keys, Home/End, Enter, and Escape work in the
menu; dialogs return focus to the opener. The desktop sidebar can collapse. On
mobile, the navigation drawer traps focus and hides the transcript from interaction.
Host controls are in the sidebar footer, including when no conversation is selected.
The top bar shows the host battery percentage and charging indicator on Linux/Android
hosts with a readable system battery. It refreshes every 30 seconds while visible
and when returning to the page. Low discharging batteries (20% or less) appear in
amber; unavailable readings are hidden. The tooltip and accessible label identify
this as the host battery, rather than the browser device's battery.

The composer floats over the transcript with inset edges and a subtle bottom fade.
It starts as a single row in a box with rounded corners, with an attachment plus
button on the left and a rounded-square send/interrupt action on the right. Wrapped drafts and image attachments
expand the text area above the controls; long drafts scroll internally at the height
limit. All controls retain 44px touch targets. Routine helper copy is screen-reader-only;
connection state remains visible, and the placeholder identifies follow-up drafts. Images, image errors, and send failures remain visible.

The transcript reserves the measured composer height so the last message is not
covered, including while attaching images or composing a long draft. If following
latest output, composer growth maintains that position; reading older messages
keeps automatic follow disabled. The app follows the visual viewport at normal
zoom, tracking both its height and vertical offset so Safari keyboard panning does
not lift the composer away from the keyboard. The page itself is fixed; transcript
and composer scrolling stay inside their containers. Pinch zoom retains
normal browser behavior. Bottom padding accounts for safe-area insets when the
keyboard is closed; a keyboard-reduced visual viewport uses a tighter 4px gap.

### Compact and revert

**Conversation actions** provides **Compact conversation**. Compaction reports that
it started; timeline activity and turn lifecycle show progress/completion.

Each persisted user message has **Revert from here** under its text beside **Copy**.
Image-only messages also have revert. The action opens a confirmation with the
selected message preview and explains that this turn (including its response) and
all later turns will be removed. File edits, commands, and other side effects are
not undone. Fork first to preserve a copy. Cancel is focused by default.
Optimistic messages without persisted history do not offer revert.

Both compact and revert are disabled during an active turn or pending approvals,
with matching server enforcement. Revert also requires an online connection and
blocks other conversation writes while running. The selected turn ID is passed
directly to the provider; there is no turn-count input or rollback control.

Revert refreshes history by replacement, clears old pagination, and invalidates
prior event replay. Provider `thread/reverted` notifications trigger the same
recovery. Revision checks recover even if a reset event was missed; stale in-flight
history pages cannot restore removed turns. An ambiguous failure prevents another
revert until history is successfully reloaded, even after closing and reopening the
confirmation. A removed selection cannot be submitted. Reload failures keep recovery
pending. Discord `!rollback` is retired with a notice pointing to this web action.

### Host controls

The sidebar’s **Host controls** opens host status, running and checkout commits,
remote refs, restart, and deploy. These controls work without selecting a conversation.
Both actions require confirmation because they affect every surface. Leave the
branch blank for stable main or enter a preview branch; deploy main to return to
stable. Shared lifecycle guards refuse actions while turns or approvals are active.

Deployment runs in the background and status polls show validation progress,
validation failure/restoration details, or restart. Command output is rendered as
plain text in a bounded, scrollable area. The UI remembers its pending request in
session storage and continues checking after closing the dialog or reloading the
page. It never automatically resends a lost request. An unknown outcome requires
checking status before explicitly requesting another action.

When instance identity changes, the UI refreshes status and attempts to resume the
selected stored conversation through the existing API. Drafts in the current page
remain keyed by thread. Resume failures remain visible and the saved selection is
retained for manual recovery. Check running/checkout commits to verify a deployment:
restart alone does not establish success. Detailed operation logs are not persisted
across host restarts; full output remains in host logs.

Existing tabs reconnect without a full page reload. Reload the page when you want
to load newly deployed web UI assets; in-memory unsent drafts do not survive a page
reload.

### Image attachments

The composer supports **Attach images**, clipboard image paste, and file drop.
PNG, JPEG, GIF, and WebP are accepted: up to four images, 5 MiB each, 10 MiB total.
Convert unsupported formats before attaching. Thumbnails show filenames and individual
Remove controls. Send images with text or on their own, including as follow-ups to
an active turn. Conversation history shows inline raster previews alongside the
user message; unsupported historical attachments have a placeholder.

Image drafts are kept per thread when switching conversations or reconnecting in the
current page. Failed sends retain both text and images; inspect the conversation
before retrying an uncertain request. Successful sends clear only submitted
attachments. Draft images are in memory and do not survive a full page reload;
sent attachments are read back from provider history. Image URLs in agent Markdown
remain non-fetching placeholders.

### Conversation history

Each conversation has its own transcript. Use **Load earlier messages** to read
older turns in that transcript. There is no separate turn/item inspector in web;
Discord retains its history commands for navigating conversations within a channel.

### Conversation list freshness

Stored conversation pages explicitly use `updated_at` descending, matching Discord
`!threads`, including archived and later pages. Active means not archived, not
currently running. The web list refreshes after selected-turn activity, when the
page regains focus/visibility, and every 30 seconds while visible. Refresh shows a
busy indicator. Automatic refresh pauses after loading more conversations to avoid
collapsing older pages; manual Refresh returns to the newest page and resumes it.
