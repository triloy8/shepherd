import { EventBus } from "../../server/ports/event_bus.js";
import type { ProviderSession, TurnSettings } from "../../server/ports/provider_session.js";
import { bridgeEvent, type BridgeEventPayloads, type BridgeEventType } from "../../shared/protocol/events.js";
import type { ProviderCapabilities } from "../../shared/protocol/provider_capabilities.js";
import type { CreateThreadRequest, ListModelsRequest, ModelSummary, ResumeThreadRequest } from "../../shared/protocol/requests.js";
import type { UserInput } from "../../shared/protocol/user_input.js";

export const capabilities: ProviderCapabilities = {
  steer: false, interrupt: false, rename: false, archive: false, unarchive: false,
  workspaceChange: false, modelCatalog: false, modelSelection: false, effortSelection: false,
  skillConfig: false, questions: false, skills: false, compact: false, revert: false, fork: false,
  accountReset: false, sandboxModes: [], approvalModes: ["provider_default"], inputKinds: ["text"],
  imageDetail: false,
};
export const model = (id: string, isDefault = false): ModelSummary => ({ id, isDefault, displayName: id,
  description: "", hidden: false, inputModalities: null, defaultEffort: null, supportedEfforts: [] });

/** Independent execution model: no SDK, advertised default, account reader, or external loaded threads. */
export class LocalSession implements ProviderSession {
  readonly sessionId = crypto.randomUUID();
  readonly eventBus = new EventBus();
  activeTurnId: string | null = null;
  approvalPolicy = "provider_default" as const;
  bound = false;
  stopped = false;
  calls: Array<{ model?: string; effort?: string | null }> = [];
  decisions: string[] = [];
  readIds: string[] = [];
  selectedModel: string | null = null;
  effort: string | null = null;
  rows: ModelSummary[] = [];
  constructor(readonly capabilities: ProviderCapabilities) {}
  async initialize() {}
  stop() { this.stopped = true; }
  async startThread(_request?: CreateThreadRequest) { this.bound = true; return { threadId: "1", cwd: "/tmp", model: this.selectedModel, effort: null, approvalPolicy: this.approvalPolicy }; }
  async resumeThread(id: string, request?: ResumeThreadRequest) { this.readIds.push(id); return this.startThread(request); }
  async startTurn(_input: UserInput[], { model: selected, effort }: TurnSettings = {}) {
    this.calls.push({ model: selected, effort }); this.activeTurnId = "turn";
    if (selected) this.selectedModel = selected;
    if (effort !== undefined) this.effort = effort;
    this.emit("thread.settings.changed", { model: this.selectedModel, effort: this.effort, cwd: "/tmp", approvalPolicy: this.approvalPolicy });
    this.emit("turn.started", { turnId: "turn" });
    return "turn";
  }
  emit<K extends BridgeEventType>(type: K, payload: BridgeEventPayloads[K]) { this.eventBus.publish(bridgeEvent({ id: crypto.randomUUID(), type, payload, threadId: "1", sessionId: this.sessionId, ts: new Date().toISOString() })); }
  async applyApprovalDecision(id: string) { this.decisions.push(id); return { approvalId: id }; }
  async listStoredThreads() { return { data: [{ id: "1", cwd: "/tmp" }], nextCursor: null }; }
  async readThread(id: string) { this.readIds.push(id); return { thread: { id, cwd: "/tmp", model: this.selectedModel } }; }
  async listThreadTurns(id: string) { this.readIds.push(id); return { data: [], nextCursor: null, backwardsCursor: null }; }
  async listThreadItems(id: string) { this.readIds.push(id); return { data: [], nextCursor: null, backwardsCursor: null }; }
  async listModels(_request?: ListModelsRequest) { return { data: this.rows, nextCursor: null }; }
}
