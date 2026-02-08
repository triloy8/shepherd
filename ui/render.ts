import { ui } from "./dom.js";
import type { AgentState, ThreadItem } from "../core/types.js";

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

  const content = document.createElement("p");
  content.className = "message-body";
  if (item.status === "pending") {
    content.textContent = item.content || "Running turn…";
  } else if (item.status === "error") {
    content.textContent = item.error ?? "Operation failed.";
  } else {
    content.textContent = item.content;
    if (item.kind === "agent_output" && !item.content.trim()) {
      content.classList.add("empty-output");
      content.setAttribute("aria-label", "No output");
    }
  }

  article.append(roleLabel, content);

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

export function renderItems(state: AgentState): void {
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
  ui.itemList.scrollTop = ui.itemList.scrollHeight;
}
