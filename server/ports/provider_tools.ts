import type { DynamicToolCallParams, DynamicToolCallResponse, DynamicToolSpec } from "../../shared/protocol/dynamic_tools.js";

/** Application tools offered to provider sessions. Adapters expose them through their native tool mechanism. */
export interface ProviderTools {
  hasTools(): boolean;
  specifications(): DynamicToolSpec[];
  execute(params: DynamicToolCallParams): Promise<DynamicToolCallResponse>;
}

export class InvalidDynamicToolCallError extends Error {}
export class UnknownDynamicToolError extends Error {}

export const noProviderTools: ProviderTools = {
  hasTools: () => false,
  specifications: () => [],
  execute: async () => { throw new UnknownDynamicToolError("Shepherd has no dynamic tools registered."); },
};
