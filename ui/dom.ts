type Elements = {
  messageList: HTMLElement | null;
  composerForm: HTMLFormElement | null;
  textarea: HTMLTextAreaElement | null;
  sendButton: HTMLButtonElement | null;
  statusPill: HTMLSpanElement | null;
  statusText: HTMLSpanElement | null;
  cancelButton: HTMLButtonElement | null;
  newChatButton: HTMLButtonElement | null;
  exportButton: HTMLButtonElement | null;
  confirmDialog: HTMLDialogElement | null;
  confirmOkButton: HTMLButtonElement | null;
  confirmCancelButton: HTMLButtonElement | null;
  confirmTitle: HTMLElement | null;
  confirmDescription: HTMLElement | null;
  systemPromptButton: HTMLButtonElement | null;
  systemPromptDialog: HTMLDialogElement | null;
  systemPromptContent: HTMLElement | null;
  systemPromptCloseFooterButton: HTMLButtonElement | null;
};

type ResolvedElements = {
  [K in keyof Elements]-?: NonNullable<Elements[K]>;
};

export type StatusVariant = "default" | "pending" | "error";

const TEXTAREA_MIN_HEIGHT = 96;
const TEXTAREA_MAX_HEIGHT = 192;

const elements: Elements = {
  messageList: document.querySelector<HTMLElement>("#message-list"),
  composerForm: document.querySelector<HTMLFormElement>("#composer-form"),
  textarea: document.querySelector<HTMLTextAreaElement>("#composer-textarea"),
  sendButton: document.querySelector<HTMLButtonElement>("#send-btn"),
  statusPill: document.querySelector<HTMLSpanElement>("#status-pill"),
  statusText: document.querySelector<HTMLSpanElement>("#status-text"),
  cancelButton: document.querySelector<HTMLButtonElement>("#cancel-request-btn"),
  newChatButton: document.querySelector<HTMLButtonElement>("#new-agent-btn"),
  exportButton: document.querySelector<HTMLButtonElement>("#export-agent-btn"),
  confirmDialog: document.querySelector<HTMLDialogElement>("#confirm-dialog"),
  confirmOkButton: document.querySelector<HTMLButtonElement>("#confirm-ok-btn"),
  confirmCancelButton: document.querySelector<HTMLButtonElement>("#confirm-cancel-btn"),
  confirmTitle: document.querySelector<HTMLElement>("#confirm-title"),
  confirmDescription: document.querySelector<HTMLElement>("#confirm-description"),
  systemPromptButton: document.querySelector<HTMLButtonElement>("#system-prompt-btn"),
  systemPromptDialog: document.querySelector<HTMLDialogElement>("#system-prompt-dialog"),
  systemPromptContent: document.querySelector<HTMLElement>("#system-prompt-content"),
  systemPromptCloseFooterButton: document.querySelector<HTMLButtonElement>("#system-prompt-close-btn-footer"),
};

function resolveElements(source: Elements): ResolvedElements {
  if (!source.messageList) throw new Error("Missing DOM element: messageList");
  if (!source.composerForm) throw new Error("Missing DOM element: composerForm");
  if (!source.textarea) throw new Error("Missing DOM element: textarea");
  if (!source.sendButton) throw new Error("Missing DOM element: sendButton");
  if (!source.statusPill) throw new Error("Missing DOM element: statusPill");
  if (!source.statusText) throw new Error("Missing DOM element: statusText");
  if (!source.cancelButton) throw new Error("Missing DOM element: cancelButton");
  if (!source.newChatButton) throw new Error("Missing DOM element: newChatButton");
  if (!source.exportButton) throw new Error("Missing DOM element: exportButton");
  if (!source.confirmDialog) throw new Error("Missing DOM element: confirmDialog");
  if (!source.confirmOkButton) throw new Error("Missing DOM element: confirmOkButton");
  if (!source.confirmCancelButton) throw new Error("Missing DOM element: confirmCancelButton");
  if (!source.confirmTitle) throw new Error("Missing DOM element: confirmTitle");
  if (!source.confirmDescription) throw new Error("Missing DOM element: confirmDescription");
  if (!source.systemPromptButton) throw new Error("Missing DOM element: systemPromptButton");
  if (!source.systemPromptDialog) throw new Error("Missing DOM element: systemPromptDialog");
  if (!source.systemPromptContent) throw new Error("Missing DOM element: systemPromptContent");
  if (!source.systemPromptCloseFooterButton) {
    throw new Error("Missing DOM element: systemPromptCloseFooterButton");
  }
  return source as ResolvedElements;
}

export const ui = resolveElements(elements);

export function setComposerDisabled(disabled: boolean): void {
  ui.textarea.disabled = disabled;
  ui.sendButton.hidden = disabled;
  ui.cancelButton.hidden = !disabled;
  ui.cancelButton.disabled = !disabled;
}

export function setStatus(text: string, variant: StatusVariant = "default"): void {
  ui.statusText.textContent = text;
  ui.statusPill.dataset.state = variant;
  ui.statusPill.setAttribute("title", text);
  ui.statusPill.setAttribute("aria-label", text);
}

export function adjustTextareaHeight(): void {
  const textarea = ui.textarea;
  textarea.style.height = "auto";
  const next = Math.min(textarea.scrollHeight, TEXTAREA_MAX_HEIGHT);
  textarea.style.height = `${Math.max(next, TEXTAREA_MIN_HEIGHT)}px`;
  textarea.style.overflowY = next >= TEXTAREA_MAX_HEIGHT ? "auto" : "hidden";
}

export function resetTextareaHeight(): void {
  ui.textarea.style.height = `${TEXTAREA_MIN_HEIGHT}px`;
  ui.textarea.style.overflowY = "hidden";
}
