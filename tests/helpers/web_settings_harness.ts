import { ApplicationActionError } from "../../server/core/action_error";
import type { ThreadModelState, ThreadEffortState, ModelSummary } from "../../shared/protocol/requests";
import type { webHarness } from "./web_harness";

export function installWebSettings(h: ReturnType<typeof webHarness>) {
  const models: ModelSummary[] = ["small", "large"].map((model) => ({ id: model, model, displayName: model === "small" ? "Small model" : "Large model", description: "Fixture model", hidden: false, isDefault: model === "small", supportsPersonality: false, defaultReasoningEffort: "low", supportedReasoningEfforts: (model === "small" ? ["low"] : ["low", "high"]).map((reasoningEffort) => ({ reasoningEffort, description: reasoningEffort })) }));
  const states = new Map<string, ThreadModelState>();
  const efforts = new Map<string, string>();
  const getThreadModel = (threadId: string) => {
    let state = states.get(threadId);
    if (!state) { state = { threadId, currentModel: "small", pendingModel: null, modelProvider: "fixture" }; states.set(threadId, state); }
    return state;
  };
  const getThreadEffort = async (threadId: string): Promise<ThreadEffortState> => {
    const state = getThreadModel(threadId);
    const model = models.find((m) => m.model === (state.pendingModel ?? state.currentModel))!;
    return { threadId, model: model.model, currentEffort: "low", pendingEffort: efforts.get(threadId) ?? null, defaultEffort: model.defaultReasoningEffort!, supportedEfforts: model.supportedReasoningEfforts! };
  };
  Object.assign(h.application, { getSurfaceThreadId: (id: string) => h.bindings.get(id) ?? null });
  const controls = {
    getThreadModel,
    setThreadModel(threadId: string, model: string) { const state = { ...getThreadModel(threadId), pendingModel: model }; states.set(threadId, state); return state; },
    getThreadEffort,
    async setThreadEffort(threadId: string, requested: string) {
      const state = await getThreadEffort(threadId);
      const effort = requested === "default" ? state.defaultEffort! : requested;
      if (!state.supportedEfforts.some((option) => option.reasoningEffort === effort)) throw new ApplicationActionError({ code: "unsupported_effort", model: state.model, requested, available: state.supportedEfforts.map((x) => x.reasoningEffort) });
      efforts.set(threadId, effort); return { ...state, pendingEffort: effort };
    },
    async listModels({ cursor }: { cursor?: string }) { return { data: [models[cursor ? 1 : 0]!], nextCursor: cursor ? null : "next" }; },
    async readThreadTokenUsage(threadId: string) { return { threadId, tokenUsage: null }; },
    async readAccountRateLimits() { return { rateLimits: { planType: "fixture", primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 2000000000 }, credits: { hasCredits: false, unlimited: false, balance: null } } }; },
  };
  Object.assign(h.application.conversation, controls);
  return { controls, states, efforts };
}
