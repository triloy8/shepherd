# Built-in web UI

Shepherd includes a React + TypeScript interface styled with Tailwind and built
with Vite. It lives in `ui/` in this repository. The web adapter serves the built
interface at `/` and the conversation API at `/api/v1` on the same listener.
There is no separate UI repository, production frontend process, login screen,
or bearer token.

## Launch and private access

Run `bun install --frozen-lockfile` followed by `bun run build`. Select
`SHEPHERD_SURFACES=discord,web` (or `web`) in `envs/common.env`, validate with
`bun run check:config`, then restart through the normal deployment flow.
`bun run check` also builds the UI, so the existing deployment validation builds
both sides together. Missing UI assets cause web startup to fail with build
instructions. Disabled web does not load assets or open a listener.

For local use, open `http://127.0.0.1:8788`. The actual listener port's loopback
origins (`127.0.0.1` and `localhost`) are allowed automatically. For private remote
access, put the exact HTTPS origin printed by Tailscale Serve in `envs/web.env`:

```env
SHEPHERD_WEB_PORT=8788
SHEPHERD_WEB_ORIGINS=https://HOST.TAILNET.ts.net
```

Replace that example with the actual origin, without a path or trailing slash.
Follow [the web API private-access instructions](web-api.md#private-access-and-trust)
to configure private Serve. The same URL serves the UI and API. Neither startup
nor deployment configures Serve or changes tailnet policy. Keep access restricted
to intended operator clients; anyone who can reach the endpoint has operator
access. Never publish it with Funnel or another public proxy.

The listener validates both request Host and browser Origin against its local
addresses and configured origins. It does not trust forwarded-host headers to
invent allowed origins. This prevents a hostile browser hostname from using
loopback DNS rebinding. It is not user authentication: local processes and allowed
network clients remain trusted operators.

## First workflow

Choose **New conversation**, enter `owner/repo`, `~/path`, or `~`, and create a
conversation. Selecting a stored conversation opens the same project prompt when
it needs resuming. Choose its original project. Threads attached to another
surface must be detached there first; an existing web handle can be shared by
several browsers.

The conversation view shows stored messages, live agent text, activity status,
and pending approvals. Send a follow-up during an active turn to steer it. The
stop button interrupts the turn. Approval controls use the exact choices supplied
by the backend; request details can be expanded before deciding. Detach releases
the web handle without stopping agent work.

On a keyboard with a precise pointer, Enter sends and Shift+Enter inserts a new
line. On touch layouts, Enter inserts a new line and the send button submits.
The sidebar becomes a conversation drawer on narrow screens. Messages support
Markdown and code blocks; raw HTML and remote image fetching are disabled.
Attachments, generated-image delivery, model/skill/deploy controls and full
Discord command parity are outside this first UI version.

## Recovery and browser state

SSE reconnects with the last processed event cursor and a bounded retry delay.
Expired cursors trigger a fresh stream and history/state/approval reconciliation.
Canonical completed messages replace streamed text, and event IDs deduplicate
replay. Recent history is refreshed on meaningful events and periodically to
catch changes from another browser. Earlier history can be loaded separately.

A network failure never automatically resubmits a prompt. The draft remains in
memory, and the UI asks you to inspect the conversation before retrying. Drafts
survive switching conversations and connection loss in the same page, but not a
page reload. The last selected handle, thread and project are stored in browser
local storage (no messages or secrets). Reloads reuse an existing handle. After
a host restart or detach, choose **Resume conversation** to create a new handle
for the stored thread. The UI never silently resumes or creates an agent session
as part of retrying a failed message.

## Development and build boundaries

`bun run build:ui` typechecks browser code and writes Vite output to `ui/dist`.
`bun run build` builds the UI and typechecks the server. `bun run check` also
checks adapter capability contracts. Built assets are ignored by Git. Source
startup loads assets once into memory, so an in-progress deployment cannot change
the files served by the running host. Rollback rebuilds the restored revision's
artifacts. Docker copies the UI build into its runtime image.

`bun run build:bin` embeds the same UI assets in `release/shepherd`; the binary
serves them even when launched outside the checkout. No runtime filesystem paths
are accepted from HTTP requests: only the known built assets are served. HTML is
not cached; hashed assets have immutable caching. Unknown paths return 404 and
API errors never fall back to HTML. Production assets carry a restrictive CSP.

For local frontend development:

1. Start a test Shepherd host with `web` enabled on port 8788.
2. Add `http://127.0.0.1:5173` to its `SHEPHERD_WEB_ORIGINS` before starting it.
3. Run `bun run dev:ui`, then open `http://127.0.0.1:5173`.

The loopback-only Vite development server proxies `/api` to port 8788. It is a
development tool, not a second production service. Frontend modules import only
the shared protocol and UI modules; all agent work goes through HTTP ports.

## Validation

`bun run test` includes HTTP/static-host checks, deployment rollback, SSE framing,
replay deduplication, canonical response handling, and history reconciliation.
For browser validation without live Codex calls, build the UI and run:

```bash
bun tests/fixtures/web-ui-host.ts
```

This test-only fixture listens on `127.0.0.1:8799` and uses in-memory conversations.
Run the function in `tests/browser/web-ui-flow.js` with Playwright CLI's
`run-code` after opening that address in a fresh browser session. It covers
resume, history, live replies, approvals, failed-send drafts, interruption,
reload recovery, conversation creation and narrow layouts. Fixture routes and
mock messages are never imported by the production host.

The interface uses a neutral dark palette with text-only Shepherd branding.
Warning notices retain amber coloring to distinguish errors from ordinary content.

Assistant updates are grouped by turn. Commentary stays visible while work is
running, then folds into an expandable work summary after confirmed completion.
All explicitly marked final-answer parts stay visible with Copy buttons. Failed or
interrupted turns keep their partial work expanded. History reloads restore the
same grouping; elapsed time is shown only when supplied by stored turn history.
Tool activity is retained by item ID, with expandable details and lifecycle status.
Failed tools remain visible even when the turn completes. Activity is reconstructed
from stored items on reload using the same normalization as Discord. Provider
reasoning and full command output are not rendered; activity details are bounded.

Generated images remain visible outside folded progress and can be opened in a new
tab. Only conversation-scoped API image URLs are loaded; Markdown cannot load
arbitrary remote images. Missing, unsupported or removed files display an unavailable
notice. Reload history to retry. Older turn events cannot clear the active turn or
restart a completed turn. These rules also apply during event replay.
