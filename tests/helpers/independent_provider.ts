import { bridgeEvent, type BridgeEventType, type BridgeEventPayloads } from "../../shared/protocol/events.js";
import { EventBus } from "../../server/providers/event_bus.js";
import type { ProviderSession, TurnSettings } from "../../server/ports/provider_session.js";
import type { ProviderDescriptor } from "../../shared/protocol/providers.js";
import type { UserInput } from "../../shared/protocol/user_input.js";
import type { HistoryTurn } from "../../shared/protocol/requests.js";
export const descriptor: ProviderDescriptor = { id: "unrelated-provider", displayName: "An unrelated agent", isDefault: true, capabilities: { steer: true, interrupt: true, rename: true, archive: true, unarchive: true, workspaceChange: true, modelCatalog: true, modelCatalogScope: "provider", modelCatalogAuthoritative: true, modelSelection: true, effortSelection: true, skillConfig: false, questions: true, skills: false, compact: false, revert: false, fork: false, sandboxModes: [], approvalModes: ["provider_default", "review_sensitive", "bypass"], inputKinds: ["text", "image", "image_file"], imageDetail: false, accountReset: false } };

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
  model = "third-model";
  effort: string | null = "focused";
  turns: HistoryTurn[] = [];
  async initialize() {}
  async startThread() { this.threadId = `opaque-${crypto.randomUUID()}`; return this.bootstrap(); }
  async resumeThread(threadId: string) { this.threadId = threadId; return this.bootstrap(); }
  private bootstrap() { return { threadId: this.threadId, cwd: this.cwd, model: this.model, effort: this.effort, approvalPolicy: this.approvalPolicy }; }
  /** Tests replace this to observe or fail a turn start; the session still reports what it applied. */
  onTurn: (input: UserInput[], settings: TurnSettings) => unknown = () => {};
  async startTurn(input: UserInput[], settings: TurnSettings = {}) {
    await this.onTurn(input, settings);
    const { model, effort } = settings;
    this.inputs = structuredClone(input); this.activeTurnId = "opaque-turn";
    if (model) this.model = model;
    if (effort !== undefined) this.effort = effort;
    this.emit("thread.settings.changed", { model: this.model, effort: this.effort, cwd: this.cwd, approvalPolicy: this.approvalPolicy });
    this.turns.push({ id: this.activeTurnId, items: [{ id: "reply", type: "assistant_message", text: "Third provider answer", phase: "final" }], itemsView: "full", status: "in_progress", error: null, startedAt: 1, completedAt: null, durationMs: null });
    this.emit("turn.started", { turnId: this.activeTurnId });
    this.emit("item.delta", { turnId: this.activeTurnId, itemId: "reply", channel: "message", delta: "Third provider answer", phase: "final" });
    return this.activeTurnId;
  }
  async steerTurn(input: UserInput[]) { this.inputs.push(...input); return this.activeTurnId; }
  async interruptTurn() { const turnId = this.activeTurnId; this.activeTurnId = null; this.emit("turn.completed", { turnId }); }
  async applyApprovalDecision(approvalId: string) { return { approvalId }; }
  setCwd(cwd: string) { this.cwd = cwd; this.emit("thread.settings.changed", { model: this.model, effort: this.effort, cwd, approvalPolicy: this.approvalPolicy }); }
  stop() { this.stopped = true; }
  emit<K extends BridgeEventType>(type: K, payload: BridgeEventPayloads[K]) { this.eventBus.publish(bridgeEvent({ id: crypto.randomUUID(), type, payload, threadId: this.threadId, sessionId: this.sessionId, ts: new Date().toISOString() })); }
  async listStoredThreads() { return { data: [{ id: this.threadId, cwd: this.cwd }], nextCursor: null }; }
  async readThread(threadId: string) { return { thread: { id: threadId, cwd: this.cwd, model: "third-model" } }; }
  async listThreadTurns() { return { data: this.turns, nextCursor: null, backwardsCursor: null }; }
  async listThreadItems() { return { data: this.turns.flatMap(turn => turn.items.map(item => ({ turnId: turn.id, item }))), nextCursor: null, backwardsCursor: null }; }
  async setThreadName() {}
  async archiveThread() {}
  async unarchiveThread() {}
  async listModels() { return { data: [{ id: "third-model", displayName: "Third model", description: "", hidden: false, isDefault: true, inputModalities: ["text", "image"] as const, defaultEffort: "focused", supportedEfforts: [{ value: "focused", description: "Focus" }] }], nextCursor: null }; }
}
