import type { DynamicToolCallParams, DynamicToolCallResponse } from "../../shared/protocol/dynamic_tools.js";

export type SwarmManagerHandler = (params: DynamicToolCallParams) => Promise<unknown>;

/** Runtime capabilities supplied to swarm orchestration, without process ownership. */
export type SwarmManagerBridge = {
  connect: (handler: SwarmManagerHandler) => () => void;
  watch: (params: DynamicToolCallParams, group: string, threads: Array<{ threadId: string; label: string }>) => Promise<DynamicToolCallResponse>;
};
