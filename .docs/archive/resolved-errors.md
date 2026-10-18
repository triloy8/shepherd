# Resolved errors

Known errors that have since been fixed, kept for their diagnosis. Current
troubleshooting is in [errors](../errors.md).

## Deployment diagnostics missing after page 1

The runtime progress reporter previously selected only the first rendered card,
so a failure labeled `1/18` had no delivered continuation pages. It now edits
the progress card and delivers every remaining page. Deployment errors retain
both output streams without repeating stderr through the command exception,
put recognized failure lines first, and are logged to the host console before
Discord delivery. A failed continuation delivery is propagated as an error.

Deployment validation summaries prioritize Bun's `(fail)` records when present.
Expected `error:` logs from passing failure-path tests remain in the complete output,
but are not listed as additional test failures. Build/command failures without test
failure records still summarize error and timeout lines.

The package timeout regression runs a fast child test and verifies the executed
`bun test --timeout 30000` command. It does not sleep beyond Bun's default timeout:
wall-clock probes can fail under host load independently of application behavior.
Its subprocess watchdog is 60 seconds, with a 90-second outer cleanup budget; these
are test-harness limits, not changes to deployment or normal test timeouts.

## Structured user questions returned as unsupported

Previously, `item/tool/requestUserInput` received JSON-RPC error `-32601` with
`Shepherd does not support server request item/tool/requestUserInput.` The error
resolved the request immediately; Shepherd displayed no form and could not keep
it pending for the human's answer. A question in assistant prose followed by
continued work alone does not establish that this RPC occurred; inspect the turn's
request/error logs to distinguish the two cases.

Implemented in `7e30d66` ([PR #88](https://github.com/triloy8/shepherd/pull/88)):
valid structured requests now display pending forms, accept answers or an explicit
skip, and respect blocking/nonblocking behavior. Deploy the change and reload the
web page to load its UI assets. Existing unsupported requests are not resurrected;
ask the agent to ask again. Discord directs secret/large requests to the web UI.

See [question workflows](../user-questions.md), the [surface matrix](../surface-parity-matrix.md),
and the [Codex matrix](../codex-parity-matrix.md). MCP elicitation remains unsupported.
