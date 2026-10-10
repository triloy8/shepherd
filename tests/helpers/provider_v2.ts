import type { ConversationItem } from "../../shared/protocol/v2/conversation_items.js";
import type { ProviderRegistration } from "../../server/core/provider_registry.js";
import type { ProviderCapabilities } from "../../shared/protocol/v2/conversations.js";
import type { ProviderSession } from "../../server/ports/provider_v2.js";
import { boundText, V2_BUDGETS } from "../../shared/protocol/v2/budgets.js";

export function assistantItem(text = "", id = "message"): ConversationItem & { type: "assistant_message" } {
  return { id, turnId: "turn", parentItemId: null, relatedItemIds: [], status: "in_progress", startedAt: null,
    completedAt: null, error: null, recovery: "complete", detailAsset: null, unavailableFields: [], omitted: {},
    type: "assistant_message", text: boundText(text, V2_BUDGETS.messageTextBytes), phase: null };
}
export function capabilities(): ProviderCapabilities {
  return { fork: false, steering: false, compact: false, revert: false, skills: { list: false, configure: false },
    resets: false, questions: true, backgroundWork: false, inputKinds: ["text"], inputMedia: [],
    approvalModes: ["provider_default", "review_sensitive"], sandboxModes: ["unrestricted"] };
}
/** A third synthetic adapter demonstrates that registry/core need no identity switch. */
export function registration(id = "fixture-agent"): ProviderRegistration {
  const { skills: _skills, resets: _resets, ...declared } = capabilities();
  const unsupported = async (): Promise<never> => { throw new Error("Fixture operation is not implemented."); };
  const session: ProviderSession = {
    provider: id, sessionId: "session", activeTurnId: null, backgroundTaskCount: 0,
    events: { subscribe: () => () => {} }, initialize: async () => {}, startThread: unsupported, resumeThread: unsupported,
    startTurn: async () => "turn", interruptTurn: async () => {}, respond: async () => {}, setCwd: async () => {}, stop: async () => {},
  };
  return { id, displayName: "Fixture agent", capabilities: declared, defaults: { approvalMode: "provider_default", sandboxMode: "unrestricted" }, services: {
    createSession: () => session,
    history: { listThreads: unsupported, readThread: unsupported, listTurns: unsupported, listItems: unsupported, rename: unsupported, archive: unsupported },
    catalog: { listModels: async () => ({ data: [], nextCursor: null, backwardsCursor: null }) }, shutdown: async () => {},
  } };
}
