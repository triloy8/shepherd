import { sendChatCompletion } from "../services/api.js";
import { getSystemPrompt } from "./config.js";
import { confirmAction, syncSystemPromptUI } from "../ui/dialogs.js";
import { adjustTextareaHeight, resetTextareaHeight, setComposerDisabled, setStatus, ui } from "../ui/dom.js";
import { renderMessages } from "../ui/render.js";
import { createConversationId, createMessage, state } from "./state.js";
import { clearTranscript, loadTranscript, persistTranscript } from "../services/storage.js";
import type { Message } from "./types.js";

function syncView(): void {
  persistTranscript(state);
  renderMessages(state);
}

function addMessage(message: Message): void {
  state.messages.push(message);
  syncView();
}

function upsertMessage(message: Message): void {
  const index = state.messages.findIndex((item) => item.id === message.id);
  if (index === -1) {
    state.messages.push(message);
  } else {
    state.messages[index] = message;
  }
  syncView();
}

async function sendToModel(placeholder: Message): Promise<void> {
  const messagesForRequest = state.messages.filter((message) => message.id !== placeholder.id);

  setComposerDisabled(true);
  setStatus("Thinking…", "pending");
  state.isSending = true;

  const controller = new AbortController();
  state.abortController = controller;

  ui.cancelButton.addEventListener(
    "click",
    () => controller.abort(),
    { once: true },
  );

  try {
    const reply = await sendChatCompletion(messagesForRequest, controller.signal, state.conversationId);
    const assistantMessage: Message = {
      ...placeholder,
      content: reply,
      status: undefined,
    };
    upsertMessage(assistantMessage);
    setStatus("Ready");
  } catch (error) {
    const placeholderExists = state.messages.some((item) => item.id === placeholder.id);
    if (!placeholderExists) {
      setStatus("Ready");
      return;
    }

    if (controller.signal.aborted) {
      const cancelledMessage: Message = {
        ...placeholder,
        content: "",
        status: "error",
        error: "Request cancelled.",
      };
      upsertMessage(cancelledMessage);
      setStatus("Cancelled", "error");
    } else {
      console.error(error);
      const failedMessage: Message = {
        ...placeholder,
        content: "",
        status: "error",
        error: error instanceof Error ? error.message : "Unknown error.",
      };
      upsertMessage(failedMessage);
      setStatus("Error", "error");
    }
  } finally {
    state.isSending = false;
    state.abortController = undefined;
    setComposerDisabled(false);
    ui.textarea.focus();
  }
}

async function handleSubmit(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  if (state.isSending) return;

  const text = ui.textarea.value.trim();
  if (!text) return;

  const userMessage = createMessage("user", text);
  ui.textarea.value = "";
  resetTextareaHeight();
  addMessage(userMessage);

  const assistantPlaceholder: Message = {
    id: createConversationId(),
    role: "assistant",
    content: "",
    createdAt: new Date().toISOString(),
    status: "pending",
  };

  addMessage(assistantPlaceholder);
  await sendToModel(assistantPlaceholder);
}

function resetChat(): void {
  state.abortController?.abort();
  state.abortController = undefined;
  state.messages = [];
  state.conversationId = createConversationId();
  clearTranscript();
  renderMessages(state);
  setStatus("Ready");
  resetTextareaHeight();
}

async function offerTranscriptRestore(): Promise<void> {
  const stored = loadTranscript();
  if (!stored || stored.messages.length === 0) return;

  const shouldRestore = await confirmAction({
    title: "Restore previous chat?",
    description: "A previous conversation was found. Would you like to load it?",
    confirmLabel: "Restore",
  });

  if (shouldRestore) {
    state.conversationId = stored.conversationId ?? createConversationId();
    state.messages = stored.messages;
    renderMessages(state);
    setStatus("Transcript restored");
  } else {
    clearTranscript();
  }
}

async function handleNewChatClick(): Promise<void> {
  if (state.isSending) {
    state.abortController?.abort();
  }

  if (state.messages.length === 0) {
    resetChat();
    return;
  }

  const shouldReset = await confirmAction({
    title: "Start a new chat?",
    description: "This will clear the current conversation.",
    confirmLabel: "Start new chat",
  });

  if (shouldReset) {
    resetChat();
  }
}

async function handleExportClick(): Promise<void> {
  if (state.messages.length === 0) {
    setStatus("Nothing to export", "error");
    return;
  }

  const systemPrompt = getSystemPrompt();
  const payload = {
    conversationId: state.conversationId,
    exportedAt: new Date().toISOString(),
    messages: state.messages,
    ...(systemPrompt ? { systemPrompt } : {}),
  };

  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);

  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `chat-${state.conversationId}.json`;
  anchor.rel = "noopener";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);

  setStatus("Transcript exported");
}

function attachEventListeners(): void {
  ui.composerForm.addEventListener("submit", (event) => {
    void handleSubmit(event as SubmitEvent);
  });

  ui.newChatButton.addEventListener("click", () => {
    void handleNewChatClick();
  });

  ui.exportButton.addEventListener("click", () => {
    void handleExportClick();
  });

  ui.textarea.addEventListener("input", () => {
    adjustTextareaHeight();
  });

  ui.textarea.addEventListener("keydown", (event: KeyboardEvent) => {
    if (event.key !== "Enter") return;
    if (event.shiftKey) return;
    event.preventDefault();
    ui.composerForm.requestSubmit();
  });

  ui.systemPromptButton.addEventListener("click", () => {
    const prompt = getSystemPrompt();
    if (!prompt) return;
    ui.systemPromptContent.textContent = prompt;
    ui.systemPromptDialog.showModal();
  });

  const closePromptDialog = () => {
    if (ui.systemPromptDialog.open) {
      ui.systemPromptDialog.close();
    }
  };

  ui.systemPromptCloseFooterButton.addEventListener("click", closePromptDialog);
  ui.systemPromptDialog.addEventListener("cancel", closePromptDialog);
}

export function setupApp(): void {
  syncSystemPromptUI(getSystemPrompt());
  renderMessages(state);
  attachEventListeners();
  void offerTranscriptRestore();
  resetTextareaHeight();
  ui.textarea.focus();
}
