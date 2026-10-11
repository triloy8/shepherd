import { bridgeEvent, type BridgeEventType, type BridgeEventPayloads } from "../../shared/protocol/events.js";
import { EventBus } from "../../server/providers/event_bus.js";
import type { ProviderSession } from "../../server/ports/provider_session.js";
import type { ProviderDescriptor } from "../../shared/protocol/providers.js";
import type { UserInput } from "../../shared/protocol/user_input.js";
import type { HistoryTurn } from "../../shared/protocol/requests.js";
export const descriptor: ProviderDescriptor = { id: "unrelated-provider", displayName: "An unrelated agent", isDefault: true, capabilities: { questions: true, skills: false, compact: false, revert: false, fork: false, sandboxModes: [], approvalModes: ["provider_default", "review_sensitive", "bypass"], inputKinds: ["text", "image", "image_file"], imageDetail: false, ephemeralThreads: false, resets: false } };

/** Implements the actual port directly; no SDK session, proxy, or compatibility methods. */
export class IndependentSession implements ProviderSession {
  readonly capabilities = descriptor.capabilities;
  readonly sessionId = crypto.randomUUID();
  readonly eventBus = new EventBus();
  activeTurnId: string | null = null;
  approvalPolicy = "review_sensitive" as const;
  inputs: UserInput[] = [];
  stopped = false;
  cwd = "/tmp";
  threadId = "";
  turns: HistoryTurn[] = [];
  async initialize() {}
  async startThread() { this.threadId = `opaque-${crypto.randomUUID()}`; return this.bootstrap(); }
  async resumeThread(threadId: string) { this.threadId = threadId; return this.bootstrap(); }
  private bootstrap() { return { threadId: this.threadId, model: "third-model", effort: "focused" }; }
  async startTurn(input: UserInput[]) {
    this.inputs = structuredClone(input); this.activeTurnId = "opaque-turn";
    this.turns.push({ id: this.activeTurnId, items: [{ id: "reply", type: "assistant_message", text: "Third provider answer", phase: "final" }], itemsView: "full", status: "in_progress", error: null, startedAt: 1, completedAt: null, durationMs: null });
    this.emit("turn.started", { turnId: this.activeTurnId });
    this.emit("turn.stream.delta", { kind: "assistant_text", turnId: this.activeTurnId, itemId: "reply", textDelta: "Third provider answer", phase: "final" });
    return this.activeTurnId;
  }
  async steerTurn(input: UserInput[]) { this.inputs.push(...input); return this.activeTurnId; }
  async interruptTurn() { const turnId = this.activeTurnId; this.activeTurnId = null; this.emit("turn.completed", { turnId }); }
  async applyApprovalDecision(approvalId: string) { return { approvalId }; }
  setCwd(cwd: string) { this.cwd = cwd; }
  stop() { this.stopped = true; }
  private emit<K extends BridgeEventType>(type: K, payload: BridgeEventPayloads[K]) { this.eventBus.publish(bridgeEvent({ id: crypto.randomUUID(), type, payload, threadId: this.threadId, sessionId: this.sessionId, ts: new Date().toISOString() })); }
  async listStoredThreads() { return { data: [{ id: this.threadId, cwd: this.cwd }], nextCursor: null }; }
  async listLoadedThreads() { return { data: this.threadId ? [this.threadId] : [], nextCursor: null }; }
  async readThread(threadId: string) { return { thread: { id: threadId, cwd: this.cwd } }; }
  async listThreadTurns() { return { data: this.turns, nextCursor: null, backwardsCursor: null }; }
  async listThreadItems() { return { data: this.turns.flatMap(turn => turn.items.map(item => ({ turnId: turn.id, item }))), nextCursor: null, backwardsCursor: null }; }
  async setThreadName() {}
  async archiveThread() {}
  async unarchiveThread() {}
  async listModels() { return { data: [{ id: "third-model", displayName: "Third model", description: "", hidden: false, isDefault: true, defaultEffort: "focused", supportedEfforts: [{ value: "focused", description: "Focus" }] }], nextCursor: null }; }
}
