# Volatile signal callbacks

An agent can launch a detached operation, such as a build or a research run, and be told
when it reports back. During a turn the agent asks Shepherd for a fresh, opaque callback
URL and passes it to the operation. Shepherd only creates the callback, receives signals,
and resumes the originating conversation.

Codex gets the tool as a dynamic tool. Claude gets it through Shepherd's in-process MCP
server, as `mcp__shepherd__shepherd__get_signal_callback`; the MCP bridge
(`server/providers/claude/mcp_bridge.ts`) supplies the trusted thread and turn IDs from
the active turn and rejects calls made outside one. The route and delivery rules below
apply to both. The wire examples show the Codex `item/tool/call` form.

The design reasoning and implementation record are archived in
[signal callbacks: design record](archive/signal-callbacks-design.md).

## Flow

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
  -> Shepherd resolves the route and posts a sanitized signal notice to Discord
  -> Shepherd starts a new turn in the captured thread, replying to that notice
  -> existing surface subscriptions deliver the response to Discord
  -> the route expires or is revoked after a terminal signal
```

There is one HTTP listener in the always-running Shepherd process. Detached
services are HTTP clients; Shepherd does not create a server or port for each
run.

## Runtime ownership

Shared composition lives in `server/runtime/signal_runtime.ts`. The surface host
(`server/runtime/surface_host.ts`) registers its cleanup with `ShepherdRuntime`
and starts the listener after all selected adapters have started. Each adapter
supplies its own signal-presentation hook; Discord renders research notices.
The callback contract and loopback-only trust boundary are unchanged by this
extraction.

## Dynamic tool contract

The [official Codex app-server documentation](https://learn.chatgpt.com/docs/app-server)
defines `dynamicTools` on `thread/start` and the corresponding
`item/tool/call` request/response flow as experimental APIs. Shepherd's pinned
`codex-cli 0.160.1` exposes the same fields when schemas are generated with the
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
        "description": "Services supplied by the Shepherd conversation bridge.",
        "tools": [
          {
            "type": "function",
            "name": "get_signal_callback",
            "description": "Create a unique localhost callback URL immediately before launching a detached local service. Pass the returned URL directly to the service's per-launch --signal-url CLI argument; never place it in environment variables, files, durable state, or logs.",
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
app-server supports it. The baseline under the Git-ignored `schemas/` directory
is generated by the repository-standard commands without `--experimental`.
Temporary verification uses:

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
the same turn. Shepherd returns the complete URL as text tool output
(`{ "type": "text", "text": ... }` in the application result). Each adapter encodes
it natively; the Codex JSON-RPC reply is:

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

Malformed request framing and wrong-thread or stale-turn calls receive JSON-RPC
invalid-params (`-32602`). Unknown dynamic tools receive method-not-found
(`-32601`). Invalid callback arguments, unsupported signal definitions, missing
delivery context, and route-capacity exhaustion return a failed tool result.
Codex must not launch a service without a callback when callback delivery is
required.

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
      adapter: string; // e.g. "discord" or "web"
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

- the conversation thread that receives the signal-started turn;
- the originating turn for diagnostics;
- the workspace used for execution;
- the adapter and surface that receive existing thread events; and
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

1. Check the method and path and structurally validate the opaque route ID.
2. Enforce lifecycle availability and JSON content type.
3. Read bounded JSON and structurally validate the envelope.
4. Resolve the active route, apply its request-rate limit, and confirm its allowed
   kind and version.
5. Validate the kind-specific payload and build the input.
6. Resolve the captured thread binding and workspace through the dispatcher.
7. Queue or coalesce the signal within the pending-capacity limit.

`GET /health` reports only whether the shared adapter can accept work.

## Response semantics

- `202 Accepted`: accepted into the current process's memory;
- `400 Bad Request`: malformed envelope or kind-specific payload;
- `404 Not Found`: wrong method/path, unknown, expired, or revoked route, unknown
  signal kind, or kind/version mismatch with the route;
- `409 Conflict`: the captured target cannot currently execute or deliver;
- `413 Content Too Large`: the configured body limit was exceeded;
- `415 Unsupported Media Type`: the request is not JSON;
- `429 Too Many Requests`: the pending queue is full or the per-route request rate
  is exceeded;
- `503 Service Unavailable`: the listener is quiescing or shutting down; and
- `500 Internal Server Error`: unexpected signal handling failure.

Before the listener starts, no HTTP response is available. Route-allocation
capacity is reported through the tool result, not an HTTP callback response.

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
- replacing pending signals with the same key and retaining one latest follow-up
  for a signal already waiting for idle or executing;
- waiting for active human turns without steering them; and
- invoking an adapter-owned pre-execution presentation hook; and
- submitting the resulting provider-neutral input.

The captured thread is the execution target. The captured Discord surface uses
the existing thread-event subscription, Components V2 renderer, streaming
behavior, and final-answer delivery. For `research.state-changed`, the Discord
adapter first renders a status-accented card from the already validated run ID,
reported state, producer verification flag, and optional research project. It
records that bot-authored card as the reply target for the signal-started turn.
The raw HTTP body, callback URL, route ID, thread ID, and surface ID are not
rendered.

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
- create routes only through a validated dynamic tool or Claude MCP tool call;
- generate cryptographically random, non-sequential route IDs;
- validate route, kind, version, subject, payload, and request-size bounds;
- bound route count, queue size, and per-route request rate;
- avoid logging complete callback URLs or untrusted payloads;
- redact callback URLs from Discord command-activity rendering;
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

## Module ownership

Existing signal components remain:

```text
shared/protocol/signals.ts
server/core/signals/signal_registry.ts
server/core/signals/signal_dispatcher.ts
server/core/signals/conversation_signal_executor.ts
server/adapters/webhook/server.ts
server/signals/research_state_changed.ts
server/runtime/shepherd_runtime.ts
```

The narrowly scoped routing components are:

```text
server/core/conversation/dynamic_tool_registry.ts
  validate and dispatch explicitly registered application tools (Codex
  item/tool/call requests and Claude MCP tool calls)

server/core/signals/signal_route_registry.ts
  create, resolve, expire, revoke, and bound opaque routes

server/core/signals/signal_route_service.ts
  convert trusted tool-call context into a route and complete callback URL
```

`CodexSession` owns JSON-RPC framing and response correlation. It delegates
recognized dynamic tool requests instead of embedding signal or research logic.

The route registry remains independent of HTTP, Discord, Codex, research, and
systemd. Research-specific payload interpretation remains in the registered
signal definition.

