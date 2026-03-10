# Discord Formatting Reference

This document is a reset point for Discord message rendering in Shepherd.

The goal is to describe:
- what Shepherd does today
- what problems were observed
- what OpenClaw does that is more mature
- what a clean rewrite in Shepherd should likely include

This should be enough to redesign the Discord formatting path from zero without needing prior chat context.

## Current Shepherd Behavior

Discord agent streaming currently lives in `server/adapters/discord/bot.ts`.

The current model is:
- accumulate streamed agent text into one mutable `state.text` buffer
- track whether the stream is in `commentary` or `final_answer`
- render commentary as Discord blockquotes using `> `
- insert phase transition spacing for final answers
- split the final rendered buffer into chunks using a simple `chunkForDiscord()` helper
- edit or send Discord messages based on the resulting chunk list

### Current Chunking

Shepherd currently uses:
- a hard chunk target of `1900` characters
- a simple boundary rule:
  - prefer the last newline or space inside the current window
  - otherwise cut at the hard limit

This logic is intentionally simple and safe, but it is not Discord-markdown-aware.

### Current Commentary Rendering

Commentary is rendered as blockquote lines:

```text
> line one
> line two
```

The renderer tracks whether the next commentary delta starts at the beginning of a line so it knows whether to prefix `> `.

### Current Final Answer Rendering

The desired behavior now is:
- no phase headers
- no `"📦 Final Answer"`
- keep a blank-line separation before final output when there is prior rendered text

That means the final answer should begin as plain content after spacing, not under a visible section title.

## Observed Problem: Commentary To Final Transition

The practical problem that came up was:
- the first final-answer chunk could visually attach to the preceding commentary block

This happened because commentary rendering was previously carrying quote-state in the visible rendered buffer, instead of keeping that state only in renderer state.

The more holistic fix is:
- keep line-start / quote-continuation state internally
- do not leave temporary blockquote placeholder text in the rendered output

That is the correct general direction for the renderer.

## Why The Current Chunking Is Not Mature Enough

The current `chunkForDiscord()` approach is not enough if we want Discord formatting to be robust.

It does not explicitly account for:
- fenced code blocks
- markdown constructs spanning chunk boundaries
- soft line-count limits for readability
- stable formatting across streamed edits
- retry-aware ordered chunk delivery

The current implementation is acceptable for a simple bot, but not for a polished Discord rendering pipeline.

## OpenClaw Comparison

OpenClaw has a more mature Discord formatting and delivery model.

Relevant code paths found in the cloned repo:
- `/tmp/openclaw/src/discord/chunk.ts`
- `/tmp/openclaw/src/discord/send.shared.ts`
- `/tmp/openclaw/src/discord/send.outbound.ts`
- `/tmp/openclaw/src/discord/monitor/reply-delivery.ts`
- `/tmp/openclaw/src/config/types.discord.ts`

### What OpenClaw Does

OpenClaw splits long Discord text using a dedicated Discord-aware chunker.

It accounts for:
- hard character limits
- soft line limits
- chunk mode selection
- markdown fence balancing
- ordered delivery with retry handling

### Hard Character Limit

OpenClaw uses `2000` characters as the Discord text limit.

Important detail:
- OpenClaw can safely use `2000` because the rest of its chunking and delivery pipeline is more sophisticated than Shepherd's current one

This is why Shepherd should not automatically raise `1900` to `2000` without strengthening the surrounding logic first.

### Soft Line Limit

OpenClaw also uses a soft maximum line count per Discord message.

Default observed value:
- `17` lines

Reason:
- Discord clients can clip or collapse very tall messages
- splitting tall messages improves readability even when the character count is still under the hard limit

### Chunk Modes

OpenClaw supports at least:
- `length`
- `newline`

Conceptually:
- `length` means split primarily by message size
- `newline` means prefer paragraph or newline-based boundaries before falling back to size-based splitting

This is better than a single hardcoded strategy.

### Fence-Aware Splitting

One of the most important differences is fence-aware splitting.

This means:
- if text contains a fenced markdown code block
- and a chunk boundary happens inside that block
- each individual Discord message still gets valid markdown

Example problem:

Input:

```md
Here is code:

```ts
const x = 1;
const y = 2;
console.log(x + y);
```
```

Naive splitting can produce:

Chunk 1:

```md
Here is code:

```ts
const x = 1;
const y =
```

Chunk 2:

```md
2;
console.log(x + y);
```
```

That is bad because:
- chunk 1 opens a fence and never closes it
- chunk 2 continues code without opening a fence
- Discord markdown rendering can break or look inconsistent

Fence-aware splitting fixes that by:
- tracking whether a code fence is open
- closing the fence at the end of the current chunk if needed
- reopening it at the start of the next chunk

This keeps every chunk independently valid as Discord markdown.

### Ordered Delivery And Retry Handling

OpenClaw also does more work at delivery time.

It sends chunks sequentially and includes retry handling for:
- `429`
- `5xx`

This matters because for multi-message delivery:
- order must be preserved
- retries must not scramble chunk order
- failures should not duplicate or reorder later chunks

Shepherd does not currently have this level of delivery discipline in its Discord stream path.

## Why Shepherd Should Not Just Copy The 2000 Limit

OpenClaw's `2000` limit is supported by:
- stronger chunk planning
- Discord-specific markdown handling
- safer delivery sequencing
- broader tests

Shepherd currently has:
- a simpler chunker
- no fence-aware splitting
- no soft line splitting
- a more ad hoc render-state model

Because of that, Shepherd's `1900` is currently a reasonable safety margin.

The right sequence is:
1. improve chunking and rendering
2. improve tests and delivery handling
3. then consider increasing the limit to `2000`

## What A Mature Shepherd Discord Renderer Should Include

If we want Shepherd to reach OpenClaw-level maturity, the work should be decomposed.

### 1. Replace The Current Chunker

Replace `chunkForDiscord()` with a Discord-specific chunk planner.

It should support:
- hard character limit
- optional soft line limit
- paragraph-aware splitting
- exact-boundary safety

This chunk planner should be a standalone unit with its own tests.

### 2. Add Fence-Aware Markdown Handling

The chunker should understand fenced code blocks.

At minimum:
- detect opening and closing fences
- track whether a chunk ends inside a fence
- close/reopen fences when necessary across chunk boundaries

Tests should include:
- long fenced blocks
- boundaries inside code blocks
- boundaries exactly on fence lines
- backticks and tildes

### 3. Separate Render State From Visible Output

Shepherd should stop treating Discord output as one giant mutable string with formatting side effects embedded in it.

Instead:
- keep structured state for commentary
- keep structured state for final output
- render that state into visible Discord text
- then chunk the rendered text

This prevents state bugs where temporary formatting artifacts leak into visible output.

### 4. Keep Commentary State Internal

For commentary blockquotes:
- keep `atLineStart` or equivalent quote-state internally
- do not encode placeholder continuation markers into the final rendered text

The renderer should emit only visible text that is valid if flushed immediately.

### 5. Make Final Formatting Explicit

Current desired final formatting:
- no phase headers
- no labels like `"📦 Final Answer"`
- final content separated from previous commentary with spacing only

That should be an explicit rendering rule, not an accidental consequence of phase transitions.

### 6. Stabilize Multi-Message Edits

For streamed delivery:
- the mapping from rendered content to Discord message chunks should be as stable as possible
- edits should target the same chunk positions predictably
- avoid unnecessary churn in downstream chunks when only one section changes

This likely requires a more explicit render model than a single mutable string.

### 7. Add Delivery Policy

Shepherd should define a real Discord delivery policy.

Possible modes:
- final-only
- single preview message with edits
- multi-message block streaming

This policy should be intentional, not just whatever falls out of the implementation.

### 8. Add Retry-Aware Ordered Sending

If Shepherd sends or edits multiple Discord messages for one response, it should account for:
- rate limits
- transient server errors
- preserving chunk order

This is especially important if the system becomes more streaming-heavy.

### 9. Add Configurable Limits

Useful Discord-specific config knobs would include:
- `textChunkLimit`
- `maxLinesPerMessage`
- `chunkMode`
- stream mode

This lets behavior evolve without hardcoding every policy in the adapter.

### 10. Add Targeted Tests

At minimum, Shepherd should have tests for:
- short single-chunk plain text
- multi-chunk plain text
- commentary blockquote rendering
- commentary to final transitions
- exact size boundaries near the Discord limit
- fenced code block splitting
- paragraph-aware splitting
- stable chunk edits across repeated flushes

## Recommended Rewrite Order

The practical implementation order should be:

### Phase 1: Chunker

Build a new Discord chunker that supports:
- hard char limit
- optional soft line limit
- paragraph-aware splitting
- fence-aware splitting

Do this first and test it heavily.

### Phase 2: Renderer

Refactor the Discord formatter so it:
- keeps commentary/final state separately
- renders visible text from structured state
- never relies on temporary placeholder text in the output buffer

### Phase 3: Delivery

Refine the transport layer so it:
- maps rendered text to stable chunk slots
- edits existing Discord messages predictably
- handles retries and ordering more safely

Only after these three phases should Shepherd seriously consider changing the hard limit from `1900` to `2000`.

## Short Design Position

The correct takeaway is not:
- "just copy OpenClaw's 2000-char limit"

The correct takeaway is:
- OpenClaw's maturity comes from a full Discord-specific formatting and delivery pipeline
- Shepherd can reach that level
- but it requires a real chunker, a cleaner render model, and better delivery discipline

## Immediate Practical Guidance

If starting fresh today:

1. Keep the desired product behavior fixed:
   - commentary as blockquotes
   - no phase headers
   - plain final output with spacing only

2. Implement a real Discord chunk planner before changing limits.

3. Treat formatting and transport as separate responsibilities.

4. Keep state internal and render only valid visible text.

5. Add fence-aware tests before attempting exact-limit operation at `2000`.
