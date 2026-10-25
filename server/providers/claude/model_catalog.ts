import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import type { ModelSummary } from "../../../shared/protocol/requests.js";
import type { claudeDefaults } from "./defaults.js";

/** Keep wire IDs visible and aliases available for existing conversations. */
export function claudeModelCatalog(models: ModelInfo[], defaults: ReturnType<typeof claudeDefaults>): ModelSummary[] {
  const preferred = models.find(model => model.value === defaults.model || model.resolvedModel === defaults.model);
  const defaultModel = preferred?.resolvedModel ?? preferred?.value;
  const rows = new Map<string, ModelSummary>();
  function row(model: ModelInfo, id: string, hidden: boolean): ModelSummary {
    const efforts = model.supportsEffort === false ? [] : model.supportedEffortLevels ?? null;
    return { id, displayName: model.displayName, description: model.description,
      hidden, isDefault: !hidden && id === defaultModel,
      // The SDK's ModelInfo has no modality metadata. Do not invent model support.
      inputModalities: null,
      defaultEffort: efforts?.includes(defaults.effort) ? defaults.effort : null,
      supportedEfforts: efforts?.map(value => ({ value, description: "" })) ?? null };
  }
  // Claude lists its own default first, under a generic name, resolving to the same ID as a
  // named alias. The named entry names the model; "default" stays a hidden alias.
  const named = [...models.filter(model => model.value !== "default"), ...models.filter(model => model.value === "default")];
  for (const model of named) {
    const id = model.resolvedModel ?? model.value;
    if (!rows.has(id)) rows.set(id, row(model, id, false));
  }
  for (const model of models) if (!rows.has(model.value)) rows.set(model.value, row(model, model.value, true));
  return [...rows.values()];
}
