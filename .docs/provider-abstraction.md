# Provider abstraction

## Status

Proposed on 2026-10-10, for review before implementation. It will be implemented on
[PR #90](https://github.com/triloy8/shepherd/pull/90) (`feat/multiple-agent-providers`).
This document describes the target design. [Architecture](architecture.md) describes
the code as it is today; update it as each stage lands. When the last stage is
merged, move this document to `archive/` and keep the rules in
[Architecture](architecture.md).

Decisions already agreed:

- Shepherd presents one conversation model for every provider, built as a
  re-architecture on PR #90 rather than a follow-up PR. Native provider formats
  stop at the provider adapter.
- Codex history stays in the Codex app-server. The Codex adapter converts it to
  Shepherd items when it is read (option 2). Shepherd does not store a copy.

Everything else here is proposed and open for review, in particular the item
types, interaction options using the provider's own IDs, and moving to web API
version 2 without a compatibility layer (see [Open questions](#open-questions)).

## Problem

PR #90 added Claude beside Codex, but the shared layer is still Codex's format.
Claude imitates Codex to fit into it.

| Area | Today | Effect |
| --- | --- | --- |
| History items | `CodexSession.listThreadTurns` returns Codex `ThreadItem`s unchanged. `shared/protocol/history_presentation.ts` switches on Codex type names (`commandExecution`, `fileChange`, `mcpToolCall`). | Claude saves every tool call as `{ type: "mcpToolCall", server: "claude" }`. After a reload, a Bash call reads `Running command · claude.Bash`. |
| Live tool activity | `turn.activity` carries `{ kind, label, detail, status }`. Codex builds it with the shared mapper; Claude builds it by hand. | The live view and reloaded history differ. Claude's completion event replaces the detail with `null`, so a finished call shows only `Bash · Done`. Neither provider shows command output or diffs. |
| Raw events | `turn.notification` forwards Codex `method` and `params`. `turn.stream.delta.method` holds native method names, and `ui/src/chat-state.ts` checks `"item/agentMessage/delta"`. | Discord renders `Event: <native method>`. Each provider supplies the other's strings. |
| Approvals | `ApprovalRequestPayload.method` and `params` are native. Choices are native decision strings. | Discord shows `Action: item/fileChange/requestApproval`. The web card cannot show what is being approved without native knowledge. |
| Session port | `AgentSession` includes compaction, revert, skills, and Codex rate-limit resets. Claude implements them by throwing `UnsupportedProviderOperationError`. | Each provider difference is a method that throws plus a capability flag kept in sync by hand. |
| Account limits | Codex uses `readAccountRateLimits` (native shape). Claude uses the neutral `ProviderAccountLimits`. | Two UI paths for one concept; Discord `!limits` is Codex-only. |
| Records and requests | `ThreadRecord.source` is `"appServer"`. Requests carry Codex `config`, `personality`, `modelProvider`, and `ephemeral`. | Claude has to reject or ignore Codex fields. |

Already neutral and kept: turn start, completion, and failure; streamed answer text
with phase; token usage; provider capabilities; structured questions
(`shared/protocol/user_questions.ts`); the thread/provider directory; and the
provider account-limits DTO.

## Goals

1. One item model for live events and history, for every provider.
2. Tool calls show what ran and what happened: the command and its output, the
   changed files and their diffs, the search, the URL, the subagent's report.
3. Approval and question requests describe the action in Shepherd terms and keep
   the provider's own reply options.
4. A provider port with optional parts, so missing features are absent, not
   methods that throw.
5. One account-limits model and UI path for every provider.
6. Native names, method strings, and SDK types appear only in
   `server/providers/<name>/`, enforced by tests.
7. Adapter tests replay recorded provider sessions.

## Non-goals

These [T3 Code](https://github.com/pingdotgg/t3code) features were considered and
deferred. Each can be added later without changing this design.

- An execution graph of runs, nodes, and subagent threads
  (T3 `docs/orchestration-v2/core-graph-and-data-model.md`).
- Filesystem checkpoints and rollback.
- Switching provider inside a conversation, or context handoff between providers.
- Event sourcing, command receipts, and Shepherd-owned Codex history (option 1).
- Changing thread ID formats. IDs stay opaque; existing IDs keep working.

## Rules

1. **Native formats stop at the adapter.** Nothing outside
   `server/providers/<name>/` imports a provider SDK, names a native item type or
   RPC method, or reads a native payload.
2. **A provider is never made to look like another provider.** Adapters convert
   to Shepherd items; they do not emit another provider's names or shapes.
3. **Live and stored items share one model.** An item seen live and the same
   item read from history have the same type and fields.
4. **Capabilities describe reality.** A capability is reported only when the
   provider performs it natively. Shepherd does not imitate a missing sandbox,
   approval mode, or rollback.
5. **Provider reply options pass through.** An interaction option carries the
   provider's own ID. Shepherd adds a display label and an intent, and the
   adapter validates the reply. When the provider's reply is not an option list
   (Claude's `canUseTool` callback, Codex permission grants), the adapter defines
   the options and validates them the same way.
6. **Every payload is bounded.** Text fields that can grow (command output,
   diffs, tool input and output) have a size cap and a `truncated` marker. The
   cap applies to stored history, live events, and API responses alike.

## Layers

```text
Surfaces (web UI and API, Discord, webhook)
  render only shared/protocol types
        │
Application core (server/core)
  routing, sessions, interactions store, account limits
  depends on provider ports and shared/protocol
        │
Provider ports (server/core/agent_session.ts, server/ports)
        │
Provider adapters (server/providers/codex, server/providers/claude)
  the only code that sees native protocols and SDKs
        │
Runtime composition (server/runtime/provider_services.ts)
  constructs adapters, stores, and readers
```

Storage implementations (`server/storage`) implement ports and import neither SDK.

## Conversation items

New module: `shared/protocol/conversation_items.ts`. It replaces
`HistoryItem`'s open shape and `shared/protocol/history_presentation.ts`.

```ts
type ItemStatus = "in_progress" | "completed" | "failed" | "interrupted" | "declined";

/** Text that can grow is bounded everywhere it is stored or sent. */
interface BoundedText {
  text: string;
  truncated: boolean;
  /** Original length in UTF-16 code units, when known. */
  totalLength?: number;
}

interface ItemBase {
  id: string;
  turnId: string;
  /** Set for work done inside a subagent; null for the main agent. */
  parentItemId: string | null;
  status: ItemStatus;
  startedAt: number | null;    // seconds since the epoch
  completedAt: number | null;
  error?: string;
}

type ConversationItem = ItemBase & (
  | { type: "user_message"; content: UserInput[] }
  | { type: "assistant_message"; text: string; phase: "commentary" | "final_answer" | null }
  | { type: "reasoning"; summary: string[] }
  | { type: "plan"; text: string | null; steps: Array<{ text: string; status: "pending" | "in_progress" | "completed" }> }
  | { type: "command"; command: string; cwd: string | null; output: BoundedText | null; exitCode: number | null;
      durationMs: number | null; background: boolean }
  | { type: "file_change"; changes: Array<{ path: string; kind: "add" | "update" | "delete" | "move"; movePath: string | null;
      diff: BoundedText | null; additions: number | null; deletions: number | null }> }
  | { type: "file_read"; path: string; lines: string | null }
  | { type: "search"; pattern: string; path: string | null; output: BoundedText | null }
  | { type: "web"; action: "search" | "open_page" | "find_in_page" | "other"; query: string | null; url: string | null;
      output: BoundedText | null }
  | { type: "tool"; source: "mcp" | "shepherd" | "provider"; server: string | null; name: string;
      input: BoundedText; output: BoundedText | null }
  | { type: "subagent"; description: string; prompt: BoundedText | null; report: BoundedText | null }
  | { type: "image"; origin: "generated" | "viewed"; path: string; prompt: string | null }
  | { type: "notice"; kind: "compaction" | "review" | "hook" | "wait" | "other"; text: string }
);
```

Notes:

- `tool.input` is the provider's argument object serialized as JSON and bounded.
  Surfaces show it as text; they do not interpret it.
- `file_change` is one item per tool call or Codex item, with one entry per file.
- `plan` covers Codex plan items and `turn/plan/updated`, and Claude `TodoWrite`.
- `notice` covers lifecycle markers that are not work: Codex `contextCompaction`,
  `enteredReviewMode`/`exitedReviewMode`, `hookPrompt`, `sleep`.
- Unknown native items become `tool` items with `source: "provider"` and the
  native name. They are never dropped silently.

### Size limits

| Field | Live and stored cap | Notes |
| --- | --- | --- |
| `command.output`, `search.output`, `web.output`, `tool.output` | 16 KiB | Keep the head and the last 2 KiB, so the end of a failing build is visible. |
| `file_change.changes[].diff` | 32 KiB per file, 128 KiB per item | The `+`/`−` counts are computed before truncation. |
| `tool.input`, `subagent.prompt` | 8 KiB | |
| `subagent.report` | 16 KiB | |

Discord shortens further when rendering (see Surfaces). The caps live in one
module, `shared/protocol/item_limits.ts`, with a single `boundText` helper.

## Live events

`shared/protocol/events.ts` keeps `BridgeEvent` and its envelope. Payload types change.

| Event | Fate | Payload |
| --- | --- | --- |
| `item.started` | New | `{ item: ConversationItem }` |
| `item.updated` | New | `{ item: ConversationItem }`, complete replacement |
| `item.completed` | New | `{ item: ConversationItem }`, final state |
| `item.delta` | New, replaces `turn.stream.delta` | `{ itemId, turnId, field: "text" \| "output" \| "reasoning", delta }` |
| `turn.activity` | Removed | Replaced by `item.*` |
| `turn.message.completed` | Removed | `item.completed` with `assistant_message` |
| `turn.image.generated`, `turn.image.viewed` | Removed | `item.completed` with `image`; the web adapter adds the asset URL |
| `turn.notification` | Removed | Native frames go to adapter diagnostics only. A native error becomes `session.error`. |
| `approval.*` | Renamed `interaction.*` | See [Interactions](#interactions) |
| `turn.started`, `turn.completed`, `turn.failed` | Kept | Unchanged |
| `thread.*`, `thread.tokenUsage.updated`, `session.started`, `session.error` | Kept | `thread.status.changed` gets a typed payload `{ backgroundTaskCount, state: "idle" \| "active" \| "waiting" }` |
| `session.limit.context` | Kept | `method` removed from the payload |

Rules:

- `item.updated` and `item.completed` always carry the full item, so a client
  that missed a delta still converges. Deltas are an optimization.
- The `assistant_message` phase may be `null` while text streams and is set on
  `item.completed`. (Claude decides the phase when the next block arrives; see
  the mapping below.)
- An item ID is stable from `item.started` to history, including after a reload.

## Interactions

Approvals and structured questions become interaction requests. New module:
`shared/protocol/interactions.ts`, replacing `ApprovalRequestPayload`.

```ts
interface InteractionRequest {
  id: string;                     // Shepherd ID, opaque
  threadId: string;
  turnId: string | null;
  itemId: string | null;          // the item the request is about, when known
  kind: "command" | "file_change" | "permissions" | "tool" | "user_input";
  title: string;                  // "Run a command", "Edit files", "Answer questions"
  item: ConversationItem | null;  // snapshot shown on the card: the command, the diff
  reason: string | null;          // provider-supplied explanation
  options: Array<{
    id: string;                   // provider's own option value, passed back unchanged
    label: string;
    intent: "allow" | "allow_session" | "deny" | "cancel" | "submit" | "other";
  }>;
  questions: UserQuestionRequest | null;   // for kind "user_input"
}

interface InteractionReply { optionId: string; answers?: UserQuestionAnswers; reason?: string }
```

- `intent` lets surfaces style and order buttons and lets Discord choose
  defaults. Replies always send `optionId`.
- The adapter rejects an `optionId` it did not offer.
- `interaction.requested`, `.decided`, `.applied`, `.failed`, `.expired` replace
  `approval.*` with the same lifecycle. `ApprovalsStore` becomes
  `InteractionsStore`; its rules (one decision, expiry at turn end, stale-answer
  protection) are unchanged.

## Provider port

`server/core/agent_session.ts` is restructured. Required parts:

```ts
interface ProviderSession {
  readonly provider: AgentProvider;
  readonly sessionId: string;
  readonly events: AgentEvents;
  readonly activeTurnId: string | null;
  readonly backgroundTaskCount: number;
  approvalPolicy: ApprovalPolicy;

  initialize(): Promise<void>;
  startThread(request: CreateThreadRequest): Promise<ThreadBootstrapInfo>;
  resumeThread(threadId: string, request: ResumeThreadRequest): Promise<ThreadBootstrapInfo>;
  forkThread(threadId: string, request: ForkThreadRequest): Promise<ThreadBootstrapInfo>;
  startTurn(input: TurnInput): Promise<string>;
  steerTurn(input: UserInput[], turnId?: string): Promise<string>;
  interruptTurn(turnId?: string): Promise<void>;
  respond(requestId: string, reply: InteractionReply): Promise<void>;
  setCwd(cwd: string): void;
  stop(): void;

  readonly history: ProviderHistory;   // list/read threads, turns, items; rename; archive; unarchive
  readonly models: ProviderModels;     // listModels

  readonly compaction?: { compact(threadId: string): Promise<void> };
  readonly revert?: { revertBefore(threadId: string, turnId: string): Promise<RevertThreadResponse> };
  readonly skills?: { list(request: SkillsListRequest): Promise<SkillsListResponse>; write(request: SkillsConfigWriteRequest): Promise<SkillsConfigWriteResponse> };
}
```

- `ProviderHistory.listThreadTurns` and `listThreadItems` return `ConversationItem`s.
- `ProviderCapabilities` stays the client contract. `compact`, `revert`, and
  `skills` are derived from whether the optional part exists; `questions`, `fork`,
  and `sandboxModes` stay declared by the adapter.
- `SessionManager` calls an optional part only through its presence check and
  returns the existing `UnsupportedProviderOperationError` when it is absent.
- `readAccountRateLimits` and `consumeRateLimitReset` leave the session (see
  [Account limits](#account-limits)).
- `startTurn` takes one object, `TurnInput { input, approvalPolicy?, model?, cwd?, effort? }`,
  instead of five positional arguments.

### Requests and records

- `CreateThreadRequest`, `ResumeThreadRequest`, and `ForkThreadRequest` keep the
  neutral fields: `provider`, `cwd`, `model`, `effort`, `approvalPolicy`,
  `sandbox`, `baseInstructions`, `developerInstructions`.
- Codex-only fields (`config`, `personality`, `modelProvider`, `ephemeral`) are
  removed from shared requests. No surface sets them today. The Codex adapter
  keeps its own defaults from its environment.
- `ThreadRecord` becomes `{ id, provider, name, preview, cwd, createdAt, updatedAt, archived }`.
  `source` and `modelProvider` are dropped.

## Account limits

Both providers implement `ProviderAccountLimitsReader`
(`server/ports/provider_account_limits.ts`) and return `ProviderAccountLimits`.

Codex mapping (`account/rateLimits/read`):

| Codex | Shepherd |
| --- | --- |
| Each `rateLimitsByLimitId` entry's `primary` and `secondary` (or the single `rateLimits` snapshot when the map is null) | One `AccountLimitWindow` each. `id` = `<limitId>:primary` or `<limitId>:secondary`. `label` = catalog model name from `normalModelSlug`, then `limitName`, then a readable ID (today's UI rule moves into the adapter). `usedPercent`, `resetsAt` copied. |
| `rateLimitReachedType`, `ordinaryUsageAllowed: false` | `status: "limited"` on the affected windows |
| `planType` | `account.plan` |
| `credits` (`hasCredits`, `unlimited`, `balance`) | `extraUsage` with `enabled` and a balance label |
| `account/rateLimits/updated` notifications | Observed updates, as Claude's `rate_limit_event`s are today |
| `rateLimitResetCredits` | New optional `resets` section (below) |

Banked resets become an optional reader extension:

```ts
interface ProviderLimitResets {
  list(): Promise<RateLimitResetCredits>;
  consume(request: ConsumeRateLimitResetRequest): Promise<ConsumeRateLimitResetResponse>;
}
```

Only Codex provides it. The idempotency contract and outcomes are unchanged.
`GET /limits?provider=` returns `ProviderAccountLimits` for either provider. The
Usage panel renders one component with an optional resets section. Discord
`!limits` gains a provider argument and defaults to the attached conversation's
provider.

## Provider mappings

### Codex items

| Codex `ThreadItem` | Shepherd item |
| --- | --- |
| `userMessage` | `user_message` |
| `agentMessage` | `assistant_message` (`phase` copied) |
| `reasoning` | `reasoning` (`summary`; raw `content` is not shown) |
| `plan`; `turn/plan/updated` | `plan` |
| `commandExecution` | `command`. `aggregatedOutput` → `output`; `exitCode`, `durationMs`, `cwd` copied. When every `commandActions` entry is `read`, `file_read`; when every entry is `search` or `listFiles`, `search`. |
| `item/commandExecution/outputDelta` | `item.delta` with `field: "output"` |
| `fileChange` | `file_change`. Each `FileUpdateChange { path, kind, diff }` → one change; `move_path` → `kind: "move"`; counts computed from the diff. |
| `item/fileChange/outputDelta`, `item/fileChange/patchUpdated` | `item.updated` |
| `mcpToolCall` | `tool` (`source: "mcp"`, `server`, `tool` → `name`, `arguments` → `input`, `result`/`error` → `output`/`error`) |
| `dynamicToolCall` | `tool` (`source: "shepherd"`, `namespace` + `tool` → `name`, `contentItems` → `output`) |
| `webSearch` (`WebSearchAction`) | `web` (`search`, `openPage` → `open_page`, `findInPage` → `find_in_page`, `other`) |
| `collabAgentToolCall`, `subAgentActivity` | `subagent` |
| `imageGeneration`, `imageView` | `image` (`generated`, `viewed`) |
| `contextCompaction`, `enteredReviewMode`, `exitedReviewMode`, `hookPrompt`, `sleep` | `notice` |
| `functionCallOutput` | Merged into the matching `tool` item's output; not shown alone |
| Anything new | `tool` with `source: "provider"` and the native type name |

### Codex requests

| Server request | Interaction |
| --- | --- |
| `item/commandExecution/requestApproval` | `kind: "command"`, `item` = the `command` item. Options from `CommandExecutionApprovalDecision`: `accept` (allow), `acceptForSession` (allow_session), `decline` (deny), `cancel` (cancel). Policy-amendment decisions are offered only when the request proposes one (intent `other`). |
| `item/fileChange/requestApproval` | `kind: "file_change"`, `item` = the `file_change` item with diffs. Options from `FileChangeApprovalDecision`. |
| `item/permissions/requestApproval` | `kind: "permissions"`, showing the requested network and filesystem access. Currently answered as unsupported. The reply is a granted profile plus a `turn` or `session` scope, not an option list, so the adapter offers Shepherd-defined options (`grant_turn`, `grant_session`, `deny`) and builds the grant from the request. |
| `execCommandApproval`, `applyPatchApproval` (legacy) | `command`, `file_change` with the legacy option values (`approved`, `approved_for_session`, `denied`, `abort`) |
| `item/tool/requestUserInput` | `kind: "user_input"` |
| `item/tool/call` | Not an interaction. Dispatched to the Shepherd tool registry as today. |
| `mcpServer/elicitation/request`, `account/chatgptAuthTokens/refresh`, `attestation/generate` | Still answered as unsupported, now logged as diagnostics instead of `session.error` noise |

### Claude items

The CLI emits one assistant message per content block. Tool calls start from the
`tool_use` block and complete from the matching `tool_result` plus the message's
structured `tool_use_result`.

| SDK input | Shepherd item |
| --- | --- |
| User input | `user_message` |
| `text` blocks | `assistant_message`. Phase `commentary` when a `tool_use` follows, `final_answer` when the response ends (the rule PR #90 already uses). |
| `thinking` blocks, when present (`redacted_thinking` is skipped) | `reasoning` |
| `Bash` | `command`. `input.command`, `input.description` (shown as a subtitle). Completion from `BashOutput`: `stdout` and `stderr` → `output`, `interrupted`, `timedOutAfterMs` → `error`, `backgroundTaskId` → `background: true`. |
| `TaskStop`, `Monitor` | `tool`, linked to the background command's item when the task ID matches |
| `Edit`, `Write`, `NotebookEdit` (and `MultiEdit` from older CLIs) | `file_change`. From `FileEditOutput`/`FileWriteOutput`/`NotebookEditOutput`: `structuredPatch` → `diff`, or `gitDiff.patch` with `additions`/`deletions`; `type: "create"` → `kind: "add"`. |
| `Read` | `file_read` (`file_path`, `offset`/`limit` → `lines`) |
| `Grep`, `Glob` | `search` (`pattern`, `path`; matches from `GrepOutput`/`GlobOutput`) |
| `WebSearch`, `WebFetch`; server-side `server_tool_use` with `web_search_tool_result`/`web_fetch_tool_result` blocks | `web` (`search` with `query`; `open_page` with `url`) |
| `Agent` (`Task` in older CLIs) | `subagent` (`description`, `prompt`; `AgentOutput`'s final report → `report`). Messages with this `parent_tool_use_id` become items with `parentItemId` set. |
| `TodoWrite` | `plan` (`todos` → `steps`) |
| `TaskCreate`, `TaskUpdate`, `TaskList`, `TaskGet` | `tool` in this stage; a later stage can fold them into `plan` |
| `AskUserQuestion` | No item; becomes a `user_input` interaction |
| `mcp__<server>__<tool>` | `tool` (`source: "mcp"`, or `"shepherd"` for the Shepherd server) |
| Any other tool | `tool` (`source: "provider"`) |
| `tool_progress` | No event. Surfaces show the elapsed time of an `in_progress` item from `startedAt`. |
| `tool_use_summary` | Not shown in this stage |
| `system` message with `subtype: "compact_boundary"` | `notice` (`compaction`) |

Existing Claude snapshots store `{ type: "mcpToolCall", server: "claude", tool, arguments, result }`
and agent messages as `agentMessage`. `server/storage/claude_thread_store.ts`
converts both on read using the table above (without structured results, so the
command and file are shown, with output from the stored result preview).
Snapshots are rewritten in the new format on their next save.

### Claude requests

`canUseTool(name, input, context)` becomes an interaction whose `kind` follows the
item mapping: `Bash` → `command`; `Edit`/`Write` → `file_change` with the
proposed change built from `input`; other tools → `tool`. Options: `allow`
(allow once), `allow_session` (offered only when the SDK supplies suggestions),
`deny`. `AskUserQuestion` → `user_input` with `submit` and `cancel`. These are
Shepherd-defined option IDs, because the SDK's reply is a callback result, not
an option list; the adapter validates them the same way.

### Claude user images

User image parts are stored today as base64 data URLs inside the thread
snapshot. They move to files beside the snapshot
(`<state dir>/<threadId>/attachments/<sha256>.<ext>`), and the stored item keeps
a reference. History reads return the same data URL to surfaces, so this is not
visible outside the store. Snapshots stop growing by megabytes per screenshot.

## Surfaces

- **Web UI.** `ui/src/chat-state.ts` reduces `item.*` events into items. A new
  item renderer replaces the generic "label · status" row:
  command (command, collapsible output, exit code), file change (file list with
  `+`/`−` counts and collapsible diffs), file read, search, web, tool, subagent
  (description, nested items, report), plan (checklist), notice. History and
  live view use the same renderer. Interaction cards show the item snapshot.
- **Web API.** `WEB_API_VERSION` becomes 2. The UI reads `/health` and asks for a
  reload when the server's version differs from the version it was built with,
  so a tab left open during a deploy does not misread events.
- **Discord.** One line per item: `$ bun test` with exit code, `Edited src/app.ts (+12 −3)`,
  `Searched "pattern"`. Approval cards show the command or file list instead of a
  method name. How much output and diff text Discord shows is
  [open question 2](#open-questions); the proposal is summaries, with longer
  output as an attachment.
- **History pages** (`server/core/history_page_service.ts`,
  `server/adapters/web/history.ts`, `server/adapters/discord/history_pagination.ts`)
  page `ConversationItem`s directly. `webActivity` disappears; `webImage` remains
  as the web adapter's asset URL decoration.

## Enforcement

`tests/architecture_boundaries.test.ts` gains rules:

- Only `server/providers/codex/` may contain Codex item type names, RPC method
  strings, or import generated Codex types.
- Only `server/providers/claude/` may import `@anthropic-ai/claude-agent-sdk`.
- `ui/src`, `server/adapters`, and `server/core` may import provider types only
  from `shared/protocol`.
- `shared/protocol` may not import from `server/`.

## Testing

**Replay fixtures** replace hand-written native frames for adapter behavior,
following T3 Code's approach.

- `scripts/record-codex-fixture.ts` runs a real `codex app-server` and records the
  JSON-RPC frames in both directions to `tests/fixtures/codex/<scenario>.jsonl`.
- `scripts/record-claude-fixture.ts` wraps the SDK `query()` and records every
  `SDKMessage`, every `canUseTool` call with its reply, and the account calls,
  to `tests/fixtures/claude/<scenario>.jsonl`.
- Scenarios, per provider: simple answer; tool call with output; file edit with
  diff; command approval allowed and denied; question answered and skipped;
  interrupt; steering; resume after restart; background task (Claude).
- A replay harness feeds the recording through the real adapter and
  `SessionManager`, then asserts the item stream and the stored history.
- Recordings are reviewed before commit for secrets and personal data. The
  recorders strip auth headers, emails, and account IDs.

Hand-written native frames stay only for failures a real provider cannot produce
on demand (malformed frames, crashes, timeouts). Contract tests run both
adapters through the same scenario list and assert the same item types.

## Implementation stages

Each stage is a separate commit on PR #90 and passes `bun test` and `bun run check`.

1. **Shared model.** `conversation_items.ts`, `item_limits.ts`, `interactions.ts`,
   new event payloads, `TurnInput`, neutral `ThreadRecord` and requests. No behavior change yet.
2. **Ports and core.** Restructured `ProviderSession` with optional parts;
   `SessionManager`, `InteractionsStore`, account-limits service with
   `ProviderLimitResets`.
3. **Codex adapter.** Item, event, interaction, and account mapping;
   `listThreadTurns`/`listThreadItems` conversion; diagnostics instead of
   `turn.notification`.
4. **Claude adapter.** Item mapping from `tool_use_result`; subagent nesting;
   interactions; snapshot format and read-time conversion; attachment files.
5. **Surfaces.** Web item renderer and interaction cards; unified Usage panel;
   API version 2; Discord renderers and `!limits <provider>`.
6. **Enforcement and replays.** Boundary rules, recorders, fixtures, replay harness.
7. **Docs.** Update [Architecture](architecture.md), [Web API](web-api.md),
   [Web UI](web-ui.md), the parity matrices, and the README; archive this document.

## Compatibility and rollout

- Web: the UI and server ship together. An old tab detects API version 2 and
  asks for a reload. SSE replay buffers are in memory and do not survive the
  restart, so no old events are replayed to new clients.
- Discord: renderers ship with the server.
- Stored data: Claude snapshots convert on read. Codex history is converted on
  every read and needs no migration. Interaction records are in memory.
- Assumption to confirm before stage 5 ([open question 1](#open-questions)):
  nothing outside this repository reads `BridgeEvent`s, approval payloads, or
  `/api/v1`. If something does, add a translation layer for one release.

## Open questions

1. Does anything outside this repository read `BridgeEvent`s, approval payloads,
   or `/api/v1`, such as `shepherd-ui` or webhook callers? If not, the event and
   API changes ship without a translation layer.
2. Should Discord get the full item detail (output and diffs as attachments), or
   one-line summaries with a pointer to the web UI?
3. Are the size caps right for how you use Shepherd? They decide how much command
   output and diff text history keeps.
4. Should Claude user images move to attachment files in this PR (stage 4), or
   in a later one?

## Risks

- **Codex item fields can change between CLI versions.** Mitigation: replay
  fixtures recorded per refresh; the Codex parity matrix refresh includes
  re-recording.
- **`tool_use_result` shapes are per tool and typed `unknown`.** Mitigation:
  validate each shape in the Claude adapter; on a mismatch, fall back to the
  `tool_result` text.
- **Large outputs.** Mitigation: the caps above, and Discord summaries.
- **Scope.** This roughly doubles PR #90. Mitigation: staged commits with tests
  at each stage, and per-commit PR comments.

## References

- T3 Code, `docs/orchestration-v2/README.md`, `core-graph-and-data-model.md`
  (turn items), `provider-capability-system.md`, and
  `docs/internals/adding-a-provider.md`; adapter contract in
  `packages/provider-core/src/server/ProviderAdapter.ts`. Reviewed at `c77a7b7e`.
- Codex app-server schema generated from `codex-cli 0.160.1`
  (`ThreadItem`, `CommandExecutionApprovalDecision`, `FileChangeApprovalDecision`,
  `GetAccountRateLimitsResponse`).
- Claude Agent SDK `0.3.296` types: `SDKAssistantMessage`, `SDKUserMessage.tool_use_result`,
  `SDKToolProgressMessage`, and `sdk-tools.d.ts` (`BashOutput`, `FileEditOutput`, `FileWriteOutput`).
- [Provider architecture audit](archive/provider-architecture-audit.md): the
  audit that preceded PR #90's first implementation.
