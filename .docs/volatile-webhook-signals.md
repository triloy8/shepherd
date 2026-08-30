# Volatile localhost webhook signals

## Status

Implemented.

## Objective

Allow an always-on Shepherd process to begin agent work in response to local
service signals, without requiring a human message and without introducing
durable coordination state into Shepherd.

The first intended producer is a local remote-experiment service. The design
must remain generic enough for other local producers without turning Shepherd
into a workflow engine.

## Core decisions

- Shepherd is always running. Process activation and process wake-up are not
  part of this design.
- Producers communicate with Shepherd through HTTP webhooks bound to the
  loopback interface.
- All signal coordination inside Shepherd is in memory.
- Shepherd does not add SQLite, a durable inbox, an event log, leases, durable
  acknowledgements, or restart recovery for signals.
- Signals are best-effort notifications that something may deserve attention.
  They are not durable jobs or commands that must execute exactly once.
- The producer continues to own every correctness-critical lifecycle concern.
- Trusted Shepherd configuration owns routing and execution policy. Webhook
  payloads report facts and cannot select arbitrary execution privileges.

## Terminology

This design calls inbound messages **signals** rather than jobs or events. A
signal means:

> Something changed. If Shepherd hears this signal, it may inspect the current
> state and begin an agent turn.

The word is intentionally weaker than a durable event. Receiving a successful
HTTP response does not create a persistent obligation for Shepherd.

Signals should normally be level-triggered. For example,
`research.state-changed` asks Shepherd to inspect current research state. It
does not require Shepherd to execute a unique `run-completed` task exactly
once. Repeated level-triggered signals can be coalesced safely, and later
signals can make earlier missed changes visible.

## Responsibility boundary

```text
local producer
  owns its durable state and correctness-critical lifecycle
       |
       | best-effort HTTP signal over loopback
       v
Shepherd
  validates, routes, coalesces, and queues in memory
       |
       | starts or resumes a configured Codex thread
       v
surface adapter
  optionally delivers the agent response, for example to Discord
```

For remote experiments, the experiment service remains responsible for launch,
budgets, monitoring, evidence publication, recovery, and resource termination.
Those invariants must remain correct if Shepherd is stopped, busy, or never
receives the signal. Shepherd may inspect and interpret the resulting state,
but it is not part of the experiment control plane.

## HTTP ingress

The adapter exposes a small HTTP surface on a configurable
loopback address. It must not bind to a public or wildcard interface by
default.

```http
POST /signals HTTP/1.1
Host: 127.0.0.1:8787
Content-Type: application/json

{
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

All producers use the same endpoint and envelope:

```ts
type SignalEnvelope = {
  kind: string;
  version: number;
  subject?: { type: string; id: string };
  payload: unknown;
};
```

Each signal kind owns a narrow, versioned payload schema. A service unrelated
to research can therefore use the same API with a different kind and payload:

```json
{
  "kind": "build.finished",
  "version": 1,
  "subject": { "type": "build", "id": "build-456" },
  "payload": { "status": "failed", "branch": "main" }
}
```

Unknown kinds, unsupported versions, and invalid kind-specific payloads are
rejected before entering the in-memory dispatcher.

Suggested response semantics:

- `202 Accepted`: the current Shepherd process accepted the signal into memory;
- `400 Bad Request`: the request or payload is malformed;
- `401 Unauthorized`: the configured bearer token is missing or incorrect;
- `404 Not Found`: the signal kind is unknown;
- `409 Conflict`: the configured target has no active thread binding;
- `413 Content Too Large`: the request exceeds the configured size limit;
- `415 Unsupported Media Type`: the request is not JSON;
- `429 Too Many Requests`: the bounded in-memory queue is full; and
- `503 Service Unavailable`: Shepherd is starting, quiescing, or shutting down.

`202 Accepted` deliberately does not promise eventual execution, durable
acceptance, or delivery of an agent response.

An accepted response reports whether the signal replaced equivalent pending
work and which live thread was resolved:

```json
{
  "accepted": true,
  "coalesced": false,
  "threadId": "thread-123"
}
```

`GET /health` returns `200` while the adapter is accepting signals and `503`
while Shepherd is quiescing.

## Trusted routing configuration

Webhook payloads should contain external facts, not execution authority.
Shepherd registers each signal kind with its validation, input construction,
coalescing policy, and trusted target. Definitions are registered during runtime
composition rather than handled by a central `switch` statement:

```ts
type SignalTarget = {
  type: "surface";
  adapter: string;
  surfaceId: string;
};

type SignalDefinition<T> = {
  kind: string;
  version: number;
  validatePayload: (value: unknown) => T;
  buildInput: (signal: SignalEnvelope & { payload: T }) => UserInput[];
  coalesceKey?: (signal: SignalEnvelope & { payload: T }) => string;
  target: SignalTarget;
};
```

The target resolves to the surface's current in-memory thread binding and that
thread's workspace when the signal is accepted. Switching the surface to a
different thread changes where later signals go. If the surface has no active
binding, Shepherd cannot dispatch the signal. This preserves the intentionally
volatile model without permanently configuring Codex thread IDs.

The exact configuration format is an implementation decision. The boundary is
more important than the syntax: a producer must not be able to choose an
arbitrary workspace, thread, prompt template, model, sandbox mode, approval
policy, surface destination, or shell command.

The configured prompt should direct Codex to inspect authoritative current
state. For consequential operations it should require the same explicit human
authority that an interactive turn would require.

## In-memory dispatch

The dispatcher retains the following state for the life of the process:

- a bounded queue of accepted signals;
- coalescing keys for queued and active signals;
- active Codex sessions and turns;
- per-thread concurrency state;
- transient response-delivery state.

All of this state is discarded on restart.

The default busy-thread policy queues the signal in memory. It does not
steer an unrelated active turn automatically. A bounded queue prevents local
producers from causing unbounded memory growth. Repeated level-triggered signals
with the same configured coalescing key may collapse into one pending signal.
For example, three queued `research.state-changed` signals for `run-123` can
become one inspection, while a signal for `run-456` remains separate. This is
only an in-memory optimization and provides no delivery or deduplication
guarantee across restarts.

If an equivalent signal arrives while its turn is active, the dispatcher
retains at most one pending follow-up containing the latest accepted payload.
This lets Shepherd inspect changes that occurred during the active turn without
building an unbounded backlog.

An implementation may add an in-memory startup or periodic reconciliation
signal. Such a signal still provides no durable cursor or processing history;
it simply asks the agent to inspect current external state again.

## Failure semantics

This design knowingly accepts the following behavior:

- a signal may be lost during process restart or shutdown;
- an accepted signal may never begin a Codex turn;
- a turn may begin but its response may not be delivered;
- repeated signals may cause repeated inspection;
- signals from different producers may be observed in timing-dependent order;
- Shepherd cannot prove that a particular external change was handled; and
- surface bindings and other in-memory routing state may need to be recreated
  after restart unless supplied by static configuration.

These are product semantics, not implementation bugs. A feature must not use
volatile signals when losing or duplicating the requested work would violate a
safety, cost, publication, cleanup, or audit requirement.

## Local security boundary

Loopback binding substantially narrows exposure, but the endpoint still crosses
a trust boundary because Shepherd may run Codex with broad filesystem and
command permissions.

The adapter therefore:

- bind to `127.0.0.1` by default and reject unsafe bind configuration unless it
  is explicitly enabled;
- enforce strict route-specific payload validation and request-size limits;
- reject unknown fields where practical;
- avoid logging secrets or full untrusted payloads;
- place rate and queue bounds on every producer;
- use trusted route configuration for execution context; and
- optionally support a shared bearer token as inexpensive defense in depth.

A Unix domain socket remains a possible future transport, but stdio is not the
preferred boundary. Stdio would couple producer and Shepherd process
lifecycles, complicate multiple producers, and make independent restarts and
manual testing less convenient.

## Relationship to Shepherd's architecture

The webhook listener is an ingress adapter alongside Discord, not a Discord
feature. Signal validation, coalescing, busy-thread policy, and dispatch belong
in the application core. HTTP request parsing and response delivery belong in a
localhost webhook adapter.

The implementation avoids introducing a general plugin loader.
The webhook adapter and one remote-experiment integration should establish the
extension seam. A formal addon contract can be designed after a second use case
shows which parts are genuinely reusable.

A likely initial module boundary is:

```text
shared/protocol/signals.ts
  common envelope and normalized signal contracts

server/core/signal_registry.ts
  kind registration and per-kind payload validation

server/core/signal_dispatcher.ts
  in-memory queue, coalescing, bounds, and per-thread dispatch

server/adapters/webhook/server.ts
  loopback HTTP lifecycle, parsing, validation, and status mapping

server/signals/research_state_changed.ts
  first kind definition and Codex input construction

server/runtime/shepherd_runtime.ts
  shared composition and lifecycle for Discord and webhook adapters
```

The dispatcher should depend on a small execution port rather than HTTP or
Discord directly:

```ts
type SignalExecutor = {
  resolveTarget: (target: SignalTarget) => Promise<{
    threadId: string;
    cwd: string;
  } | null>;
  waitUntilIdle: (target: ResolvedSignalTarget) => Promise<void>;
  executeTurn: (target: ResolvedSignalTarget, input: UserInput[]) => Promise<void>;
};
```

Existing surface subscriptions can deliver the resulting Codex events to
Discord. Signal turns should not need a second response-delivery mechanism.

## Implementation structure

### 1. Core signal mechanism

- Add the shared envelope, kind registry, dispatcher, and execution port.
- Implement a bounded FIFO queue, per-thread serialization, pending-signal
  coalescing, and one follow-up for a matching active signal.
- Resolve a trusted surface target to its current thread and workspace.
- Never steer an unrelated active turn.
- Cover the mechanism with transport-independent unit tests.

### 2. Local webhook adapter

- Implement `POST /signals` with Bun's built-in HTTP server.
- Bind to loopback, enforce content type and body-size limits, and optionally
  check a bearer token.
- Map validation, saturation, and lifecycle results to the documented status
  codes.
- Stop accepting signals while Shepherd is quiescing.
- Add adapter tests without introducing a web framework dependency.

### 3. Runtime wiring and first kind

- Extract shared runtime composition from the Discord entry point so both
  adapters use one `ConversationService` and lifecycle.
- Register `research.state-changed` with its payload schema, coalescing key,
  prompt construction, and configured Discord surface target.
- Submit the turn to the surface's current thread and use its existing event
  subscription for response delivery.
- Exercise the integration with a local producer before defining a general
  addon API.

Simple future kinds may use declarative schemas and prompt templates. Kinds
requiring richer interpretation can remain small TypeScript definition modules.
In either case, producer business logic stays outside Shepherd.

## Test matrix

- unknown kinds, unsupported versions, and invalid payloads are rejected;
- equal pending signals coalesce while different subjects remain separate;
- a matching signal during an active turn creates at most one follow-up;
- busy threads are queued and never implicitly steered;
- queue saturation returns `429`;
- missing surface bindings fail cleanly;
- quiescing returns `503` and disposal clears pending work; and
- a signal-started turn is delivered through the existing surface subscription.

## Acceptance criteria for the experiment

- A local process can signal Shepherd without sending a Discord message.
- Shepherd can route the signal into the current thread and workspace of a
  configured surface.
- A configured surface can receive the resulting final answer.
- Multiple equal level-triggered signals can be coalesced in memory.
- A busy target thread does not receive an implicit steer.
- Queue saturation and lifecycle unavailability return explicit HTTP errors.
- Restarting Shepherd clears all signal coordination state without migrations
  or recovery work.
- Remote-experiment correctness and cleanup remain independent of Shepherd.

## Open decisions

- Whether later kinds use environment configuration, a declarative route file,
  or TypeScript-only registration.
- Whether a bearer token should become mandatory rather than optional.
- Whether periodic reconciliation should complement producer webhooks.
- Whether responses are delivered only to surfaces or can also be returned
  asynchronously to local producers in a later design.
