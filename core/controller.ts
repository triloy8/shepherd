import { connectEventStream, interruptTurn, startThread, startTurn } from "../services/app_server_client.js";
import { createId, createThreadItem, state } from "./state.js";
import { setComposerDisabled, setStatus, ui, adjustTextareaHeight, resetTextareaHeight } from "../ui/dom.js";
import { renderItems } from "../ui/render.js";
import type { BridgeEvent, OutputSegment, ThreadItem } from "./types.js";

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

function findActiveOutputIndex(): number {
  const activeId = state.activeAgentItemId;
  if (!activeId) return -1;
  return state.items.findIndex((item) => item.id === activeId);
}

function appendTextToActiveOutput(delta: string): void {
  if (!delta) return;
  const index = findActiveOutputIndex();
  if (index < 0) return;

  const current = state.items[index];
  const segments = [...(current.outputSegments ?? [])];
  const last = segments[segments.length - 1];

  if (last?.kind === "text") {
    segments[segments.length - 1] = {
      ...last,
      text: `${last.text}${delta}`,
    };
  } else {
    segments.push({
      id: createId("segment"),
      kind: "text",
      text: delta,
      createdAt: new Date().toISOString(),
    });
  }

  const next: ThreadItem = {
    ...current,
    content: `${current.content}${delta}`,
    outputSegments: segments,
  };
  updateItem(next);
}

function appendReasoningSectionToActiveOutput(title: string): void {
  if (!title.trim()) return;
  const index = findActiveOutputIndex();
  if (index < 0) return;

  const current = state.items[index];
  const segments = [...(current.outputSegments ?? [])];
  segments.push({
    id: createId("segment"),
    kind: "reasoning",
    title,
    text: "",
    expanded: false,
    createdAt: new Date().toISOString(),
  });

  const next: ThreadItem = {
    ...current,
    outputSegments: segments,
  };
  updateItem(next);
}

function appendReasoningDeltaToActiveOutput(delta: string): void {
  if (!delta) return;
  const index = findActiveOutputIndex();
  if (index < 0) return;

  const current = state.items[index];
  const segments = [...(current.outputSegments ?? [])];
  const last = segments[segments.length - 1];

  if (last?.kind === "reasoning") {
    segments[segments.length - 1] = {
      ...last,
      text: `${last.text}${delta}`,
    };
  } else {
    segments.push({
      id: createId("segment"),
      kind: "reasoning",
      text: delta,
      expanded: false,
      createdAt: new Date().toISOString(),
    });
  }

  const next: ThreadItem = {
    ...current,
    outputSegments: segments,
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

  const index = findActiveOutputIndex();
  if (index >= 0) {
    const current = state.items[index];
    const next: ThreadItem = {
      ...current,
      status: undefined,
    };
    updateItem(next);
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

  const index = findActiveOutputIndex();
  if (index >= 0) {
    const current = state.items[index];
    const next: ThreadItem = {
      ...current,
      status: "error",
      error: message,
    };
    updateItem(next);
  }

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

  const msg = record.msg;
  if (typeof msg === "object" && msg) {
    const msgRecord = msg as Record<string, unknown>;
    if (typeof msgRecord.delta === "string") return msgRecord.delta;
    if (typeof msgRecord.text === "string") return msgRecord.text;
  }

  return "";
}

function isAgentMessageDeltaMethod(method: string): boolean {
  const normalized = method.toLowerCase();
  return normalized === "item/agentmessage/delta" || normalized.includes("item/agentmessage/delta");
}

function isReasoningSummaryTextMethod(method: string): boolean {
  const normalized = method.toLowerCase();
  return normalized.includes("reasoning/summarytextdelta") || normalized.endsWith("reasoning_summary_text_delta");
}

function isReasoningSummaryPartMethod(method: string): boolean {
  const normalized = method.toLowerCase();
  return normalized.includes("reasoning/summarypartadded") || normalized.endsWith("reasoning_summary_part_added");
}

function parseReasoningSummaryTextDelta(params: unknown): string | undefined {
  if (typeof params !== "object" || !params) return undefined;
  const record = params as Record<string, unknown>;

  if (typeof record.summaryTextDelta === "string") return record.summaryTextDelta;
  if (typeof record.summary_text_delta === "string") return record.summary_text_delta;
  if (typeof record.delta === "string") return record.delta;
  if (typeof record.text === "string") return record.text;

  const msg = record.msg;
  if (typeof msg === "object" && msg) {
    const msgRecord = msg as Record<string, unknown>;
    if (typeof msgRecord.summaryTextDelta === "string") return msgRecord.summaryTextDelta;
    if (typeof msgRecord.summary_text_delta === "string") return msgRecord.summary_text_delta;
    if (typeof msgRecord.delta === "string") return msgRecord.delta;
    if (typeof msgRecord.text === "string") return msgRecord.text;
  }
  return undefined;
}

function parseReasoningSummaryPartAdded(params: unknown): string | undefined {
  if (typeof params !== "object" || !params) return undefined;
  const record = params as Record<string, unknown>;

  if (typeof record.summaryPartAdded === "string") return record.summaryPartAdded;
  if (typeof record.summary_part_added === "string") return record.summary_part_added;
  if (typeof record.title === "string") return record.title;
  if (typeof record.name === "string") return record.name;

  const part = record.part;
  if (typeof part === "object" && part) {
    const partRecord = part as Record<string, unknown>;
    if (typeof partRecord.title === "string") return partRecord.title;
    if (typeof partRecord.name === "string") return partRecord.name;
  }

  const msg = record.msg;
  if (typeof msg === "object" && msg) {
    const msgRecord = msg as Record<string, unknown>;
    if (typeof msgRecord.summaryPartAdded === "string") return msgRecord.summaryPartAdded;
    if (typeof msgRecord.summary_part_added === "string") return msgRecord.summary_part_added;
    if (typeof msgRecord.title === "string") return msgRecord.title;
  }
  return undefined;
}

function handleNotification(method: string, params: unknown): void {
  if (isAgentMessageDeltaMethod(method)) {
    const delta = parseTurnDeltaText(params);
    if (delta) appendTextToActiveOutput(delta);
    return;
  }

  if (isReasoningSummaryTextMethod(method)) {
    const delta = parseReasoningSummaryTextDelta(params);
    if (delta) appendReasoningDeltaToActiveOutput(delta);
    return;
  }

  if (isReasoningSummaryPartMethod(method)) {
    const title = parseReasoningSummaryPartAdded(params);
    if (title) appendReasoningSectionToActiveOutput(title);
    return;
  }

  if (method.endsWith("turn/completed") || method === "turn/completed") {
    completeActiveTurn();
    setStatus("Turn completed");
    return;
  }

  if (method.includes("turn/interrupted") || method.includes("turn/cancel") || method.endsWith("turn/stopped")) {
    completeActiveTurn();
    setStatus("Turn interrupted");
    return;
  }

  if (method.includes("turn/error") || method.endsWith("turn/errored") || method === "turn/errored") {
    failActiveTurn("Turn failed.");
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
  output.outputSegments = [];
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

function toggleSegment(itemId: string, segmentId: string): void {
  const itemIndex = state.items.findIndex((item) => item.id === itemId);
  if (itemIndex < 0) return;
  const item = state.items[itemIndex];
  if (item.kind !== "agent_output" || !item.outputSegments) return;

  const segments: OutputSegment[] = item.outputSegments.map((segment) => {
    if (segment.id !== segmentId || segment.kind !== "reasoning") return segment;
    return {
      ...segment,
      expanded: !segment.expanded,
    };
  });

  updateItem({
    ...item,
    outputSegments: segments,
  });
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

  ui.itemList.addEventListener("click", (event) => {
    const target = event.target as HTMLElement | null;
    if (!target) return;
    const toggle = target.closest<HTMLButtonElement>("[data-action='toggle-segment']");
    if (!toggle) return;
    const itemId = toggle.dataset.itemId;
    const segmentId = toggle.dataset.segmentId;
    if (!itemId || !segmentId) return;
    toggleSegment(itemId, segmentId);
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
