# Known Errors

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
