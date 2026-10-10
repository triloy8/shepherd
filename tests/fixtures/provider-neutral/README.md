# Provider-neutral fixtures

`codex-text.json` and `claude-text.json` are synthetic, version-tagged protocol
fixtures. They cover Unicode text, commentary/final phases, root tools, and
multiple text blocks sharing one Claude API message ID. They are not recordings.

`codex-recorded.json` was recorded with Codex CLI 0.160.1 and
`claude-recorded.json` with Claude Agent SDK 0.3.296. Both ran in a temporary Git
repository containing only `../workspace/fixture.txt`. Workspace/home paths,
project path derivatives, emails, credential/account fields are sanitized;
native IDs remain to preserve frame relationships. The Claude read succeeded.
The Codex command failed because this host could not initialize the bwrap
sandbox; the completed answer explains the failure. This records tool failure
recovery, not evidence of successful sandboxed execution. No approvals,
questions, background work, images, or rate-limit normalization are proved here.

The tests replay these recordings without network calls. Claude frames go
through the actual session/store path; Codex frames go through the native mapper,
core event log, and shared reducer, and are compared to native recovered history.
The synthetic Codex test also exercises the actual session/history read path.

To explicitly record another fixture using your installed provider and auth:

```sh
bun scripts/record-provider-neutral.ts --provider codex --out /tmp/new-codex.json
bun scripts/record-provider-neutral.ts --provider claude --out /tmp/new-claude.json
```

The recorder uses a temporary fixture workspace, sets a three-minute timeout,
and removes the workspace on exit. Claude permits only the fixture read and is limited
to three turns and $1; Codex uses read-only sandboxing and never asks for approval.
An existing output file is never overwritten. Recording can incur provider usage;
it is deliberately excluded from `bun test`. Review the generated file before
adding it here. Synthetic additions must retain `evidence: "synthetic"`.
