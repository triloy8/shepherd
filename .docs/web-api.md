# Web API v1

The `web` surface provides the conversation API and [built-in web UI](web-ui.md).
It runs alone or beside Discord against the same application core. It does not
provide arbitrary Codex RPC or full Discord command parity. Text prompts,
history, events, interruption and approvals are the initial scope. Attachment
uploads and model/skill/deploy controls are not HTTP routes in v1; generated image output is supported.

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
work under host policy, and answering approvals. Local processes on the host and
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
| GET | `/threads?cursor=...&limit=20` | Stored thread summaries and pagination cursors |
| GET | `/conversations` | `{ conversations: [{ id, threadId, project }] }` |
| POST | `/conversations` | `{ project, threadId? }`; creates a thread or resumes the supplied one; 201 with `{ id, threadId, project }` |
| GET | `/conversations/:id` | Handle summary plus `state` with active-turn/session state |
| DELETE | `/conversations/:id` | Detaches the handle and closes streams; `{ ok: true }` |
| POST | `/conversations/:id/messages` | `{ text }`; returns `{ type: "submit" or "steer", threadId, turnId }` |
| POST | `/conversations/:id/interrupt` | `{ turnId? }`; `{ ok: true }` |
| GET | `/conversations/:id/turns?cursor=...&limit=20` | Full persisted turns and pagination cursors |
| GET | `/conversations/:id/approvals` | `{ approvals: [...] }` with choices and status |
| POST | `/conversations/:id/approvals/:approvalId` | `{ decision, reason? }`; `{ ok: true }` |
| GET | `/conversations/:id/events` | SSE stream; optional `Last-Event-ID` |

`project` accepts the shared project-target syntax (a GitHub `owner/repo`, `~/path`,
or `~`). Provisioning uses existing core workspace rules. A resumed loaded
thread retains its current workspace. The returned `project` is the handle's
selected target, not a guarantee of the loaded thread's cwd. Thread IDs must contain only letters, digits, hyphens or underscores. A thread already
bound to Discord or a different web handle returns `409 thread_in_use`. Detach
there first. Several browsers may share one web handle and its streams.

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
  errors and approval notifications.
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

## Turn activity and generated images

History items may include `webActivity` (the shared normalized activity payload)
or `webImage: { url, prompt }`. Generated-image SSE events include the same scoped
asset URL as `payload.url`. The browser uses these fields for the work timeline
and image previews; it does not request files by filesystem path.

`GET /conversations/:id/images/:assetId` serves only an artifact registered from a
provider image event or that conversation's stored history. IDs are opaque and
scoped to the attached conversation. Origin/host checks and the private network
boundary apply to images too. Responses are non-cacheable, with verified raster
MIME types and nosniff. PNG, JPEG, GIF and WebP files up to 10 MiB are supported by
the shared loader used for Discord. No SVG/HTML or arbitrary file endpoint exists.
Each handle retains at most 256 image references; detach/restart discards them.
Reloading the relevant history registers images again. Unknown references return
404; missing, oversized or unsupported files return sanitized 422 errors.
