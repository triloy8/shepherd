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
`ESC[31m` or `ESC[0m`. As reviewed on 2026-09-13, Codex stderr is logged to the
host console by `CodexSession.onServerStderr`; it is not forwarded to Discord.
Structured app-server errors follow the separate event-delivery path.

### Meaning

This is a Codex patch-tool input error, not a Shepherd deployment or Discord
connection failure. The submitted patch contained malformed patch structure.
In the recorded occurrence, a second `*** Update File` marker appeared where
the parser still expected lines belonging to the preceding hunk.

The patch command rejected that entire invocation during verification. It did
not partially apply that malformed patch or corrupt the target files.

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

For the occurrence recorded on 2026-07-25, the failed multi-file patch was
immediately retried as separate valid patches. The retry succeeded, and the
resulting implementation passed `bun run check` and all 109 tests before PR
creation.

### Prevention

- Prefer one focused file update per patch call when changing unrelated files.
- Keep every hunk line correctly prefixed.
- Re-read nearby file contents before retrying a rejected patch.
- Treat the tool result as authoritative: only report a change as applied after
  the patch tool returns success.
