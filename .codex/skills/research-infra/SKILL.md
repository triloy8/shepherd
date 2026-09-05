---
name: research-infra
description: Plan, launch, and interpret repository-backed remote research using an auto-infra control plane and Shepherd completion callbacks. Use when a selected project contains infra/, run-specs/, and the supported Justfile commands for remote experiments.
---

# Research Infra

Treat the repository selected through `!repo` as the complete research machine.
Work from its root and follow its `AGENTS.md`, research-ledger instructions, and
more specific subtree contracts. Do not install another infrastructure copy or
create a project template.

## Prepare the run

Discuss and predeclare the hypothesis, evaluation protocol, workload, expected
artifacts, dependency extras, compute shape, runtime, and budget. Implement the
experiment and create a new bounded JSON specification under `run-specs/`.

Use the repository's allowed local checks and offline planning commands. Never
run training, inference, evaluation, benchmarks, or research artifact
generation locally when the repository requires remote execution.

Before launch, commit the exact intended source state and require a clean
worktree. Report the experiment ID, commit, CPU or GPU shape, maximum hourly
price, maximum runtime, and maximum total cost. Provision only after the user
explicitly authorizes those exact bounds in the current conversation. Obtain
new authorization if any reported bound or the intended commit materially
changes.

## Launch with Shepherd resumption

Immediately before an authorized detached launch, call
`shepherd.get_signal_callback` with:

```json
{
  "kind": "research.state-changed",
  "version": 1
}
```

Start the repository command in an interactive execution session:

```bash
just launch-signaled run-specs/<spec>.json SPEND
```

Transfer the returned callback URL directly to that process through stdin.
Never put the callback in argv, an environment variable, a shell pipeline, a
file, Git, controller state, logs, or repeat it in user-visible output. Do not
request the callback before the run is ready to launch because the route is a
short-lived bearer capability.

If callback allocation or stdin handoff fails, do not silently launch without
resumption. Report the failure and preserve the control plane's cleanup
behavior. After a successful launch, report the run ID and bounded spend; the
detached infra watcher owns monitoring, publication, recovery, and exact-worker
termination.

## Handle the completion turn

Treat `research.state-changed@1` as a notification, not evidence. When Shepherd
resumes the conversation, inspect the authoritative
`.remote-runs/<run-id>/state.json`, verified or recovered artifacts, applicable
logs, and the project research ledger before drawing conclusions.

Report the terminal state, verification and cleanup outcomes, material metrics
or failures, and the justified next research step. Record durable scientific
evidence or decisions through the repository's research-ledger contract.
