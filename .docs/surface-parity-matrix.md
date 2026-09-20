# Surface parity matrix

Reviewed 2026-09-20 against `35cd417` (PR #70). Current registered surfaces:
**Discord** and **web**. This is an inventory of implemented user-facing behavior,
not a roadmap requiring identical interfaces. Provider capabilities that neither
surface exposes are not automatically parity work.

**Yes** = implemented by Shepherd; **Partial** = implemented with the stated
restriction; **No** = no Shepherd surface control; **N/A** = transport-specific;
**Client** = provided by the surrounding Discord client, not Shepherd code.
Web means the built-in UI unless a cell explicitly says API-only. A shared core
method or generated schema alone does not count as UI support.

## Conversation and workspace management

| Feature | Discord | Web | Scope / distinction |
| --- | --- | --- | --- |
| Create conversation | Yes — `!newthread`; ordinary input can ensure a thread | Yes — New conversation | Shared conversation core |
| Select project/repository/local workspace | Yes — `!repo <owner/repo>`, `~`, `~/path` | Yes — project dialog | Shared project resolution |
| Read selected project | Yes — `!repo`, `!status` | Yes — header | Presentation differs |
| Change binding for future conversations | Yes — `!repo` | Partial — choose when opening a conversation | Discord change does not move the current session's cwd |
| List stored conversations | Yes — `!threads` | Yes — sidebar | Paged in both |
| List archived conversations | Yes — `!threads archived` | Yes — Archived filter | Separate from active/stored view |
| List host-loaded conversations | Yes — `!threads loaded` | No | Web attachment dots are not a host-loaded list |
| Switch/resume stored conversation | Yes — `!thread <id>` | Yes — select conversation and resume | Normal workflow covered in both |
| Paste an arbitrary conversation ID | Yes — `!thread <id>` | No UI; API accepts `threadId` on create | Optional navigation difference |
| Read current conversation ID | Yes — `!thread`, `!status` | No dedicated UI | ID exists in API state |
| Inspect ID/name/update time/preview together | Yes — `!threadread [id]` | Partial — names/previews in navigation | No dedicated web metadata panel |
| Rename | Yes — `!threadname <name>` | Yes — conversation actions | Current conversation |
| Fork | Yes — `!fork [id]` | Yes — conversation actions | Web forks selected conversation; Discord can target an ID |
| Archive | Yes — `!archive [id]` | Yes — conversation actions | Web acts on selected conversation |
| Restore archive | Yes — `!unarchive <id>` | Yes — Restore in archived list | Shared core action |
| Detach without interrupting work | Yes — `!detach` | Yes — header detach control | Detach is not deletion or stop |
| Compact context | Yes — `!compact [id]` | Yes — conversation actions | Web selected conversation; active work/approvals constrain actions |
| Roll back recent turns | Yes — `!rollback <numTurns> [id]` | Yes — conversation actions | Conversation rollback, not a filesystem undo |
| Conversation search | No Shepherd command | No | Discord channel search is a client feature, not stored-thread search |

Sources: [Discord commands](../server/adapters/discord/commands.ts),
[web app](../ui/src/App.tsx), [conversation actions](../ui/src/components/ConversationActions.tsx),
[web routes](../server/adapters/web/api.ts), [shared controls](../server/core/control_actions_service.ts).

## Input, routing and approvals

| Feature | Discord | Web | Scope / distinction |
| --- | --- | --- | --- |
| Send text | Yes — channel/DM message | Yes — composer | Shared ingress |
| Send follow-up during a turn | Yes | Yes — Send follow-up | Steers active work; not a separate UI queue |
| Interrupt active turn | Yes — `!interrupt` | Yes — Stop response | Shared interruption action |
| Open/mention-only listening | Yes — `!listen [open\|mentions]` | N/A | Web submission is explicit |
| Pause and resume conversation ingress | Yes — `!pause`, `!resume` | N/A | Discord control commands remain available while paused |
| Direct-message routing | Yes — open unless paused | N/A | Discord transport behavior |
| Command help | Yes — `!help` | N/A — labeled controls | No web command interpreter |
| Current surface status | Yes — `!status` | Partial — header, settings, host controls | No single equivalent status report |
| Command/file-change approval decisions | Yes — approval buttons | Yes — approval cards | Both use shared allowed choices |
| Approval request details | Yes — rendered approval request | Yes — expandable request details | Presentation differs |
| Arbitrary questionnaire/form answers | No general form renderer | No general form renderer | Approval choices are not a questionnaire UI |
| Image-only prompts | Yes | Yes | Text is optional when images are present |
| Text plus images | Yes — attachments | Yes — attachments | PNG, JPEG, GIF, WebP |
| Image attachment picker | Client | Yes | Web also supports paste/drop |
| Paste/drop images | Client | Yes | Web validates before sending |
| Image size/count limits | Yes — 10 MiB per image | Yes — four images, 5 MiB each, 10 MiB total | These are Shepherd limits; Discord transport limits also apply |
| Audio/voice input | No — explicit unsupported-audio response | No | No transcription workflow |
| General non-image file input | No dedicated ingestion workflow | No | Do not infer support from a client's file picker |
| Drafts while switching conversations | Client | Yes — text/images in page memory | Web keys drafts by thread |
| Draft persistence across page reload | Client | No | Web remembers selection, not draft content |
| Failed-send draft retention | Client | Yes | Web warns to check outcome before retrying |

Sources: [Discord ingress](../server/adapters/discord/message_ingress.ts),
[Discord interactions](../server/adapters/discord/interactions.ts),
[web composer](../ui/src/components/Composer.tsx), [web approvals](../ui/src/components/Approvals.tsx),
[Discord image input](../server/adapters/discord/image_input.ts),
[web image limits](../shared/protocol/image_input.ts).

## Responses, activity and history

| Feature | Discord | Web | Scope / distinction |
| --- | --- | --- | --- |
| Live response delivery | Yes — edited/chunked messages | Yes — streamed transcript | Transport-specific delivery |
| Commentary versus final answer | Yes — progress/final presentation | Yes — grouped assistant turns | Commentary is user-facing progress, not raw internal reasoning |
| Collapse completed progress | Partial — Discord progress presentation | Yes — completed progress disclosure | Failed activity remains visible in web |
| Command execution activity | Yes — progress lines | Yes — expandable activity | Summary, not a terminal emulator |
| File-change activity | Yes — progress lines | Yes — expandable activity | No dedicated interactive diff viewer |
| MCP/dynamic tool activity | Yes — progress lines | Yes — expandable activity | Shared activity mapping |
| Web-search activity | Yes | Yes | Shared activity mapping |
| Agent collaboration activity | Yes | Yes | Summaries, not an agent management UI |
| Image-view/generation activity | Yes | Yes | Separate from actual generated image delivery |
| Wait/sleep activity | Yes | Yes | Shared activity mapping |
| Per-item completed activity state | Partial — live lines emphasize started/failed | Yes — Running/Done/Failed/Stopped labels | Not identical lifecycle presentation |
| Turn failure/context-limit feedback | Yes | Yes | Shared events with surface-specific rendering |
| Markdown response rendering | Yes — Discord normalization/rendering | Yes — basic Markdown | Markdown dialects differ; web has no table extension or syntax highlighter |
| Copy assistant response button | Client | Yes | Web copies response text |
| Dedicated per-code-block copy | Client | No | No custom web code toolbar |
| Generated image display | Yes — attachment delivery | Yes — scoped image viewer | Shared artifact handling; different delivery |
| Input image previews in transcript | Client for original attachment | Yes — bounded valid inline images | Unavailable images get a placeholder |
| Per-conversation transcript | Partial — channel messages may span several conversations | Yes | Native web history workflow |
| Read earlier stored turns | Yes — `!history [thread-id]` | Yes — Load earlier messages | Same need, different presentation |
| Raw turn-item inspection | Yes — `!history items <turn-id> [thread-id]` | No | Web inspector intentionally removed in PR #70 |
| History page navigation | Yes — history controls | Yes — prepend older transcript pages | No separate web history panel |
| Research signal notice | Yes — research state-change card | Partial — signal event triggers state refresh | No dedicated web signal notice card |
| Background conversation working/unread badges | Client notifications; no Shepherd overview | No | Web attachment dot means attached, not working/unread |
| Jump-to-latest control | Client | No | Web follows output while near the bottom |
| Persist reading position per conversation | Client | No explicit web persistence | Browser scroll anchoring is not a saved position feature |

Sources: [Discord event presentation](../server/adapters/discord/thread_event_handler.ts),
[activity mapping](../server/core/codex_rpc_mapper.ts), [web timeline](../ui/src/components/Timeline.tsx),
[web messages](../ui/src/components/Message.tsx), [web images](../ui/src/components/GeneratedImage.tsx),
[Discord signal notices](../server/adapters/discord/signal_notice.ts),
[web conversation controller](../ui/src/use-conversation.ts).

## Models, usage and skills

| Feature | Discord | Web | Scope / distinction |
| --- | --- | --- | --- |
| List available models | Yes — `!models` | Yes — settings model picker | Paged discovery |
| Read current/pending model | Yes — `!model` | Yes — settings | Pending choice applies to a new turn |
| Set model | Yes — `!model set <id>` | Yes — settings | Shared model validation |
| Read/set reasoning effort | Yes — `!effort [set <level\|default>]` | Yes — settings | Includes default/reset and supported choices |
| Context/token usage | Yes — `!context` | Yes — settings | Available telemetry; not always present before a turn |
| Account rate limits/credits | Yes — `!limits` | Yes — settings | Provider-reported values |
| List discovered skills | Yes — `!skills` | Yes — Skills section | Workspace-scoped discovery |
| Reload skill discovery | Yes — `!skills reload` | Yes — Reload skills | Not an installer |
| Enable/disable skill | Yes — `!skill enable/disable <name-or-path>` | Yes — per-skill control | Shared configuration; may affect other conversations |
| Filter discovered skills | No dedicated filter command | Yes — name/description/path/scope filter | Web presentation convenience |
| Install/edit skills through a dedicated control | No | No | An agent can work on files; that is not a surface installer |

Sources: [Discord commands](../server/adapters/discord/commands.ts),
[web settings](../ui/src/components/ConversationSettings.tsx),
[web usage](../ui/src/components/Usage.tsx), [web skills](../ui/src/components/ConversationSkills.tsx).

## Host lifecycle, access and recovery

| Feature | Discord | Web | Scope / distinction |
| --- | --- | --- | --- |
| Run alone or alongside the other surface | Yes | Yes | `SHEPHERD_SURFACES`; shared runtime, not two hosts |
| Restart host | Yes — `!restart` | Yes — Host controls | Host-wide; shared active-work/approval guards |
| Deploy stable main | Yes — `!deploy` | Yes — Deploy with blank/main branch | Shared validation and restart workflow |
| Deploy named branch | Yes — `!deploy branch <name>` | Yes — Deployment branch field | Same host-wide operation |
| Inspect checkout deployment status | Yes — `!deploy status` | Yes — Host controls | Commit, locally known remote refs, deployment state |
| Distinguish running and checkout commits | No dedicated pair in command output | Yes — both displayed | Checkout may differ from running process |
| Deployment progress/failure report | Yes — lifecycle cards | Yes — polled operation status | Validation failure retains/restores prior checkout through shared service |
| Explicit host-action confirmation UI | No — command submits action | Yes — confirmation step | Interaction difference, not different lifecycle authority |
| Reconnect transport after disruption | Yes — Discord client reconnect | Yes — SSE reconnect and snapshot refresh | Does not promise durable delivery of every intermediate event |
| Replay/deduplicate browser events | N/A | Yes — bounded SSE replay and snapshot fallback | Replay buffer is in-memory |
| Reconcile pending approvals after browser reconnect | N/A | Yes | Shared pending approval state; host restart is different |
| Recover after surface-initiated host restart | Partial — recovery instructions | Partial — pending operation in session storage, resume when possible | Neither guarantees full host reboot recovery |
| Resume after unrelated host restart | Partial — restore channel binding | Partial — manually resume stored conversation when needed | Ephemeral bindings/handles are not durable sessions |
| Durable host operation journal | No | No | Web operation tracking is bounded and in-memory |
| Access boundary | Discord access/channel permissions | Private network plus Host/Origin checks | Web has no application login/token; trusted network access matters |
| Surface health reporting at startup | Yes | Yes | Shared host lifecycle/logging |
| Full host reboot validation | Not established by this review | Not established by this review | Previously deferred; code/fixture checks are not reboot evidence |

Sources: [surface launch](surface-launch.md), [web API contract](web-api.md),
[Discord lifecycle commands](../server/adapters/discord/commands.ts),
[web host controls](../ui/src/components/HostControls.tsx),
[web host operation service](../server/adapters/web/host_controls.ts),
[web conversation recovery](../ui/src/use-conversation.ts).

## Interpretation and maintenance

Core everyday workflows are covered on both surfaces. Differences such as channel
listening modes, explicit thread IDs, and the web conversation sidebar reflect the
surfaces' interaction models. A No/Partial cell is an inventory result, not an
approved backlog item. This document does not prescribe resume-by-ID, a loaded-thread
panel, or a replacement history inspector as next work.

Keep this matrix symmetric: add a row when either surface gains a user-visible
feature, update both cells, and describe meaningful limits. Update the review date
and source commit. Distinguish built-in controls from API-only support, shared core
capabilities, and Discord-client behavior. Keep detailed API/setup instructions in
the linked references. The separate [schema parity matrix](schema-parity-matrix.md)
tracks the provider protocol; it is not a surface feature inventory.
