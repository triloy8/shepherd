import type { TurnRoutingConversation } from "./turn_routing_service.js";
import type { ConversationService } from "./conversation_service.js";

const readMethods = [
  "getThreadState", "getThreadModel", "listStoredThreads", "listLoadedThreads",
  "listModels", "listSkills", "listThreadTurns", "listThreadItems",
] as const;
const controlMethods = [
  "getThreadEffort", "setThreadEffort", "writeSkillConfig", "setThreadModel",
  "readAccountRateLimits", "readThreadTokenUsage", "setThreadName", "readThread",
  "archiveThread", "unarchiveThread", "rollbackThread", "compactThread", "interruptTurn",
] as const;

export type ConversationReads = Pick<ConversationService, typeof readMethods[number]>;
export type ConversationControls = Pick<ConversationService, typeof controlMethods[number]>;
export type ApplicationConversation = ConversationReads & ConversationControls;
export type InteractionConversation = Pick<ConversationReads,
  "listStoredThreads" | "listLoadedThreads" | "listModels" | "getThreadModel" | "listSkills" | "listThreadTurns" | "listThreadItems"
> & Pick<ConversationService, "applyApprovalDecision">;

/** Bind methods so callers receive capabilities, not the service instance. */
function bindMethods<T extends object, K extends keyof T>(source: T, keys: readonly K[]): Pick<T, K> {
  return Object.fromEntries(keys.map((key) => {
    const value = source[key];
    return [key, typeof value === "function" ? value.bind(source) : value];
  })) as Pick<T, K>;
}

export function createApplicationConversation(source: ApplicationConversation): ApplicationConversation {
  return bindMethods(source, [...readMethods, ...controlMethods]);
}

export function createIngressConversation(source: TurnRoutingConversation): TurnRoutingConversation {
  return bindMethods(source, ["getThreadState", "submitTurn", "steerTurn"]);
}

export function createInteractionConversation(source: InteractionConversation): InteractionConversation {
  return bindMethods(source, [
    "listStoredThreads", "listLoadedThreads", "listModels", "getThreadModel",
    "listSkills", "listThreadTurns", "listThreadItems", "applyApprovalDecision",
  ]);
}
