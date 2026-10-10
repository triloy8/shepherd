# Web UI

The built-in web UI is the browser client for Shepherd's web surface. This page
describes what the UI shows and how its controls behave. Setup, private access,
the HTTP and event contract, limits, and error codes are in [Web API](web-api.md);
the UI uses only that API. Differences from Discord are in the
[surface parity matrix](surface-parity-matrix.md).

## Transcript, work, and images

Assistant answers appear in the transcript. Tool calls, commentary, and other work
appear in a work timeline between the request and the answer, and fold when the
turn completes.

Completed work remains collapsible even when a tool step failed. The work summary
shows the number of failed steps; expand it to inspect their details. Failed or
interrupted turns themselves retain expanded progress.

Completed Codex `imageView` items expose the existing local image, including
Playwright screenshots opened with `view_image`. Viewed images (`kind: "viewed"`)
are work artifacts: their previews are collapsed by default while working and fold
with completed work. Expand **Viewed image** to inspect them at full size.
Images explicitly embedded in assistant answers stay visible. Reloading history
restores the same behavior while source files remain available. Failed or unfinished view
items remain activity only; inspecting an image makes it visible to the web user.
Generated images appear immediately as assistant output, grouped with the following
final text under one Shepherd author label. Generation prompts live under a closed
**Generation details** disclosure. This also supports image-only responses and
history reload. Viewed work images use their filenames.

Assistant answers can embed registered images with Markdown, for example
`![Desktop view](/absolute/path/to/screenshot.png)`. The renderer resolves the exact
local source path (including URL-encoded paths) to its known conversation asset
URL. Plain links to registered images resolve to the same full-size asset. Images
remain inside the assistant message with their Markdown alt text as a caption.
Unregistered local paths, remote images, and arbitrary asset URLs remain image
placeholders; Markdown never registers or reads a new file. References to older
images work when their artifact metadata is loaded in the current conversation.

## Usage and limits

The sidebar **Usage & limits** panel has Codex and Claude tabs. It opens on the
selected conversation provider, or on Codex when a reset request needs recovery.
The values are host account allowances shared across conversations, not
per-conversation budgets. The panel polls only while it is open and the page is
visible.

Codex bucket titles use the model catalog display name matched by
`normalModelSlug`, then the provider's `limitName`, then a humanized internal ID.
When a model name and a distinct quota label are both present, the quota label is
shown beneath the title. Optional catalog failures leave usage and reset controls
available.

Each available, unexpired, supported Codex reset has a **Use this reset** button.
If details are count-only or capped, **Use next available reset** lets Codex choose
from its available inventory; the UI does not assume an expiry ordering. The UI
keeps the request key and selected credit ID in session storage, so a reload in the
same tab can retry an attempt whose outcome is unknown; until then, only that retry
is allowed. Reset controls work without a selected conversation.

The Claude tab shows reported allowance windows, reset times, plan, and extra usage
status, with stale labels when values are old or a refresh failed. It offers an
external usage link and no reset or billing controls.

Conversation settings show context telemetry, which can be empty before the first
turn.

## Conversation management

**Conversation menu → Conversation actions** provides Rename, Fork conversation and
Archive conversation. Renaming updates the title and list. Forking selects the
new conversation while preserving the source, its handle and its draft. Archive
asks for confirmation, clears the local selection and detaches the web handle;
it does not delete history. Archive and fork are disabled during active work or
pending approvals, with the same check enforced by the API.

The sidebar has Active and Archived views. Archived rows offer Restore; restoring
returns to Active without automatically attaching the restored thread. Select it
to resume normally. Pagination and delayed responses are scoped to the chosen
view so switching filters cannot mix lists. The currently open conversation keeps
its title while browsing the other view. Other clients sharing an archived handle
will need to refresh and restore/resume it before sending again.

After an uncertain fork response, refresh the conversation list before retrying.
The UI does not automatically retry management writes. These controls use the
shared core thread operations; they add no separate conversation storage.

## Skills controls

Conversation settings includes a collapsible **Skills** section. It lists workspace
skills with descriptions, scope, effective enabled state, and expandable paths.
Filter by name, description, scope, or path; discovery errors remain visible even
when filtering. Enable/disable uses the exact listed path, so duplicate names in
different scopes remain distinct. Changes use the shared Discord control action and
can affect other conversations through shared Codex configuration.

**Reload skills** refreshes discovery after installation or file changes. The UI
reports effective-state overrides, distinguishes empty discovery from failure, and
requires reloading after a failed update before offering another toggle. Requests
from a closed settings panel cannot overwrite a newly opened panel. This adds no
skill installation, file editing, or per-conversation configuration semantics.

## Markdown diagrams

Assistant responses and draft previews render fenced `mermaid` code blocks as
diagrams, including flowcharts and sequence diagrams. **Show source** switches
to the original diagram code, and **Copy** copies that source in either view.

Incomplete, invalid, or oversized diagrams display their source instead. Rendering
is deferred briefly while text streams. Diagrams use the dark theme, fit the
transcript width, and scroll within their container on narrow screens. Diagram
links are disabled; SVG images isolate diagram styles from the surrounding UI.

## Answering agent questions

Structured questions from either provider appear as a form in the selected
transcript: Codex `item/tool/requestUserInput` requests and Claude `AskUserQuestion`
calls. Claude questions always block, and a question that allows several answers
shows checkboxes (**Choose one or more answers**). Blocking
requests display **Waiting for your answer** and suppress the working/writing
indicators while the request is pending. Nonblocking requests display **Shepherd
has a question** while the agent continues working.

Select an option, choose **Write another answer** when custom text is allowed, or
fill a free-text field. Secret answers use a password input. No option is selected
automatically; **Submit answers** stays disabled until every question has a
nonempty answer. Multiple questions submit together. **Skip questions** explicitly
returns no answers, rather than accepting a recommended choice. Answer and skip
controls are disabled while disconnected or another write is busy.

Reload/reconnect restores pending questions from the API, but unsubmitted answer
drafts are not persisted. Submitted, skipped, withdrawn, interrupted/completed-turn,
and stopped-session requests disappear. A host restart does not restore pending
forms. Ordinary questions in assistant prose do not create interactive requests.
Pending questions use the same lifecycle guards as approvals.

See [desktop/mobile examples](user-questions.md) and the
[API answer contract](web-api.md#structured-user-questions). Codex questions were
reviewed on 2026-10-09 against `7e30d66` in
[PR #88](https://github.com/triloy8/shepherd/pull/88); Claude questions on
2026-10-10 on PR #90.

## Compact layout and navigation

The header has a sidebar toggle, a single-line conversation title, a connection
status dot, and **Conversation menu**. Tap the dot or choose **Conversation details**
to see connection state, project path, and thread ID. Settings, conversation actions,
and detach are in the same menu. Arrow keys, Home/End, Enter, and Escape work in the
menu; dialogs return focus to the opener. The desktop sidebar can collapse. On
mobile, the navigation drawer traps focus and hides the transcript from interaction.
Host controls are in the sidebar footer, including when no conversation is selected.
The top bar shows the host battery percentage and charging indicator on Linux/Android
hosts with a readable system battery. It refreshes every 30 seconds while visible
and when returning to the page. Low discharging batteries (20% or less) appear in
amber; unavailable readings are hidden. The tooltip and accessible label identify
this as the host battery, rather than the browser device's battery.

The composer floats over the transcript with inset edges and a subtle bottom fade.
It starts as a single row in a box with rounded corners, with an attachment plus
button on the left and a rounded-square send/interrupt action on the right. Wrapped drafts and image attachments
expand the text area above the controls; long drafts scroll internally at the height
limit. All controls retain 44px touch targets. Routine helper copy is screen-reader-only;
connection state remains visible, and the placeholder identifies follow-up drafts. Images, image errors, and send failures remain visible.

The transcript reserves the measured composer height so the last message is not
covered, including while attaching images or composing a long draft. If following
latest output, composer growth maintains that position; reading older messages
keeps automatic follow disabled. The app follows the visual viewport at normal
zoom, tracking both its height and vertical offset so Safari keyboard panning does
not lift the composer away from the keyboard. The page itself is fixed; transcript
and composer scrolling stay inside their containers. Pinch zoom retains
normal browser behavior. Bottom padding accounts for safe-area insets when the
keyboard is closed; a keyboard-reduced visual viewport uses a tighter 4px gap.

## Compact and revert

**Conversation actions** provides **Compact conversation**. Compaction reports that
it started; timeline activity and turn lifecycle show progress/completion.

Each persisted user message has **Revert from here** under its text beside **Copy**.
Image-only messages also have revert. The action opens a confirmation with the
selected message preview and explains that this turn (including its response) and
all later turns will be removed. File edits, commands, and other side effects are
not undone. Fork first to preserve a copy. Cancel is focused by default.
Optimistic messages without persisted history do not offer revert.

Both compact and revert are disabled during an active turn or pending approvals,
with matching server enforcement. Revert also requires an online connection and
blocks other conversation writes while running. The selected turn ID is passed
directly to the provider; there is no turn-count input or rollback control.

Revert refreshes history by replacement, clears old pagination, and invalidates
prior event replay. Provider `thread/reverted` notifications trigger the same
recovery. Revision checks recover even if a reset event was missed; stale in-flight
history pages cannot restore removed turns. An ambiguous failure prevents another
revert until history is successfully reloaded, even after closing and reopening the
confirmation. A removed selection cannot be submitted. Reload failures keep recovery
pending. Discord `!rollback` is retired with a notice pointing to this web action.

## Host controls

The sidebar’s **Host controls** opens host status, running and checkout commits,
remote refs, restart, and deploy. These controls work without selecting a conversation.
Both actions require confirmation because they affect every surface. Leave the
branch blank for stable main or enter a preview branch; deploy main to return to
stable. Shared lifecycle guards refuse actions while turns or approvals are active.

Deployment runs in the background and status polls show validation progress,
validation failure/restoration details, or restart. Command output is rendered as
plain text in a bounded, scrollable area. The UI remembers its pending request in
session storage and continues checking after closing the dialog or reloading the
page. It never automatically resends a lost request. An unknown outcome requires
checking status before explicitly requesting another action.

When instance identity changes, the UI refreshes status and attempts to resume the
selected stored conversation through the existing API. Drafts in the current page
remain keyed by thread. Resume failures remain visible and the saved selection is
retained for manual recovery. Check running/checkout commits to verify a deployment:
restart alone does not establish success. Detailed operation logs are not persisted
across host restarts; full output remains in host logs.

Existing tabs reconnect without a full page reload. Reload the page when you want
to load newly deployed web UI assets; in-memory unsent drafts do not survive a page
reload.

## Image attachments

The composer supports **Attach images**, clipboard image paste, and file drop.
PNG, JPEG, GIF, and WebP are accepted: up to four images, 5 MiB each, 10 MiB total.
Convert unsupported formats before attaching. Thumbnails show filenames and individual
Remove controls. Send images with text or on their own, including as follow-ups to
an active turn. Conversation history shows inline raster previews alongside the
user message; unsupported historical attachments have a placeholder.

Image drafts are kept per thread when switching conversations or reconnecting in the
current page. Failed sends retain both text and images; inspect the conversation
before retrying an uncertain request. Successful sends clear only submitted
attachments. Draft images are in memory and do not survive a full page reload;
sent attachments are read back from provider history. Image URLs in agent Markdown
remain non-fetching placeholders.

## Conversation history

Each conversation has its own transcript. Use **Load earlier messages** to read
older turns in that transcript. There is no separate turn/item inspector in web;
Discord retains its history commands for navigating conversations within a channel.

## Conversation list freshness

The conversation list shows the most recently updated conversations first, in
both the Active and Archived views. It refreshes after selected-turn activity, when
the page regains focus/visibility, and every 30 seconds while visible. Refresh shows a
busy indicator. Automatic refresh pauses after loading more conversations to avoid
collapsing older pages; manual Refresh returns to the newest page and resumes it.
