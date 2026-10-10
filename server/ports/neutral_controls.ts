import type { ConversationInput } from "../../shared/protocol/v2/conversation_items.js";
import type { ModelSummary, Page, ThreadSettings, TokenUsage, TurnInput } from "../../shared/protocol/v2/conversations.js";
import type { InteractionReply } from "../../shared/protocol/v2/interactions.js";

/** Application operations contain no native policies, decisions, SDK inputs or model records. */
export interface NeutralConversationControls {
  skills?: { list(reload?: boolean): Promise<import("../../shared/protocol/v2/conversations.js").SkillList>; configure(referenceId: string, enabled: boolean): Promise<{ enabled: boolean }> };
  settings(): ThreadSettings;
  configure(settings: Partial<ThreadSettings>): Promise<ThreadSettings>;
  models(cursor?: string): Promise<Page<ModelSummary>>;
  context(): Promise<TokenUsage | null>;
  submit(turn: TurnInput): Promise<string>;
  steer?(input: ConversationInput, turnId: string): Promise<string>;
  interrupt(turnId?: string): Promise<void>;
  respond(id: string, reply: InteractionReply): Promise<void>;
}

/** Malformed shared input or unsupported catalog selection, before native work. */
export class NeutralInputError extends Error {}
