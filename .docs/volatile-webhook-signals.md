# Volatile localhost webhook signals

## Status

Proposed.

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

The initial adapter should expose a small HTTP surface on a configurable
loopback address. It must not bind to a public or wildcard interface by
default.

```http
POST /signals/research-state-changed HTTP/1.1
Host: 127.0.0.1:8787
Content-Type: application/json

{
  "runId": "run-123",
  "state": "COMPLETE"
}
```

The route name identifies a configured signal kind. Payload schemas may differ
by signal kind, but each schema should be explicit, narrow, and validated
before the signal enters the in-memory dispatcher.

Suggested response semantics:

- `202 Accepted`: the current Shepherd process accepted the signal into memory;
- `400 Bad Request`: the request or payload is malformed;
- `404 Not Found`: the signal kind is unknown;
- `413 Content Too Large`: the request exceeds the configured size limit;
- `429 Too Many Requests`: the bounded in-memory queue is full; and
- `503 Service Unavailable`: Shepherd is starting, quiescing, or shutting down.

`202 Accepted` deliberately does not promise eventual execution, durable
acceptance, or delivery of an agent response.

## Trusted routing configuration

Webhook payloads should contain external facts, not execution authority.
Shepherd-owned configuration maps each signal kind to a trusted route such as:

```ts
type SignalRoute = {
  kind: string;
  threadId: string;
  cwd: string;
  prompt: string;
  replyTo?: {
    adapter: "discord";
    surfaceId: string;
  };
  coalesceBy?: string[];
};
```

The exact configuration format is an implementation decision. The boundary is
more important than the syntax: a producer must not be able to choose an
arbitrary workspace, thread, prompt template, model, sandbox mode, approval
policy, surface destination, or shell command.

The configured prompt should direct Codex to inspect authoritative current
state. For consequential operations it should require the same explicit human
authority that an interactive turn would require.

## In-memory dispatch

The dispatcher may retain the following state for the life of the process:

- a bounded queue of accepted signals;
- coalescing keys for queued and active signals;
- active Codex sessions and turns;
- per-thread concurrency state;
- recent signal identifiers for short-lived duplicate suppression; and
- transient response-delivery state.

All of this state is discarded on restart.

The default busy-thread policy should queue the signal in memory. It should not
steer an unrelated active turn automatically. A bounded queue prevents local
producers from causing unbounded memory growth. Repeated level-triggered signals
with the same configured coalescing key may collapse into one pending signal.

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

The adapter should therefore:

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

The first implementation should avoid introducing a general plugin loader.
The webhook adapter and one remote-experiment integration should establish the
extension seam. A formal addon contract can be designed after a second use case
shows which parts are genuinely reusable.

A likely initial module boundary is:

```text
server/core/signal_dispatcher.ts
  signal routing, coalescing, bounds, and turn dispatch

server/adapters/webhook/server.ts
  loopback HTTP lifecycle, parsing, validation, and status mapping

server/adapters/discord/*
  optional response delivery for configured routes
```

Runtime construction should eventually move out of the Discord bootstrap so
Discord and webhook ingress can share one `ConversationService` and lifecycle.

## Initial implementation sequence

1. Extract shared Shepherd runtime composition from the Discord entry point.
2. Define the normalized core signal and configured route contracts.
3. Implement and test a bounded in-memory dispatcher with coalescing and
   per-thread busy handling.
4. Add the loopback-only HTTP adapter with validation and explicit response
   semantics.
5. Configure one remote-experiment signal and deliver its agent response to a
   Discord surface.
6. Exercise restart, saturation, duplicate, active-turn, and shutdown behavior
   while preserving the deliberately volatile contract.
7. Revisit an addon API only after another local producer is integrated.

## Acceptance criteria for the experiment

- A local process can signal Shepherd without sending a Discord message.
- Shepherd can route the signal into a configured Codex thread and workspace.
- A configured surface can receive the resulting final answer.
- Multiple equal level-triggered signals can be coalesced in memory.
- A busy target thread does not receive an implicit steer.
- Queue saturation and lifecycle unavailability return explicit HTTP errors.
- Restarting Shepherd clears all signal coordination state without migrations
  or recovery work.
- Remote-experiment correctness and cleanup remain independent of Shepherd.

## Open decisions

- Configuration format and precedence for signal routes.
- Whether the first version enables a bearer token by default.
- Queue capacity, coalescing-key rules, and periodic reconciliation interval.
- Whether responses are delivered only to surfaces or can also be returned
  asynchronously to local producers in a later design.
