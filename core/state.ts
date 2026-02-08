import type { AgentState, ThreadItem, ThreadItemType } from "./types.js";

export const state: AgentState = {
  threadId: null,
  items: [],
  activeTurnId: null,
  activeAgentItemId: null,
  isTurnActive: false,
};

export function createId(prefix: string): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function createThreadItem(itemType: ThreadItemType, label: string, content: string): ThreadItem {
  return {
    id: createId("item"),
    itemType,
    label,
    content,
    createdAt: new Date().toISOString(),
  };
}
