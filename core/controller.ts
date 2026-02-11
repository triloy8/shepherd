import {
  connectEventStream,
  interruptTurn,
  respondCommandApproval,
  respondFileChangeApproval,
  respondToolUserInput,
  startThread,
  startTurn,
} from "../services/app_server_client.js";
import { ITEM_TYPE_REGISTRY, normalizeThreadItemType } from "./item_registry.js";
import { createId, createThreadItem, state } from "./state.js";
import { setComposerDisabled, setStatus, ui, adjustTextareaHeight, resetTextareaHeight } from "../ui/dom.js";
import { renderItems } from "../ui/render.js";
import { renderApprovals } from "../ui/render.js";
import type {
  ApprovalQuestion,
  AskForApproval,
  BridgeEvent,
  CommandApprovalDecision,
  FileChangeApprovalDecision,
  OutputSegment,
  PendingApprovalRequest,
  PendingCommandApprovalRequest,
  PendingFileChangeApprovalRequest,
  PendingToolUserInputRequest,
  ThreadItem,
  ThreadItemType,
} from "./types.js";

type SegmentRef = { itemId: string; segmentId: string; itemType: ThreadItemType };

let interruptFallbackTimer: number | undefined;
const protocolMessageMap = new Map<string, string>();
const protocolSubBlockMap = new Map<string, SegmentRef>();
let activeReasoningSubBlockRef: SegmentRef | null = null;

function syncView(): void {
  syncApprovalPolicyControl();
  renderItems(state);
  renderApprovals(state);
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

function parseString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function parseErrorText(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "object") {
    const record = parseObject(value);
    const message = record ? parseString(record.message) ?? parseString(record.error) : null;
    if (message) return message;
    try {
      return JSON.stringify(value);
    } catch {
      return null;
    }
  }
  return `${value}`;
}

function isApprovalPolicy(value: string): value is AskForApproval {
  return value === "untrusted" || value === "on-failure" || value === "on-request" || value === "never";
}

function syncApprovalPolicyControl(): void {
  const buttons = ui.approvalPolicyGroup.querySelectorAll<HTMLButtonElement>("button[data-approval-policy]");
  for (const button of buttons) {
    const value = button.dataset.approvalPolicy;
    const active = value === state.selectedApprovalPolicy;
    button.dataset.active = active ? "true" : "false";
    button.setAttribute("aria-pressed", active ? "true" : "false");
  }
}

function toArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function upsertPendingApproval(request: PendingApprovalRequest): void {
  const index = state.pendingApprovals.findIndex((candidate) => candidate.requestId === request.requestId);
  if (index >= 0) {
    state.pendingApprovals[index] = request;
  } else {
    state.pendingApprovals.push(request);
  }
  syncView();
}

function markPendingApprovalSubmitting(requestId: string, submitting: boolean, error?: string): void {
  const next = state.pendingApprovals.map((request) => {
    if (request.requestId !== requestId) return request;
    return {
      ...request,
      submitting,
      error,
    };
  });
  state.pendingApprovals = next;
  syncView();
}

function removePendingApproval(requestId: string): void {
  state.pendingApprovals = state.pendingApprovals.filter((request) => request.requestId !== requestId);
  syncView();
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

  const msg = parseObject(record.msg);
  if (msg) {
    const nestedMsg = msg.itemId ?? msg.item_id ?? msg.callId ?? msg.call_id ?? msg.id;
    if (typeof nestedMsg === "string" && nestedMsg.trim()) return nestedMsg;
  }

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

  const direct =
    record.delta ??
    record.outputDelta ??
    record.textDelta ??
    record.summaryTextDelta ??
    record.summary_text_delta ??
    record.text ??
    record.chunk ??
    record.content;
  if (typeof direct === "string") return direct;

  const msg = parseObject(record.msg);
  if (msg) {
    const nested =
      msg.delta ??
      msg.outputDelta ??
      msg.textDelta ??
      msg.summaryTextDelta ??
      msg.summary_text_delta ??
      msg.text ??
      msg.chunk ??
      msg.content;
    if (typeof nested === "string") return nested;
  }

  const item = parseObject(record.item);
  if (item) {
    const nested =
      item.delta ??
      item.outputDelta ??
      item.textDelta ??
      item.summaryTextDelta ??
      item.summary_text_delta ??
      item.text ??
      item.chunk ??
      item.content;
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

function formatPlanUpdateText(params: unknown): string {
  const record = parseObject(params);
  if (!record) return "";

  const lines: string[] = [];
  const explanation = record.explanation ?? record.summary ?? record.text;
  if (typeof explanation === "string" && explanation.trim()) {
    lines.push(explanation.trim());
  }

  const plan = Array.isArray(record.plan) ? record.plan : null;
  if (plan) {
    for (let i = 0; i < plan.length; i += 1) {
      const step = plan[i];
      if (typeof step === "string" && step.trim()) {
        lines.push(`${i + 1}. ${step.trim()}`);
        continue;
      }
      const stepRecord = parseObject(step);
      if (!stepRecord) continue;
      const label = stepRecord.step ?? stepRecord.text ?? stepRecord.title ?? stepRecord.name;
      if (typeof label !== "string" || !label.trim()) continue;
      const status = stepRecord.status;
      if (typeof status === "string" && status.trim()) {
        lines.push(`${i + 1}. ${label.trim()} [${status.trim()}]`);
      } else {
        lines.push(`${i + 1}. ${label.trim()}`);
      }
    }
  }

  return lines.join("\n");
}

function handlePlanUpdated(method: string, params: unknown): void {
  const agent = ensureActiveAgentMessage();
  const protocolItemId = extractProtocolItemId(params);
  const ref = appendSubBlock(agent, "plan", protocolItemId, ITEM_TYPE_REGISTRY.plan.label);
  const text = formatPlanUpdateText(params);
  updateSubBlockText(ref, text);
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
    displayMode: "compact",
    details: protocolItemId ? { protocolItemId } : {},
    raw: {},
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

function updateSubBlock(
  ref: SegmentRef,
  updater: (segment: OutputSegment) => OutputSegment,
): void {
  const item = findItemById(ref.itemId);
  if (!item || !item.outputSegments) return;
  const outputSegments = item.outputSegments.map((segment) => {
    if (segment.id !== ref.segmentId || segment.kind !== "subBlock") return segment;
    return updater(segment);
  });
  updateItem({ ...item, outputSegments });
}

function setSubBlockDisplayMode(itemId: string, segmentId: string, displayMode: "compact" | "full" | "debug"): void {
  const item = findItemById(itemId);
  if (!item || !item.outputSegments) return;
  const outputSegments = item.outputSegments.map((segment) => {
    if (segment.id !== segmentId || segment.kind !== "subBlock") return segment;
    if (segment.displayMode === displayMode) return segment;
    return { ...segment, displayMode };
  });
  updateItem({ ...item, outputSegments });
}

function updateSubBlockText(ref: SegmentRef, delta: string): void {
  if (!delta) return;
  updateSubBlock(ref, (segment) => {
    return {
      ...segment,
      text: `${segment.text}${delta}`,
    };
  });
}

function mergeSubBlockDetails(ref: SegmentRef, patch: Record<string, unknown>): void {
  updateSubBlock(ref, (segment) => {
    return {
      ...segment,
      details: {
        ...(segment.details ?? {}),
        ...patch,
      },
    };
  });
}

function setSubBlockRawEvent(ref: SegmentRef, stage: string, payload: unknown): void {
  updateSubBlock(ref, (segment) => {
    return {
      ...segment,
      raw: {
        ...(segment.raw ?? {}),
        [stage]: payload,
      },
    };
  });
}

function updateSubBlockStatus(ref: SegmentRef, status: "pending" | "completed" | "error", error?: string): void {
  updateSubBlock(ref, (segment) => {
    const patch: Record<string, unknown> = { status };
    if (error) patch.error = error;
    return {
      ...segment,
      status,
      error,
      details: {
        ...(segment.details ?? {}),
        ...patch,
      },
    };
  });
}

function getSubBlockText(ref: SegmentRef): string {
  const item = findItemById(ref.itemId);
  if (!item || !item.outputSegments) return "";
  const segment = item.outputSegments.find((candidate) => candidate.id === ref.segmentId && candidate.kind === "subBlock");
  return segment && segment.kind === "subBlock" ? segment.text : "";
}

function formatWebSearchEndText(method: string, params: unknown): string {
  void method;
  const record = parseObject(params) ?? {};
  const msg = parseObject(record.msg) ?? record;
  const action = parseObject(msg.action);
  const lines: string[] = [];

  const query = parseString(msg.query);
  const actionType =
    parseString(action?.type) ?? parseString(action?.name) ?? parseString(action?.kind) ?? "other";
  lines.push(actionType);

  const normalizedActionType = actionType.replace(/[_\s-]/g, "").toLowerCase();
  const isSearch = normalizedActionType === "search";
  const isOpenPage = normalizedActionType === "openpage";
  const isFindInPage = normalizedActionType === "findinpage";

  if (query) lines.push(`query: ${query}`);

  const actionQuery = parseString(action?.query);
  if (isSearch && actionQuery && actionQuery !== query) {
    lines.push(`action query: ${actionQuery}`);
  }

  const queries = toArray(action?.queries)
    .map((entry) => parseString(entry))
    .filter((entry): entry is string => Boolean(entry));
  if (isSearch && queries.length > 0) {
    lines.push("queries:");
    for (let i = 0; i < queries.length; i += 1) {
      lines.push(`${i + 1}. ${queries[i]}`);
    }
  }

  const url = parseString(action?.url);
  if ((isOpenPage || isFindInPage) && url) lines.push(`url: ${url}`);

  const pattern = parseString(action?.pattern);
  if (isFindInPage && pattern) lines.push(`pattern: ${pattern}`);

  return lines.join("\n");
}

function parseNumberLike(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function formatCommandExecutionCompletedText(itemContainer: Record<string, unknown>): string {
  const lines: string[] = [];
  const cwd = parseString(itemContainer.cwd);
  if (cwd) lines.push(`cwd: ${cwd}`);

  const exitCode = parseNumberLike(itemContainer.exitCode ?? itemContainer.exit_code);
  if (exitCode !== null) lines.push(`exit code: ${exitCode}`);

  const durationMs = parseNumberLike(itemContainer.durationMs ?? itemContainer.duration_ms);
  if (durationMs !== null) lines.push(`duration: ${durationMs}ms`);

  const output = parseString(itemContainer.aggregatedOutput ?? itemContainer.aggregated_output ?? itemContainer.output);
  if (output) {
    lines.push("output:");
    lines.push(output);
  }

  return lines.join("\n");
}

function formatFileChangeDiffFromCompleted(itemContainer: Record<string, unknown>): string {
  const changes = toArray(itemContainer.changes ?? itemContainer.fileChanges ?? itemContainer.file_changes);
  const lines: string[] = [];

  for (const changeValue of changes) {
    const change = parseObject(changeValue);
    if (!change) continue;
    const path = parseString(change.path) ?? "(unknown path)";
    const diff = parseString(change.diff);
    if (!diff) continue;

    lines.push(path);
    lines.push(diff.trimEnd());
    lines.push("");
  }

  return lines.join("\n").trim();
}

function extractItemErrorText(params: unknown, itemContainer?: Record<string, unknown> | null): string | null {
  const record = parseObject(params) ?? {};
  const msg = parseObject(record.msg) ?? {};
  const container = itemContainer ?? extractItemContainer(params);
  const candidates: unknown[] = [
    container?.error,
    container?.exception,
    container?.reason,
    record.error,
    record.exception,
    record.reason,
    msg.error,
    msg.exception,
    msg.reason,
  ];
  for (const candidate of candidates) {
    const parsed = parseErrorText(candidate);
    if (parsed) return parsed;
  }
  return null;
}

function isWebSearchEndEvent(method: string, params: unknown): boolean {
  const lower = method.toLowerCase();
  if (lower.includes("web_search_end") || lower.includes("websearchend")) return true;

  const record = parseObject(params);
  const msg = record ? parseObject(record.msg) : null;
  const rawType = parseString(msg?.type) ?? parseString(record?.type) ?? "";
  return rawType.toLowerCase() === "web_search_end";
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
  if (lower.includes("websearch") || lower.includes("web_search")) return "webSearch";
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

  if (itemType === "webSearch") {
    return;
  }

  const existingRef = protocolItemId ? protocolSubBlockMap.get(protocolItemId) ?? null : null;
  const agent = ensureActiveAgentMessage();
  const ref = existingRef ?? appendSubBlock(agent, itemType, protocolItemId);
  mergeSubBlockDetails(ref, {
    status: "pending",
    startedAt: new Date().toISOString(),
  });
  if (itemContainer) {
    setSubBlockRawEvent(ref, "started", itemContainer);
  }

  if (itemType === "commandExecution") {
    const command = parseString(itemContainer?.command);
    const cwd = parseString(itemContainer?.cwd);
    mergeSubBlockDetails(ref, {
      ...(command ? { command } : {}),
      ...(cwd ? { cwd } : {}),
    });
    if (command && getSubBlockText(ref).length === 0) {
      updateSubBlockText(ref, `$ ${command}\n`);
    }
    return;
  }
}

function handleItemCompleted(params: unknown): void {
  const itemContainer = extractItemContainer(params);
  const protocolItemId = extractProtocolItemId(params);
  if (!protocolItemId) return;
  const ref = protocolSubBlockMap.get(protocolItemId);
  if (ref) {
    const itemType = normalizeThreadItemType(itemContainer?.type ?? itemContainer?.itemType ?? itemContainer?.item_type);
    if (itemContainer) {
      setSubBlockRawEvent(ref, "completed", itemContainer);
    }
    if (itemType === "commandExecution" && itemContainer) {
      const exitCode = parseNumberLike(itemContainer.exitCode ?? itemContainer.exit_code);
      const durationMs = parseNumberLike(itemContainer.durationMs ?? itemContainer.duration_ms);
      const cwd = parseString(itemContainer.cwd);
      const output = parseString(itemContainer.aggregatedOutput ?? itemContainer.aggregated_output ?? itemContainer.output);
      mergeSubBlockDetails(ref, {
        ...(exitCode !== null ? { exitCode } : {}),
        ...(durationMs !== null ? { durationMs } : {}),
        ...(cwd ? { cwd } : {}),
        ...(output ? { output } : {}),
      });
      const summary = formatCommandExecutionCompletedText(itemContainer);
      if (summary && !getSubBlockText(ref).includes("exit code:")) {
        updateSubBlockText(ref, `\n${summary}\n`);
      }
    }
    if (itemType === "fileChange" && itemContainer) {
      const diffText = formatFileChangeDiffFromCompleted(itemContainer);
      const changeCount = toArray(itemContainer.changes ?? itemContainer.fileChanges ?? itemContainer.file_changes).length;
      mergeSubBlockDetails(ref, {
        ...(changeCount > 0 ? { changeCount } : {}),
        ...(diffText ? { diff: diffText } : {}),
      });
      if (diffText && !getSubBlockText(ref).includes(diffText)) {
        updateSubBlockText(ref, `\n${diffText}\n`);
      }
    }
    if (itemType === "mcpToolCall" && itemContainer) {
      const details = formatMcpCompletionText(params, itemContainer);
      const durationMs = extractMcpDurationMs(params, itemContainer);
      const error = extractMcpError(params, itemContainer);
      const structuredContent = extractMcpStructuredContent(params, itemContainer);
      mergeSubBlockDetails(ref, {
        ...(durationMs !== null ? { durationMs } : {}),
        ...(error !== null ? { error: parseErrorText(error) } : {}),
        ...(structuredContent !== null ? { structuredContent } : {}),
      });
      if (details && !getSubBlockText(ref).includes(details)) {
        updateSubBlockText(ref, `\n${details}\n`);
      }
    }
    updateSubBlockStatus(ref, "completed");
  }
}

function handleItemFailed(method: string, params: unknown): void {
  const itemContainer = extractItemContainer(params);
  const protocolItemId = extractProtocolItemId(params);
  const ref = protocolItemId ? protocolSubBlockMap.get(protocolItemId) ?? null : null;
  const target = ref ?? ensureSubBlockForMethod(method, params);
  const errorText = extractItemErrorText(params, itemContainer) ?? "Operation failed.";

  mergeSubBlockDetails(target, {
    status: "error",
    error: errorText,
    failedAt: new Date().toISOString(),
  });
  setSubBlockRawEvent(target, "failed", itemContainer ?? parseObject(params) ?? params);
  updateSubBlockStatus(target, "error", errorText);
}

function ensureSubBlockForMethod(method: string, params: unknown): SegmentRef {
  const inferredType = inferItemTypeFromMethod(method);
  const protocolItemId = extractProtocolItemId(params);
  if (protocolItemId) {
    const existing = protocolSubBlockMap.get(protocolItemId);
    if (existing) return existing;
  }

  const agent = ensureActiveAgentMessage();
  return appendSubBlock(agent, inferredType, protocolItemId);
}

function tryParseJsonString(value: string): unknown | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function formatUnknownAsJson(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") {
    const parsed = tryParseJsonString(value);
    if (parsed !== null) return JSON.stringify(parsed, null, 2);
    return value;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return null;
  }
}

function parseUnknownMaybeJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const parsed = tryParseJsonString(value);
  return parsed ?? value;
}

function extractMcpStructuredContent(params: unknown, itemContainer: Record<string, unknown>): unknown | null {
  const record = parseObject(params) ?? {};
  const msg = parseObject(record.msg) ?? {};
  const resultCandidates: unknown[] = [
    itemContainer.result,
    itemContainer.output,
    itemContainer.response,
    itemContainer.content,
    itemContainer.toolResult,
    itemContainer.tool_result,
    record.result,
    record.output,
    record.response,
    record.content,
    msg.result,
    msg.output,
    msg.response,
    msg.content,
  ];

  for (const candidate of resultCandidates) {
    const normalized = parseUnknownMaybeJson(candidate);
    const candidateObj = parseObject(normalized);
    if (candidateObj && candidateObj.structuredContent !== undefined) {
      return candidateObj.structuredContent;
    }
  }

  return null;
}

function extractMcpError(params: unknown, itemContainer: Record<string, unknown>): unknown | null {
  const record = parseObject(params) ?? {};
  const msg = parseObject(record.msg) ?? {};
  const errorCandidates: unknown[] = [
    itemContainer.error,
    itemContainer.exception,
    itemContainer.toolError,
    itemContainer.tool_error,
    record.error,
    record.exception,
    msg.error,
    msg.exception,
  ];
  for (const candidate of errorCandidates) {
    if (candidate !== undefined && candidate !== null && `${candidate}`.trim() !== "") {
      return parseUnknownMaybeJson(candidate);
    }
  }
  return null;
}

function extractMcpDurationMs(params: unknown, itemContainer: Record<string, unknown>): number | null {
  const record = parseObject(params) ?? {};
  const msg = parseObject(record.msg) ?? {};
  const durationCandidates: unknown[] = [
    itemContainer.durationMs,
    itemContainer.duration_ms,
    itemContainer.latencyMs,
    itemContainer.latency_ms,
    record.durationMs,
    record.duration_ms,
    record.latencyMs,
    record.latency_ms,
    msg.durationMs,
    msg.duration_ms,
    msg.latencyMs,
    msg.latency_ms,
  ];
  for (const candidate of durationCandidates) {
    const parsed = parseNumberLike(candidate);
    if (parsed !== null) return parsed;
  }
  return null;
}

function formatMcpCompletionText(params: unknown, itemContainer: Record<string, unknown>): string | null {
  const lines: string[] = [];

  const durationMs = extractMcpDurationMs(params, itemContainer);
  if (durationMs !== null) {
    lines.push(`duration: ${durationMs}ms`);
  }

  const error = extractMcpError(params, itemContainer);
  if (error !== null) {
    const errorText = formatUnknownAsJson(error);
    if (errorText) {
      lines.push("error:");
      lines.push(errorText);
    }
  }

  const structuredContent = extractMcpStructuredContent(params, itemContainer);
  if (structuredContent !== null) {
    const structuredContentText = formatUnknownAsJson(structuredContent);
    if (structuredContentText) {
      lines.push("structuredContent:");
      lines.push(structuredContentText);
    }
  }

  return lines.length > 0 ? lines.join("\n") : null;
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
    const parsedReasoningDelta = parseReasoningSummaryTextDelta(params);
    const reasoningDelta = parsedReasoningDelta ?? delta;
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
  void method;
  void params;
  setStatus("Approval required");
}

function parseCommandActions(params: Record<string, unknown>): string[] {
  const actions = toArray(params.commandActions);
  const labels: string[] = [];
  for (const action of actions) {
    const record = parseObject(action);
    if (!record) continue;
    const type = parseString(record.type);
    const label = parseString(record.label);
    const value = label ?? type;
    if (value) labels.push(value);
  }
  return labels;
}

function parseApprovalQuestions(params: Record<string, unknown>): ApprovalQuestion[] {
  const questions = toArray(params.questions);
  const parsed: ApprovalQuestion[] = [];

  for (const question of questions) {
    const q = parseObject(question);
    if (!q) continue;
    const id = parseString(q.id);
    const header = parseString(q.header) ?? "";
    const prompt = parseString(q.question) ?? "";
    if (!id || !prompt) continue;

    const options = toArray(q.options)
      .map((option) => {
        const opt = parseObject(option);
        if (!opt) return null;
        const label = parseString(opt.label);
        if (!label) return null;
        const description = parseString(opt.description) ?? "";
        return { label, description };
      })
      .filter((option): option is { label: string; description: string } => Boolean(option));

    parsed.push({
      id,
      header,
      question: prompt,
      isOther: Boolean(q.isOther),
      isSecret: Boolean(q.isSecret),
      options,
    });
  }

  return parsed;
}

function handleServerRequest(requestId: string, method: string, params: unknown): void {
  const lower = method.toLowerCase();
  const record = parseObject(params) ?? {};
  const threadId = parseString(record.threadId) ?? state.threadId ?? "unknown";
  const turnId = parseString(record.turnId) ?? state.activeTurnId ?? "unknown";
  const itemId = parseString(record.itemId) ?? requestId;
  const reason = parseString(record.reason);
  const createdAt = new Date().toISOString();

  if (lower === "item/commandexecution/requestapproval") {
    handleApprovalEvent(method, params);
    const request: PendingCommandApprovalRequest = {
      kind: "command",
      requestId,
      method,
      threadId,
      turnId,
      itemId,
      reason,
      createdAt,
      command: parseString(record.command),
      cwd: parseString(record.cwd),
      commandActions: parseCommandActions(record),
      submitting: false,
    };
    upsertPendingApproval(request);
    return;
  }

  if (lower === "item/filechange/requestapproval") {
    handleApprovalEvent(method, params);
    const request: PendingFileChangeApprovalRequest = {
      kind: "fileChange",
      requestId,
      method,
      threadId,
      turnId,
      itemId,
      reason,
      createdAt,
      grantRoot: parseString(record.grantRoot),
      submitting: false,
    };
    upsertPendingApproval(request);
    return;
  }

  if (lower === "item/tool/requestuserinput") {
    const request: PendingToolUserInputRequest = {
      kind: "toolUserInput",
      requestId,
      method,
      threadId,
      turnId,
      itemId,
      reason,
      createdAt,
      questions: parseApprovalQuestions(record),
      submitting: false,
    };
    upsertPendingApproval(request);
    setStatus("User input required");
  }
}

function handleNotification(method: string, params: unknown): void {
  const lower = method.toLowerCase();

  if (lower === "turn/plan/updated") {
    handlePlanUpdated(method, params);
    return;
  }

  if (lower === "item/started") {
    handleItemStarted(params);
    return;
  }

  if (lower === "item/completed") {
    handleItemCompleted(params);
    return;
  }

  if (lower === "item/failed" || lower === "item/errored" || lower === "item/error") {
    handleItemFailed(method, params);
    return;
  }

  if (isWebSearchEndEvent(method, params)) {
    const ref = ensureSubBlockForMethod(method, params);
    const details = formatWebSearchEndText(method, params);
    mergeSubBlockDetails(ref, {
      ...(details ? { summary: details } : {}),
      endedAt: new Date().toISOString(),
    });
    setSubBlockRawEvent(ref, "completed", parseObject(params) ?? params);
    if (details) {
      updateSubBlockText(ref, `${details}\n`);
    }
    updateSubBlockStatus(ref, "completed");
  }

  if (lower === "item/commandexecution/requestapproval" || lower === "item/filechange/requestapproval") {
    handleApprovalEvent(method, params);
    return;
  }

  if (
    lower.endsWith("/delta") ||
    lower.endsWith("outputdelta") ||
    lower.endsWith("textdelta") ||
    lower.endsWith("summarytextdelta") ||
    lower.endsWith("summarypartadded") ||
    lower.includes("summary_text_delta") ||
    lower.includes("summary_part_added")
  ) {
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
    setStatus(
      state.threadId
        ? `Thread ready (${state.threadId}) • approval=${state.selectedApprovalPolicy}`
        : `Thread ready • approval=${state.selectedApprovalPolicy}`,
    );
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
    return;
  }

  if (event.type === "server_request" && event.method && event.requestId) {
    handleServerRequest(event.requestId, event.method, event.params);
  }
}

function isCommandDecision(value: string): value is CommandApprovalDecision {
  return value === "accept" || value === "acceptForSession" || value === "decline" || value === "cancel";
}

function isFileChangeDecision(value: string): value is FileChangeApprovalDecision {
  return value === "accept" || value === "acceptForSession" || value === "decline" || value === "cancel";
}

function isSegmentDisplayMode(value: string): value is "compact" | "full" | "debug" {
  return value === "compact" || value === "full" || value === "debug";
}

function findPendingApproval(requestId: string): PendingApprovalRequest | null {
  return state.pendingApprovals.find((request) => request.requestId === requestId) ?? null;
}

async function submitCommandApproval(requestId: string, decision: CommandApprovalDecision): Promise<void> {
  const request = findPendingApproval(requestId);
  if (!request || request.kind !== "command") return;
  markPendingApprovalSubmitting(requestId, true);
  try {
    await respondCommandApproval(requestId, decision);
    removePendingApproval(requestId);
    setStatus("Command approval submitted");
  } catch (error) {
    markPendingApprovalSubmitting(
      requestId,
      false,
      error instanceof Error ? error.message : "Failed to submit command approval",
    );
    setStatus("Command approval failed", "error");
  }
}

async function submitFileChangeApproval(requestId: string, decision: FileChangeApprovalDecision): Promise<void> {
  const request = findPendingApproval(requestId);
  if (!request || request.kind !== "fileChange") return;
  markPendingApprovalSubmitting(requestId, true);
  try {
    await respondFileChangeApproval(requestId, decision);
    removePendingApproval(requestId);
    setStatus("File change approval submitted");
  } catch (error) {
    markPendingApprovalSubmitting(
      requestId,
      false,
      error instanceof Error ? error.message : "Failed to submit file change approval",
    );
    setStatus("File change approval failed", "error");
  }
}

async function submitToolUserInput(form: HTMLFormElement): Promise<void> {
  const requestId = form.dataset.requestId;
  if (!requestId) return;
  const request = findPendingApproval(requestId);
  if (!request || request.kind !== "toolUserInput") return;

  const answers: Record<string, { answers: string[] }> = {};
  for (const question of request.questions) {
    const selected = form.elements.namedItem(`q:${question.id}`);
    const other = form.elements.namedItem(`other:${question.id}`);
    const values: string[] = [];

    if (selected instanceof HTMLSelectElement && selected.value) {
      values.push(selected.value);
    }
    if (other instanceof HTMLInputElement && other.value.trim()) {
      values.push(other.value.trim());
    }

    if (values.length > 0) {
      answers[question.id] = { answers: values };
    }
  }

  markPendingApprovalSubmitting(requestId, true);
  try {
    await respondToolUserInput(requestId, answers);
    removePendingApproval(requestId);
    setStatus("Tool input submitted");
  } catch (error) {
    markPendingApprovalSubmitting(
      requestId,
      false,
      error instanceof Error ? error.message : "Failed to submit tool input",
    );
    setStatus("Tool input failed", "error");
  }
}

async function ensureThread(): Promise<void> {
  if (state.threadId) return;
  const response = await startThread(state.selectedApprovalPolicy);
  state.threadId = response.threadId;
  setStatus(`Thread ready (${state.threadId}) • approval=${state.selectedApprovalPolicy}`);
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
    const response = await startTurn(input, state.selectedApprovalPolicy);
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
  state.pendingApprovals = [];
  protocolMessageMap.clear();
  protocolSubBlockMap.clear();
  activeReasoningSubBlockRef = null;
  setComposerDisabled(false);
  syncView();

  try {
    const response = await startThread(state.selectedApprovalPolicy);
    state.threadId = response.threadId;
    setStatus(`Thread ready (${state.threadId}) • approval=${state.selectedApprovalPolicy}`);
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

  ui.approvalPolicyGroup.addEventListener("click", (event: MouseEvent) => {
    const target = event.target as HTMLElement;
    const button = target.closest<HTMLButtonElement>("button[data-approval-policy]");
    if (!button) return;
    const next = button.dataset.approvalPolicy;
    if (!next) return;
    if (!isApprovalPolicy(next)) return;
    if (next === state.selectedApprovalPolicy) return;
    state.selectedApprovalPolicy = next;
    syncApprovalPolicyControl();
    setStatus(`Approval policy set to ${next}`);
  });

  ui.itemList.addEventListener("click", (event: MouseEvent) => {
    const target = event.target as HTMLElement;
    const button = target.closest<HTMLButtonElement>("button[data-segment-id][data-item-id][data-display-mode]");
    if (!button) return;
    const next = button.dataset.displayMode;
    const itemId = button.dataset.itemId;
    const segmentId = button.dataset.segmentId;
    if (!next || !isSegmentDisplayMode(next)) return;
    if (!itemId || !segmentId) return;
    setSubBlockDisplayMode(itemId, segmentId, next);
  });

  ui.approvalList.addEventListener("click", (event: MouseEvent) => {
    const target = event.target as HTMLElement;
    const button = target.closest<HTMLButtonElement>("button[data-request-id][data-approval-decision]");
    if (!button) return;

    const requestId = button.dataset.requestId;
    const decision = button.dataset.approvalDecision;
    if (!requestId || !decision) return;

    const pending = findPendingApproval(requestId);
    if (!pending) return;

    if (pending.kind === "command" && isCommandDecision(decision)) {
      void submitCommandApproval(requestId, decision);
      return;
    }

    if (pending.kind === "fileChange" && isFileChangeDecision(decision)) {
      void submitFileChangeApproval(requestId, decision);
    }
  });

  ui.approvalList.addEventListener("submit", (event: Event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    event.preventDefault();
    void submitToolUserInput(form);
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
  syncApprovalPolicyControl();
  syncView();
  attachEventListeners();
  connectBridgeEventStream();
  resetTextareaHeight();
  ui.textarea.focus();
}
