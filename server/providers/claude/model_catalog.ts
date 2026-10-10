import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import type { ModelSummary } from "../../../shared/protocol/requests.js";
import type { claudeDefaults } from "./defaults.js";

/** Keep wire IDs visible and aliases available for existing conversations. */
export function claudeModelCatalog(models: ModelInfo[], defaults: ReturnType<typeof claudeDefaults>): ModelSummary[] {
  const preferred = models.find(model => model.value === defaults.model || model.resolvedModel === defaults.model);
  const defaultModel = preferred?.resolvedModel ?? preferred?.value;
  const rows = new Map<string, ModelSummary>();
  function row(model: ModelInfo, id: string, hidden: boolean): ModelSummary {
    const efforts = model.supportedEffortLevels ?? [];
    return { id, model: id, displayName: model.displayName, description: model.description,
      hidden, isDefault: !hidden && id === defaultModel,
      defaultReasoningEffort: model.supportsEffort && efforts.includes(defaults.effort) ? defaults.effort : null,
      supportedReasoningEfforts: efforts.map(reasoningEffort => ({ reasoningEffort, description: "" })) };
  }
  for (const model of models) {
    const id = model.resolvedModel ?? model.value;
    if (!rows.has(id)) rows.set(id, row(model, id, false));
  }
  for (const model of models) if (!rows.has(model.value)) rows.set(model.value, row(model, model.value, true));
  return [...rows.values()];
}
