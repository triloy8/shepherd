# Volatile signal callbacks

## Status

This contract is implemented. Shepherd creates a fresh opaque callback URL
through a Codex dynamic tool for each detached operation. Codex launches the
operation; Shepherd only creates the callback, receives signals, and resumes the
originating conversation.

The former static research-channel route, its environment variable, and the old
`POST /signals` request shape have been removed without a compatibility shim.

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

## Target flow

```text
Discord conversation
  -> Shepherd starts a Codex turn and retains its surface context
  -> Codex decides to launch a detached operation
  -> Codex calls shepherd.get_signal_callback
  -> codex app-server sends item/tool/call with the trusted thread and turn IDs
  -> Shepherd creates a fresh opaque callback route for that conversation
  -> Shepherd returns the complete callback URL to Codex
  -> Codex passes the URL as a CLI argument when it launches the service
  -> the interactive Codex turn ends
  -> the systemd-supervised service operates independently
  -> the service POSTs a level-triggered signal to its unique callback URL
  -> Shepherd resolves the route and starts a new turn in the captured thread
  -> existing surface subscriptions deliver the response to Discord
  -> the route expires or is revoked after a terminal signal
```

There is one HTTP listener in the always-running Shepherd process. Detached
services are HTTP clients; Shepherd does not create a server or port for each
run.

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
- The callback URL is passed to the service as a per-launch CLI argument, not an
  environment variable or shared configuration file.
- Routes, queued signals, and delivery state are bounded and process-local.
- Signals are best-effort and level-triggered. They are not durable jobs or
  exactly-once events.
- Existing validation, queueing, busy-thread policy, Codex execution, and Discord
  rendering remain the delivery path.
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

## Dynamic tool contract

The [official Codex app-server documentation](https://learn.chatgpt.com/docs/app-server)
defines `dynamicTools` on `thread/start` and the corresponding
`item/tool/call` request/response flow as experimental APIs. Shepherd's pinned
`codex-cli 0.149.0` exposes the same fields when schemas are generated with the
experimental surface included.

### Advertisement

Shepherd first opts into experimental app-server fields during initialization:

```json
{
  "id": 1,
  "method": "initialize",
  "params": {
    "clientInfo": {
      "name": "shepherd",
      "title": "Shepherd",
      "version": "1.0.0"
    },
    "capabilities": {
      "experimentalApi": true
    }
  }
}
```

It then advertises one narrowly scoped function namespace when starting the
thread. The function arguments are:

```ts
type GetSignalCallbackArguments = {
  kind: string;
  version: number;
};
```

The `thread/start` registration is:

```json
{
  "id": 10,
  "method": "thread/start",
  "params": {
    "model": "<configured-model>",
    "approvalPolicy": "<configured-policy>",
    "dynamicTools": [
      {
        "type": "namespace",
        "name": "shepherd",
        "description": "Shepherd conversation services",
        "tools": [
          {
            "type": "function",
            "name": "get_signal_callback",
            "description": "Create a unique callback URL for a detached local service.",
            "inputSchema": {
              "type": "object",
              "properties": {
                "kind": { "type": "string" },
                "version": { "type": "integer", "minimum": 1 }
              },
              "required": ["kind", "version"],
              "additionalProperties": false
            }
          }
        ]
      }
    ]
  }
}
```

The tool allocates routing context only. It does not execute a command or start
a service. Dynamic tool and namespace names must follow Responses API naming
constraints and must not collide with reserved built-in Codex namespaces.

App-server persists the dynamic tool definitions in the thread rollout. A
normal `thread/resume` restores them, so Shepherd does not need to re-register
the function on every turn.

The default schema-generation commands omit experimental fields. Protocol
verification uses temporary output with `--experimental`; without that flag,
`ThreadStartParams` does not show `dynamicTools` even though the installed
app-server supports it. The checked-in baseline remains generated by the
repository-standard commands:

```bash
codex app-server generate-ts --experimental --out <temporary-directory>
codex app-server generate-json-schema --experimental --out <temporary-directory>
```

### App-server request

When Codex selects the tool, app-server sends Shepherd a reverse JSON-RPC
request on the existing stdio connection:

```json
{
  "id": 42,
  "method": "item/tool/call",
  "params": {
    "threadId": "019faa58-...",
    "turnId": "019faa59-...",
    "callId": "call_123",
    "namespace": "shepherd",
    "tool": "get_signal_callback",
    "arguments": {
      "kind": "research.state-changed",
      "version": 1
    }
  }
}
```

For each invocation, app-server emits this lifecycle on the same thread:

1. `item/started` with `item.type = "dynamicToolCall"` and an in-progress
   status;
2. the `item/tool/call` server request shown above;
3. Shepherd's correlated JSON-RPC response; and
4. `item/completed` with the final status, returned content items, and success
   value.

Shepherd must validate that:

- `threadId`, `turnId`, and `callId` are non-empty strings;
- the request belongs to the current Shepherd session and active turn;
- the originating surface for that turn is still known;
- the namespace and tool name are registered;
- the requested signal kind and version are registered; and
- the arguments match the tool's input schema exactly.

The model cannot provide or override the execution thread, workspace, Discord
surface, prompt, model, sandbox, approval policy, or shell command through this
tool.

### Tool response

Every successful call creates a distinct route, including repeated calls from
the same turn. Shepherd returns the complete URL as tool output:

```json
{
  "id": 42,
  "result": {
    "success": true,
    "contentItems": [
      {
        "type": "inputText",
        "text": "{\"url\":\"http://127.0.0.1:8787/signals/L9iY...\"}"
      }
    ]
  }
}
```

Malformed requests receive a JSON-RPC invalid-params response. Unknown dynamic
tools remain unsupported. A route-allocation failure returns a failed tool
result and Codex must not launch a service without a callback when callback
delivery is required.

## Route model

The in-memory registry retains records shaped approximately as follows:

```ts
type EphemeralSignalRoute = {
  id: string;
  allowedSignal: {
    kind: string;
    version: number;
  };
  target: {
    type: "conversation";
    threadId: string;
    cwd: string;
    delivery: {
      adapter: "discord";
      surfaceId: string;
    };
  };
  originTurnId: string;
  createdAt: number;
  expiresAt: number;
};
```

Route IDs must have enough entropy to avoid collisions and casual enumeration.
They are opaque routing handles rather than authentication secrets. Logs use a
short prefix when correlation is needed.

The route captures information that the producer must not control:

- the Codex thread that receives the signal-started turn;
- the originating turn for diagnostics;
- the workspace used for execution;
- the Discord surface that receives existing thread events; and
- the one allowed signal kind and version.

Routes are process-local. Restarting Shepherd invalidates all callback URLs.
The producer may report failure or retry according to its own policy, but it
must never rely on Shepherd callback delivery for correctness.

## Producer launch contract

After receiving the tool result, Codex passes the complete URL to the detached
service as an ordinary CLI argument:

```bash
research-service start \
  --signal-url http://127.0.0.1:8787/signals/L9iY...
```

The existing research launcher may pass the argument through to a unique
transient or templated systemd unit. Every process receives an immutable command
line from its own launch, so simultaneous launches do not share mutable state.

The service owns its run identifier. Different services may target the same
Codex thread, but each tool call still gives them a distinct callback URL.

If launch fails after route allocation, the unused route simply expires. Codex
may report the launch failure in the current turn; no correctness-critical
cleanup depends on route revocation.

## HTTP callback contract

The route ID is part of the path:

```http
POST /signals/L9iY... HTTP/1.1
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

The envelope is:

```ts
type RoutedSignalEnvelope = {
  kind: string;
  version: number;
  subject?: {
    type: string;
    id: string;
  };
  payload: unknown;
};
```

The path supplies routing. The body supplies signal identity and domain state.
Thread IDs, Discord surface IDs, route IDs, prompts, commands, models, and
execution policy are not valid body fields.

Ingress processing order is:

1. Enforce lifecycle availability, method, path, content type, and body limit.
2. Extract and structurally validate the opaque route ID from the path.
3. Parse and structurally validate the bounded JSON envelope.
4. Resolve the active route and confirm its allowed kind and version.
5. Validate the kind-specific payload.
6. Resolve the captured thread and delivery subscription.
7. Offer the signal to the bounded dispatcher.

`GET /health` reports only whether the shared adapter can accept work.

## Response semantics

- `202 Accepted`: accepted into the current process's memory;
- `400 Bad Request`: malformed envelope or kind-specific payload;
- `404 Not Found`: unknown, expired, or revoked route, or unknown signal kind;
- `409 Conflict`: the captured target cannot currently execute or deliver;
- `413 Content Too Large`: the configured body limit was exceeded;
- `415 Unsupported Media Type`: the request is not JSON;
- `429 Too Many Requests`: the bounded queue or route limit is saturated; and
- `503 Service Unavailable`: Shepherd is starting, quiescing, or shutting down.

There are no tombstones and no distinct `410 Gone` response. All inactive route
IDs return `404`.

`202 Accepted` means only that the current Shepherd process accepted the signal.
It does not promise eventual execution, durable acceptance, or delivery of an
agent response.

The response may report coalescing without exposing routing information:

```json
{
  "accepted": true,
  "coalesced": false
}
```

It must not return a thread ID, turn ID, Discord surface ID, or full route ID.

## Signal definitions and coalescing

Signal definitions remain independent of callback routing:

```ts
type SignalDefinition<T> = {
  kind: string;
  version: number;
  validatePayload: (value: unknown) => T;
  buildInput: (signal: SignalEnvelope & { payload: T }) => UserInput[];
  coalesceKey?: (signal: SignalEnvelope & { payload: T }) => string;
  isTerminal?: (signal: SignalEnvelope & { payload: T }) => boolean;
};
```

The research service includes a stable run ID as the subject ID. Dispatcher
identity includes the target thread, route, kind, version, and definition-level
coalescing key. Signals for the same run may collapse into one pending
inspection; signals from independent routes or runs must not collapse together.

The generated Codex input directs the agent to inspect authoritative current
state. Consequential operations retain the same explicit human-authority
requirements as an interactive turn.

## Dispatch and Discord delivery

The existing dispatcher remains responsible for:

- bounded in-memory queueing;
- per-thread serialization;
- coalescing queued and active level-triggered signals;
- waiting for active human turns without steering them; and
- submitting the resulting Codex input.

The captured thread is the execution target. The captured Discord surface uses
the existing thread-event subscription, Components V2 renderer, streaming
behavior, and final-answer delivery.

Multiple routes can target one thread. They share its serialization queue and
conversation context while retaining distinct route and run identities.

## Route lifecycle

Route cleanup is bounded housekeeping, not a correctness mechanism.

- A new route expires after 24 hours by default.
- No route may remain active for more than 7 days.
- Registry capacity is bounded.
- Expired and revoked routes are removed rather than retained as tombstones.
- A signal definition may mark a signal as terminal.
- A route is revoked immediately after its terminal signal has been accepted.
- Nonterminal signals leave the route active until expiration.
- A route allocated for a launch that later fails is not special-cased; it
  expires naturally after its configured lifetime.
- Shepherd shutdown clears routes, queues, and transient delivery state.

The 24-hour default covers normal research runs without requiring the launcher
to manage callback cleanup. The 7-day hard limit bounds unusually long runs and
abandoned routes while keeping callback state explicitly volatile.

## Security boundary

The listener is deliberately unauthenticated. Loopback binding is the network
trust boundary. Any local process that learns a live callback URL can submit the
one allowed signal kind to that route, but it cannot redirect the signal to a
different conversation or choose execution policy.

The implementation must:

- bind to loopback and reject wildcard or public binds;
- create routes only through a validated app-server tool call;
- generate cryptographically random, non-sequential route IDs;
- validate route, kind, version, subject, payload, and request-size bounds;
- bound route count, queue size, and per-route request rate;
- avoid logging complete callback URLs or untrusted payloads;
- prevent producer-controlled execution and delivery targets; and
- make expiration and revocation effective immediately.

This mode must not be exposed on a public or wildcard interface.

## Failure semantics

This design knowingly accepts that:

- callback URLs become invalid after Shepherd restarts;
- a signal may be lost during restart or shutdown;
- an accepted signal may never begin a Codex turn;
- a turn may begin but its response may not reach Discord;
- an unused route may remain until expiration after launch failure;
- repeated signals may cause repeated inspection;
- callbacks from different producers may be observed in timing-dependent order;
- a systemd service may outlive its Shepherd callback route; and
- Shepherd cannot prove that an external change was handled.

These are product semantics, not implementation bugs. Volatile callbacks must
not enforce spending limits, terminate compute, preserve artifacts, publish
evidence, audit activity, or perform any action that must happen exactly once.

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

## Module ownership

Existing signal components remain:

```text
shared/protocol/signals.ts
server/core/signal_registry.ts
server/core/signal_dispatcher.ts
server/core/conversation_signal_executor.ts
server/adapters/webhook/server.ts
server/signals/research_state_changed.ts
server/runtime/shepherd_runtime.ts
```

The narrowly scoped routing components are:

```text
server/core/dynamic_tool_registry.ts
  validate and dispatch explicitly registered item/tool/call handlers

server/core/signal_route_registry.ts
  create, resolve, expire, revoke, and bound opaque routes

server/core/signal_route_service.ts
  convert trusted tool-call context into a route and complete callback URL
```

`CodexSession` owns JSON-RPC framing and response correlation. It delegates
recognized dynamic tool requests instead of embedding signal or research logic.

The route registry remains independent of HTTP, Discord, Codex, research, and
systemd. Research-specific payload interpretation remains in the registered
signal definition.

## Implementation inventory

### 1. Experimental app-server integration — implemented

- Set `initialize.params.capabilities.experimentalApi` to `true`.
- Add the documented `dynamicTools` namespace to `thread/start`.
- Verify experimental generated schemas separately from the checked-in baseline.
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
- Commentary, activity, and the final answer reach the originating Discord
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
created before this feature was deployed must be replaced once; Shepherd does
not mutate historical rollouts during `thread/resume`.
