# Provider architecture audit

Audit date: 2026-10-10. Baseline: ee23487, rebased on b5797c1.

Scope: provider selection, session lifecycle, SDK translation, storage, tools,
approvals and questions, history and catalogs, controls, build packaging, and
existing regression tests. The audit used source imports and installed SDK types.
It did not assume that a passing mock test proves real model behavior.

## Findings before implementation

| Area | Finding | Required change |
| --- | --- | --- |
| Dependencies | Core imports a registry that imports both native implementations. | Inject provider services at the runtime composition boundary. Move native adapters out of core. |
| Contract | A single session interface combines execution, history, catalog, and account operations. | Name separate ports. Keep their composition explicit. |
| Identity | Controls and history infer provider from thread ID prefixes. | Persist explicit bindings; isolate legacy ID recognition in composition. |
| Claude responsibilities | Storage, SDK execution, input queue, MCP tools, and approval translation share one file. | Separate storage, input transport, tool bridge, and question translation. |
| Fork | Fork first resumes and writes the source with fork overrides. | Read and copy the source without changing it. |
| Metadata | Rename/archive can replace in-memory turns with an older saved snapshot. | Mutate the authoritative live record when bound. |
| Questions | AskUserQuestion is treated as a tool permission; bypass mode has no question handler. | Normalize questions and answers through the shared request contract in every permission mode. |
| Controls | Unsupported Claude operations remain visible. | Publish capabilities and use them in controls; retain server rejection. |
| Events | Claude emits a Codex method name to satisfy common stream consumers. | Define a normalized stream kind; preserve native method only as diagnostics and support older events. |
| Discovery | Loaded-thread discovery asks only the Codex control process. | Include loaded sessions owned by the application. |
| Lifecycle | Claude closes its query at the first final result, including when background tasks remain. | Track background activity and keep the transport available while that work runs. |
| Verification | Native fixtures do not cover the defects above or prevent dependency regressions. | Add meaningful boundary, identity, question, mutation, and lifecycle regressions. |

## Intended dependency direction

Browser and surface adapters -> application core -> provider ports and shared DTOs.
Native provider adapters -> provider ports and shared DTOs.
Runtime composition -> application, native providers, and storage implementations.
Storage implementations must not import either SDK. Core must not import native
providers, storage implementations, or SDK packages. The build script can import
packaging dependencies.

Thread IDs are opaque to application code. An explicit provider binding is the
source of truth after discovery or creation. Legacy Claude prefixes and legacy
Codex IDs are recognized only at the composition boundary. Existing IDs remain
stable. Native session IDs remain private to each adapter.

Capabilities describe application operations, not every feature of a native SDK.
An adapter must reject unsupported operations even when a client ignores the
capability response. Model-specific effort options remain catalog data.

## Validation plan

Run source boundary checks, provider regressions, the full test suite, TypeScript
and UI build checks, and the packaged executable configuration check. Test SDK
transport behavior without asserting that simulated streams are live recordings.
Record any live-model validation limits in the completion report.

## Implemented structure

- `server/core/agent_session.ts` defines execution, history, catalog, account, and
  event ports. Responses at these ports use shared types. Codex response decoding
  is in its native adapter, including account-credit interpretation.
- `server/runtime/provider_services.ts` assembles the registered providers,
  session factories, storage, and provider directory. `ConversationService`
  receives these services through constructor options. Its isolated defaults do
  not create SDK processes.
- `server/storage` implements thread snapshots and explicit provider bindings.
  The Claude adapter receives a repository port from `server/ports`. Binding
  creation uses an atomic link, so competing writers cannot reassign a thread.
- Claude question mapping, MCP tools, the input queue, and background tracking
  have separate modules. The session owns every native query, including catalog
  discovery, and closes them on shutdown. A stopped active turn is persisted
  before the iterator finishes.
- Claude credential policy is confined to its adapter. Subscription login is
  the default; API authentication requires `CLAUDE_AUTH_MODE=api`. Both turn and
  catalog queries use the same isolated subprocess environment and settings,
  which prevent inherited API credentials from replacing subscription login.
  The host environment and Codex credentials remain untouched.
- `server/core/account_limits_service.ts` routes host account reads through the
  `server/ports/provider_account_limits.ts` reader port. Its DTO is in shared
  protocol and has no SDK or conversation dependency. Runtime composition owns
  one Claude reader, registers it with the core and injects its native observer
  into Claude sessions. The core closes account readers on shutdown.
- The Claude account adapter owns native usage queries, identity isolation,
  coalescing, cache, timeout and event collection. Its mapper alone interprets
  experimental native usage replies and rate-limit events. Account reads submit
  no model prompt and disable project settings/tools/MCP. Observation cannot
  stall a model stream. Browser code consumes only shared account DTOs. Existing
  Codex limits/reset response contracts remain intact; no cross-provider reset
  action is added.
- `server/core/provider_thread_catalog.ts` merges provider pages and refills
  sources before choosing the next row. The merge handles changing page sizes,
  empty intermediate pages, and repeated cursor failures.
- Shared stream events have an assistant-text kind. Consumers accept older
  events during replay. Shared history presentation has no native adapter import.
- Web controls read capabilities from thread state. Unsupported operations are
  also rejected by the application. Discord model pagination uses explicit
  provider identity. Multi-select question forms use checkboxes; Discord directs
  those requests to the web form.

Claude queries remain open between turns. Background snapshots replace edge
state and exclude ambient watchers from restart guards. Responses that arrive
without a submitted user turn create a new recorded turn. Session-setting
changes wait for background work to finish. When interruption reports queued
steering that would still run, Shepherd closes that query: the public SDK does
not expose cancellation for those queued messages.

The question translation follows the [official SDK user-input contract](https://code.claude.com/docs/en/agent-sdk/user-input).
Background tracking uses the types supplied by the installed SDK.

## Verification and limits

The full suite, server and browser type checks, UI build, and standalone binary
build pass. Native Claude model discovery also succeeds. The regression suite
uses controlled SDK streams for questions, tools, turn failure, steering,
background responses, interruption, and shutdown. It does not claim a live model
run or a recorded production transcript. The packaged web configuration passes;
Discord configuration requires its token.

Storage remains file-based. Provider identity is persisted separately from the
native transcript, and both must be preserved when migrating a host. Listings
are live views: changes during pagination can require a reload. Legacy ID
recognition remains a compatibility path at composition, not an application
routing rule. Both providers report account limits at host scope. Claude uses an experimental
SDK read with stale/unavailable fallback and shared native event observations;
Codex alone supports banked reset redemption. Claude
manual compaction, rewind, restricted sandbox modes, and skill-management
controls remain unsupported.
