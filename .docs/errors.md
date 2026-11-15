# Known Errors

## Codex first-message history race leaves a backend-error banner

Status: open; repair deferred on 2026-11-14. Reproduced with Codex CLI 0.160.1.

### Symptoms and impact

The web UI can display this banner even though the first message was accepted and
the assistant's reply completed:

```text
The backend operation failed. Check host logs.
```

The host log records:

```text
Web API operation failed:
error: list_turns is not supported yet
```

The failed operation is a history read, not necessarily message submission or
execution. Live events can continue displaying the reply. Later history reads
can succeed while the old banner remains visible.

### Diagnosis

After a successful message POST, `ui/src/use-conversation.ts` immediately refreshes
state, history, and approvals. Turn events also schedule refreshes. The history
request reaches the shared browser API (`server/adapters/shared/browser_api.ts`), then
`CodexSession.listThreadTurns()` in `server/providers/codex/session.ts`, which sends
`thread/turns/list` to the shared Codex app-server.

During first-message persistence, Codex can expose the paginated rollout file
before the thread's SQLite metadata exists. Its history handler recognizes the
file as paginated and calls the store's `list_turns`. The store requires SQLite
metadata; missing metadata produces `Unsupported { operation: "list_turns" }`,
which app-server reports as `list_turns is not supported yet`. This wording can
describe a temporary persistence state even when the backend supports the API.

Shepherd normalizes the explicit "thread is not materialized yet" first-page
error to empty history, but does not handle this intermediate state. The generic
web error handler therefore returns HTTP 502 with code `operation_failed`.
Separately, successful background refreshes merge history without clearing the
previous refresh error, leaving a stale banner after recovery.

### Verification and reproduction

The investigation used isolated temporary `CODEX_HOME` directories with Codex
0.160.1 and a diagnostic model provider pointing to the closed local endpoint
`http://127.0.0.1:1/v1`, with request and stream retries disabled. No real inference
was performed or existing conversation state modified by those tests.

1. Initialize app-server with `experimentalApi: true` and create a persistent thread.
2. Start its first turn and concurrently issue `thread/turns/list` requests with
   `itemsView: "full"`, `sortDirection: "desc"`, and `limit: 30`.
3. Observe transient errors during persistence, then successful history pages
   after metadata becomes available.

All seven test runs reproduced `list_turns is not supported yet`. One measured
run returned it around 25–35 ms after starting the turn, while SQLite metadata was
missing; metadata became available around 36 ms. These timings describe the test,
not a guaranteed retry interval. Some overlapping requests also returned
`paginated_threads is not supported yet`.

Both a fresh app-server process and the running Shepherd host subsequently read
the affected conversation successfully. The original host error lacked a request
timestamp and thread ID, so its exact timing cannot be proven retrospectively.
The reproduced race and stale-error behavior explain the observed screenshot,
rather than establishing a general version incompatibility.

### Recovery and deferred repair

Once persistence settles, reopening the conversation clears the local error state
and reloads history. Check the transcript before resending: this banner alone does
not mean the message failed to send. No host restart is required for the reproduced
race.

A future repair should handle transient history-read failures with bounded recovery
and clear recovered history errors without clearing unrelated action errors. Do
not broadly convert unsupported-operation errors to empty history. Existing tests
mock the backend and cover the explicit unmaterialized-thread response; add
coverage for this persistence transition and for clearing the recovered banner.

## Error 001 — `apply_patch verification failed: invalid hunk`

### Example

```text
Session Error

ERROR codex_core:🛠️:router:
apply_patch verification failed: invalid hunk at line 45,
Unexpected line found in update hunk: '*** Update File: .../server/adapters/discord/bot.ts'.
Every line should start with ' ' (context line), '+' (added line), or '-' (removed line)
```

The historical Discord message included raw ANSI terminal sequences such as
`ESC[31m` or `ESC[0m`. Codex stderr is logged to the host console by the shared
`CodexAppServer` (`server/providers/codex/app_server.ts`); it is not forwarded to a surface.
Structured app-server errors follow the separate event-delivery path.

### Meaning

This is a Codex patch-tool input error, not a Shepherd deployment or Discord
connection failure. The submitted patch contained malformed patch structure.
In the recorded occurrence, a second `*** Update File` marker appeared where
the parser still expected lines belonging to the preceding hunk.

In that occurrence the patch command rejected the entire invocation during
verification, and no target file was partially changed. The patch tool belongs to
Codex, not Shepherd, so this behaviour is recorded as observed rather than
guaranteed; step 1 of the recovery checks it each time.

### Likely causes

- A multi-file patch is missing a valid boundary between update sections.
- A hunk contains a line without the required context (` `), addition (`+`),
  or deletion (`-`) prefix.
- A patch marker such as `*** Update File` appears before the prior hunk is
  structurally complete.
- Generated patch context no longer matches the current file.

### Recovery

1. Inspect `git status` and `git diff` to confirm what, if anything, changed.
2. Split the failed multi-file patch into smaller, independent patch calls.
3. Regenerate each hunk against the current file contents.
4. Retry the patch and run the relevant typecheck and tests.

For the occurrence recorded on 2026-07-25 (an incident record, not reproducible
from this repository), the failed multi-file patch was immediately retried as
separate valid patches. The retry succeeded, and the resulting implementation
passed `bun run check` and all 109 tests that existed then, before PR creation.

### Prevention

- Prefer one focused file update per patch call when changing unrelated files.
- Keep every hunk line correctly prefixed.
- Re-read nearby file contents before retrying a rejected patch.
- Treat the tool result as authoritative: only report a change as applied after
  the patch tool returns success.

## Screenshot Markdown shows an image placeholder

`[Image: ...]` is the web renderer's fallback for an image source that does not
match a registered conversation artifact. A relative path such as
`docs/images/example.png` does not match the artifact's absolute local path.
Open the image with `view_image` and reference the exact absolute source path
(or its scoped asset URL) in the assistant's Markdown. The file must still be
readable, and its artifact metadata must be loaded in the conversation. A plain
Markdown image reference does not register or read a new file.

See [image delivery and embedding](web-ui.md#transcript-work-and-images). This is
separate from structured question handling; PR screenshots also remain available
as repository images.

## A reply is missing after a restart

A turn that was still writing its reply when Shepherd restarted can lose that last
message: it streamed to the browser, but Claude Code never recorded it, and the
stored conversation holds a placeholder (`No response requested.`) instead. Shepherd
cannot recover a message the agent did not record. The web view keeps a streamed
message in its own turn until reloaded.

Restarts and deploys now wait for running turns to finish, so this happens only when
the process stops some other way, such as a manual stop or a crash. Stop Shepherd
while no turn is running.

## Swarm manager waits while a completed worker cannot notify it

Observed during the real Codex integration check on 2026-11-15. The manager
delegated successfully, then used a sleep tool to wait. Worker completion was
queued by the signal dispatcher, which deliberately waits for the manager's
current turn to finish. Sleeping kept that turn active.

Manager role instructions and successful dispatch responses now explicitly tell
the manager to finish its turn once independent work is done, without sleeping
or polling. The host starts the result-processing turn automatically. After
resumption with the revised instructions, a second real assignment to the same
worker completed the entire automatic notification and report cycle without
manual steering. See [live validation](swarm-surface.md#live-integration-check-2026-11-15).

## Browser-connected host restart stalls during listener shutdown

Observed in the same integration check after opening real manager and worker
histories. The listeners stopped accepting requests, but awaiting the browser
listener's `stop(true)` did not resolve after its SSE controllers were disposed.
The supervisor could not relaunch until the process exited. Restarting without
attached conversation streams succeeded.

The shared browser adapter now initiates HTTP connection cancellation before
disposing API streams, then awaits listener shutdown. Repeating the connected
manager/worker-history restart exited with status 0 and the normal supervisor
relaunched Orbit. A loopback regression test leaves an SSE reader connected with
unread turn events and verifies shutdown and binding cleanup. The exact internal
Bun failure was not traced; the corrected shutdown order was validated live.

## Codex turn interruption can leave a running command alive

Confirmed during extended Orbit integration testing on 2026-11-15. An isolated
worker ran a foreground `sleep 15`. After the exact-turn interrupt endpoint
returned success, the worker observation and provider history became
`interrupted`, but the same process remained in Linux state `S` (sleeping, not
zombie) for every sample through 5.5 seconds after interruption. An earlier
manager-mediated `swarm_interrupt` also left a foreground sleep process present
after the turn stopped. The bounded sleep processes subsequently exited.

Shepherd forwards the Codex `turn/interrupt` operation through its shared provider
session; swarm interruption does not own or independently terminate tool-created
processes. A stopped turn therefore does not prove that its commands stopped or
that the workspace is quiescent. The manager correctly reported an interrupted
turn without claiming the command had exited. This remains an open provider/tool
cancellation gap; no process-killing workaround was added to the swarm adapter.
