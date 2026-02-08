import { connectEventStream, interruptTurn, startThread, startTurn } from "../services/app_server_client.js";
import { ITEM_TYPE_REGISTRY, normalizeThreadItemType } from "./item_registry.js";
import { createId, createThreadItem, state } from "./state.js";
import { setComposerDisabled, setStatus, ui, adjustTextareaHeight, resetTextareaHeight } from "../ui/dom.js";
import { renderItems } from "../ui/render.js";
import type { BridgeEvent, OutputSegment, ThreadItem, ThreadItemType } from "./types.js";

type SegmentRef = { itemId: string; segmentId: string; itemType: ThreadItemType };

let interruptFallbackTimer: number | undefined;
const protocolMessageMap = new Map<string, string>();
const protocolSubBlockMap = new Map<string, SegmentRef>();
let activeReasoningSubBlockRef: SegmentRef | null = null;

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

function parseObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null;
  return value as Record<string, unknown>;
}

function extractItemContainer(params: unknown): Record<string, unknown> | null {
  const record = parseObject(params);
  if (!record) return null;
  return parseObject(record.item) ?? parseObject(record.msg) ?? record;
}

function extractProtocolItemId(value: unknown): string | null {
  const record = parseObject(value);
  if (!record) return null;
  const direct = record.itemId ?? record.item_id ?? record.callId ?? record.call_id ?? record.id;
  if (typeof direct === "string" && direct.trim()) return direct;

  const item = parseObject(record.item);
  if (item) {
    const nested = item.itemId ?? item.item_id ?? item.callId ?? item.call_id ?? item.id;
    if (typeof nested === "string" && nested.trim()) return nested;
  }
  return null;
}

function extractTextValue(value: unknown): string {
  const record = parseObject(value);
  if (!record) return "";

  const direct = record.delta ?? record.text ?? record.chunk ?? record.content;
  if (typeof direct === "string") return direct;

  const msg = parseObject(record.msg);
  if (msg) {
    const nested = msg.delta ?? msg.text ?? msg.chunk ?? msg.content;
    if (typeof nested === "string") return nested;
  }

  const item = parseObject(record.item);
  if (item) {
    const nested = item.delta ?? item.text ?? item.chunk ?? item.content;
    if (typeof nested === "string") return nested;
  }

  return "";
}

function parseReasoningSummaryTextDelta(params: unknown): string | undefined {
  const record = parseObject(params);
  if (!record) return undefined;
  const direct = record.summaryTextDelta ?? record.summary_text_delta ?? record.delta ?? record.text;
  if (typeof direct === "string") return direct;

  const msg = parseObject(record.msg);
  if (msg) {
    const nested = msg.summaryTextDelta ?? msg.summary_text_delta ?? msg.delta ?? msg.text;
    if (typeof nested === "string") return nested;
  }
  return undefined;
}

function parseReasoningSummaryPartAdded(params: unknown): string | undefined {
  const record = parseObject(params);
  if (!record) return undefined;
  const direct = record.summaryPartAdded ?? record.summary_part_added ?? record.title ?? record.name;
  if (typeof direct === "string") return direct;

  const part = parseObject(record.part);
  if (part) {
    const nested = part.title ?? part.name;
    if (typeof nested === "string") return nested;
  }
  return undefined;
}

function findItemById(itemId: string | null | undefined): ThreadItem | null {
  if (!itemId) return null;
  return state.items.find((item) => item.id === itemId) ?? null;
}

function getLatestAgentMessage(): ThreadItem | null {
  if (state.activeAgentItemId) {
    const active = findItemById(state.activeAgentItemId);
    if (active?.itemType === "agentMessage") return active;
  }
  for (let i = state.items.length - 1; i >= 0; i -= 1) {
    if (state.items[i].itemType === "agentMessage") {
      return state.items[i];
    }
  }
  return null;
}

function getLatestUserMessage(): ThreadItem | null {
  for (let i = state.items.length - 1; i >= 0; i -= 1) {
    if (state.items[i].itemType === "userMessage") {
      return state.items[i];
    }
  }
  return null;
}

function ensureActiveAgentMessage(): ThreadItem {
  const existing = getLatestAgentMessage();
  if (existing) return existing;

  const output = createThreadItem("agentMessage", ITEM_TYPE_REGISTRY.agentMessage.label, "");
  output.status = "pending";
  output.outputSegments = [];
  appendItem(output);
  state.activeAgentItemId = output.id;
  return output;
}

function appendTextSegment(item: ThreadItem, delta: string): void {
  if (!delta) return;
  const current = findItemById(item.id);
  if (!current) return;
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

function appendSubBlock(
  item: ThreadItem,
  itemType: ThreadItemType,
  protocolItemId?: string | null,
  customTitle?: string,
): SegmentRef {
  const current = findItemById(item.id);
  if (!current) {
    return { itemId: item.id, segmentId: "", itemType };
  }
  const segment: OutputSegment = {
    id: createId("segment"),
    kind: "subBlock",
    itemType,
    title: customTitle ?? ITEM_TYPE_REGISTRY[itemType].label,
    text: "",
    status: "pending",
    createdAt: new Date().toISOString(),
  };
  const next: ThreadItem = {
    ...current,
    outputSegments: [...(current.outputSegments ?? []), segment],
  };
  updateItem(next);

  const ref: SegmentRef = { itemId: current.id, segmentId: segment.id, itemType };
  if (protocolItemId) {
    protocolSubBlockMap.set(protocolItemId, ref);
  }
  return ref;
}

function updateSubBlockText(ref: SegmentRef, delta: string): void {
  if (!delta) return;
  const item = findItemById(ref.itemId);
  if (!item || !item.outputSegments) return;
  const outputSegments = item.outputSegments.map((segment) => {
    if (segment.id !== ref.segmentId || segment.kind !== "subBlock") return segment;
    return {
      ...segment,
      text: `${segment.text}${delta}`,
    };
  });
  updateItem({ ...item, outputSegments });
}

function updateSubBlockStatus(ref: SegmentRef, status: "pending" | "completed" | "error", error?: string): void {
  const item = findItemById(ref.itemId);
  if (!item || !item.outputSegments) return;
  const outputSegments = item.outputSegments.map((segment) => {
    if (segment.id !== ref.segmentId || segment.kind !== "subBlock") return segment;
    return {
      ...segment,
      status,
      error,
    };
  });
  updateItem({ ...item, outputSegments });
}

function inferItemTypeFromMethod(method: string): ThreadItemType {
  const lower = method.toLowerCase();
  if (lower.includes("agentmessage")) return "agentMessage";
  if (lower.includes("reasoning")) return "reasoning";
  if (lower.includes("plan")) return "plan";
  if (lower.includes("commandexecution")) return "commandExecution";
  if (lower.includes("filechange")) return "fileChange";
  if (lower.includes("mcptoolcall")) return "mcpToolCall";
  if (lower.includes("collabtoolcall")) return "collabToolCall";
  if (lower.includes("websearch")) return "webSearch";
  if (lower.includes("imageview")) return "imageView";
  if (lower.includes("enteredreviewmode")) return "enteredReviewMode";
  if (lower.includes("exitedreviewmode")) return "exitedReviewMode";
  if (lower.includes("contextcompaction")) return "contextCompaction";
  return "unknown";
}

function createReasoningSubBlock(params: unknown, sectionTitle?: string): SegmentRef {
  const protocolItemId = extractProtocolItemId(params);
  if (protocolItemId) {
    const existing = protocolSubBlockMap.get(protocolItemId);
    if (existing) return existing;
  }

  const agent = ensureActiveAgentMessage();
  const title = sectionTitle ? `Reasoning - ${sectionTitle}` : ITEM_TYPE_REGISTRY.reasoning.label;
  const ref = appendSubBlock(agent, "reasoning", protocolItemId, title);
  activeReasoningSubBlockRef = ref;
  return ref;
}

function markAgentCompleted(): void {
  const active = findItemById(state.activeAgentItemId);
  if (!active) return;
  updateItem({
    ...active,
    status: undefined,
  });
}

function completeActiveTurn(): void {
  if (interruptFallbackTimer) {
    window.clearTimeout(interruptFallbackTimer);
    interruptFallbackTimer = undefined;
  }
  markAgentCompleted();
  state.isTurnActive = false;
  state.activeTurnId = null;
  state.activeAgentItemId = null;
  activeReasoningSubBlockRef = null;
  setComposerDisabled(false);
}

function failActiveTurn(message: string): void {
  if (interruptFallbackTimer) {
    window.clearTimeout(interruptFallbackTimer);
    interruptFallbackTimer = undefined;
  }

  const active = findItemById(state.activeAgentItemId);
  if (active) {
    updateItem({
      ...active,
      status: "error",
      error: message,
    });
  }

  state.isTurnActive = false;
  state.activeTurnId = null;
  state.activeAgentItemId = null;
  activeReasoningSubBlockRef = null;
  setComposerDisabled(false);
  setStatus(message, "error");
}

function handleItemStarted(params: unknown): void {
  const itemContainer = extractItemContainer(params);
  const protocolItemId = extractProtocolItemId(itemContainer);
  const itemType = normalizeThreadItemType(itemContainer?.type ?? itemContainer?.itemType ?? itemContainer?.item_type);

  if (itemType === "userMessage") {
    if (protocolItemId && protocolMessageMap.has(protocolItemId)) return;
    const latestUser = getLatestUserMessage();
    if (latestUser && protocolItemId) {
      protocolMessageMap.set(protocolItemId, latestUser.id);
    }
    return;
  }

  if (itemType === "agentMessage") {
    const agent = ensureActiveAgentMessage();
    if (protocolItemId) protocolMessageMap.set(protocolItemId, agent.id);
    return;
  }

  const agent = ensureActiveAgentMessage();
  appendSubBlock(agent, itemType, protocolItemId);
}

function handleItemCompleted(params: unknown): void {
  const protocolItemId = extractProtocolItemId(params);
  if (!protocolItemId) return;
  const ref = protocolSubBlockMap.get(protocolItemId);
  if (ref) {
    updateSubBlockStatus(ref, "completed");
  }
}

function ensureSubBlockForMethod(method: string, params: unknown): SegmentRef {
  const protocolItemId = extractProtocolItemId(params);
  if (protocolItemId) {
    const existing = protocolSubBlockMap.get(protocolItemId);
    if (existing) return existing;
  }
  const agent = ensureActiveAgentMessage();
  const type = inferItemTypeFromMethod(method);
  return appendSubBlock(agent, type, protocolItemId);
}

function handleMethodDelta(method: string, params: unknown): void {
  const lower = method.toLowerCase();
  const protocolItemId = extractProtocolItemId(params);
  const mappedMessageId = protocolItemId ? protocolMessageMap.get(protocolItemId) : null;
  const mappedMessage = findItemById(mappedMessageId);
  const delta = extractTextValue(params);

  if (lower.includes("agentmessage/delta")) {
    const target = mappedMessage?.itemType === "agentMessage" ? mappedMessage : ensureActiveAgentMessage();
    appendTextSegment(target, delta);
    return;
  }

  if (lower.includes("reasoning/summarytextdelta") || lower.endsWith("reasoning_summary_text_delta")) {
    const reasoningDelta = parseReasoningSummaryTextDelta(params) ?? delta;
    if (!reasoningDelta) return;

    let ref = extractProtocolItemId(params) ? protocolSubBlockMap.get(extractProtocolItemId(params) as string) : null;
    if (!ref) {
      ref = activeReasoningSubBlockRef ?? createReasoningSubBlock(params);
    }
    updateSubBlockText(ref, reasoningDelta);
    return;
  }

  if (lower.includes("reasoning/summarypartadded") || lower.endsWith("reasoning_summary_part_added")) {
    const section = parseReasoningSummaryPartAdded(params);
    if (section) {
      createReasoningSubBlock(params, section);
    }
    return;
  }

  const ref = ensureSubBlockForMethod(method, params);
  updateSubBlockText(ref, delta);
}

function handleApprovalEvent(method: string, params: unknown): void {
  const ref = ensureSubBlockForMethod(method, params);
  updateSubBlockStatus(ref, "pending");
  setStatus("Approval required");
}

function handleNotification(method: string, params: unknown): void {
  const lower = method.toLowerCase();

  if (lower === "item/started") {
    handleItemStarted(params);
    return;
  }

  if (lower === "item/completed") {
    handleItemCompleted(params);
    return;
  }

  if (lower === "item/commandexecution/requestapproval" || lower === "item/filechange/requestapproval") {
    handleApprovalEvent(method, params);
    return;
  }

  if (lower.endsWith("/delta") || lower.includes("summary_text_delta") || lower.includes("summary_part_added")) {
    handleMethodDelta(method, params);
  }

  if (lower.endsWith("turn/completed") || lower === "turn/completed") {
    completeActiveTurn();
    setStatus("Turn completed");
    return;
  }

  if (lower.includes("turn/interrupted") || lower.includes("turn/cancel") || lower.endsWith("turn/stopped")) {
    completeActiveTurn();
    setStatus("Turn interrupted");
    return;
  }

  if (lower.includes("turn/error") || lower.endsWith("turn/errored") || lower === "turn/errored") {
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

  appendItem(createThreadItem("userMessage", ITEM_TYPE_REGISTRY.userMessage.label, input));
  const output = createThreadItem("agentMessage", ITEM_TYPE_REGISTRY.agentMessage.label, "");
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
  protocolMessageMap.clear();
  protocolSubBlockMap.clear();
  activeReasoningSubBlockRef = null;
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
