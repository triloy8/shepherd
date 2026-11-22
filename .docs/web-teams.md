# Teams in web conversations

The ordinary web conversation is the manager. No team record is allocated by
opening a chat or asking for status. The first valid delegation creates the team.
Workers belong to that parent and do not appear in the main active/archive lists.
The Swarm panel shows status, assignments and read-only worker history. Normal
chat, models, approvals and history continue through the existing web interface.
After a dispatch, the roster shows the task and status for its exact turn using
worker history and live state. The worker inspector keeps the original assignment
alongside the full conversation.

## Architecture

- `server/adapters/web/api.ts` composes one browser API with team routes and events.
- `SwarmService` owns saved membership, revisions, lifecycle and dispatch receipts.
- `SwarmManagerService` verifies the active caller, provisions isolated workers,
  installs watches before dispatch, and handles reports, decisions and interruption.
- Shared browser transport supplies history, controls, assets and SSE.
- The web surface composition supplies `FileSwarmStore`; core depends on its port.
- `ui/src/swarm` contains only the panel, worker inspector, modal, API and roster hook.

The separate Orbit application, surface registration, listener, configuration
example, font bundle and UI entry point are removed. No forwarding modules or
surface aliases remain. Deployment migration is documented in `deploy/README.md`.

## Persistence and authority

Records retain their existing format in `~/.shepherd/swarm-groups`. Override the
path with `SHEPHERD_SWARM_STATE_DIR` in `envs/web.env`. Saved manager thread IDs
rebind through web on resume. Workers cannot manage teams. A manager can control
only its own members during its current active turn. Duplicate dispatch IDs
return their saved receipt; uncertain pending receipts require history inspection.
Watches are renewed by status on the manager's next turn after restart.
Watcher updates name the worker turns that changed while the manager was busy.
Pass the worker thread ID and turn ID to `swarm_report` to get that turn's
dispatch receipt, status, final reply and pending decisions. Omit the turn ID to
page through full worker history.

New isolated workers require an owner/repo project. Local-path chats can work
alone. Closed teams retain history. Creating another team for the same parent
requires new delegation; old worker identities remain workers.

`swarm_delegate` accepts an optional exact `model` ID for the selected `provider`.
Fresh workers use the host's default provider when `provider` is omitted. Shepherd
watches the new worker before sending its real assignment as the first turn with
that model. Retries with the same request ID return the existing receipt.

See [worker retirement](future-implementations.md#retire-an-individual-worker)
for a proposed way to replace one worker within an active team.

## Verification boundaries

Automated tests exercise API authority, duplicate dispatch suppression, storage,
restart/rebinding, events, worker visibility, and the single web listener. Browser
fixtures exercise layout and inspection. Synthetic tests do not establish real
provider approval behavior, physical phone keyboard behavior, or command-process
cancellation. See `.docs/errors.md` for the known cancellation and history races.

Verification for this refactor: 877 tests passed; `bun run check` and the compiled
binary build passed. Firefox fixtures covered zero-worker chats, delegation,
roster updates, read-only inspection, draft preservation and reload at 320, 390,
1440 and 1920px. The existing chat workflow also passed streaming, approvals,
failed-send drafts, interruption, offline reconnect and expired-handle recovery.
Source and binary smoke checks used isolated team stores and checked health,
root UI/assets, an empty roster, the retired entry returning 404, and graceful
shutdown. The binary ran from a temporary directory without UI files. Real
provider delegation was not rerun for this refactor.
