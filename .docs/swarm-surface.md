# Swarm surface

The `swarm` surface is a separate manager conversation workspace using the active
Orbit Alloy mockup's materials, layout, and original procedural SVG identities.
Portrait gradients, masks, and filters live inside each portrait SVG to avoid
external symbol references rendering incompletely in some browsers.
It shares the host's conversation runtime with web and Discord, with its own
listener, conversation handles, navigation, and durable team records.

## Workflow

1. **New conversation** asks only for a project. Describe the task in the ordinary
   manager composer. No strategy, group name, or worker forms are required.
2. The manager discusses a small team and assignments with the user. Agreement
   happens in the conversation; the host does not implement a separate approval
   form or attempt to infer consent from message text.
3. The manager delegates through its tools. Workers appear automatically in the
   roster, each with an isolated workspace for an `owner/repo` project.
4. Worker turn ends, failures, interruptions, and requests for decisions notify
   the manager through the existing coalescing signal dispatcher. Delivery waits
   for the manager to become idle. Once independent work is done, the manager
   finishes its dispatch turn with a progress update; it must not sleep or poll
   for results. The host starts the continuation automatically. The manager reads reports, asks the user when
   needed, integrates changes, and verifies the result.
5. Worker inspection is read-only. Opening it preserves the manager's draft and
   recipient. The mobile **Swarm · count** action opens the roster; the main
   conversation retains its floating composer.

Navigation follows the Shepherd web layout: a collapsible desktop sidebar and a
left-side modal drawer on phones. Orbit’s rounded Nunito wordmark and conversation titles,
circular manager portraits, recessed selection, and softly bevelled controls style
the shared navigation structure. It lists manager conversations with project
subtitles, refresh, and shared Usage & limits and Host controls panels.
The header keeps host battery, a Swarm button containing manager status and
worker count, and conversation actions beside the editable title. The Swarm panel
also shows the manager connection, project, provider and conversation ID. No Active/Archived filter is exposed.
The composer floats over the conversation with a transparent surrounding dock.
Its measured height reserves space at the end of the timeline so the last message
can scroll clear of the input and settings, including when the draft grows or
the viewport shrinks. The rounded Latest messages control floats above the dock.
Focus uses a quiet inset keyboard indicator and a composer border change.
The composer reuses the web surface’s attachment, model/effort, context, and
draft-preview controls in their standard positions, with model/context controls
beneath the input. The top-right three-dot menu offers Manager skills and Compact manager
conversation through the shared web panels, respecting provider capabilities.
Compaction is disabled during an active manager turn or pending approvals.
There is no Close swarm action; the existing backend lifecycle remains for saved
data compatibility. Fork, detach, and provider archive actions are not exposed. Clicking or tapping a completed message bubble copies its text. Links, controls,
code blocks, and text selection retain their normal behavior. A focused bubble
also copies with Enter or Space. There is no Copy button: a small, temporary
checkmark confirms success without shifting the message; a failed copy shows a
retryable error. No three-dot menu is needed.
Interim commentary inside the work log uses plain text without portraits or
bubble materials; final manager replies retain their portrait and bubble.
**Turn finished** describes an observed turn, not a verified task outcome.

Absolute local projects support manager conversations. New workers require an
`owner/repo` target: shared local checkout delegation is rejected rather than
silently giving multiple writers the same workspace.

## Enable

For existing installations, use the [deployment and rollback guide](../deploy/README.md#enable-orbit-on-an-existing-host),
including the handoff from a separate preview host. Deployment preserves local env
files; it does not enable Orbit or configure private routing automatically.

Build with `bun run build`, add `swarm` to `SHEPHERD_SURFACES` in
`envs/common.env`, and copy `envs/swarm.env.example` to `envs/swarm.env`:

```env
SHEPHERD_SWARM_PORT=8789
SHEPHERD_SWARM_ORIGINS=
# Optional; default: ~/.shepherd/swarm-groups
# SHEPHERD_SWARM_STATE_DIR=/absolute/path/to/swarm-groups
```

Run `bun run check:config` and restart through the normal host lifecycle when
ready. Source changes do not deploy or change live configuration. Open
`http://127.0.0.1:8789` locally. Private remote access uses the same
[trust model as web](web-api.md#private-access-and-trust): exact allowed browser
origins and a loopback listener. Reachable clients have operator access; there is
no application login. A private proxy must target this surface's port.

Both HTML entrypoints are built into the bundle. The swarm listener serves
`swarm.html` at `/`; web continues serving `index.html`.

## Architecture and manager tools

React calls the swarm HTTP adapter for records and observations and the shared
browser transport for the manager's existing timeline, history, composer,
approvals, attachments, and settings. The adapter supplies scoped capabilities
to `SwarmManagerService`; core owns manager authorization and delegation
orchestration. React never calls providers or owns the worker lifecycle.

`createSurfaceHost` supplies a narrow manager bridge only to the swarm adapter.
Runtime composition owns raw dynamic-tool registration and removal. Explicit
host role instructions pass through ordinary thread creation/resumption, separate
from user messages and execution policy. The provider boundary maps these to
native developer instructions or an append to its normal system preset. Managers
and workers receive different roles. Existing already-loaded sessions retain
their original bootstrap instructions; fresh creation and resumption after a host
restart apply the role. Binding a previously loaded ordinary conversation does
not rewrite its running session's prompt.

The `shepherd` manager tools are:

| Tool | Behavior |
| --- | --- |
| `swarm_status` | Discover saved team, open workers, renew notifications, inspect current observations |
| `swarm_delegate` | Create/reuse a named worker, save membership, watch before sending its assignment |
| `swarm_send` | Send a new assignment to an idle team member with a retry key |
| `swarm_report` | Read up to five recent worker turns, an older-history cursor, dispatch receipts, and pending decisions |
| `swarm_decide` | Apply a current offered decision or validated question answers to a team member |
| `swarm_interrupt` | Interrupt a team member's current turn without closing its task |
| `swarm_rename` | Set a concise task title for the manager and saved record |

### Layer boundaries

The implementation is divided into these independently reviewable modules:

| Module | Owns | Dependency boundary |
| --- | --- | --- |
| Contracts and ports | Neutral conversation handles, swarm records/events, storage and runtime capability interfaces | Protocol and port types; no browser, provider, or filesystem implementation |
| Swarm core (`core/surface/swarm_*`) | Membership, revision checks, dispatch receipts, manager authority, orchestration and role instructions | Narrow conversation capabilities and injected ports; no HTTP status codes or browser contracts |
| Infrastructure | `FileSwarmStore`; generic provider bootstrap instructions | Implements ports; storage imports no core or adapters; providers contain no swarm workflow |
| Browser adapters | Shared HTTP/SSE/history/assets and swarm routes/observations | Core's public API and ports; no provider or storage implementation; web and swarm do not import one another |
| Orbit UI | Shell/navigation, `ManagerChat`, read-only `WorkerInspector`, `SwarmDialog`, `useSwarms`, `useChatScroll` | HTTP contracts and existing shared UI; shared UI cannot import Orbit modules |
| Runtime composition | Construct concrete services, register tools, connect watches and own lifecycle | The only layer permitted to wire all implementations together |

The architecture test enforces the swarm core and Orbit UI as feature layers,
and the browser protocol as a separate contract layer. Generic core cannot
import swarm orchestration; core, ports, storage and providers cannot import
browser contracts. Shared event framing accepts a typed event map; swarm
invalidations and their parser selection belong to the swarm feature.

### Final layer audit, 2026-11-15

The audit removed browser handle types and HTTP status codes from swarm core,
moved the runtime bridge into a port, narrowed orchestration capabilities, and
split chat/inspection/scroll behavior out of the UI shell. Managed watches call
the watch service directly rather than depending on a registration's array index.

It also corrected four failure paths:

- Rename now holds the mutation guard across the revision check, provider rename,
  and record update. Concurrent or stale renames cannot overwrite the provider
  title before discovering their conflict. Provider failure preserves the record
  and releases the guard.
- Renaming a saved manager after restart attaches its provider session in the
  HTTP adapter before calling core. It starts no turn, and core rechecks the
  revision after attachment in case the group changed while opening.
- Assignment submission rechecks manager authority after persisting the pending
  receipt. Cancellation in that interval prevents submission, and retrying the
  pending receipt does not silently send it.
- Browser shutdown starts connection cancellation before disposing streams, waits
  for both cleanup paths, and reports both failures if they fail together.

These cases have regression tests. The full suite passed with 873 tests, along
with the build, UI/server type checks, and contract checks. Live Codex evidence
from the earlier integration runs remains distinct from fixture browser checks.
The final Firefox fixture run passed at all four widths with no browser errors.
After refreshing only the separate Orbit host, live checks confirmed cold rename
before manual resumption, stale-revision rejection, preserved membership and
readable saved history, without starting an inference turn. The ordinary Shepherd
listener remained healthy.
The documented command-cancellation gap and deferred first-message history race
remain open; this architectural audit does not claim to resolve them.

Each call derives manager authority from the provider-supplied caller thread and
active turn, never model-provided group ownership. Workers, unrelated callers,
stale turns, closed groups, and foreign team members are rejected. The model is
instructed to obtain conversational agreement before delegation and to ask the
user about decisions outside authorization; the tools do not independently prove
that conversational agreement occurred. Pending decision IDs and offered choice
values are checked against actual worker records before application.

Managed watches work independently of the experimental public watch-tool and
webhook flags. They reuse `ThreadWatchService` and `SignalDispatcher`, including
coalescing, idle delivery, lifetime limits, and shutdown cleanup. No separate
callback server or bespoke wake loop is introduced. Watch labels include worker
names. Watches are volatile and default to 24 hours. Managers call `swarm_status`
at the start of each turn to renew/recreate them. After a host restart the saved
manager can be resumed, and its next turn reopens workers and restores watches.
There is no automatic replay of notifications missed while the host was down;
the manager must inspect worker history to reconcile results.

Reports cap serialized history at 48,000 characters and explicitly flag truncation;
use the returned history cursor for older turns. Exceptionally large individual
turns may require normal conversation history inspection.

## Durable records and dispatch recovery

Version-1 JSON records contain an explicit canonical manager thread ID, project,
task title, strategy (legacy metadata), lifecycle, revision, timestamps, and
members with canonical IDs, unique names, assignments, identity seeds, and join
times. The same schema accepts older records without dispatch receipts. New
receipts are persisted with a unique request key, `pending`/`sent` state, and turn
ID. Membership is independent of watches and browser handles.

The dispatch sequence is **save member → open/watch → save pending receipt →
submit turn → save sent receipt**. Retrying a recorded key never automatically
submits again. A lost submission response or failure saving the final receipt
leaves a visible pending receipt: delivery may have happened. The manager must
inspect history before deciding on a new assignment. A failed watch leaves the
saved worker unsent and retryable. Per-manager operations are serialized by
rejection while busy, and durable writes retain revision checks.

Files use atomic replacement and private permissions. One host process owns a
store directory; multiple independent writers are unsupported. Limits: 128
groups, 64 workers/group, 64 recorded assignments/worker, 96 simultaneously attached
swarm conversations. Receipts are never silently evicted to make an old retry look
new. A conversation belongs to only one active group. A failed provisioning or
membership write may leave an unbound provider conversation; it is not restarted
or discarded automatically.

Observations remain separate from records: active turn, pending decisions,
latest available turn status, timestamp, and current surface handle. Unavailable
history is not completion. History reads use small batches and a short cache.
One aggregate SSE feed invalidates roster snapshots; reconnect, tab visibility,
and a 60-second visible-tab refresh reconcile state. Inspection opens only the
selected worker's ordinary browser stream.

## HTTP contract

Shared browser `/api` history, approval, settings, and event routes remain
available to trusted operator clients. Read-only worker inspection is a UI
workflow, not a restriction on an operator's direct API access.

| Method and path | Body / response |
| --- | --- |
| `GET /api/swarms` | `{ groups }` durable records |
| `POST /api/swarms` | `{ project, name?, provider?, managerThreadId?, strategy? }` → `{ group }`; default title `New conversation` |
| `GET /api/swarms/:id` | `{ group, manager, workers }` observations |
| `POST /api/swarms/:id/rename` | `{ revision, name }` → `{ group }` |
| `POST /api/swarms/:id/open` | `{ threadId }` → conversation handle; membership required |
| `POST /api/swarms/:id/close` | `{ revision }` → `{ group }` |
| `POST /api/swarms/:id/interrupt` | `{ revision }` → per-worker outcomes |
| `POST /api/swarms/:id/members` | Legacy/operator membership API; `{ revision, name, assignment?, threadId?, provider? }`; does not send assignments |
| `GET /api/swarms/events` | SSE `swarm` invalidations; null group ID means refresh observations |

Mutations reject stale revisions (`409 swarm_changed`) and conflicting writes
(`409 swarm_busy`). Input checks and origin/quiescing protection apply before
operations. Existing-thread input determines its provider. Conversation creation
itself is not idempotent: check the group list after a lost create response.

The surface does not import legacy skill-helper `~/.shepherd/swarms` manifests.
Its default store intentionally differs. Do not infer ownership from helper files
or transient watches. The previously diagnosed first-message history race remains
deferred; see [known errors](errors.md#codex-first-message-history-race-leaves-a-backend-error-banner).

## Validation

Run `bun run check` and `bun test --timeout 30000`. The regression suite covers
manager identity and active-turn authority, foreign member rejection,
watch-before-send ordering, retry deduplication, uncertain submission recovery,
persisted membership, pending decisions, provider role instructions, shared
transport behavior, architecture boundaries, and lifecycle cleanup.

```bash
UI_TEST_SURFACE=swarm UI_TEST_PORT=18979 bun tests/fixtures/web-ui-host.ts
playwright-cli open --browser=firefox
playwright-cli run-code "$(cat tests/browser/swarm-surface.js)"
```

The browser fixture implements a deterministic proposal/agreement/delegation
scenario and labels itself simulated. Firefox checks 320, 390, 1440, and 1920px,
read-only inspection, draft isolation, title persistence, dialogs, navigation,
roster updates, manager skills and compaction targeting, and the existing streaming
conversation components. These checks
do not prove live model behavior or real-device iOS keyboard behavior.

### Deployment readiness, 2026-11-15

The PR validation reran `bun run check` and all 873 tests (zero failures).
A fresh production source host with `web,swarm` served healthy, distinct UI roots
and all directly referenced assets using an isolated empty swarm store, then shut
down cleanly. The compiled binary passed the same checks from a temporary working
directory with no UI files, confirming both entrypoints are embedded. The main installation's prospective `discord,web,swarm` selection
validated against its actual local configuration without opening clients.
Its ignored `envs/swarm.env` was prepared with port 8789 and the existing private
Orbit origin, with mode 600. Its current surface selection and live routing were
preserved pending deployment; these preparation checks do not migrate the running
separate Orbit service or run another provider assignment.

### Live integration check, 2026-11-15

The private Orbit endpoint now runs the real `swarm` surface rather than the
browser fixture: `https://shepherd-host.tailcc06a7.ts.net:8451/` proxies loopback
port 18981. The separate `shepherd-orbit-live` tmux session uses the existing
`deploy/ubuntu/start-shepherd.sh run` supervisor, local ignored configuration in
`envs/common.env` and `envs/swarm.env`, and logs in `logs/orbit-live/shepherd.log`.
Its signal listener uses port 18982. The ordinary web/Discord host remains a
separate process. Saved teams use `~/.shepherd/swarm-groups`; the fixture remains
available locally on port 18979.

With real Codex sessions, `Orbit integration check` created one worker in its own
checkout, saved its dispatch receipt, displayed it in the live roster, and read
its completed history through the worker inspector. The worker read the check
and test scripts from `package.json`; the manager retrieved `swarm_report` and
independently verified both values. No repository files were changed by these
agent turns. After restarting and resuming the same manager, a second assignment
to the existing worker completed the notification/report/verification cycle
without manual steering. Team membership and both receipts survived restart.

The first run exposed a manager sleeping while its notification was queued;
manager instructions and successful dispatch responses now explicitly require
yielding the turn. A connected-browser restart also exposed shutdown stalling
after stream disposal. The shared listener now initiates connection cancellation
before disposing stream controllers. A subsequent Host controls restart with
manager and worker histories connected exited cleanly and the supervisor
relaunched the listener. Automated coverage includes stopping with an open SSE
reader and unread turn events.

The initial live check exercised Codex and a single worker. Claude delegation,
approval prompts, and physical iPhone keyboard behavior remain outside the live
checks below. Provider-independent automated tests cover
approval routing, concurrency guards, and recovery cases.

### Extended live checks, 2026-11-15

A separate `Orbit parallel checks` conversation ran two real Codex workers in
distinct checkouts. Provider timestamps show three seconds of overlapping
execution. The manager received both notifications, retrieved both reports, and
verified the package scripts and TypeScript configuration by reading the files.
Repeating `swarm_send` with the same request ID returned a duplicate receipt;
the saved record contained one receipt and the worker executed one additional
turn. Stopping a newly dispatched worker preserved its membership and produced
an interrupted report rather than a successful result. After the running-command
probes, a fresh assignment completed on the same interrupted worker thread;
the manager retrieved and verified the result. Both workers and the manager
finished idle, with all three checkouts clean.

The full Firefox fixture workflow also passed at 320, 390, 1440, and 1920px,
including worker inspection, draft isolation, settings, capability gating,
attachments, copy feedback, short viewport layout, and cancelling a queued
scroll during a Latest messages jump. This run corrected a stale helper name
left in the browser test after the floating composer change. All 54 targeted
runtime, transport, and timeline tests passed. The manager and worker checkouts
were clean after the read-only audits.

Interrupting an actually running command exposed an open limitation: Codex
accepted the turn interruption and history showed `interrupted`, but the
foreground sleep process continued in Linux state `S` for at least 5.5 seconds.
The manager did not claim that the process had exited. A turn stop must not be
treated as proof that all command execution has stopped; see the
[cancellation gap](errors.md#codex-turn-interruption-can-leave-a-running-command-alive).

The swarm surface bundles Nunito as a local variable font with its OFL license.
This user-selected rounded typography replaces the original serif treatment;
ordinary web typography remains unchanged. Model, context, and draft-preview
controls below the composer share the rounded Alloy button treatment.
