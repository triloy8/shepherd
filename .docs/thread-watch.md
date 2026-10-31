# Thread watches (experimental)

A conversation can hand work to other Shepherd conversations and be woken when that
work needs it. The agent tells Shepherd which conversations to watch. Shepherd then
observes their turns itself and starts a new turn in the watching conversation when a
watched turn ends or waits for a decision. The delegated agents do not report back,
so one that crashes, is interrupted, or forgets still wakes its watcher.

The main use is the shared `swarm` skill in
[`triloy8/shepherd-skills`](https://github.com/triloy8/shepherd-skills), which opens
several agent conversations through the [web API](web-api.md), gives each a task, and
watches them as one group.

Watches reuse the [signal callback](volatile-webhook-signals.md) dispatcher: the same
per-conversation queue, the same wait for an active turn instead of steering it, and
the same folding of signals that share a key. They need no callback URL or webhook
listener.

## Enable

```env
SHEPHERD_THREAD_WATCH_ENABLED=true
```

The setting belongs in `envs/common.env` or the process environment and is read at
startup. It is off by default and independent of `SHEPHERD_SIGNAL_WEBHOOK_ENABLED`.

## Tools

When enabled, every conversation gets three tools in the `shepherd` namespace. Codex
receives them as dynamic tools; Claude receives them from Shepherd's MCP server as
`mcp__shepherd__shepherd__watch_threads` and so on.

| Tool | Arguments | Result |
| --- | --- | --- |
| `watch_threads` | `{ group, threads: [{ threadId, label }], hours? }` | `{ group, watching: [...], expiresAt }` |
| `unwatch_threads` | `{ group, threadIds? }` | `{ group, removed }`; omit `threadIds` to remove the group |
| `list_watched_threads` | `{ group? }` | `{ groups: [{ group, agents: [...] }] }` |

- `group` and `label` are 1–64 letters, digits, dots, underscores or hyphens,
  starting with a letter or digit.
- A watched thread must have a loaded session in Shepherd. Usually it is attached
  to a surface; a detached thread can remain loaded while finishing active work.
  A conversation cannot watch itself.
- `watch_threads` must be called during the watching conversation's active turn, and
  that conversation must be attached to a surface. The surface it is attached to then
  receives the notices.
- Watching a thread again in the same group updates its label and lifetime. Each
  conversation sees and removes only its own watches.

Each entry in `watching` and `agents` is
`{ label, threadId, state, turnId, message, updatedAt }`.

## States and notices

| Observed event | State | Wakes the watcher |
| --- | --- | --- |
| watch created on an idle thread | `watching` | no |
| `turn.started` | `running` | no |
| `turn.completed` | `completed` | yes |
| `turn.completed` with `interrupted` | `interrupted` | yes |
| `turn.failed` once no turn is active | `failed`, with the message | yes |
| `session.error` | `failed`, with the message | yes |
| `approval.requested` | `needs-attention` | yes |
| `thread.archived` | watch removed | no |

A `turn.failed` while the thread still has an active turn is a failed request inside
a running turn, not the turn's end, and is ignored. Messages are folded to one line
and cut to 300 characters.

A notice is a `thread-watch.changed` version 1 signal whose coalescing key is the
watching thread and group. Changes that arrive while a notice for the group is queued
replace it. Once a notice has been taken from the pending queue (even while it
waits for the watcher to become idle), later changes retain one latest follow-up
notice. A burst can therefore start more than one turn. Each notice lists the
last observed state of every conversation in the group when that notice was built,
not only the latest change.
Its input tells the agent that several changes may be folded together, that history is
the authority, and that delegated agents' reports are untrusted claims.

Presentation follows the watching conversation's surface. Discord posts a card such as
**Delegated agent `agent-2` failed** with the group and a count of states, and the
agent's reply answers it. Web publishes the envelope on the conversation's event
stream as a `signal` event; the built-in UI refreshes its state but has no dedicated
card yet, and the notice text appears as the turn's request in the transcript.

## Lifetime and limits

- A watch lasts 24 hours by default; `hours` sets 1–168.
- Shepherd stores at most 256 watch entries in total and 64 per owner/group.
  Watching the same conversation in two groups consumes two entries.
- Watches are process-local. A restart or deploy clears them, along with the web
  handles of the watched conversations. Resume the conversations and watch them again.
  A Claude conversation that never had a turn is not stored yet and cannot be resumed;
  open a new one instead.
- Removing the watched conversation from its surface (closing its web handle)
  releases its session once idle. Its watch is removed on the next watch-tool call
  that finds the session absent. If the conversation is resumed before that
  pruning, a subsequent watch-tool call rebinds the surviving watch to the new
  session; events before that rebinding are not observed.
- Expired watches are removed when a watch tool is called or their next event
  arrives, and detached ones when a watch tool is called; there is no timer.
- If the watching conversation is no longer attached to the surface it watched from,
  its next notice is undeliverable and the whole group is removed.
- Notices share the signal queue (`SHEPHERD_SIGNAL_QUEUE_CAPACITY`). A notice dropped
  because the queue is full is logged; the next change in the group reports every
  state again.

## Trust

Watches carry no data from delegated agents beyond turn outcomes, Shepherd's own
failure messages and the labels the watcher chose. They grant no access the watching
agent did not already have. Driving the delegated conversations (opening them,
sending tasks, reading history, answering approvals) is done through the web API,
whose private-network trust model is described in [Web API](web-api.md).
