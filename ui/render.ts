import { ui } from "./dom.js";
import { ITEM_TYPE_REGISTRY } from "../core/item_registry.js";
import type {
  AgentState,
  DisplayMode,
  ThreadItemType,
  PendingApprovalRequest,
  PendingToolUserInputRequest,
  OutputSegment,
  ThreadItem,
} from "../core/types.js";

const EMPTY_AGENT_OUTPUT = "No output available.";
const EMPTY_SUBBLOCK_OUTPUT = "No details available.";

function emptyStateMarkup(threadId: string | null): string {
  const subtitle = threadId
    ? `Thread: ${threadId}`
    : "No thread initialized yet.";
  return `
    <h2>Start a turn</h2>
    <p>${subtitle}</p>
  `;
}

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

function appendLine(lines: string[], label: string, value: unknown): void {
  const formatted = formatValue(value);
  if (!formatted) return;
  lines.push(`${label}: ${formatted}`);
}

type SubBlockFormatter = {
  compact: (segment: OutputSegment) => string | null;
  full: (segment: OutputSegment) => string | null;
};

const SUBBLOCK_FORMATTERS: Partial<Record<ThreadItemType, SubBlockFormatter>> = {
  commandExecution: {
    compact: (segment) => {
      const details = segment.details ?? {};
      const lines: string[] = [];
      appendLine(lines, "command", details.command);
      appendLine(lines, "exit code", details.exitCode);
      appendLine(lines, "duration", details.durationMs !== undefined ? `${details.durationMs}ms` : undefined);
      return lines.length > 0 ? lines.join("\n") : null;
    },
    full: (segment) => {
      const details = segment.details ?? {};
      const lines: string[] = [];
      appendLine(lines, "command", details.command);
      appendLine(lines, "cwd", details.cwd);
      appendLine(lines, "exit code", details.exitCode);
      appendLine(lines, "duration", details.durationMs !== undefined ? `${details.durationMs}ms` : undefined);
      appendLine(lines, "output", details.output);
      return lines.length > 0 ? lines.join("\n") : null;
    },
  },
  fileChange: {
    compact: (segment) => {
      const details = segment.details ?? {};
      const lines: string[] = [];
      appendLine(lines, "changes", details.changeCount);
      return lines.length > 0 ? lines.join("\n") : null;
    },
    full: (segment) => {
      const details = segment.details ?? {};
      const lines: string[] = [];
      appendLine(lines, "changes", details.changeCount);
      appendLine(lines, "diff", details.diff);
      return lines.length > 0 ? lines.join("\n") : null;
    },
  },
  mcpToolCall: {
    compact: (segment) => {
      const details = segment.details ?? {};
      const lines: string[] = [];
      appendLine(lines, "duration", details.durationMs !== undefined ? `${details.durationMs}ms` : undefined);
      if (details.error) appendLine(lines, "error", details.error);
      return lines.length > 0 ? lines.join("\n") : null;
    },
    full: (segment) => {
      const details = segment.details ?? {};
      const lines: string[] = [];
      appendLine(lines, "duration", details.durationMs !== undefined ? `${details.durationMs}ms` : undefined);
      appendLine(lines, "error", details.error);
      appendLine(lines, "structuredContent", details.structuredContent);
      return lines.length > 0 ? lines.join("\n") : null;
    },
  },
  webSearch: {
    compact: (segment) => {
      const details = segment.details ?? {};
      return (typeof details.summary === "string" && details.summary.trim()) ? details.summary : null;
    },
    full: (segment) => {
      const details = segment.details ?? {};
      const lines: string[] = [];
      appendLine(lines, "summary", details.summary);
      return lines.length > 0 ? lines.join("\n") : null;
    },
  },
};

function formatSubBlockContent(segment: OutputSegment, mode: DisplayMode): string {
  if (segment.kind !== "subBlock") return segment.text;
  if (mode === "debug") {
    const debugPayload = {
      itemType: segment.itemType ?? "unknown",
      status: segment.status ?? "pending",
      error: segment.error,
      text: segment.text,
      details: segment.details ?? {},
      raw: segment.raw ?? {},
    };
    return formatJson(debugPayload) ?? EMPTY_SUBBLOCK_OUTPUT;
  }

  if (segment.status === "error" && segment.error?.trim()) {
    return segment.error;
  }

  const formatter = SUBBLOCK_FORMATTERS[segment.itemType ?? "unknown"];
  const specialized = mode === "full" ? formatter?.full(segment) : formatter?.compact(segment);
  if (specialized && specialized.trim()) return specialized;
  if (segment.text.trim()) return segment.text;
  return EMPTY_SUBBLOCK_OUTPUT;
}

function buildItemNode(item: ThreadItem): HTMLElement {
  const article = document.createElement("article");
  article.className = "message";
  article.dataset.role = ITEM_TYPE_REGISTRY[item.itemType].role;
  article.dataset.itemType = item.itemType;
  article.dataset.id = item.id;

  if (item.status) {
    article.dataset.status = item.status;
  }

  const roleLabel = document.createElement("header");
  roleLabel.className = "message-role";
  roleLabel.textContent = item.label || ITEM_TYPE_REGISTRY[item.itemType].label;

  article.append(roleLabel);

  if (item.itemType === "agentMessage") {
    const segments = item.outputSegments ?? [];

    if (segments.length === 0) {
      const content = document.createElement("p");
      content.className = "message-body";
      if (item.status === "pending") {
        content.textContent = "Running turn…";
      } else if (item.status === "error") {
        content.textContent = item.error ?? "Operation failed.";
      } else {
        content.classList.add("empty-output");
        content.setAttribute("aria-label", "No output");
        content.textContent = EMPTY_AGENT_OUTPUT;
      }
      article.append(content);
    } else {
      for (const segment of segments) {
        article.append(buildOutputSegment(item.id, segment));
      }
    }
  } else {
    const content = document.createElement("p");
    content.className = "message-body";
    if (item.status === "pending") {
      content.textContent = item.content || "Running turn…";
    } else if (item.status === "error") {
      content.textContent = item.error ?? "Operation failed.";
    } else {
      content.textContent = item.content;
    }
    article.append(content);
  }

  if (item.status) {
    const meta = document.createElement("footer");
    meta.className = "message-meta";
    const badge = document.createElement("span");
    badge.className = `message-badge ${item.status}`;
    badge.textContent = item.status === "pending" ? "Pending" : "Error";
    meta.appendChild(badge);
    article.append(meta);
  }

  return article;
}

function buildSubBlockDisplayModeControls(itemId: string, segment: OutputSegment): HTMLElement {
  const currentMode: DisplayMode = segment.displayMode ?? "compact";
  const group = document.createElement("div");
  group.className = "segment-subblock-display";
  group.setAttribute("role", "group");
  group.setAttribute("aria-label", "Subblock Display Mode");

  const modes: DisplayMode[] = ["compact", "full", "debug"];
  for (const mode of modes) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "segment-subblock-display-btn";
    button.dataset.itemId = itemId;
    button.dataset.segmentId = segment.id;
    button.dataset.displayMode = mode;
    button.dataset.active = mode === currentMode ? "true" : "false";
    button.setAttribute("aria-pressed", mode === currentMode ? "true" : "false");
    button.textContent = mode;
    group.appendChild(button);
  }

  return group;
}

function buildOutputSegment(itemId: string, segment: OutputSegment): HTMLElement {
  if (segment.kind === "text") {
    const block = document.createElement("section");
    block.className = "segment segment-text";
    const content = document.createElement("p");
    content.className = "message-body";
    content.textContent = segment.text;
    block.appendChild(content);
    return block;
  }

  if (segment.kind === "subBlock") {
    const displayMode: DisplayMode = segment.displayMode ?? "compact";
    const block = document.createElement("section");
    block.className = "segment segment-subblock";
    block.dataset.subType = segment.itemType ?? "unknown";

    const header = document.createElement("div");
    header.className = "segment-subblock-header";

    const label = document.createElement("span");
    label.className = "segment-subblock-label";
    const typeMeta = ITEM_TYPE_REGISTRY[segment.itemType ?? "unknown"];
    label.textContent = segment.title ?? typeMeta.label;

    const status = document.createElement("span");
    status.className = "segment-subblock-status";
    status.textContent = segment.status ?? "pending";

    const right = document.createElement("div");
    right.className = "segment-subblock-right";
    right.append(buildSubBlockDisplayModeControls(itemId, segment), status);

    header.append(label, right);
    block.appendChild(header);

    const content = document.createElement(displayMode === "debug" ? "pre" : "p");
    content.className = "segment-subblock-content";
    if (displayMode === "debug") {
      content.classList.add("segment-subblock-content-json");
    }
    content.textContent = formatSubBlockContent(segment, displayMode);
    block.appendChild(content);

    return block;
  }

  const fallback = document.createElement("section");
  fallback.className = "segment segment-text";
  const content = document.createElement("p");
  content.className = "message-body";
  content.textContent = segment.text;
  fallback.appendChild(content);
  return fallback;
}

export function renderItems(state: AgentState): void {
  const wasNearBottom = ui.itemList.scrollHeight - ui.itemList.scrollTop - ui.itemList.clientHeight < 80;
  ui.itemList.innerHTML = "";

  if (state.items.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.innerHTML = emptyStateMarkup(state.threadId);
    ui.itemList.appendChild(empty);
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const item of state.items) {
    fragment.appendChild(buildItemNode(item));
  }

  ui.itemList.appendChild(fragment);
  if (wasNearBottom) {
    ui.itemList.scrollTop = ui.itemList.scrollHeight;
  }
}

function buildApprovalHeaderLabel(request: PendingApprovalRequest): string {
  if (request.kind === "command") return "Command Approval";
  if (request.kind === "fileChange") return "File Change Approval";
  return "User Input Required";
}

function appendApprovalMetaRow(parent: HTMLElement, label: string, value: string): void {
  const row = document.createElement("div");
  row.className = "approval-meta-row";

  const key = document.createElement("span");
  key.className = "approval-meta-key";
  key.textContent = label;

  const val = document.createElement("span");
  val.className = "approval-meta-value";
  val.textContent = value;

  row.append(key, val);
  parent.appendChild(row);
}

function buildApprovalActions(
  requestId: string,
  actions: Array<{ label: string; value: string; className?: string }>,
  submitting: boolean,
): HTMLElement {
  const block = document.createElement("div");
  block.className = "approval-actions";

  for (const action of actions) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `approval-action-btn ${action.className ?? ""}`.trim();
    button.dataset.requestId = requestId;
    button.dataset.approvalDecision = action.value;
    button.disabled = submitting;
    button.textContent = action.label;
    block.appendChild(button);
  }

  return block;
}

function buildToolInputForm(request: PendingToolUserInputRequest): HTMLElement {
  const form = document.createElement("form");
  form.className = "tool-input-form";
  form.dataset.requestId = request.requestId;

  for (const question of request.questions) {
    const group = document.createElement("fieldset");
    group.className = "tool-input-question";
    group.disabled = request.submitting;

    const legend = document.createElement("legend");
    legend.textContent = question.header || question.question;
    group.appendChild(legend);

    if (question.header && question.question && question.header !== question.question) {
      const prompt = document.createElement("p");
      prompt.className = "tool-input-prompt";
      prompt.textContent = question.question;
      group.appendChild(prompt);
    }

    if (question.options.length > 0) {
      const select = document.createElement("select");
      select.name = `q:${question.id}`;
      select.required = !question.isOther;

      const placeholder = document.createElement("option");
      placeholder.value = "";
      placeholder.textContent = "Choose an option";
      placeholder.disabled = true;
      placeholder.selected = true;
      select.appendChild(placeholder);

      for (const option of question.options) {
        const entry = document.createElement("option");
        entry.value = option.label;
        entry.textContent = option.description
          ? `${option.label} - ${option.description}`
          : option.label;
        select.appendChild(entry);
      }

      group.appendChild(select);
    }

    if (question.isOther) {
      const input = document.createElement("input");
      input.type = question.isSecret ? "password" : "text";
      input.name = `other:${question.id}`;
      input.placeholder = "Other";
      input.autocomplete = "off";
      input.required = question.options.length === 0;
      group.appendChild(input);
    }

    form.appendChild(group);
  }

  const submit = document.createElement("button");
  submit.type = "submit";
  submit.className = "approval-action-btn allow";
  submit.disabled = request.submitting;
  submit.textContent = request.submitting ? "Submitting..." : "Submit Answers";
  form.appendChild(submit);

  return form;
}

function buildApprovalRequestNode(request: PendingApprovalRequest): HTMLElement {
  const card = document.createElement("article");
  card.className = "approval-card";
  card.dataset.kind = request.kind;
  card.dataset.requestId = request.requestId;

  const header = document.createElement("header");
  header.className = "approval-header";

  const title = document.createElement("h3");
  title.textContent = buildApprovalHeaderLabel(request);

  const badge = document.createElement("span");
  badge.className = "approval-status";
  badge.textContent = request.submitting ? "Submitting..." : "Awaiting decision";

  header.append(title, badge);
  card.appendChild(header);

  const meta = document.createElement("div");
  meta.className = "approval-meta";
  appendApprovalMetaRow(meta, "Request ID", request.requestId);
  appendApprovalMetaRow(meta, "Turn", request.turnId);
  if (request.reason) appendApprovalMetaRow(meta, "Reason", request.reason);
  card.appendChild(meta);

  if (request.kind === "command") {
    if (request.command) {
      const command = document.createElement("pre");
      command.className = "approval-command";
      command.textContent = request.command;
      card.appendChild(command);
    }
    if (request.cwd) {
      const cwd = document.createElement("p");
      cwd.className = "approval-note";
      cwd.textContent = `cwd: ${request.cwd}`;
      card.appendChild(cwd);
    }
    if (request.commandActions.length > 0) {
      const actions = document.createElement("p");
      actions.className = "approval-note";
      actions.textContent = `actions: ${request.commandActions.join(", ")}`;
      card.appendChild(actions);
    }
    card.appendChild(
      buildApprovalActions(
        request.requestId,
        [
          { label: "Allow Once", value: "accept", className: "allow" },
          { label: "Allow Session", value: "acceptForSession", className: "allow" },
          { label: "Deny", value: "decline", className: "deny" },
          { label: "Cancel", value: "cancel" },
        ],
        request.submitting,
      ),
    );
  } else if (request.kind === "fileChange") {
    if (request.grantRoot) {
      const root = document.createElement("p");
      root.className = "approval-note";
      root.textContent = `grant root requested: ${request.grantRoot}`;
      card.appendChild(root);
    }
    card.appendChild(
      buildApprovalActions(
        request.requestId,
        [
          { label: "Allow Once", value: "accept", className: "allow" },
          { label: "Allow Session", value: "acceptForSession", className: "allow" },
          { label: "Deny", value: "decline", className: "deny" },
          { label: "Cancel", value: "cancel" },
        ],
        request.submitting,
      ),
    );
  } else {
    card.appendChild(buildToolInputForm(request));
  }

  if (request.error) {
    const error = document.createElement("p");
    error.className = "approval-error";
    error.textContent = request.error;
    card.appendChild(error);
  }

  return card;
}

export function renderApprovals(state: AgentState): void {
  ui.approvalList.innerHTML = "";

  if (state.pendingApprovals.length === 0) {
    ui.approvalList.hidden = true;
    return;
  }

  ui.approvalList.hidden = false;
  const fragment = document.createDocumentFragment();
  for (const request of state.pendingApprovals) {
    fragment.appendChild(buildApprovalRequestNode(request));
  }
  ui.approvalList.appendChild(fragment);
}
