type Elements = {
  itemList: HTMLElement | null;
  approvalList: HTMLElement | null;
  composerForm: HTMLFormElement | null;
  textarea: HTMLTextAreaElement | null;
  sendButton: HTMLButtonElement | null;
  approvalPolicy: HTMLSelectElement | null;
  statusPill: HTMLSpanElement | null;
  statusText: HTMLSpanElement | null;
  interruptButton: HTMLButtonElement | null;
  newThreadButton: HTMLButtonElement | null;
};

type ResolvedElements = {
  [K in keyof Elements]-?: NonNullable<Elements[K]>;
};

export type StatusVariant = "default" | "pending" | "error";

const TEXTAREA_MIN_HEIGHT = 96;
const TEXTAREA_MAX_HEIGHT = 192;

const elements: Elements = {
  itemList: document.querySelector<HTMLElement>("#item-list"),
  approvalList: document.querySelector<HTMLElement>("#approval-list"),
  composerForm: document.querySelector<HTMLFormElement>("#composer-form"),
  textarea: document.querySelector<HTMLTextAreaElement>("#turn-input"),
  sendButton: document.querySelector<HTMLButtonElement>("#start-turn-btn"),
  approvalPolicy: document.querySelector<HTMLSelectElement>("#approval-policy"),
  statusPill: document.querySelector<HTMLSpanElement>("#status-pill"),
  statusText: document.querySelector<HTMLSpanElement>("#status-text"),
  interruptButton: document.querySelector<HTMLButtonElement>("#interrupt-turn-btn"),
  newThreadButton: document.querySelector<HTMLButtonElement>("#new-thread-btn"),
};

function resolveElements(source: Elements): ResolvedElements {
  if (!source.itemList) throw new Error("Missing DOM element: itemList");
  if (!source.approvalList) throw new Error("Missing DOM element: approvalList");
  if (!source.composerForm) throw new Error("Missing DOM element: composerForm");
  if (!source.textarea) throw new Error("Missing DOM element: textarea");
  if (!source.sendButton) throw new Error("Missing DOM element: sendButton");
  if (!source.approvalPolicy) throw new Error("Missing DOM element: approvalPolicy");
  if (!source.statusPill) throw new Error("Missing DOM element: statusPill");
  if (!source.statusText) throw new Error("Missing DOM element: statusText");
  if (!source.interruptButton) throw new Error("Missing DOM element: interruptButton");
  if (!source.newThreadButton) throw new Error("Missing DOM element: newThreadButton");
  return source as ResolvedElements;
}

export const ui = resolveElements(elements);

export function setComposerDisabled(disabled: boolean): void {
  ui.textarea.disabled = disabled;
  ui.sendButton.hidden = disabled;
  ui.interruptButton.hidden = !disabled;
  ui.interruptButton.disabled = !disabled;
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
