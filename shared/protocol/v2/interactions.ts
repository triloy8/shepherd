import type { BoundedText, ConversationItem } from "./conversation_items.js";
import type { UserQuestionAnswers, UserQuestionRequest } from "../user_questions.js";

export type PermissionScope = "once" | "turn" | "session" | "persistent";
export interface PermissionDetails {
  cwd: string | null;
  filesystem: Array<{ path: string; access: "read" | "write" }>;
  network: Array<{ host: string | null; access: "allow" | "deny" }>;
  commands: Array<{ match: BoundedText; scope: PermissionScope }>;
  explanation: BoundedText | null;
}
export type InteractionIntent = "allow" | "deny" | "cancel" | "submit" | "other";
export interface InteractionRequest {
  id: string;
  threadId: string;
  turnId: string | null;
  itemId: string | null;
  kind: "command" | "file_change" | "permissions" | "tool" | "user_input";
  title: string;
  item: ConversationItem | null;
  reason: BoundedText | null;
  permissions: PermissionDetails | null;
  options: Array<{ id: string; label: string; intent: InteractionIntent; scope: PermissionScope | null; effect: PermissionDetails | null }>;
  questions: UserQuestionRequest | null;
}
export interface InteractionReply { optionId: string; answers?: UserQuestionAnswers; reason?: string }
export interface InteractionRecord extends InteractionRequest {
  sessionId: string;
  status: "pending" | "decided" | "applied" | "failed" | "expired";
  selectedOptionId: string | null;
  selectedIntent: InteractionIntent | null;
  createdAt: number;
  updatedAt: number;
}
