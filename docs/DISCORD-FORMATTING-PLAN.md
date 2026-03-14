# Discord Formatting Plan

This document turns the current Discord formatting discussion into an implementation plan for Shepherd.

It is intentionally opinionated.

The goal is not to clone OpenClaw's Discord stack wholesale. The goal is to extract the parts that materially improve Shepherd's Discord UX, keep the design proportionate to Shepherd's current architecture, and sequence the work so each stage is independently shippable.

## Goals

The Discord formatting path should:

- render streamed output predictably on Discord
- preserve markdown structure across chunk boundaries
- make approvals and system messages easier to scan
- avoid introducing a large Discord-only UI framework too early
- keep Discord-specific rendering in the adapter unless a reusable core abstraction is clearly justified

## Non-Goals

This plan does not aim to:

- reproduce OpenClaw's entire Carbon-based components system
- introduce a generic cross-channel rich message DSL in the first pass
- redesign the whole Discord adapter architecture
- optimize for feature parity with OpenClaw modals, selects, media galleries, and advanced agent UI on day one

## Current State In Shepherd

Today, Shepherd's Discord path is structurally simple:

- stream text into one mutable buffer
- split that rendered text into chunks with a naive size-based algorithm
- send or edit plain Discord messages based on those chunks
- send approval prompts as text plus button rows
- send thread and error events as plain one-line text messages

Relevant files:

- `server/adapters/discord/stream_delivery.ts`
- `server/adapters/discord/thread_event_handler.ts`
- `server/adapters/discord/message_renderer.ts`

This is acceptable as a baseline, but it has obvious limits:

- code fences can break across chunk boundaries
- long messages can become visually dense even when under the character limit
- approvals look like utility prompts rather than first-class UI
- system messages have no visual hierarchy
- the adapter has no formal message-shape model beyond string content and raw button rows

## What OpenClaw Gets Right

From the cloned `openclaw/openclaw` repo, the most useful ideas are these:

### 1. Discord-aware chunking

OpenClaw has a dedicated chunker for Discord text.

It handles:

- hard character limits
- soft line limits
- fenced code block balancing
- special-case formatting continuity, such as reasoning italics

This is the highest-value improvement for Shepherd because it directly fixes rendering correctness for normal model output.

### 2. Message composition as layout

OpenClaw builds rich Discord messages as ordered UI blocks inside a components v2 container.

The important lesson is not the specific library. The important lesson is that each message has explicit structure:

- heading text
- body text
- sections
- separators
- action rows
- footers or metadata

That gives approvals and status messages visual hierarchy instead of forcing everything into a flat paragraph.

### 3. Tight interaction semantics

OpenClaw restricts who can use buttons, gives clear ephemeral denials, and updates approval state in place.

That is worth copying conceptually even if Shepherd uses simpler mechanics.

## Design Principles For Shepherd

The implementation should follow these principles:

### Keep text streaming simple but correct

The stream path should stay string-first.

We do not need a rich component tree for normal streaming replies. We do need markdown-aware chunk planning and stable edit behavior.

### Use richer formatting only where structure matters

Approvals and system notices benefit from explicit layout.

Normal assistant prose does not need a heavy component model unless we later add richer interactions.

### Avoid premature generalization

There is no reason to invent a generic cross-surface message schema in phase one.

Discord-specific presentation can remain in `server/adapters/discord/*` unless the same shape becomes useful across multiple surfaces.

### Prefer staged improvements over a big-bang rewrite

The right order is:

1. fix correctness of streamed text
2. improve high-value message types such as approvals
3. improve system event rendering
4. consider whether a reusable rich-message abstraction is justified

## Proposed Plans

There are three viable plans. Only one should be chosen as the immediate implementation target, but all three are included because they represent different ambition levels.

## Plan A: Targeted Upgrade

This is the recommended plan.

It ports the highest-value ideas from OpenClaw without importing its full message framework.

### Summary

Implement:

- a Discord-aware chunk planner for streamed text
- a more structured approval prompt format
- clearer formatting for event and status messages
- focused tests around chunking and approval rendering

Do not implement:

- modals
- select menus
- components v2 containers
- a generic rich-message schema

### Why This Is The Best First Step

This plan fixes the actual UX issues users will notice first:

- broken markdown
- ugly long messages
- low-signal approval prompts
- weak event formatting

It also keeps the implementation compatible with Shepherd's current model:

- streaming stays string-based
- approvals remain button-based
- Discord-specific logic stays local to the adapter

### Scope

#### A1. Replace `chunkForDiscord()`

Introduce a real Discord chunk planner in `server/adapters/discord/stream_delivery.ts` or a dedicated sibling file such as `server/adapters/discord/chunking.ts`.

The chunker should support:

- hard character limit
- optional soft line limit
- fence-aware splitting
- long-line splitting
- stable chunk output for repeated edits of the same growing text

Recommended defaults:

- keep the hard target at `1900` initially
- add a soft line limit around `16` to `20`

Important detail:

Do not raise the limit to `2000` in the same change unless tests demonstrate the resulting payloads are always safe. The current `1900` margin is conservative for a reason.

#### A2. Make approval prompts visually structured

Keep buttons, but rewrite the prompt body from:

- flat method line
- raw prompt text

into a compact card-like plain-text layout.

Example shape:

```text
Approval Required

Action: shell.exec
Reason: Run `bun install`

Choose a decision below.
```

If the approval payload contains command-like text or structured choices, render those deliberately instead of dumping raw text.

Possible improvements:

- title line
- labeled fields
- blank-line grouping
- optional fenced block for long command previews
- consistent wording for success, denial, and expiration followups

This preserves compatibility with the current button-row approach while making prompts much easier to scan.

#### A3. Improve event/system messages

The one-line lowercase event messages in `message_renderer.ts` should be upgraded to a more deliberate style.

Examples:

- `context window limit reached. try !compact or start a new thread.` becomes a short warning block
- `thread renamed: foo` becomes a labeled status line
- session and approval failures become short, clearer diagnostic messages

The goal is not decorative formatting. The goal is scanability and clarity.

#### A4. Add tests before further UI work

Add unit tests for:

- chunking within normal prose
- chunking inside fenced code blocks
- chunking for long unbroken lines
- chunking with soft line overflow
- approval text rendering
- event line rendering

This is important because Discord formatting regressions are subtle and otherwise easy to reintroduce.

### Files Likely Affected

- `server/adapters/discord/stream_delivery.ts`
- `server/adapters/discord/thread_event_handler.ts`
- `server/adapters/discord/message_renderer.ts`
- new tests under `server/adapters/discord/*.test.ts`

### Risks

- chunking logic can become overcomplicated if it tries to handle every markdown edge case at once
- approval formatting can become verbose if we overfit to imagined payload shapes
- event messages can become noisy if every state transition turns into a mini-card

### Mitigations

- only support the markdown constructs we actually emit and observe
- treat code fences as the main correctness requirement
- keep approval layouts compact
- reserve richer formatting for high-signal events only

### Exit Criteria

Plan A is complete when:

- fenced code blocks no longer render broken across chunks
- long replies are easier to read on Discord
- approval prompts are clearly structured
- the formatting path is covered by tests

## Plan B: Rich Discord Surface

This is the medium-ambition plan.

It builds on Plan A and adds a small structured message model for Discord-only rich rendering.

### Summary

Create an internal message-shape layer for Discord that can render:

- text blocks
- labeled sections
- dividers
- button rows
- status banners

This would still avoid adopting a third-party component framework, but it would stop treating non-streaming messages as raw strings.

### Why You Might Choose It

Choose this if the product direction clearly includes:

- more interactive approval flows
- richer thread status messages
- actionable bot-generated messages beyond plain prose

### Scope

#### B1. Introduce a small Discord render model

Add a local adapter-only type such as:

```ts
type DiscordRenderable =
  | { kind: "text"; text: string }
  | { kind: "section"; title?: string; body: string[] }
  | { kind: "divider" }
  | { kind: "actions"; buttons: DiscordButtonSpec[] };
```

Then add a renderer that converts these structures into either:

- plain content plus action rows
- or richer Discord message payloads if the chosen transport supports them

This creates discipline around message composition without needing a cross-repo DSL.

#### B2. Convert approvals to structured renderables

Instead of generating approval text directly, build a message object and render it.

That makes state changes like pending, resolved, and expired straightforward to model and test.

#### B3. Convert high-value system messages

Use the same model for:

- thread lifecycle notices
- session failures
- context-limit notices
- repo/workspace status replies

### Risks

- this can become a mini framework if left unconstrained
- if the render model is too abstract, it will obscure simple Discord behavior instead of clarifying it

### Mitigations

- keep the model adapter-local
- do not try to make it reusable across non-Discord surfaces yet
- only add block types required by actual Shepherd messages

### Exit Criteria

Plan B is complete when:

- string assembly is no longer scattered across message handlers
- non-streaming Discord messages are composed from structured data
- approvals, notices, and errors all render consistently

## Plan C: Components-First Rich UI

This is the highest-ambition plan.

It borrows the spirit of OpenClaw's component-oriented message composition more directly.

### Summary

Adopt richer Discord-native UI patterns for approvals and status messages, potentially using:

- components v2 or the closest supported `discord.js` primitives
- richer layouts
- in-place message updates for approval lifecycle
- restricted button usage and better unauthorized handling

### Why You Might Choose It

Choose this only if Shepherd's Discord surface is becoming a primary product surface rather than a convenience transport.

This plan makes sense when the bot is expected to behave more like a Discord-native application than a thin bridge to Codex.

### Scope

#### C1. Move approvals to a richer card model

This is the most defensible use of richer Discord UI.

Approval messages would have:

- a title
- a summarized command preview
- clear status coloring or visual distinction
- explicit expiration state
- in-place updates after resolution

#### C2. Add button authorization semantics

Users who are not allowed to use an approval button should get a clean ephemeral denial.

This is an actual UX and safety improvement, not decoration.

#### C3. Consider richer Discord-only interactions

Examples:

- more expressive thread controls
- slash-command followup actions
- richer repo/workspace status responses

### Why This Is Not Recommended As The First Move

This plan is expensive relative to Shepherd's current needs.

It adds:

- more Discord-specific state
- more interaction handling complexity
- more message lifecycle logic
- more testing burden

That only pays off if Shepherd is committed to richer Discord-native workflows.

### Exit Criteria

Plan C is complete when:

- approvals and other high-value bot messages feel like a first-class Discord UI
- interaction restrictions and state transitions are robust
- the richer message lifecycle is fully tested

## Recommendation

The recommended sequence is:

1. Implement Plan A fully
2. Reassess whether Plan B is still needed
3. Only pursue Plan C if Discord becomes a clearly strategic interface

This sequence is correct because:

- Plan A fixes correctness and clarity
- Plan B improves maintainability and composition discipline
- Plan C is only worth the cost if richer interaction becomes a product requirement

## Concrete Implementation Sequence

This is the recommended execution order for Plan A.

## Implementation Checklist

- [x] Create a dedicated Discord chunking helper instead of leaving chunk logic embedded in stream delivery
- [x] Replace the naive splitter with fence-aware and soft-line-aware chunk planning
- [x] Add phase-1 tests for fenced blocks, long unbroken lines, and soft line overflow
- [ ] Verify chunk stability against real streamed commentary and final-answer transcripts
- [ ] Rewrite approval prompt rendering into a structured, scan-friendly layout
- [ ] Normalize approval response wording and failure text
- [ ] Upgrade high-signal event messages from flat one-liners to clearer status formatting
- [ ] Reassess whether a Discord-local structured render model is still needed after the targeted upgrade

## Phase 1: Chunking

### Deliverables

- new Discord-aware chunk planner
- tests for markdown-safe chunk boundaries
- no behavior change to buttons or event formatting yet

### Tasks

1. Extract chunking into a dedicated helper module
2. Port the fence-balancing logic concept from OpenClaw
3. Add soft line splitting
4. Keep the existing `1900` hard limit unless tests prove a higher limit is safe
5. Update `flushDiscordStream()` to use the new helper

### Acceptance Criteria

- code fences remain balanced per chunk
- a growing stream does not cause chaotic chunk reshaping
- existing send/edit behavior still works

## Phase 2: Approval Presentation

### Deliverables

- rewritten approval prompt body
- more deliberate button labeling and followup text
- approval rendering tests

### Tasks

1. Replace `formatApprovalText()` with a structured formatter
2. Separate display formatting from button creation
3. Normalize wording for decision responses
4. Keep the transport payload simple: content plus components

### Acceptance Criteria

- approvals are easier to scan than the current flat prompt
- no changes are required to the approval decision plumbing

## Phase 3: Event And Status Messages

### Deliverables

- clearer event text for high-signal events
- small formatting improvements for warnings and failures
- tests for message rendering

### Tasks

1. Audit `formatEventLine()`
2. Group events into categories:
   - lifecycle
   - warnings
   - failures
3. Format only the high-value events more richly
4. Leave low-signal events minimal

### Acceptance Criteria

- important notices stand out without becoming verbose
- event messages feel consistent with the upgraded approval formatting

## Phase 4: Reassessment

At the end of Plan A, reassess whether Shepherd still needs:

- a local structured render model
- richer in-place approval lifecycle updates
- components-first Discord UI patterns

If the answer is no, stop there.

That is a valid outcome.

## Suggested File Layout

If Plan A is implemented, a clean file shape would be:

- `server/adapters/discord/chunking.ts`
- `server/adapters/discord/chunking.test.ts`
- `server/adapters/discord/message_renderer.ts`
- `server/adapters/discord/message_renderer.test.ts`
- `server/adapters/discord/thread_event_handler.ts`

This keeps:

- stream chunking isolated
- message formatting isolated
- send/update orchestration isolated

## Open Questions

These should be resolved before implementation starts:

1. Should commentary and final-answer formatting remain visually distinct on Discord, or should the renderer converge them more?
2. Are approval prompts expected to show full command text, a truncated preview, or both?
3. Do we want approval messages to update in place after a decision, or is the current reply-based flow sufficient?
4. Is Discord a high-investment surface for Shepherd, or just a convenient transport?

The answers affect whether the project should stop after Plan A or continue to Plan B or C.

## Final Recommendation

Build Plan A now.

It is the highest-leverage path because it:

- fixes correctness problems immediately
- materially improves Discord readability
- avoids overengineering
- leaves room for a richer Discord UI later if it becomes necessary

Do not start with a big component framework.

Do not start with a generalized render DSL.

Fix the stream path first, then improve approvals, then revisit whether the remaining complexity is justified.
