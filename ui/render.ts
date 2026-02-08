import { ui } from "./dom.js";
import type { AgentState, OutputSegment, ThreadItem } from "../core/types.js";

function emptyStateMarkup(threadId: string | null): string {
  const subtitle = threadId
    ? `Thread: ${threadId}`
    : "No thread initialized yet.";
  return `
    <h2>Start a turn</h2>
    <p>${subtitle}</p>
  `;
}

function buildItemNode(item: ThreadItem): HTMLElement {
  const article = document.createElement("article");
  article.className = "message";
  article.dataset.role = item.kind === "agent_output" ? "assistant" : item.kind === "user_input" ? "user" : "system";
  article.dataset.id = item.id;

  if (item.status) {
    article.dataset.status = item.status;
  }

  const roleLabel = document.createElement("header");
  roleLabel.className = "message-role";
  roleLabel.textContent = item.label;

  article.append(roleLabel);

  if (item.kind === "agent_output") {
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
        content.textContent = "";
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

  const block = document.createElement("section");
  block.className = "segment segment-reasoning";

  const header = document.createElement("div");
  header.className = "segment-reasoning-header";

  const label = document.createElement("span");
  label.className = "segment-reasoning-label";
  label.textContent = segment.title ? `Reasoning - ${segment.title}` : "Reasoning";

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "reasoning-toggle";
  toggle.dataset.action = "toggle-segment";
  toggle.dataset.itemId = itemId;
  toggle.dataset.segmentId = segment.id;
  const expanded = segment.expanded ?? false;
  toggle.setAttribute("aria-expanded", String(expanded));
  toggle.textContent = expanded ? "Collapse" : "Expand";

  header.append(label, toggle);
  block.appendChild(header);

  const content = document.createElement("p");
  content.className = "segment-reasoning-content";
  const text = segment.text.trim();
  if (expanded || text.length <= 160) {
    content.textContent = text || "Awaiting reasoning summary…";
  } else {
    content.textContent = `${text.slice(0, 160)}…`;
  }
  block.appendChild(content);

  return block;
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
