import type { UserInput } from "./user_input.js";

export type ModelInputModality = "text" | "image" | "audio";

/** Provider-defined effort values; clients must not infer levels from model names. */
export interface EffortOption { value: string; description: string }

/** Model support, independent of adapter transport and lifecycle capabilities. */
export interface ModelCapabilities {
  /** Null means unreported, not unsupported. An empty list means no supported modalities. */
  inputModalities: readonly ModelInputModality[] | null;
  /** Null means unreported; an empty array means no supported effort values. */
  supportedEfforts: EffortOption[] | null;
  defaultEffort: string | null;
}

export class UnsupportedModelInputError extends Error {
  constructor(readonly model: string, readonly modality: ModelInputModality) {
    super(`Model "${model}" does not support ${modality} inputs.`);
  }
}

export function inputModality(input: UserInput): ModelInputModality | null {
  switch (input.type) {
    case "text": return "text";
    case "image": case "image_file": return "image";
    case "audio": case "audio_file": return "audio";
    case "skill": return null;
  }
}

/** Unknown model data leaves enforcement to the adapter; it never grants adapter support. */
export function unsupportedModelInput(capabilities: ModelCapabilities, input: readonly UserInput[]): ModelInputModality | null {
  if (capabilities.inputModalities === null) return null;
  for (const part of input) {
    const modality = inputModality(part);
    if (modality && !capabilities.inputModalities.includes(modality)) return modality;
  }
  return null;
}
