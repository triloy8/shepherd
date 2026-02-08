import { ui } from "./dom.js";
import { ITEM_TYPE_REGISTRY } from "../core/item_registry.js";
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
        content.textContent = "";
      }
      article.append(content);
    } else {
      for (const segment of segments) {
        article.append(buildOutputSegment(segment));
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

function buildOutputSegment(segment: OutputSegment): HTMLElement {
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

    header.append(label, status);
    block.appendChild(header);

    const content = document.createElement("p");
    content.className = "segment-subblock-content";
    if (segment.status === "error") {
      content.textContent = segment.error ?? "Operation failed.";
    } else {
      content.textContent = segment.text || (segment.status === "completed" ? "Completed." : "In progress…");
    }
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
