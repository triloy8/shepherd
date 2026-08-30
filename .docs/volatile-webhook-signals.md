# Volatile signal callbacks

## Status

The generic loopback webhook, signal registry, bounded in-memory dispatcher,
and static Discord-surface route are implemented.

Ephemeral callback routes are the accepted next design step. They are proposed
here but are not implemented yet. Until that work lands,
`research.state-changed` continues to use the single Discord channel configured
by `SHEPHERD_RESEARCH_SIGNAL_DISCORD_CHANNEL_ID`, and that channel must have a
live in-memory Codex thread binding.

## Objective

Allow an always-on Shepherd process to begin agent work when a detached local
service reports a meaningful state change. The service can outlive the Codex
turn that launched it, and the resulting agent turn should return to the
originating Codex conversation and Discord channel without placing thread or
channel identifiers in producer-controlled payloads.

The first producer is a detached research-run service supervised by systemd.
The mechanism must remain generic enough for builds, data preparation, and
other local services without turning Shepherd into a workflow engine.

## Target flow

```text
Discord conversation
  -> Shepherd/Codex requests a detached operation
  -> Shepherd creates an ephemeral callback route for that conversation
  -> the opaque route ID is passed to the systemd service
  -> the interactive Codex turn ends
  -> the service operates independently
  -> the service POSTs a level-triggered signal to its callback route
  -> Shepherd starts a new turn in the originating Codex thread
  -> existing surface subscriptions deliver the response to Discord
  -> the route is revoked or expires
```

Shepherd owns callback routing and agent execution policy. The detached service
continues to own every correctness-critical part of its operation.

## Core decisions

- Shepherd is always running. Process activation is outside this design.
- Producers communicate through HTTP bound to the loopback interface.
- Signals and callback routes are best-effort and held only in memory.
- Shepherd does not add SQLite, a durable inbox, an event log, leases, durable
  acknowledgements, or callback recovery.
- A signal means that current authoritative state may deserve inspection. It
  is not a durable job that must execute exactly once.
- Trusted Shepherd code creates routes from an active conversation context.
  Producers cannot select a Codex thread, workspace, Discord channel, prompt,
  model, sandbox, approval policy, or shell command.
- Each detached operation receives an opaque, random route identifier.
- Existing validation, bounded queueing, coalescing, busy-thread policy, Codex
  execution, and Discord rendering remain the delivery path.
- The producer remains correct if Shepherd is stopped, its route expires, a
  signal is lost, or the resulting agent turn fails.

## Current implemented baseline

The implemented route for `research.state-changed` is static:

```text
configured Discord channel
  -> current in-memory thread binding
  -> signal-started Codex turn
  -> Discord delivery through the channel subscription
```

This proves the webhook, validation, dispatch, and delivery path, but has two
important limitations:

- one Shepherd process has one configured research destination; and
- a Shepherd restart loses the channel-to-thread binding.

The static route remains as a compatibility fallback during the ephemeral-route
rollout. It should not be extended into a collection of indexed environment
variables. Dynamic per-operation routes are the intended scaling mechanism.

## Terminology

### Signal

A versioned, validated notification that something changed and Shepherd may
want to inspect authoritative current state.

Signals should normally be level-triggered. For example,
`research.state-changed` means "inspect the current state of this run," not
"perform this completion action exactly once." Repeated signals can therefore
be safely coalesced in memory.

### Signal definition

Trusted code that owns a signal kind's payload validation, Codex input
construction, coalescing policy, and allowed execution behavior.

### Callback route

An opaque, temporary routing handle created by Shepherd. It associates one or more
allowed signal definitions with a trusted execution and delivery target.

### Producer

The detached local service that owns domain state and reports changes through
the route. For research, this is the systemd-supervised research service, not
Shepherd.

## Responsibility boundary

```text
trusted launch context in Shepherd
  creates route for originating thread and surface
       |
       | opaque route ID
       v
detached local producer
  owns execution, monitoring, budgets, artifacts, recovery, and cleanup
       |
       | best-effort localhost signal
       v
Shepherd
  validates, resolves, coalesces, and queues in memory
       |
       | starts a new turn in the captured Codex thread
       v
Discord surface
  renders normal Shepherd activity and the final response
```

For remote experiments, the experiment service remains responsible for launch,
spending limits, monitoring, evidence publication, recovery, and resource
termination. These invariants must remain correct if Shepherd never receives a
signal. Shepherd may inspect and interpret the resulting state, but it is not
part of the experiment control plane.

## Ephemeral route model

The core registry should retain records shaped approximately as follows:

```ts
type EphemeralSignalRoute = {
  id: string;
  allowedSignals: ReadonlyArray<{
    kind: string;
    version: number;
  }>;
  target: {
    threadId: string;
    cwd: string;
  };
  delivery: {
    adapter: "discord";
    surfaceId: string;
  };
  createdAt: number;
  expiresAt: number;
  state: "active" | "revoked" | "expired";
};
```

Route IDs must have enough entropy to avoid collisions and casual enumeration,
but they are routing handles rather than authentication secrets. The loopback
listener is intentionally unauthenticated. Logs should use a shortened route-ID
prefix when that is sufficient for correlation.

The route captures both concerns that were previously conflated:

- `threadId` determines which Codex conversation receives the new turn; and
- `surfaceId` determines where existing thread events are rendered.

The producer receives neither identifier.

Routes are process-local. Restarting Shepherd invalidates all outstanding route
IDs by design. A producer may retry or rely on a later level-triggered
notification, but it must not assume callback delivery.

## Trusted route creation

Route creation must occur inside Shepherd while the originating conversation is
known. The trusted caller supplies conversation context already resolved by the
runtime:

```ts
type CreateSignalRouteRequest = {
  allowedSignals: ReadonlyArray<{ kind: string; version: number }>;
  target: { threadId: string; cwd: string };
  delivery: { adapter: "discord"; surfaceId: string };
  ttlMs: number;
};
```

Signal ingress must not accept arbitrary thread or Discord channel IDs. Route
creation is a trusted control-plane operation, not part of producer ingress.

The initial research integration needs a Shepherd-aware launch operation. From
an active conversation it should:

1. Resolve the current Codex thread, workspace, and Discord surface.
2. Create a route allowing `research.state-changed@1`.
3. Add the callback URL and route ID to the detached unit's environment.
4. Launch or hand off to the existing systemd research runner.
5. Return control while systemd and the producer own the remaining lifecycle.

The generic route service must not depend on research or systemd. The first
integration can adapt that service to the existing research launcher. Later
launchers can reuse the same route-creation API.

One implementation detail still requires a focused interface decision: how an
agent-initiated launch invokes the trusted route service with its active
conversation context. Acceptable approaches include a first-class Shepherd
control/tool operation or a route-aware launcher owned by the adapter/core
boundary. A public webhook that lets the producer claim a thread or surface is
not acceptable.

## Producer handoff

The route-aware launcher passes two ordinary callback values to the detached
service:

```env
SHEPHERD_SIGNAL_URL=http://127.0.0.1:8787/signals
SHEPHERD_SIGNAL_ROUTE_ID=<opaque-route-id>
```

No token file, authorization header, credential exchange, or secret rotation is
part of this contract. The URL and route ID may be passed directly through the
unit environment. Producers should still avoid dumping their complete runtime
environment or unbounded signal payloads into logs.

Shepherd initiating this handoff does not make it the research supervisor. The
unit remains independently managed and can continue or clean up after the
interactive Codex turn ends.

## HTTP ingress

The existing endpoint remains generic:

```http
POST /signals HTTP/1.1
Host: 127.0.0.1:8787
Content-Type: application/json

{
  "routeId": "opaque-route-id",
  "kind": "research.state-changed",
  "version": 1,
  "subject": {
    "type": "research-run",
    "id": "run-123"
  },
  "payload": {
    "state": "COMPLETE",
    "verified": true,
    "researchProject": "P001"
  }
}
```

The proposed routed envelope is:

```ts
type RoutedSignalEnvelope = {
  routeId: string;
  kind: string;
  version: number;
  subject?: { type: string; id: string };
  payload: unknown;
};
```

Ingress processing order should avoid leaking route information:

1. Enforce lifecycle availability, method, path, content type, and body limit.
2. Parse the envelope and validate its structural bounds.
3. Resolve the route and confirm it is active and allows the requested kind and
   version.
4. Validate the kind-specific payload.
5. Resolve the captured thread and delivery subscription.
6. Offer the signal to the bounded dispatcher.

The existing static envelope may remain temporarily for backward compatibility.

## Response semantics

- `202 Accepted`: accepted into the current process's memory;
- `400 Bad Request`: malformed envelope or kind-specific payload;
- `404 Not Found`: unknown route or signal kind;
- `409 Conflict`: the captured target cannot currently execute or deliver;
- `410 Gone`: known route that has been revoked or expired, if Shepherd retains
  a bounded tombstone; otherwise return `404`;
- `413 Content Too Large`: request exceeds the configured body limit;
- `415 Unsupported Media Type`: request is not JSON;
- `429 Too Many Requests`: bounded queue or route rate limit is saturated; and
- `503 Service Unavailable`: Shepherd is starting, quiescing, or shutting down.

`202 Accepted` means only that the current Shepherd process accepted the
signal. It does not promise eventual execution, durable acceptance, or delivery
of an agent response.

An accepted response may report coalescing without exposing internal routing:

```json
{
  "accepted": true,
  "coalesced": false
}
```

The routed response should not return a Codex thread ID. `GET /health` reports
only whether the adapter can accept work.

## Signal definitions

Signal definitions remain independent of routes:

```ts
type SignalDefinition<T> = {
  kind: string;
  version: number;
  validatePayload: (value: unknown) => T;
  buildInput: (signal: SignalEnvelope & { payload: T }) => UserInput[];
  coalesceKey?: (signal: SignalEnvelope & { payload: T }) => string;
};
```

A route authorizes one or more registered definitions and supplies the trusted
target. This allows many simultaneous routes to reuse
`research.state-changed@1` while delivering to different conversations.

The configured input should direct Codex to inspect authoritative current state.
For consequential operations it must retain the same explicit human authority
requirements as an interactive turn.

## Dispatch and Discord delivery

The existing dispatcher remains responsible for:

- a bounded in-memory queue;
- coalescing queued and active signals;
- per-thread serialization;
- waiting for active human turns without steering them; and
- submitting the resulting Codex input.

Repeated level-triggered signals with the same coalescing key may collapse into
one pending inspection. A matching signal received while its turn is active may
retain at most one follow-up containing the latest payload.

The route's captured thread is the execution target. The captured Discord
surface uses the existing thread-event subscription, Components V2 renderer,
streaming behavior, and final-answer delivery. A signal-started turn should be
visibly identified as automated context, for example with a concise
`Research signal` status card, while its substantive output remains a normal
Shepherd response.

Multiple routes may target different threads and Discord channels. Routes that
target the same thread share its serialization queue and conversation context.

## Route lifecycle

Route cleanup is bounded housekeeping, not a correctness mechanism.

- Every route has a maximum TTL.
- Trusted launch code can explicitly revoke a route.
- A route may optionally revoke after a terminal signal is accepted, but only
  when the signal definition declares that policy.
- Shepherd shutdown clears routes, queues, and transient delivery state.
- Expired route records and optional tombstones are pruned with strict bounds.

A failed revocation must not affect research cleanup. A terminal signal may be
lost, duplicated, or arrive after expiration.

## Failure semantics

This design knowingly accepts that:

- route IDs become invalid after Shepherd restarts;
- a signal may be lost during restart or shutdown;
- an accepted signal may never begin a Codex turn;
- a turn may begin but its response may not reach Discord;
- repeated signals may cause repeated inspection;
- callbacks from different producers may be observed in timing-dependent order;
- a systemd service may outlive its Shepherd callback route; and
- Shepherd cannot prove that an external change was handled.

These are product semantics, not implementation bugs. Volatile callbacks must
not be used for GPU termination, spending enforcement, artifact preservation,
publication, auditing, or any action that must happen exactly once.

## Security boundary

The listener is deliberately unauthenticated. Loopback binding is therefore the
network trust boundary, and any local process that learns a live route ID can
submit allowed signals to that route. It cannot redirect execution or select a
different thread or surface. This tradeoff is accepted for the trusted,
single-user deployment, but the mode must never be exposed on a public or
wildcard interface.

The implementation must:

- bind to loopback and reject wildcard or public binds;
- create routes only from trusted conversation context;
- generate random, non-sequential route IDs;
- strictly validate allowed kinds, versions, payloads, and request sizes;
- place bounds on routes, tombstones, queues, and per-route request rates;
- avoid logging full untrusted payloads;
- prevent producers from selecting execution or delivery targets; and
- ensure revocation and expiration disable future signals for the route.

## Relationship to MCP

MCP or a domain CLI can provide the command path from Codex to a research
service:

```text
Codex -> launch, inspect, cancel -> research service
```

The callback route provides the opposite asynchronous direction:

```text
research service -> state changed -> Shepherd -> new Codex turn
```

Normal MCP tool calls occur during an active turn and do not by themselves wake
Shepherd after a detached operation completes. The two mechanisms are
complementary. If a future Codex/MCP notification path can reliably initiate a
new Shepherd turn with trusted conversation context, it may replace the HTTP
callback without changing the route and dispatch semantics.

## Proposed module structure

Existing modules remain in place:

```text
shared/protocol/signals.ts
server/core/signal_registry.ts
server/core/signal_dispatcher.ts
server/core/conversation_signal_executor.ts
server/adapters/webhook/server.ts
server/signals/research_state_changed.ts
server/runtime/shepherd_runtime.ts
```

Add narrowly scoped route components:

```text
server/core/signal_route_registry.ts
  create, resolve, revoke, expire, and bound ephemeral routes

server/core/signal_route_service.ts
  trusted conversation-context route creation and producer handoff contract

server/adapters/webhook/server.ts
  routed-envelope resolution and response mapping

shared/protocol/signals.ts
  routed envelope and route-safe response types
```

Research-specific systemd handoff belongs in the research integration or
launcher, not in the generic registry or dispatcher.

## Implementation sequence

### 1. Route registry

- Add route records, random ID generation, TTL enforcement, capacity bounds,
  revocation, pruning, and disposal.
- Keep the registry independent of HTTP, Discord, Codex, research, and systemd.
- Add deterministic clock and route-ID generation seams for tests.

### 2. Routed ingress

- Extend the envelope with `routeId`.
- Resolve routes and enforce their signal allowlists.
- Keep the legacy static route operational during migration.
- Avoid returning internal thread or surface identifiers.

### 3. Trusted conversation integration

- Add a route service that accepts an already-resolved thread and surface.
- Ensure the thread is resumable and the Discord subscription is active.
- Produce a handoff containing the callback URL and route ID.
- Decide and implement the trusted agent-launch invocation boundary.

### 4. Research launcher integration

- Create a route before launching the detached systemd unit.
- Pass the callback URL and route ID through the detached unit environment.
- Keep the existing research supervisor responsible for all lifecycle work.
- Add explicit revocation where convenient and rely on TTL as the bound.

### 5. Presentation and operations

- Identify signal-started turns in Discord without creating a second renderer.
- Add bounded diagnostics for active route count, expiration, rejection, queue
  saturation, and dispatch failure without logging full payloads.
- Document operator inspection and route expiration.

### 6. Compatibility cleanup

- Exercise multiple concurrent routes from different Discord conversations.
- Decide whether the single static research channel remains a supported fallback
  or is deprecated after migration.
- Do not remove it until the producer integration is deployed and verified.

## Test matrix

- route creation captures the originating thread, workspace, and Discord
  surface;
- unknown, expired, and revoked route IDs are rejected;
- a producer cannot alter its route's thread, workspace, or delivery surface;
- a route cannot submit an unapproved kind or version;
- independent routes for the same kind remain isolated;
- routes from different Discord channels deliver only to their origin;
- equal pending signals coalesce while different subjects remain separate;
- matching signals during an active turn create at most one follow-up;
- busy threads queue signals and are never implicitly steered;
- route and queue saturation return explicit errors;
- shutdown rejects new work and clears all volatile state;
- a reboot invalidates routes without affecting producer-owned cleanup; and
- the static route remains compatible until deliberately retired.

## Acceptance criteria

- A detached service can wake Shepherd after its originating Codex turn ends.
- No Discord channel or Codex thread ID is supplied by the producer.
- The new turn resumes the originating Codex conversation.
- Commentary, activity, and the final answer reach the originating Discord
  channel through the existing renderer.
- Simultaneous operations launched from different conversations remain isolated.
- Routes are narrowly scoped, bounded, revocable, and process-local.
- A busy target thread is queued rather than steered.
- Restarting Shepherd invalidates routes without migrations or recovery state.
- Research correctness, spending control, evidence, and cleanup remain fully
  independent of Shepherd.

## Open decisions

- Which trusted control/tool boundary lets an agent-initiated launch request a
  route using its active conversation context.
- Default and maximum route TTLs.
- Whether terminal research signals automatically revoke their routes.
- Whether bounded route tombstones justify distinct `404` and `410` responses.
- When, if ever, to deprecate the static research-channel environment route.
