# Web and Discord surface review

Reviewed 2026-09-20, alongside the history browser. This inventories implemented
surface controls; it is not a claim that every provider capability is exposed.

| Capability | Web coverage |
| --- | --- |
| Send, steer, interrupt | Composer and stop control |
| Approval decisions | Shared pending approval records and allowed choices |
| Model, effort, context, account limits | Conversation settings |
| Skills discovery, reload, enable/disable | Skills panel |
| New, resume, rename, fork, archive, restore, detach | Conversation navigation and actions |
| Compact and rollback | Conversation actions with history revision recovery |
| Turn and item history | Browse history, with separate paged turn inspection |
| Restart, deploy, deployment status | Host controls and operation status |
| Image input and generated images | Composer attachments and scoped image rendering |
| Discord listen/mentions, pause/resume routing | Transport-specific; web uses an explicit composer |

## Remaining differences

- Discord can attach directly using a thread ID. The web API supports attaching
  a thread ID, but the UI currently offers stored-conversation selection.
- Discord exposes the host's loaded-thread list. Web navigation shows stored
  conversations and its own attached handles, not a host-wide loaded list.
- Discord's thread-read command exposes ID, name, update time and preview in one
  response. Web navigation distributes some of these fields; a conversation
  details panel would make that information consistently accessible.
- Repository selection is a channel binding in Discord and a project choice
  when opening a conversation in web. These are different surface workflows
  over the shared core, rather than interchangeable commands.
- Web uploads allow four images, 5 MiB per image and 10 MiB combined. Discord's
  attachment limit is 10 MiB per image. Both accept PNG, JPEG, GIF and WebP.
- Neither approval renderer is a general questionnaire editor: both render the
  shared approval choices. Broader provider interaction support remains a
  separate core-and-surface task.

## Recovery coverage and limits

Existing tests cover replay/deduplication and expired event cursors, approval
reconciliation, history reads crossing rollback, rejected stale history pages,
image-send failures retaining the draft, and host operation status recovery.
The history browser adds abortable reads, return navigation and first-page
recovery after a revision conflict. It does not freeze an actively growing
conversation; Refresh requests current history.

A web-initiated host action records pending recovery in session storage. This is
not a durable host operation journal. An unrelated restart may require manually
resuming a stored conversation. Composer drafts and image attachments are not
persisted across page reloads. Full host reboot validation remains deferred;
local fixture/browser checks do not establish reboot reliability.

The next focused parity improvement is a conversation details/resume-by-ID flow,
followed by host-wide loaded-conversation visibility. Keep these in shared core
ports and expose presentation through each adapter, without importing Discord
command handlers into web.
