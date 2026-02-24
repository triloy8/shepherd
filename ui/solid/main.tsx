import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { render } from "solid-js/web";
import { AgentController } from "./controller/agent_controller.js";
import { ITEM_TYPE_REGISTRY } from "./presentation/item_registry.js";
import type {
  DisplayMode,
  OutputSegment,
  PendingChatgptAuthRefreshRequest,
  PendingDynamicToolCallRequest,
  PendingLegacyExecApprovalRequest,
  PendingLegacyPatchApprovalRequest,
  PendingApprovalRequest,
  PendingToolUserInputRequest,
  ThreadItem,
} from "./types/ui_types.js";
import "./styles.css";

const EMPTY_AGENT_OUTPUT = "No output available.";
const EMPTY_SUBBLOCK_OUTPUT = "No details available.";

type KvEntry = { label: string; value: unknown };

function formatJson(value: unknown): string | null {
  if (value === undefined) return null;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return null;
  }
}

function formatValue(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return `${value}`;
  return formatJson(value);
}

function kvEntries(entries: KvEntry[]): Array<{ label: string; value: string }> {
  return entries
    .map((entry) => ({ label: entry.label, value: formatValue(entry.value) }))
    .filter((entry): entry is { label: string; value: string } => Boolean(entry.value));
}

function App() {
  const controller = new AgentController();
  const [snapshot, setSnapshot] = createSignal(controller.getSnapshot());

  let itemListRef: HTMLElement | undefined;
  let textareaRef: HTMLTextAreaElement | undefined;

  const statusTitle = createMemo(() => snapshot().statusText);

  const adjustTextareaHeight = () => {
    if (!textareaRef) return;
    textareaRef.style.height = "auto";
    const next = Math.min(textareaRef.scrollHeight, 192);
    textareaRef.style.height = `${Math.max(next, 96)}px`;
    textareaRef.style.overflowY = next >= 192 ? "auto" : "hidden";
  };

  const resetTextareaHeight = () => {
    if (!textareaRef) return;
    textareaRef.style.height = "96px";
    textareaRef.style.overflowY = "hidden";
  };

  onMount(() => {
    const unsubscribe = controller.subscribe((next) => setSnapshot(next));
    void controller.connect();
    resetTextareaHeight();
    textareaRef?.focus();
    onCleanup(() => {
      unsubscribe();
      snapshot().eventSource?.close();
    });
  });

  createEffect(() => {
    snapshot().items.length;
    queueMicrotask(() => {
      if (!itemListRef) return;
      const nearBottom = itemListRef.scrollHeight - itemListRef.scrollTop - itemListRef.clientHeight < 120;
      if (nearBottom || snapshot().isTurnActive) {
        itemListRef.scrollTop = itemListRef.scrollHeight;
      }
    });
  });

  const submitTurn = async (event: SubmitEvent) => {
    event.preventDefault();
    if (!textareaRef) return;
    const value = textareaRef.value.trim();
    if (!value) return;
    textareaRef.value = "";
    resetTextareaHeight();
    await controller.submitTurn(value);
  };

  const onTextareaKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Enter" || event.shiftKey) return;
    event.preventDefault();
    const form = (event.currentTarget as HTMLTextAreaElement).form;
    form?.requestSubmit();
  };

  return (
    <main class="agent-app" data-role="agent-app">
      <header class="agent-header">
        <h1>Agent</h1>
        <div class="agent-actions">
          <div class="approval-control" aria-label="Approval Policy">
            <span class="approval-control-label">Approval</span>
            <div class="approval-segment" role="group" aria-label="Approval Policy">
              <For each={["untrusted", "on-failure", "on-request", "never"] as const}>
                {(policy) => (
                  <button
                    type="button"
                    class="approval-chip"
                    data-active={policy === snapshot().selectedApprovalPolicy ? "true" : "false"}
                    aria-pressed={policy === snapshot().selectedApprovalPolicy}
                    onClick={() => controller.setApprovalPolicy(policy)}
                  >
                    {policy === "on-failure"
                      ? "On Failure"
                      : policy === "on-request"
                      ? "On Request"
                      : policy[0].toUpperCase() + policy.slice(1)}
                  </button>
                )}
              </For>
            </div>
          </div>
          <button type="button" class="header-chip-action" onClick={() => void controller.newThread()}>
            New Thread
          </button>
        </div>
      </header>

      <section class="agent-body" aria-live="polite" ref={itemListRef}>
        <Show
          when={snapshot().items.length > 0}
          fallback={
            <div class="empty-state">
              <h2>Start a turn</h2>
              <p>{snapshot().threadId ? `Thread: ${snapshot().threadId}` : "No thread initialized yet."}</p>
            </div>
          }
        >
          <For each={snapshot().items}>{(item) => <ThreadItemView item={item} onModeChange={(segmentId, mode) => controller.setSubBlockDisplayMode(item.id, segmentId, mode)} />}</For>
        </Show>
      </section>

      <section class="agent-composer">
        <section class="approval-list" aria-live="polite" hidden={snapshot().pendingApprovals.length === 0}>
          <For each={snapshot().pendingApprovals}>
            {(request) => (
              <ApprovalCard
                request={request}
                onCommand={(requestId, decision) => void controller.submitCommandApproval(requestId, decision)}
                onFileChange={(requestId, decision) => void controller.submitFileChangeApproval(requestId, decision)}
                onToolInput={(requestId, answers) => void controller.submitToolUserInput(requestId, answers)}
                onToolCall={(requestId, success, contentText) =>
                  void controller.submitDynamicToolCall(requestId, success, contentText)
                }
                onChatgptAuthRefresh={(requestId, accessToken, chatgptAccountId, chatgptPlanType) =>
                  void controller.submitChatgptAuthRefresh(requestId, accessToken, chatgptAccountId, chatgptPlanType)
                }
                onApplyPatchApproval={(requestId, decision) =>
                  void controller.submitApplyPatchApproval(requestId, decision)
                }
                onExecCommandApproval={(requestId, decision) =>
                  void controller.submitExecCommandApproval(requestId, decision)
                }
              />
            )}
          </For>
        </section>

        <form onSubmit={(event) => void submitTurn(event as SubmitEvent)}>
          <div class="composer-main">
            <span
              class="status-pill"
              role="status"
              aria-live="polite"
              data-state={snapshot().statusVariant}
              title={statusTitle()}
              aria-label={statusTitle()}
            >
              <span class="visually-hidden">{statusTitle()}</span>
              <svg class="status-icon icon-ready" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M6.5 12.75l3.25 3.25L17.5 8.5" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
              <svg class="status-icon icon-pending" viewBox="0 0 24 24" aria-hidden="true">
                <circle class="track" cx="12" cy="12" r="7.5" stroke="currentColor" opacity="0.2" />
                <path class="indicator" d="M12 4.5a7.5 7.5 0 0 1 7.5 7.5" stroke="currentColor" stroke-linecap="round" />
              </svg>
              <svg class="status-icon icon-error" viewBox="0 0 24 24" aria-hidden="true">
                <circle cx="12" cy="12" r="7" stroke="currentColor" stroke-linecap="round" />
                <path d="M12 8.5v4" stroke="currentColor" stroke-linecap="round" />
                <circle cx="12" cy="16" r="0.8" fill="currentColor" stroke="none" />
              </svg>
            </span>

            <div class="composer-field">
              <label for="turn-input" class="visually-hidden">Turn Input</label>
              <textarea
                id="turn-input"
                name="turn_input"
                placeholder="Type input for the next turn..."
                autocomplete="off"
                required
                ref={textareaRef}
                disabled={snapshot().isTurnActive}
                onInput={adjustTextareaHeight}
                onKeyDown={onTextareaKeyDown}
              />
            </div>

            <div class="composer-controls">
              <div class="composer-action-stack">
                <button
                  class="icon-button primary"
                  type="submit"
                  aria-label="Start turn"
                  title="Start turn"
                  hidden={snapshot().isTurnActive}
                >
                  <svg class="icon icon-send" viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M4.5 3.75l15 8.25-15 8.25 3-8.25-3-8.25z" stroke="currentColor" fill="none" stroke-linejoin="round" />
                    <path d="M7.5 11.75l12-.75" stroke="currentColor" stroke-linecap="round" />
                  </svg>
                  <span class="visually-hidden">Start turn</span>
                </button>
                <button
                  type="button"
                  class="icon-button ghost"
                  hidden={!snapshot().isTurnActive}
                  aria-label="Interrupt turn"
                  title="Interrupt turn"
                  onClick={() => void controller.interruptActiveTurn()}
                >
                  <svg class="icon icon-cancel" viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M8 8l8 8" stroke="currentColor" />
                    <path d="M16 8l-8 8" stroke="currentColor" />
                  </svg>
                  <span class="visually-hidden">Interrupt turn</span>
                </button>
              </div>
            </div>
          </div>
        </form>
      </section>
    </main>
  );
}

function ThreadItemView(props: { item: ThreadItem; onModeChange: (segmentId: string, mode: DisplayMode) => void }) {
  return (
    <article
      class="message"
      data-role={ITEM_TYPE_REGISTRY[props.item.itemType].role}
      data-item-type={props.item.itemType}
      data-id={props.item.id}
      data-status={props.item.status ?? undefined}
    >
      <header class="message-role">{props.item.label || ITEM_TYPE_REGISTRY[props.item.itemType].label}</header>

      <Show
        when={props.item.itemType === "agentMessage"}
        fallback={<p class="message-body">{props.item.status === "error" ? props.item.error ?? "Operation failed." : props.item.content}</p>}
      >
        <Show
          when={(props.item.outputSegments ?? []).length > 0}
          fallback={
            <p class={`message-body ${props.item.status === "pending" ? "" : "empty-output"}`}>
              {props.item.status === "pending"
                ? "Running turn..."
                : props.item.status === "error"
                ? props.item.error ?? "Operation failed."
                : EMPTY_AGENT_OUTPUT}
            </p>
          }
        >
          <For each={props.item.outputSegments ?? []}>
            {(segment) => <OutputSegmentView segment={segment} onModeChange={(mode) => props.onModeChange(segment.id, mode)} />}
          </For>
        </Show>
      </Show>

      <Show when={Boolean(props.item.status)}>
        <footer class="message-meta">
          <span class={`message-badge ${props.item.status}`}>{props.item.status === "pending" ? "Pending" : "Error"}</span>
        </footer>
      </Show>
    </article>
  );
}

function OutputSegmentView(props: { segment: OutputSegment; onModeChange: (mode: DisplayMode) => void }) {
  if (props.segment.kind === "text") {
    return (
      <section class="segment segment-text">
        <p class="message-body">{props.segment.text}</p>
      </section>
    );
  }

  const mode: DisplayMode = props.segment.displayMode ?? "compact";

  const debugPayload = {
    itemType: props.segment.itemType ?? "unknown",
    status: props.segment.status ?? "pending",
    error: props.segment.error,
    text: props.segment.text,
    details: props.segment.details ?? {},
    raw: props.segment.raw ?? {},
  };

  return (
    <section class="segment segment-subblock" data-sub-type={props.segment.itemType ?? "unknown"}>
      <div class="segment-subblock-header">
        <span class="segment-subblock-label">{props.segment.title ?? ITEM_TYPE_REGISTRY[props.segment.itemType ?? "unknown"].label}</span>
        <div class="segment-subblock-right">
          <div class="segment-subblock-display" role="group" aria-label="Subblock Display Mode">
            <For each={["compact", "full", "debug"] as const}>
              {(nextMode) => (
                <button
                  type="button"
                  class="segment-subblock-display-btn"
                  data-active={nextMode === mode ? "true" : "false"}
                  aria-pressed={nextMode === mode}
                  onClick={() => props.onModeChange(nextMode)}
                >
                  {nextMode}
                </button>
              )}
            </For>
          </div>
          <span class="segment-subblock-status">{props.segment.status ?? "pending"}</span>
        </div>
      </div>

      <Show
        when={mode !== "debug"}
        fallback={<pre class="subblock-longtext segment-subblock-content-json">{formatJson(debugPayload) ?? EMPTY_SUBBLOCK_OUTPUT}</pre>}
      >
        <SubBlockContent segment={props.segment} mode={mode} />
      </Show>
    </section>
  );
}

function SubBlockContent(props: { segment: OutputSegment; mode: DisplayMode }) {
  const details = props.segment.details ?? {};
  const fallbackText = props.segment.status === "error" ? props.segment.error ?? "" : props.segment.text;

  if (props.mode === "compact") {
    if (props.segment.itemType === "commandExecution") {
      return <KvOrFallback entries={[{ label: "command", value: details.command }, { label: "exit code", value: details.exitCode }, { label: "duration", value: details.durationMs ? `${details.durationMs}ms` : undefined }]} fallbackText={fallbackText} />;
    }
    if (props.segment.itemType === "fileChange") {
      return <KvOrFallback entries={[{ label: "changes", value: details.changeCount }]} fallbackText={fallbackText} />;
    }
    if (props.segment.itemType === "mcpToolCall") {
      return <KvOrFallback entries={[{ label: "duration", value: details.durationMs ? `${details.durationMs}ms` : undefined }, { label: "error", value: details.error }]} fallbackText={fallbackText} />;
    }
    return (
      <div class="segment-subblock-content-card">
        <pre class="subblock-longtext">{fallbackText || EMPTY_SUBBLOCK_OUTPUT}</pre>
      </div>
    );
  }

  const sections: Array<{ title: string; content: string }> = [];
  if (props.segment.itemType === "commandExecution") {
    const rows = kvEntries([
      { label: "command", value: details.command },
      { label: "cwd", value: details.cwd },
      { label: "exit code", value: details.exitCode },
      { label: "duration", value: details.durationMs ? `${details.durationMs}ms` : undefined },
    ]);
    if (rows.length > 0) sections.push({ title: "Execution", content: rows.map((row) => `${row.label}: ${row.value}`).join("\n") });
    const outputText = formatValue(details.output) ?? fallbackText ?? EMPTY_SUBBLOCK_OUTPUT;
    if (outputText) {
      sections.push({ title: "Output", content: outputText });
    }
  } else if (props.segment.itemType === "fileChange") {
    const rows = kvEntries([{ label: "changes", value: details.changeCount }]);
    if (rows.length > 0) sections.push({ title: "Summary", content: rows.map((row) => `${row.label}: ${row.value}`).join("\n") });
    const diffText = formatValue(details.diff) ?? fallbackText;
    if (diffText) sections.push({ title: "Diff", content: diffText });
  } else if (props.segment.itemType === "mcpToolCall") {
    const rows = kvEntries([
      { label: "duration", value: details.durationMs ? `${details.durationMs}ms` : undefined },
      { label: "error", value: details.error },
      { label: "op", value: details.opName },
      { label: "name", value: details.displayName },
    ]);
    if (rows.length > 0) sections.push({ title: "Call", content: rows.map((row) => `${row.label}: ${row.value}`).join("\n") });
    const structured = formatJson(details.structuredContent);
    if (structured) {
      sections.push({ title: "Structured Content", content: structured });
    } else if (fallbackText) {
      sections.push({ title: "Details", content: fallbackText });
    }
  } else {
    sections.push({ title: "Details", content: fallbackText || EMPTY_SUBBLOCK_OUTPUT });
  }

  return (
    <div class="segment-subblock-content-card">
      <For each={sections}>
        {(section) => (
          <section class="subblock-section">
            <h4 class="subblock-section-title">{section.title}</h4>
            <pre class="subblock-longtext">{section.content}</pre>
          </section>
        )}
      </For>
    </div>
  );
}

function KvOrFallback(props: { entries: KvEntry[]; fallbackText: string }) {
  const rows = createMemo(() => kvEntries(props.entries));
  return (
    <div class="segment-subblock-content-card">
      <Show
        when={rows().length > 0}
        fallback={<pre class="subblock-longtext">{props.fallbackText || EMPTY_SUBBLOCK_OUTPUT}</pre>}
      >
        <div class="subblock-kv-grid">
          <For each={rows()}>
            {(row) => (
              <div class="subblock-kv-row">
                <span class="subblock-kv-key">{row.label}</span>
                <span class="subblock-kv-value">{row.value}</span>
              </div>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}

function approvalTitle(request: PendingApprovalRequest): string {
  if (request.kind === "command") return "Command Approval";
  if (request.kind === "fileChange") return "File Change Approval";
  if (request.kind === "dynamicToolCall") return "Tool Call Response";
  if (request.kind === "chatgptAuthRefresh") return "ChatGPT Token Refresh";
  if (request.kind === "legacyExecApproval") return "Legacy Exec Approval";
  if (request.kind === "legacyPatchApproval") return "Legacy Patch Approval";
  return "User Input Required";
}

function ApprovalCard(props: {
  request: PendingApprovalRequest;
  onCommand: (requestId: string, decision: string) => void;
  onFileChange: (requestId: string, decision: string) => void;
  onToolInput: (requestId: string, answers: Record<string, { answers: string[] }>) => void;
  onToolCall: (requestId: string, success: boolean, contentText: string) => void;
  onChatgptAuthRefresh: (
    requestId: string,
    accessToken: string,
    chatgptAccountId: string,
    chatgptPlanType: string | null,
  ) => void;
  onApplyPatchApproval: (requestId: string, decision: string) => void;
  onExecCommandApproval: (requestId: string, decision: string) => void;
}) {
  const submitToolInput = (event: SubmitEvent, request: PendingToolUserInputRequest) => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const answers: Record<string, { answers: string[] }> = {};

    for (const question of request.questions) {
      const selected = form.elements.namedItem(`q:${question.id}`);
      const other = form.elements.namedItem(`other:${question.id}`);
      const values: string[] = [];
      if (selected instanceof HTMLSelectElement && selected.value) values.push(selected.value);
      if (other instanceof HTMLInputElement && other.value.trim()) values.push(other.value.trim());
      if (values.length > 0) {
        answers[question.id] = { answers: values };
      }
    }

    props.onToolInput(request.requestId, answers);
  };

  const submitToolCall = (event: SubmitEvent, request: PendingDynamicToolCallRequest) => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const successInput = form.elements.namedItem("tool-call-success");
    const textInput = form.elements.namedItem("tool-call-text");
    const success = successInput instanceof HTMLInputElement ? successInput.checked : true;
    const text = textInput instanceof HTMLTextAreaElement ? textInput.value : "";
    props.onToolCall(request.requestId, success, text);
  };

  const submitAuthRefresh = (event: SubmitEvent, request: PendingChatgptAuthRefreshRequest) => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const accessToken = form.elements.namedItem("chatgpt-access-token");
    const accountId = form.elements.namedItem("chatgpt-account-id");
    const planType = form.elements.namedItem("chatgpt-plan-type");
    const nextAccessToken = accessToken instanceof HTMLInputElement ? accessToken.value.trim() : "";
    const nextAccountId = accountId instanceof HTMLInputElement ? accountId.value.trim() : "";
    const nextPlanTypeRaw = planType instanceof HTMLInputElement ? planType.value.trim() : "";
    if (!nextAccessToken || !nextAccountId) return;
    props.onChatgptAuthRefresh(
      request.requestId,
      nextAccessToken,
      nextAccountId,
      nextPlanTypeRaw || null,
    );
  };

  return (
    <article class="approval-card" data-kind={props.request.kind} data-request-id={props.request.requestId}>
      <header class="approval-header">
        <h3>{approvalTitle(props.request)}</h3>
        <span class="approval-status">{props.request.submitting ? "Submitting..." : "Awaiting decision"}</span>
      </header>

      <div class="approval-meta">
        <div class="approval-meta-row">
          <span class="approval-meta-key">Request ID</span>
          <span class="approval-meta-value">{props.request.requestId}</span>
        </div>
        <div class="approval-meta-row">
          <span class="approval-meta-key">Turn</span>
          <span class="approval-meta-value">{props.request.turnId}</span>
        </div>
        <Show when={Boolean(props.request.reason)}>
          <div class="approval-meta-row">
            <span class="approval-meta-key">Reason</span>
            <span class="approval-meta-value">{props.request.reason}</span>
          </div>
        </Show>
      </div>

      <Show when={props.request.kind === "command"}>
        <Show when={props.request.kind === "command" && props.request.command}>
          <pre class="approval-command">{props.request.kind === "command" ? props.request.command : ""}</pre>
        </Show>
        <Show when={props.request.kind === "command" && props.request.cwd}>
          <p class="approval-note">cwd: {props.request.kind === "command" ? props.request.cwd : ""}</p>
        </Show>
        <div class="approval-actions">
          <For each={["accept", "acceptForSession", "decline", "cancel"]}>
            {(decision) => (
              <button
                type="button"
                class={`approval-action-btn ${decision.startsWith("accept") ? "allow" : decision === "decline" ? "deny" : ""}`.trim()}
                disabled={props.request.submitting}
                onClick={() => props.onCommand(props.request.requestId, decision)}
              >
                {decision === "accept" ? "Allow Once" : decision === "acceptForSession" ? "Allow Session" : decision === "decline" ? "Deny" : "Cancel"}
              </button>
            )}
          </For>
        </div>
      </Show>

      <Show when={props.request.kind === "fileChange"}>
        <Show when={props.request.kind === "fileChange" && props.request.grantRoot}>
          <p class="approval-note">grant root requested: {props.request.kind === "fileChange" ? props.request.grantRoot : ""}</p>
        </Show>
        <div class="approval-actions">
          <For each={["accept", "acceptForSession", "decline", "cancel"]}>
            {(decision) => (
              <button
                type="button"
                class={`approval-action-btn ${decision.startsWith("accept") ? "allow" : decision === "decline" ? "deny" : ""}`.trim()}
                disabled={props.request.submitting}
                onClick={() => props.onFileChange(props.request.requestId, decision)}
              >
                {decision === "accept" ? "Allow Once" : decision === "acceptForSession" ? "Allow Session" : decision === "decline" ? "Deny" : "Cancel"}
              </button>
            )}
          </For>
        </div>
      </Show>

      <Show when={props.request.kind === "toolUserInput"}>
        <Show when={props.request.kind === "toolUserInput"}>
          {(request) => (
            <form class="tool-input-form" onSubmit={(event) => submitToolInput(event as SubmitEvent, request())}>
              <For each={request().questions}>
                {(question) => (
                  <fieldset class="tool-input-question" disabled={request().submitting}>
                    <legend>{question.header || question.question}</legend>
                    <Show when={question.header && question.header !== question.question}>
                      <p class="tool-input-prompt">{question.question}</p>
                    </Show>
                    <Show when={question.options.length > 0}>
                      <select name={`q:${question.id}`} required={!question.isOther}>
                        <option value="" selected disabled>
                          Choose an option
                        </option>
                        <For each={question.options}>
                          {(option) => (
                            <option value={option.label}>
                              {option.description ? `${option.label} - ${option.description}` : option.label}
                            </option>
                          )}
                        </For>
                      </select>
                    </Show>
                    <Show when={question.isOther}>
                      <input
                        type={question.isSecret ? "password" : "text"}
                        name={`other:${question.id}`}
                        placeholder="Other"
                        autocomplete="off"
                        required={question.options.length === 0}
                      />
                    </Show>
                  </fieldset>
                )}
              </For>

              <button type="submit" class="approval-action-btn allow" disabled={request().submitting}>
                {request().submitting ? "Submitting..." : "Submit Answers"}
              </button>
            </form>
          )}
        </Show>
      </Show>

      <Show when={props.request.kind === "dynamicToolCall"}>
        <Show when={props.request.kind === "dynamicToolCall"}>
          {(request) => (
            <form class="tool-input-form" onSubmit={(event) => submitToolCall(event as SubmitEvent, request())}>
              <p class="approval-note">tool: {request().tool}</p>
              <pre class="approval-command">{formatJson(request().arguments) ?? "{}"}</pre>
              <label>
                <input type="checkbox" name="tool-call-success" checked />
                success
              </label>
              <textarea
                name="tool-call-text"
                placeholder="Tool response text (optional)"
                rows={3}
                disabled={request().submitting}
              />
              <button type="submit" class="approval-action-btn allow" disabled={request().submitting}>
                {request().submitting ? "Submitting..." : "Submit Tool Response"}
              </button>
            </form>
          )}
        </Show>
      </Show>

      <Show when={props.request.kind === "chatgptAuthRefresh"}>
        <Show when={props.request.kind === "chatgptAuthRefresh"}>
          {(request) => (
            <form class="tool-input-form" onSubmit={(event) => submitAuthRefresh(event as SubmitEvent, request())}>
              <p class="approval-note">reason: {request().refreshReason}</p>
              <Show when={request().previousAccountId}>
                <p class="approval-note">previous account: {request().previousAccountId}</p>
              </Show>
              <input
                type="password"
                name="chatgpt-access-token"
                placeholder="Access token"
                autocomplete="off"
                required
                disabled={request().submitting}
              />
              <input
                type="text"
                name="chatgpt-account-id"
                placeholder="ChatGPT account ID"
                autocomplete="off"
                required
                disabled={request().submitting}
              />
              <input
                type="text"
                name="chatgpt-plan-type"
                placeholder="Plan type (optional)"
                autocomplete="off"
                disabled={request().submitting}
              />
              <button type="submit" class="approval-action-btn allow" disabled={request().submitting}>
                {request().submitting ? "Submitting..." : "Submit Tokens"}
              </button>
            </form>
          )}
        </Show>
      </Show>

      <Show when={props.request.kind === "legacyExecApproval"}>
        <Show when={props.request.kind === "legacyExecApproval"}>
          {(request) => (
            <>
              <Show when={request().command.length > 0}>
                <pre class="approval-command">{request().command.join(" ")}</pre>
              </Show>
              <Show when={request().cwd}>
                <p class="approval-note">cwd: {request().cwd}</p>
              </Show>
              <div class="approval-actions">
                <For each={["approved", "approved_for_session", "denied", "abort"]}>
                  {(decision) => (
                    <button
                      type="button"
                      class={`approval-action-btn ${decision.startsWith("approved") ? "allow" : decision === "denied" ? "deny" : ""}`.trim()}
                      disabled={request().submitting}
                      onClick={() => props.onExecCommandApproval(request().requestId, decision)}
                    >
                      {decision === "approved"
                        ? "Approve Once"
                        : decision === "approved_for_session"
                        ? "Approve Session"
                        : decision === "denied"
                        ? "Deny"
                        : "Abort"}
                    </button>
                  )}
                </For>
              </div>
            </>
          )}
        </Show>
      </Show>

      <Show when={props.request.kind === "legacyPatchApproval"}>
        <Show when={props.request.kind === "legacyPatchApproval"}>
          {(request) => (
            <>
              <p class="approval-note">file changes: {request().fileChangeCount}</p>
              <Show when={request().grantRoot}>
                <p class="approval-note">grant root requested: {request().grantRoot}</p>
              </Show>
              <div class="approval-actions">
                <For each={["approved", "approved_for_session", "denied", "abort"]}>
                  {(decision) => (
                    <button
                      type="button"
                      class={`approval-action-btn ${decision.startsWith("approved") ? "allow" : decision === "denied" ? "deny" : ""}`.trim()}
                      disabled={request().submitting}
                      onClick={() => props.onApplyPatchApproval(request().requestId, decision)}
                    >
                      {decision === "approved"
                        ? "Approve Once"
                        : decision === "approved_for_session"
                        ? "Approve Session"
                        : decision === "denied"
                        ? "Deny"
                        : "Abort"}
                    </button>
                  )}
                </For>
              </div>
            </>
          )}
        </Show>
      </Show>

      <Show when={Boolean(props.request.error)}>
        <p class="approval-error">{props.request.error}</p>
      </Show>
    </article>
  );
}

const root = document.getElementById("root");
if (!root) {
  throw new Error("Missing #root element");
}

render(() => <App />, root);
