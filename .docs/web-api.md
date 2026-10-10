# Web API

The web surface serves the built-in UI and a private conversation API from the
same loopback listener. It runs alone or alongside Discord using the shared core.
It supports text and image input, conversation management and history, live events,
approvals, structured agent questions, model/effort settings, usage, skills, and host restart/deployment controls.
The built-in UI retains main’s timeline and conversation behavior through `/api/v1`; its
[current UI contract](archive/web-api-v1.md) is documented separately. The
provider-neutral `/api/v2` API remains available as an additive server interface.
The shipped UI uses v2 only for provider discovery, explicit provider creation,
and account usage/reset controls. Its timeline/history/settings still use v1.
The route and recovery details below describe the v2 API.
“v1” and “v2” name API contracts, not product releases.
It does not expose arbitrary provider RPC. See the [surface parity matrix](surface-parity-matrix.md)
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

Paths below are relative to `/api/v2`. JSON bodies require
`Content-Type: application/json`; unknown fields are rejected. Shared content and
action types live in `shared/protocol/v2/`. Navigation and host types remain in
`shared/protocol/web.ts`. Errors are `{ "error": { "code", "message" } }`.

| Method | Path | Body or result |
| --- | --- | --- |
| GET | `/health` | `{ ok: true, apiVersion: 2 }`; host availability |
| GET | `/providers` | `{ providers: ProviderDescriptor[] }`; IDs, display names, actual capabilities and neutral defaults |
| GET | `/limits?provider=...&refresh=true` | Shared `ProviderAccountLimits`; provider defaults to the first registered provider, refresh is optional |
| POST | `/limits/reset` | `{ provider, idempotencyKey, creditId? }` → snake-case `reset`, `already_redeemed`, `nothing_to_reset`, or `no_credit` outcome |
| GET | `/threads?cursor=...&limit=20&archived=false` | Stored thread summaries; archived defaults to false |
| GET | `/conversations` | `{ conversations: [{ id, threadId, project, provider? }] }` |
| POST | `/conversations` | `{ project, provider? }` creates with an advertised provider; `{ threadId }` resumes its saved workspace/provider |
| GET | `/conversations/:id` | Handle summary and neutral conversation state |
| DELETE | `/conversations/:id` | Detach, release binding and close streams |
| POST | `/conversations/:id/rename` | `{ name }` |
| POST | `/conversations/:id/archive` | `{}`; archive and detach |
| POST | `/conversations/:id/fork` | `{}`; new handle with the saved provider, subject to capability/activity guards |
| POST | `/threads/:threadId/unarchive` | `{}`; restore without attaching |
| GET | `/conversations/:id/snapshot` | State, capabilities, pending interactions, epoch/watermark/history revision and versioned overlay items |
| GET | `/conversations/:id/snapshot-items?cursor=...` | Immutable snapshot continuation |
| GET | `/conversations/:id/items?cursor=...` | Native-derived, unversioned history; opaque forward cursors |
| GET | `/conversations/:id/events` | Core-ordered SSE; `Last-Event-ID: <epoch>:<sequence>` resumes replay |
| POST | `/conversations/:id/assets` | `{ data: "data:image/...;base64,...", name? }` → scoped `AssetReference` |
| GET | `/conversations/:id/assets/:assetId` | Authorized download; no filesystem path input |
| POST | `/conversations/:id/messages` | `{ input: [{ type: "text", text }, { type: "asset", assetId, media: "image" }] }` → `{ turnId, steered }` |
| POST | `/conversations/:id/interrupt` | `{ turnId? }` |
| GET | `/conversations/:id/interactions` | Current pending shared interactions |
| POST | `/conversations/:id/interactions/:requestId` | `{ optionId, answers?, reason? }`; choose an exact offered opaque token |
| GET | `/conversations/:id/settings` | `ThreadSettings`: cwd, model, effort, approvalMode, sandboxMode |
| POST | `/conversations/:id/settings` | Nonempty patch of model, effort, approvalMode or sandboxMode; applies to the next new turn |
| GET | `/conversations/:id/models?cursor=...` | Shared model page: IDs, labels, descriptions, supported efforts and default effort; up to 100 records |
| GET | `/conversations/:id/context` | `{ tokenUsage }`; request/context telemetry, separate from account allowances |
| GET | `/conversations/:id/skills` | Opaque skill references, names/descriptions/enabled state, warnings and omitted count |
| POST | `/conversations/:id/skills-reload` | `{}`; fresh discovery, subject to advertised capability |
| POST | `/conversations/:id/skills` | `{ referenceId, enabled }`; never a native filesystem path |
| POST | `/conversations/:id/compact` | `{}`; advertised capability only |
| POST | `/conversations/:id/revert` | `{ beforeTurnId }`; conversation rewind, without filesystem rollback |
| GET | `/host`, `/host/battery` | Existing host/lifecycle and battery records |
| POST | `/host/actions` | `{ requestId, action: "restart" or "deploy", branch? }`; existing host operation records |

Navigation/host operations reuse existing application services. Creation restores
explicit provider bindings and saved workspaces. Handles and stream buffers are
volatile; stored history survives detach/restart. One conversation has an exclusive
surface binding. Missing workspaces return `409 workspace_unavailable`.

`/api/v2/models`, native-style `/approvals`, `/turns`, `/model`, `/effort`, and
`/images` conversation routes are rejected. They cannot fall through to old content
codecs. The legacy API remains callable at `/api/v1`; retirement and bundle/version
negotiation are still migration work.

## Inputs, settings and replies

Text parts must be nonempty, at most 32,768 characters, and fit the 64 KiB request
budget. Uploads accept PNG/JPEG/GIF/WebP after signature validation, up to 5 MiB
per image. Native conversion enforces four images and 10 MiB total before starting
work, including repeated references. Upload references belong to one conversation;
foreign or expired references fail before native submission. Audio and skill/mention
input references are not currently advertised by either neutral adapter.

An accepted message starts a turn or steers the active turn when supported.
HTTP success acknowledges submission, not completion. Message submission has no
idempotency key: after a connection failure, the client retains the draft and asks
the operator to check the conversation before sending again. Reconnect and history
refresh never submit work.

Only modes in the descriptor are offered. Unsupported modes fail with
`422 unsupported_capability`; invalid model/effort choices fail before native work.
Settings are session-owned choices for the next turn; an active turn keeps its
existing settings. Claude advertises unrestricted execution only. Bypass suppresses
native approval prompts and does not add a sandbox. `provider_default` restores
the adapter's initial policy after an explicit override. `review_all` is not offered.

Canonical defaults use `SHEPHERD_APPROVAL_MODE` and `SHEPHERD_SANDBOX_MODE`.
Legacy approval aliases preserve the existing shared host policy; restricted
`CODEX_SANDBOX` aliases supply Codex descriptor defaults. Legacy thread bootstrap
still enforces its configured sandbox and can reject Claude under a restricted
legacy sandbox. Canonical values take precedence, and invalid
or unsupported defaults fail rather than silently falling back. Discord still uses
its legacy settings/action path; canonical neutral defaults apply to neutral sends.

Each permission option has an opaque ID, label, intent, scope and optional effect.
Adapters keep exact native replies private. Replies must belong to the current
thread/session and an unresolved request. Invalid answers leave the request pending;
concurrent valid replies have one winner. Decided/applied/failed/expired states are
published, but answers are not retained in snapshots or replay. Failed delivery is
terminal and must not be blindly retried. Unsupported persistent permission mappings
are not offered. Claude currently offers allow-once/deny for tool permissions.

Accounts use one shared window/extra-usage/reset model. Unknown values remain
unknown; providers without resets hide/reject redemption. The UI retains the exact
provider-scoped idempotency key after an uncertain reset and migrates an unresolved
legacy reset without changing that key. Known reset outcomes are recorded separately
from allowance refresh failures. Account reporting uses host accounts shared across
conversations, not conversation token counts.

## Events, history and limits

Fetch all snapshot continuation pages before applying buffered events after the
watermark. Native history has no revisions and never seeds a delta base. Versioned
overlays take precedence over native history. The client retains terminal session
items separately from forward history pages, so refresh does not reorder history.
It recaptures on gaps, epoch/history changes and `projection_incomplete` warnings.
Foreground refresh temporarily gates actions; reconnect never resends prompts.

History revert invalidates cursors and assets. Malformed, expired, future or foreign
replay cursors return `409 projection_resync_required`; detached handles return 404.
History pages fetch three native items within a 1 MiB encoded limit. Snapshots retain
two captures for 60 seconds. Overlays retain at most 2,000 items / 8 MiB; replay
retains 512 events / 4 MiB. Up to eight unresolved interactions are retained by each
adapter. Each conversation permits four SSE clients with 1.25 MiB queued per client;
slow readers close and must reconnect/recapture. Detach, session teardown, request
abort and cancellation close streams.

Asset downloads are limited to 10 MiB, retained bytes to 32 MiB / 256 references.
Eviction or history invalidation can make assets unavailable; refresh history for
current references. Full message text beyond the bounded preview is downloadable
when available within these limits. Other native variants use explicit partial
fallbacks; full background/nested-agent mapping is still pending.

Conversation mutations are serialized per handle. Overlapping actions return
`409 conversation_busy`. The adapter permits 32 handles, 32 in-flight requests, and four simultaneous uploads.
Origin/Host checks and lifecycle guards apply to both API versions.
