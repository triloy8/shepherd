# Signal callbacks: design record

The reasoning, decisions and implementation checklist behind
[volatile signal callbacks](../volatile-webhook-signals.md), which documents the current
contract.

## Problem

A detached local service can outlive the Codex turn that launched it. When the
service later has something meaningful to report, Shepherd needs enough trusted
context to resume the originating Codex thread and deliver the response to the
originating Discord conversation.

The producer must not choose a Codex thread or Discord channel. Codex also should
not need to know either identifier when launching the service.

The first producer is a research-run service supervised by systemd. The same
mechanism should remain useful for builds, data preparation, and other local
services without turning Shepherd into a workflow engine.

## Accepted decisions

- Shepherd listens on loopback and accepts raw unauthenticated HTTP callbacks.
- Each successful `get_signal_callback` tool call creates a new cryptographically
  random, non-sequential route ID.
- The route ID appears only in the callback URL. Producers do not send a thread
  ID, Discord channel ID, or route ID in the JSON body.
- The dynamic tool request's `threadId` and `turnId` are the trusted source of
  conversation context. They are never model-supplied tool arguments.
- Codex launches the detached service using the existing domain CLI or shell
  command. Shepherd does not launch, supervise, cancel, or clean up the service.
- Producer repositories own any repo-scoped Codex skills that describe their
  launch, authorization, evidence, and cleanup workflows. Shepherd owns only
  the generic callback and resumed-turn transport.
- The callback URL is passed to the service as a per-launch CLI argument, not an
  environment variable or shared configuration file.
- Routes, queued signals, and delivery state are bounded and process-local.
- Signals are best-effort and level-triggered. They are not durable jobs or
  exactly-once events.
- Existing validation, queueing, busy-thread policy, Codex execution, and Discord
  rendering remain the delivery path. The Discord adapter adds a sanitized
  signal notice immediately before execution and anchors the new turn to it.
- No compatibility shim is retained for the static research-channel route.

## Explicit non-goals

This design does not add:

- a Shepherd-owned research or systemd launcher;
- a `shepherdctl` callback-allocation command;
- thread IDs in callback URLs;
- callback or route environment variables;
- bearer tokens, token files, authorization headers, or secret rotation;
- SQLite, a durable inbox, an event log, leases, or callback recovery;
- a listener per service or per route; or
- a general-purpose workflow engine.

Correctness-critical research behavior such as budgets, monitoring, evidence,
recovery, publication, and resource cleanup remains owned by the research
service. It must remain correct if Shepherd never receives a callback.

## Removed compatibility surface

The implementation removes:

- `SHEPHERD_RESEARCH_SIGNAL_DISCORD_CHANNEL_ID`;
- the static research route in runtime wiring;
- `routeId` from the JSON body;
- the old `POST /signals` request shape; and
- documentation and tests for the static path.

The proposed `SHEPHERD_SIGNAL_URL` and `SHEPHERD_SIGNAL_ROUTE_ID` handoff
variables are also removed from the design. Dynamic callback data is passed only
through the service's `--signal-url` CLI argument.

Stable operator configuration for the shared listener, such as enablement,
loopback host, port, body limit, and queue capacity, remains ordinary Shepherd
configuration. It is not per-run callback state.

## Implementation inventory

### 1. Experimental app-server integration — implemented

- Set `initialize.params.capabilities.experimentalApi` to `true`.
- Add the documented `dynamicTools` namespace to `thread/start`.
- Verify experimental generated schemas separately from the documented baseline; `schemas/` is generated locally and ignored by Git.
- Cover the documented `item/tool/call` response contract with transport tests;
  app-server owns the surrounding item lifecycle notifications.
- Treat failures as an experimental-protocol compatibility error rather than
  silently launching without a callback.

### 2. Dynamic tool handling — implemented

- Add typed `item/tool/call` parsing and response support to `CodexSession`.
- Add an explicit dynamic-tool registry; unknown tools remain unsupported.
- Register `shepherd.get_signal_callback` with a strict input schema.
- Record the experimental support in the app-server schema parity matrix.

### 3. Trusted conversation capture — implemented

- Retain the originating surface context for each submitted turn.
- Resolve `threadId` and `turnId` from the server request, never from arguments.
- Reject callback allocation if the execution or delivery context is ambiguous
  or unavailable.

### 4. Ephemeral route registry — implemented

- Add random ID generation, collision handling, TTL enforcement, capacity
  bounds, terminal revocation, pruning, and disposal.
- Add deterministic clock and route-ID generation seams for tests.
- Return a distinct complete URL for every successful tool call.

### 5. Routed HTTP ingress — implemented

- Replace the static endpoint with `POST /signals/:routeId`.
- Remove routing fields from the JSON envelope.
- Resolve the route before kind-specific validation and dispatch.
- Return route-safe responses that do not expose internal targets.

### 6. Producer integration — external contract

- Add `--signal-url` to the research-service launch contract.
- Have Codex obtain the URL through the dynamic tool before launching.
- Keep systemd and the research service responsible for the complete operation
  lifecycle.

### 7. Remove the static path — implemented

- Remove the research-channel environment setting and runtime wiring.
- Remove the old body-routed endpoint and its tests.
- Do not retain a compatibility fallback or translation shim.

### 8. Presentation and operations — implemented

- Signal-started turns use the existing Discord turn presentation.
- Route lifecycle diagnostics log only an eight-character route prefix plus the
  registered kind and version; complete URLs and payloads are not logged.
- Existing dispatcher and webhook error paths report saturation and failures.

## Test matrix

- initialization opts into `capabilities.experimentalApi`;
- `thread/start` advertises the `shepherd` namespace and strict callback-tool
  input schema;
- default schema output omits `dynamicTools` while experimental schema output
  contains the documented field;
- dynamic tool specs are advertised using the supported app-server contract;
- valid `item/tool/call` requests receive schema-conforming responses;
- dynamic tool lifecycle notifications remain correlated to the originating
  thread and turn;
- malformed, stale-turn, wrong-session, and unknown-tool requests are rejected;
- every successful tool call returns a distinct opaque callback URL;
- repeated calls from one turn create independent routes;
- route creation captures the originating thread, workspace, and Discord
  surface without accepting those values as tool arguments;
- unknown, expired, and revoked URLs return `404`;
- a producer cannot alter its route's execution or delivery target;
- a route cannot submit an unapproved kind or version;
- independent routes for the same thread and kind remain isolated;
- routes from different Discord conversations deliver only to their origin;
- same-run pending signals may coalesce while different routes or runs do not;
- matching signals during an active turn create at most one follow-up;
- busy threads queue signals and are never implicitly steered;
- route and queue saturation return explicit errors;
- terminal signals revoke their routes after acceptance;
- routes expire after 24 hours by default and can never exceed 7 days;
- failed launches leave no permanent callback state because their unused routes
  expire naturally;
- shutdown rejects new work and clears all volatile state;
- restart invalidates callback URLs without affecting producer-owned cleanup;
  and
- no static research-channel or callback handoff environment variables remain.

## Acceptance criteria

- Codex can request a callback without supplying a thread or Discord ID.
- Each request returns a new opaque URL bound to the active conversation.
- Codex can launch any number of detached services with independent callback
  URLs using CLI arguments.
- A detached service can wake Shepherd after its originating turn ends.
- The new turn resumes the originating Codex conversation.
- Interim progress, activity, and the final answer reach the originating Discord
  conversation through the existing renderer.
- Simultaneous operations from one or many conversations remain isolated.
- Routes are narrowly scoped, bounded, revocable, and process-local.
- A busy target thread is queued rather than steered.
- Restarting Shepherd requires no route migration or recovery state.
- Research correctness and cleanup remain fully independent of Shepherd.
- The obsolete static route and dynamic callback environment variables are
  absent rather than supported through shims.

## Operational readiness

The architecture, app-server contract, callback handoff, and route-lifetime
policy are implemented. Enable the shared listener with
`SHEPHERD_SIGNAL_WEBHOOK_ENABLED=true` before creating a Codex thread that needs
the tool. App-server persists dynamic tools in the thread rollout, so a thread
created before this feature was deployed must be replaced once with
`!newthread`; Shepherd does not mutate historical rollouts during
`thread/resume`.
