import { connectEventStream, interruptTurn, startThread, startTurn } from "../services/app_server_client.js";
import { createThreadItem, state } from "./state.js";
import { setComposerDisabled, setStatus, ui, adjustTextareaHeight, resetTextareaHeight } from "../ui/dom.js";
import { renderItems } from "../ui/render.js";
import type { BridgeEvent, ThreadItem } from "./types.js";

let interruptFallbackTimer: number | undefined;

function syncView(): void {
  renderItems(state);
}

function appendItem(item: ThreadItem): void {
  state.items.push(item);
  syncView();
}

function updateItem(item: ThreadItem): void {
  const index = state.items.findIndex((candidate) => candidate.id === item.id);
  if (index >= 0) {
    state.items[index] = item;
  } else {
    state.items.push(item);
  }
  syncView();
}

function appendToActiveAgentOutput(text: string): void {
  if (!text) return;

  if (!state.activeAgentItemId) {
    const agentItem = createThreadItem("agent_output", "Agent Output", "");
    agentItem.status = "pending";
    appendItem(agentItem);
    state.activeAgentItemId = agentItem.id;
  }

  const index = state.items.findIndex((item) => item.id === state.activeAgentItemId);
  if (index < 0) return;

  const current = state.items[index];
  const next: ThreadItem = {
    ...current,
    content: `${current.content}${text}`,
  };
  updateItem(next);
}

function completeActiveTurn(): void {
  if (interruptFallbackTimer) {
    window.clearTimeout(interruptFallbackTimer);
    interruptFallbackTimer = undefined;
  }

  state.isTurnActive = false;
  state.activeTurnId = null;
  setComposerDisabled(false);

  if (state.activeAgentItemId) {
    const index = state.items.findIndex((item) => item.id === state.activeAgentItemId);
    if (index >= 0) {
      const current = state.items[index];
      const next: ThreadItem = {
        ...current,
        status: undefined,
        content: current.content,
      };
      updateItem(next);
    }
  }

  state.activeAgentItemId = null;
}

function failActiveTurn(message: string): void {
  if (interruptFallbackTimer) {
    window.clearTimeout(interruptFallbackTimer);
    interruptFallbackTimer = undefined;
  }

  state.isTurnActive = false;
  state.activeTurnId = null;
  setComposerDisabled(false);
  setStatus(message, "error");

  if (!state.activeAgentItemId) return;

  const index = state.items.findIndex((item) => item.id === state.activeAgentItemId);
  if (index < 0) return;

  const current = state.items[index];
  const next: ThreadItem = {
    ...current,
    status: "error",
    error: message,
  };
  updateItem(next);
  state.activeAgentItemId = null;
}

function parseTurnDeltaText(params: unknown): string {
  if (typeof params !== "object" || !params) return "";
  const record = params as Record<string, unknown>;

  if (typeof record.delta === "string") return record.delta;
  if (typeof record.text === "string") return record.text;
  if (typeof record.chunk === "string") return record.chunk;

  const item = record.item;
  if (typeof item === "object" && item) {
    const itemRecord = item as Record<string, unknown>;
    if (typeof itemRecord.delta === "string") return itemRecord.delta;
    if (typeof itemRecord.text === "string") return itemRecord.text;
  }

  return "";
}

function handleNotification(method: string, params: unknown): void {
  if (method.includes("delta")) {
    const deltaText = parseTurnDeltaText(params);
    if (deltaText) {
      appendToActiveAgentOutput(deltaText);
    }
    return;
  }

  if (method.endsWith("turn/completed") || method === "turn/completed") {
    completeActiveTurn();
    setStatus("Turn completed");
    return;
  }

  if (
    method.includes("turn/interrupted")
    || method.includes("turn/cancel")
    || method.endsWith("turn/stopped")
  ) {
    completeActiveTurn();
    setStatus("Turn interrupted");
    return;
  }

  if (method.includes("turn/error") || method.endsWith("turn/errored") || method === "turn/errored") {
    failActiveTurn("Turn failed.");
    return;
  }
}

function handleBridgeEvent(event: BridgeEvent): void {
  if (event.type === "error") {
    failActiveTurn(event.message ?? "Bridge error");
    return;
  }

  if (event.type === "ready") {
    setStatus("App server ready");
    return;
  }

  if (event.type === "thread_started") {
    state.threadId = event.threadId ?? null;
    setStatus(state.threadId ? `Thread ready (${state.threadId})` : "Thread ready");
    syncView();
    return;
  }

  if (event.type === "turn_started") {
    state.activeTurnId = event.turnId ?? null;
    state.isTurnActive = true;
    setStatus("Turn started", "pending");
    return;
  }

  if (event.type === "notification" && event.method) {
    handleNotification(event.method, event.params);
  }
}

async function ensureThread(): Promise<void> {
  if (state.threadId) return;
  const response = await startThread();
  state.threadId = response.threadId;
  setStatus(`Thread ready (${state.threadId})`);
  syncView();
}

async function handleSubmit(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  if (state.isTurnActive) return;

  const input = ui.textarea.value.trim();
  if (!input) return;

  await ensureThread();

  appendItem(createThreadItem("user_input", "User Input", input));
  const output = createThreadItem("agent_output", "Agent Output", "");
  output.status = "pending";
  appendItem(output);
  state.activeAgentItemId = output.id;
  state.isTurnActive = true;
  setComposerDisabled(true);
  setStatus("Starting turn…", "pending");

  ui.textarea.value = "";
  resetTextareaHeight();

  try {
    const response = await startTurn(input);
    state.activeTurnId = response.turnId ?? null;
  } catch (error) {
    failActiveTurn(error instanceof Error ? error.message : "Failed to start turn");
  }
}

async function handleInterrupt(): Promise<void> {
  if (!state.isTurnActive) return;

  try {
    await interruptTurn(state.activeTurnId);
    setStatus("Interrupt requested");
    if (interruptFallbackTimer) {
      window.clearTimeout(interruptFallbackTimer);
    }
    interruptFallbackTimer = window.setTimeout(() => {
      if (!state.isTurnActive) return;
      completeActiveTurn();
      setStatus("Turn interrupted");
    }, 1200);
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Interrupt failed", "error");
  }
}

async function handleNewThread(): Promise<void> {
  state.activeTurnId = null;
  state.activeAgentItemId = null;
  state.isTurnActive = false;
  state.items = [];
  setComposerDisabled(false);
  syncView();

  try {
    const response = await startThread();
    state.threadId = response.threadId;
    setStatus(`Thread ready (${state.threadId})`);
    syncView();
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Failed to start thread", "error");
  }
}

function attachEventListeners(): void {
  ui.composerForm.addEventListener("submit", (event) => {
    void handleSubmit(event as SubmitEvent);
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

  ui.interruptButton.addEventListener("click", () => {
    void handleInterrupt();
  });

  ui.newThreadButton.addEventListener("click", () => {
    void handleNewThread();
  });
}

function connectBridgeEventStream(): void {
  state.eventSource = connectEventStream(
    handleBridgeEvent,
    () => {
      setStatus("Event stream disconnected", "error");
    },
  );
}

export function setupApp(): void {
  syncView();
  attachEventListeners();
  connectBridgeEventStream();
  resetTextareaHeight();
  ui.textarea.focus();
}
