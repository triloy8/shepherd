import { ui } from "./dom.js";
import type { ChatState, ChatRole, Message } from "../core/types.js";

function updateActionStates(messages: Message[]): void {
  ui.exportButton.disabled = messages.length === 0;
}

function roleTitle(role: ChatRole): string {
  switch (role) {
    case "assistant":
      return "Assistant";
    case "system":
      return "System";
    default:
      return "You";
  }
}

export function renderMessages(state: ChatState): void {
  ui.messageList.innerHTML = "";

  if (state.messages.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.innerHTML = `
      <h2>Start a session</h2>
      <p>Ask a question or describe a task to begin.</p>
    `;
    ui.messageList.appendChild(empty);
    updateActionStates(state.messages);
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const message of state.messages) {
    const article = document.createElement("article");
    article.className = "message";
    article.dataset.role = message.role;
    article.dataset.id = message.id;
    if (message.status) {
      article.dataset.status = message.status;
    }

    if (message.status === "pending") {
      article.setAttribute("aria-busy", "true");
    }

    const roleLabel = document.createElement("header");
    roleLabel.className = "message-role";
    roleLabel.textContent = roleTitle(message.role);

    const content = document.createElement("p");
    content.className = "message-body";

    if (message.status === "pending") {
      content.textContent = "Thinking…";
    } else if (message.status === "error") {
      content.textContent = message.error ?? "Something went wrong.";
    } else {
      content.textContent = message.content;
    }

    article.append(roleLabel, content);

    if (message.status) {
      const meta = document.createElement("footer");
      meta.className = "message-meta";
      const badge = document.createElement("span");
      badge.className = `message-badge ${message.status}`;
      badge.textContent = message.status === "pending" ? "Pending" : "Error";
      meta.appendChild(badge);
      article.append(meta);
    }

    fragment.appendChild(article);
  }

  ui.messageList.appendChild(fragment);
  ui.messageList.scrollTop = ui.messageList.scrollHeight;
  updateActionStates(state.messages);
}
