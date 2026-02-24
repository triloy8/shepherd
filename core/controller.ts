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
import type {
  AgentState,
  ApprovalQuestion,
  AskForApproval,
  BridgeEvent,
  CommandApprovalDecision,
  DisplayMode,
  FileChangeApprovalDecision,
  OutputSegment,
  PendingApprovalRequest,
  PendingCommandApprovalRequest,
  PendingFileChangeApprovalRequest,
  PendingToolUserInputRequest,
  ThreadItem,
  ThreadItemType,
} from "./types.js";

export type StatusVariant = "default" | "pending" | "error";

export type ControllerSnapshot = AgentState & {
  statusText: string;
  statusVariant: StatusVariant;
};

type SegmentRef = { itemId: string; segmentId: string; itemType: ThreadItemType };

function createId(prefix: string): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function createThreadItem(itemType: ThreadItemType, label: string, content: string): ThreadItem {
  return {
    id: createId("item"),
    itemType,
    label,
    content,
    createdAt: new Date().toISOString(),
  };
}

function parseObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null;
  return value as Record<string, unknown>;
}

function parseString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function parseNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function tryParseJsonString(value: string): unknown | null {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function parseUnknownMaybeJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const parsed = tryParseJsonString(value);
  return parsed ?? value;
}

function toArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function extractItemContainer(params: unknown): Record<string, unknown> | null {
  const record = parseObject(params);
  if (!record) return null;
  return parseObject(record.item) ?? parseObject(record.msg) ?? record;
}

function extractProtocolItemId(value: unknown): string | null {
  const record = parseObject(value);
  if (!record) return null;
  const candidate = record.itemId ?? record.item_id ?? record.callId ?? record.call_id ?? record.id;
  if (typeof candidate === "string" && candidate.trim()) return candidate;

  const msg = parseObject(record.msg);
  if (!msg) return null;
  const nested = msg.itemId ?? msg.item_id ?? msg.callId ?? msg.call_id ?? msg.id;
  return typeof nested === "string" && nested.trim() ? nested : null;
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

function extractTextDelta(params: unknown): string {
  const record = parseObject(params);
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
  if (!msg) return "";
  const nested =
    msg.delta ??
    msg.outputDelta ??
    msg.textDelta ??
    msg.summaryTextDelta ??
    msg.summary_text_delta ??
    msg.text ??
    msg.chunk ??
    msg.content;
  return typeof nested === "string" ? nested : "";
}

function extractErrorText(params: unknown, itemContainer: Record<string, unknown>): string | null {
  const record = parseObject(params) ?? {};
  const msg = parseObject(record.msg) ?? {};
  const candidates: unknown[] = [
    itemContainer.error,
    itemContainer.exception,
    itemContainer.reason,
    record.error,
    record.exception,
    record.reason,
    msg.error,
    msg.exception,
    msg.reason,
  ];
  for (const candidate of candidates) {
    if (candidate === undefined || candidate === null) continue;
    if (typeof candidate === "string" && candidate.trim()) return candidate;
    const obj = parseObject(candidate);
    if (obj) {
      const message = parseString(obj.message) ?? parseString(obj.error);
      if (message) return message;
    }
    return `${candidate}`;
  }
  return null;
}

function extractMcpStructuredContent(params: unknown, itemContainer: Record<string, unknown>): unknown | null {
  const record = parseObject(params) ?? {};
  const msg = parseObject(record.msg) ?? {};
  const candidates: unknown[] = [
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
  for (const candidate of candidates) {
    const normalized = parseUnknownMaybeJson(candidate);
    const obj = parseObject(normalized);
    if (obj && obj.structuredContent !== undefined) return obj.structuredContent;
    if (normalized && typeof normalized === "object") return normalized;
  }
  return null;
}

function extractMcpError(params: unknown, itemContainer: Record<string, unknown>): unknown | null {
  const record = parseObject(params) ?? {};
  const msg = parseObject(record.msg) ?? {};
  const candidates: unknown[] = [
    itemContainer.error,
    itemContainer.exception,
    itemContainer.toolError,
    itemContainer.tool_error,
    record.error,
    record.exception,
    msg.error,
    msg.exception,
  ];
  for (const candidate of candidates) {
    if (candidate !== undefined && candidate !== null && `${candidate}`.trim() !== "") {
      return parseUnknownMaybeJson(candidate);
    }
  }
  return null;
}

function extractMcpDurationMs(params: unknown, itemContainer: Record<string, unknown>): number | null {
  const record = parseObject(params) ?? {};
  const msg = parseObject(record.msg) ?? {};
  const candidates: unknown[] = [
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
  for (const candidate of candidates) {
    const parsed = parseNumber(candidate);
    if (parsed !== null) return parsed;
  }
  return null;
}

function isApprovalPolicy(value: string): value is AskForApproval {
  return value === "untrusted" || value === "on-failure" || value === "on-request" || value === "never";
}

function isCommandDecision(value: string): value is CommandApprovalDecision {
  return value === "accept" || value === "acceptForSession" || value === "decline" || value === "cancel";
}

function isFileChangeDecision(value: string): value is FileChangeApprovalDecision {
  return value === "accept" || value === "acceptForSession" || value === "decline" || value === "cancel";
}

export class AgentController {
  private snapshot: ControllerSnapshot;
  private listeners = new Set<(snapshot: ControllerSnapshot) => void>();
  private protocolMessageMap = new Map<string, string>();
  private protocolSubBlockMap = new Map<string, SegmentRef>();
  private activeReasoningRef: SegmentRef | null = null;
  private interruptFallbackTimer: number | undefined;

  constructor() {
    this.snapshot = {
      threadId: null,
      items: [],
      pendingApprovals: [],
      selectedApprovalPolicy: "on-request",
      activeTurnId: null,
      activeAgentItemId: null,
      isTurnActive: false,
      statusText: "Ready",
      statusVariant: "default",
    };
  }

  getSnapshot(): ControllerSnapshot {
    return this.snapshot;
  }

  subscribe(listener: (snapshot: ControllerSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.snapshot);
    return () => this.listeners.delete(listener);
  }

  private setSnapshot(next: ControllerSnapshot): void {
    this.snapshot = next;
    for (const listener of this.listeners) {
      listener(this.snapshot);
    }
  }

  private update(updater: (prev: ControllerSnapshot) => ControllerSnapshot): void {
    this.setSnapshot(updater(this.snapshot));
  }

  private setStatus(statusText: string, statusVariant: StatusVariant = "default"): void {
    this.update((prev) => ({ ...prev, statusText, statusVariant }));
  }

  private findItemById(itemId: string | null | undefined): ThreadItem | null {
    if (!itemId) return null;
    return this.snapshot.items.find((item) => item.id === itemId) ?? null;
  }

  private getLatestAgentItem(): ThreadItem | null {
    if (this.snapshot.activeAgentItemId) {
      const active = this.findItemById(this.snapshot.activeAgentItemId);
      if (active?.itemType === "agentMessage") return active;
    }
    for (let i = this.snapshot.items.length - 1; i >= 0; i -= 1) {
      if (this.snapshot.items[i].itemType === "agentMessage") return this.snapshot.items[i];
    }
    return null;
  }

  private appendItem(item: ThreadItem): void {
    this.update((prev) => ({ ...prev, items: [...prev.items, item] }));
  }

  private upsertItem(item: ThreadItem): void {
    this.update((prev) => {
      const index = prev.items.findIndex((candidate) => candidate.id === item.id);
      if (index < 0) {
        return { ...prev, items: [...prev.items, item] };
      }
      const items = [...prev.items];
      items[index] = item;
      return { ...prev, items };
    });
  }

  private ensureActiveAgentItem(): ThreadItem {
    const existing = this.getLatestAgentItem();
    if (existing) return existing;

    const agentItem = createThreadItem("agentMessage", ITEM_TYPE_REGISTRY.agentMessage.label, "");
    agentItem.status = "pending";
    agentItem.outputSegments = [];
    this.appendItem(agentItem);
    this.update((prev) => ({ ...prev, activeAgentItemId: agentItem.id }));
    return agentItem;
  }

  private appendTextSegment(item: ThreadItem, delta: string): void {
    if (!delta) return;
    const current = this.findItemById(item.id);
    if (!current) return;
    const segments = [...(current.outputSegments ?? [])];
    const last = segments[segments.length - 1];

    if (last?.kind === "text") {
      segments[segments.length - 1] = { ...last, text: `${last.text}${delta}` };
    } else {
      segments.push({
        id: createId("segment"),
        kind: "text",
        text: delta,
        createdAt: new Date().toISOString(),
      });
    }

    this.upsertItem({
      ...current,
      content: `${current.content}${delta}`,
      outputSegments: segments,
    });
  }

  private appendSubBlock(
    item: ThreadItem,
    itemType: ThreadItemType,
    protocolItemId?: string | null,
    customTitle?: string,
  ): SegmentRef {
    const current = this.findItemById(item.id);
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

    this.upsertItem({
      ...current,
      outputSegments: [...(current.outputSegments ?? []), segment],
    });

    const ref: SegmentRef = { itemId: current.id, segmentId: segment.id, itemType };
    if (protocolItemId) {
      this.protocolSubBlockMap.set(protocolItemId, ref);
    }
    return ref;
  }

  private updateSubBlock(ref: SegmentRef, updater: (segment: OutputSegment) => OutputSegment): void {
    const item = this.findItemById(ref.itemId);
    if (!item?.outputSegments) return;
    this.upsertItem({
      ...item,
      outputSegments: item.outputSegments.map((segment) => {
        if (segment.id !== ref.segmentId || segment.kind !== "subBlock") return segment;
        return updater(segment);
      }),
    });
  }

  private ensureSubBlockForMethod(method: string, params: unknown): SegmentRef {
    const protocolItemId = extractProtocolItemId(params);
    if (protocolItemId) {
      const existing = this.protocolSubBlockMap.get(protocolItemId);
      if (existing) return existing;
    }

    const itemType = inferItemTypeFromMethod(method);
    const agent = this.ensureActiveAgentItem();
    const ref = this.appendSubBlock(agent, itemType, protocolItemId);
    if (itemType === "reasoning") {
      this.activeReasoningRef = ref;
    }
    return ref;
  }

  private completeActiveTurn(statusText: string): void {
    if (this.interruptFallbackTimer) {
      window.clearTimeout(this.interruptFallbackTimer);
      this.interruptFallbackTimer = undefined;
    }
    const active = this.findItemById(this.snapshot.activeAgentItemId);
    if (active) {
      this.upsertItem({ ...active, status: undefined });
    }
    this.update((prev) => ({
      ...prev,
      isTurnActive: false,
      activeTurnId: null,
      activeAgentItemId: null,
    }));
    this.activeReasoningRef = null;
    this.setStatus(statusText);
  }

  private failActiveTurn(message: string): void {
    if (this.interruptFallbackTimer) {
      window.clearTimeout(this.interruptFallbackTimer);
      this.interruptFallbackTimer = undefined;
    }
    const active = this.findItemById(this.snapshot.activeAgentItemId);
    if (active) {
      this.upsertItem({ ...active, status: "error", error: message });
    }
    this.update((prev) => ({
      ...prev,
      isTurnActive: false,
      activeTurnId: null,
      activeAgentItemId: null,
    }));
    this.setStatus(message, "error");
  }

  private handleMethodDelta(method: string, params: unknown): void {
    const lower = method.toLowerCase();
    const protocolItemId = extractProtocolItemId(params);
    const mappedMessageId = protocolItemId ? this.protocolMessageMap.get(protocolItemId) : null;
    const mappedMessage = this.findItemById(mappedMessageId);
    const delta = extractTextDelta(params);

    if (lower.includes("agentmessage/delta")) {
      const target = mappedMessage?.itemType === "agentMessage" ? mappedMessage : this.ensureActiveAgentItem();
      this.appendTextSegment(target, delta);
      return;
    }

    if (lower.includes("reasoning/summarytextdelta") || lower.includes("summary_text_delta")) {
      const ref = this.activeReasoningRef ?? this.ensureSubBlockForMethod(method, params);
      if (delta) {
        this.updateSubBlock(ref, (segment) => ({ ...segment, text: `${segment.text}${delta}` }));
      }
      return;
    }

    const ref = this.ensureSubBlockForMethod(method, params);
    if (delta) {
      this.updateSubBlock(ref, (segment) => ({
        ...segment,
        text: `${segment.text}${delta}`,
        raw: { ...(segment.raw ?? {}), lastDelta: delta },
      }));
    }
  }

  private parseApprovalQuestions(params: Record<string, unknown>): ApprovalQuestion[] {
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

  private upsertPendingApproval(request: PendingApprovalRequest): void {
    this.update((prev) => {
      const index = prev.pendingApprovals.findIndex((candidate) => candidate.requestId === request.requestId);
      if (index < 0) {
        return { ...prev, pendingApprovals: [...prev.pendingApprovals, request] };
      }
      const pendingApprovals = [...prev.pendingApprovals];
      pendingApprovals[index] = request;
      return { ...prev, pendingApprovals };
    });
  }

  private markPendingApprovalSubmitting(requestId: string, submitting: boolean, error?: string): void {
    this.update((prev) => ({
      ...prev,
      pendingApprovals: prev.pendingApprovals.map((request) => {
        if (request.requestId !== requestId) return request;
        return { ...request, submitting, error };
      }),
    }));
  }

  private removePendingApproval(requestId: string): void {
    this.update((prev) => ({
      ...prev,
      pendingApprovals: prev.pendingApprovals.filter((request) => request.requestId !== requestId),
    }));
  }

  private handleServerRequest(requestId: string, method: string, params: unknown): void {
    const lower = method.toLowerCase();
    const record = parseObject(params) ?? {};
    const threadId = parseString(record.threadId) ?? this.snapshot.threadId ?? "unknown";
    const turnId = parseString(record.turnId) ?? this.snapshot.activeTurnId ?? "unknown";
    const itemId = parseString(record.itemId) ?? requestId;
    const reason = parseString(record.reason);
    const createdAt = new Date().toISOString();

    if (lower === "item/commandexecution/requestapproval") {
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
        commandActions: toArray(record.commandActions)
          .map((entry) => {
            const action = parseObject(entry);
            return parseString(action?.label) ?? parseString(action?.type);
          })
          .filter((entry): entry is string => Boolean(entry)),
        submitting: false,
      };
      this.upsertPendingApproval(request);
      this.setStatus("Approval required");
      return;
    }

    if (lower === "item/filechange/requestapproval") {
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
      this.upsertPendingApproval(request);
      this.setStatus("Approval required");
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
        questions: this.parseApprovalQuestions(record),
        submitting: false,
      };
      this.upsertPendingApproval(request);
      this.setStatus("User input required");
    }
  }

  private handleItemStarted(params: unknown): void {
    const itemContainer = extractItemContainer(params) ?? {};
    const rawType = itemContainer.type ?? itemContainer.itemType ?? itemContainer.item_type;
    const protocolItemId = extractProtocolItemId(params);
    const itemType = normalizeThreadItemType(rawType) ?? "unknown";

    if (itemType === "userMessage") {
      return;
    }

    if (itemType === "agentMessage") {
      const message = this.ensureActiveAgentItem();
      if (protocolItemId) this.protocolMessageMap.set(protocolItemId, message.id);
      return;
    }

    const agent = this.ensureActiveAgentItem();
    const ref = this.appendSubBlock(agent, itemType, protocolItemId);
    this.updateSubBlock(ref, (segment) => ({
      ...segment,
      details: {
        ...(segment.details ?? {}),
        startedAt: new Date().toISOString(),
        displayName: parseString(itemContainer.displayName ?? itemContainer.display_name),
        opName: parseString(itemContainer.opName ?? itemContainer.op_name),
      },
      raw: {
        ...(segment.raw ?? {}),
        started: parseObject(params) ?? params,
      },
    }));
  }

  private handleItemCompleted(_method: string, params: unknown): void {
    const itemContainer = extractItemContainer(params) ?? {};
    const rawType = itemContainer.type ?? itemContainer.itemType ?? itemContainer.item_type;
    const completedItemType = normalizeThreadItemType(rawType);

    if (completedItemType === "userMessage") {
      return;
    }

    const protocolItemId = extractProtocolItemId(params);
    const ref = protocolItemId ? this.protocolSubBlockMap.get(protocolItemId) : null;

    if (ref) {
      const details: Record<string, unknown> = {};
      let completionText: string | undefined;

      if (ref.itemType === "commandExecution") {
        const command = parseString(itemContainer.command);
        const cwd = parseString(itemContainer.cwd);
        const output = parseString(itemContainer.output ?? itemContainer.aggregatedOutput ?? itemContainer.aggregated_output);
        const exitCode = parseNumber(itemContainer.exitCode ?? itemContainer.exit_code);
        const durationMs = parseNumber(itemContainer.durationMs ?? itemContainer.duration_ms);
        if (command) details.command = command;
        if (cwd) details.cwd = cwd;
        if (output) details.output = output;
        if (exitCode !== null) details.exitCode = exitCode;
        if (durationMs !== null) details.durationMs = durationMs;
      }

      if (ref.itemType === "fileChange") {
        const changes = toArray(itemContainer.changes ?? itemContainer.fileChanges ?? itemContainer.file_changes);
        details.changeCount = changes.length;
        details.diff = parseString(itemContainer.diff);
      }

      if (ref.itemType === "mcpToolCall") {
        const durationMs = extractMcpDurationMs(params, itemContainer);
        const error = extractMcpError(params, itemContainer);
        const structuredContent = extractMcpStructuredContent(params, itemContainer);
        if (durationMs !== null) details.durationMs = durationMs;
        if (error !== null) details.error = error;
        if (structuredContent !== null) details.structuredContent = structuredContent;

        const lines: string[] = [];
        if (durationMs !== null) lines.push(`duration: ${durationMs}ms`);
        if (error !== null) lines.push(`error: ${typeof error === "string" ? error : JSON.stringify(error, null, 2)}`);
        if (structuredContent !== null) {
          lines.push("structuredContent:");
          lines.push(typeof structuredContent === "string" ? structuredContent : JSON.stringify(structuredContent, null, 2));
        }
        completionText = lines.join("\n");
      }

      this.updateSubBlock(ref, (segment) => ({
        ...segment,
        text: completionText ?? segment.text,
        status: "completed",
        details: { ...(segment.details ?? {}), ...details, completedAt: new Date().toISOString() },
        raw: { ...(segment.raw ?? {}), completed: parseObject(params) ?? params },
      }));
      return;
    }

    if (completedItemType === "agentMessage") {
      this.completeActiveTurn("Turn completed");
    }
  }

  private handleItemFailed(params: unknown): void {
    const protocolItemId = extractProtocolItemId(params);
    const ref = protocolItemId ? this.protocolSubBlockMap.get(protocolItemId) : null;
    const itemContainer = extractItemContainer(params) ?? {};
    const error = extractErrorText(params, itemContainer) ?? "Operation failed";

    if (ref) {
      this.updateSubBlock(ref, (segment) => ({
        ...segment,
        status: "error",
        error,
        details: { ...(segment.details ?? {}), failedAt: new Date().toISOString() },
        raw: { ...(segment.raw ?? {}), failed: parseObject(params) ?? params },
      }));
      return;
    }

    const rawType = itemContainer.type ?? itemContainer.itemType ?? itemContainer.item_type;
    const failedItemType = normalizeThreadItemType(rawType);

    if (failedItemType === "agentMessage") {
      this.failActiveTurn(error);
      return;
    }

    const agent = this.ensureActiveAgentItem();
    const fallbackRef = this.appendSubBlock(agent, failedItemType, protocolItemId);
    this.updateSubBlock(fallbackRef, (segment) => ({
      ...segment,
      status: "error",
      error,
      text: segment.text || error,
      raw: { ...(segment.raw ?? {}), failed: parseObject(params) ?? params },
    }));
  }

  private handleNotification(method: string, params: unknown): void {
    const lower = method.toLowerCase();

    if (lower === "turn/plan/updated") {
      const agent = this.ensureActiveAgentItem();
      const ref = this.appendSubBlock(agent, "plan", extractProtocolItemId(params), ITEM_TYPE_REGISTRY.plan.label);
      const record = parseObject(params) ?? {};
      const explanation = parseString(record.explanation) ?? parseString(record.summary) ?? parseString(record.text) ?? "";
      this.updateSubBlock(ref, (segment) => ({ ...segment, text: explanation, status: "completed" }));
      return;
    }

    if (lower === "item/started") {
      this.handleItemStarted(params);
      return;
    }

    if (lower === "item/completed") {
      this.handleItemCompleted(method, params);
      return;
    }

    if (lower === "item/failed" || lower === "item/errored" || lower === "item/error") {
      this.handleItemFailed(params);
      return;
    }

    if (
      lower.endsWith("/delta") ||
      lower.endsWith("outputdelta") ||
      lower.endsWith("textdelta") ||
      lower.endsWith("summarytextdelta") ||
      lower.includes("summary_text_delta")
    ) {
      this.handleMethodDelta(method, params);
      return;
    }

    if (lower === "turn/completed" || lower.endsWith("turn/completed")) {
      this.completeActiveTurn("Turn completed");
      return;
    }

    if (lower.includes("turn/interrupted") || lower.includes("turn/cancel") || lower.endsWith("turn/stopped")) {
      this.completeActiveTurn("Turn interrupted");
      return;
    }

    if (lower.includes("turn/error") || lower.endsWith("turn/errored")) {
      this.failActiveTurn("Turn failed");
    }
  }

  private handleBridgeEvent(event: BridgeEvent): void {
    if (event.type === "error") {
      this.setStatus(event.message ?? "Bridge error", "error");
      return;
    }

    if (event.type === "ready") {
      this.setStatus("App server ready");
      return;
    }

    if (event.type === "thread_started") {
      this.update((prev) => ({ ...prev, threadId: event.threadId ?? null }));
      this.setStatus(
        event.threadId
          ? `Thread ready (${event.threadId}) • approval=${this.snapshot.selectedApprovalPolicy}`
          : `Thread ready • approval=${this.snapshot.selectedApprovalPolicy}`,
      );
      return;
    }

    if (event.type === "turn_started") {
      this.update((prev) => ({ ...prev, activeTurnId: event.turnId ?? prev.activeTurnId, isTurnActive: true }));
      this.setStatus("Turn started", "pending");
      return;
    }

    if (event.type === "notification" && event.method) {
      this.handleNotification(event.method, event.params);
      return;
    }

    if (event.type === "server_request" && event.method && event.requestId) {
      this.handleServerRequest(event.requestId, event.method, event.params);
    }
  }

  async connect(): Promise<void> {
    const source = connectEventStream(
      (event) => this.handleBridgeEvent(event),
      () => this.setStatus("Event stream disconnected", "error"),
    );
    this.update((prev) => ({ ...prev, eventSource: source }));
  }

  setApprovalPolicy(policy: string): void {
    if (!isApprovalPolicy(policy)) return;
    this.update((prev) => ({ ...prev, selectedApprovalPolicy: policy }));
    this.setStatus(`Approval policy set to ${policy}`);
  }

  setSubBlockDisplayMode(itemId: string, segmentId: string, mode: DisplayMode): void {
    this.update((prev) => ({
      ...prev,
      items: prev.items.map((item) => {
        if (item.id !== itemId || !item.outputSegments) return item;
        return {
          ...item,
          outputSegments: item.outputSegments.map((segment) => {
            if (segment.id !== segmentId || segment.kind !== "subBlock") return segment;
            return { ...segment, displayMode: mode };
          }),
        };
      }),
    }));
  }

  async submitTurn(input: string): Promise<void> {
    if (this.snapshot.isTurnActive) return;
    const trimmed = input.trim();
    if (!trimmed) return;

    if (!this.snapshot.threadId) {
      const response = await startThread(this.snapshot.selectedApprovalPolicy);
      this.update((prev) => ({ ...prev, threadId: response.threadId }));
    }

    this.appendItem(createThreadItem("userMessage", ITEM_TYPE_REGISTRY.userMessage.label, trimmed));

    const output = createThreadItem("agentMessage", ITEM_TYPE_REGISTRY.agentMessage.label, "");
    output.status = "pending";
    output.outputSegments = [];
    this.appendItem(output);

    this.update((prev) => ({
      ...prev,
      activeAgentItemId: output.id,
      isTurnActive: true,
    }));
    this.setStatus("Starting turn...", "pending");

    try {
      const response = await startTurn(trimmed, this.snapshot.selectedApprovalPolicy);
      this.update((prev) => ({ ...prev, activeTurnId: response.turnId ?? prev.activeTurnId }));
    } catch (error) {
      this.failActiveTurn(error instanceof Error ? error.message : "Failed to start turn");
    }
  }

  async interruptActiveTurn(): Promise<void> {
    if (!this.snapshot.isTurnActive) return;
    try {
      await interruptTurn(this.snapshot.activeTurnId);
      this.setStatus("Interrupt requested");
      if (this.interruptFallbackTimer) {
        window.clearTimeout(this.interruptFallbackTimer);
      }
      this.interruptFallbackTimer = window.setTimeout(() => {
        if (!this.snapshot.isTurnActive) return;
        this.completeActiveTurn("Turn interrupted");
      }, 1200);
    } catch (error) {
      this.setStatus(error instanceof Error ? error.message : "Interrupt failed", "error");
    }
  }

  async newThread(): Promise<void> {
    this.protocolMessageMap.clear();
    this.protocolSubBlockMap.clear();
    this.activeReasoningRef = null;

    this.update((prev) => ({
      ...prev,
      activeTurnId: null,
      activeAgentItemId: null,
      isTurnActive: false,
      items: [],
      pendingApprovals: [],
    }));

    try {
      const response = await startThread(this.snapshot.selectedApprovalPolicy);
      this.update((prev) => ({ ...prev, threadId: response.threadId }));
      this.setStatus(`Thread ready (${response.threadId}) • approval=${this.snapshot.selectedApprovalPolicy}`);
    } catch (error) {
      this.setStatus(error instanceof Error ? error.message : "Failed to start thread", "error");
    }
  }

  async submitCommandApproval(requestId: string, decision: string): Promise<void> {
    if (!isCommandDecision(decision)) return;
    this.markPendingApprovalSubmitting(requestId, true);
    try {
      await respondCommandApproval(requestId, decision);
      this.removePendingApproval(requestId);
      this.setStatus("Command approval submitted");
    } catch (error) {
      this.markPendingApprovalSubmitting(
        requestId,
        false,
        error instanceof Error ? error.message : "Failed to submit command approval",
      );
      this.setStatus("Command approval failed", "error");
    }
  }

  async submitFileChangeApproval(requestId: string, decision: string): Promise<void> {
    if (!isFileChangeDecision(decision)) return;
    this.markPendingApprovalSubmitting(requestId, true);
    try {
      await respondFileChangeApproval(requestId, decision);
      this.removePendingApproval(requestId);
      this.setStatus("File change approval submitted");
    } catch (error) {
      this.markPendingApprovalSubmitting(
        requestId,
        false,
        error instanceof Error ? error.message : "Failed to submit file change approval",
      );
      this.setStatus("File change approval failed", "error");
    }
  }

  async submitToolUserInput(requestId: string, answers: Record<string, { answers: string[] }>): Promise<void> {
    this.markPendingApprovalSubmitting(requestId, true);
    try {
      await respondToolUserInput(requestId, answers);
      this.removePendingApproval(requestId);
      this.setStatus("Tool input submitted");
    } catch (error) {
      this.markPendingApprovalSubmitting(
        requestId,
        false,
        error instanceof Error ? error.message : "Failed to submit tool input",
      );
      this.setStatus("Tool input failed", "error");
    }
  }
}
