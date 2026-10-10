import type { ConversationInput } from "../../../shared/protocol/v2/conversation_items.js";
import type { ThreadSettings } from "../../../shared/protocol/v2/conversations.js";
import type { InteractionReply } from "../../../shared/protocol/v2/interactions.js";
import { WebRequestError } from "./errors.js";

export function readNeutralInput(value: unknown): ConversationInput {
  if (!Array.isArray(value) || !value.length || value.length > 100) throw new WebRequestError(400, "invalid_input", "Add a message or an asset.");
  return value.map(part => {
    if (!part || typeof part !== "object" || Array.isArray(part)) throw new WebRequestError(400, "invalid_input", "Invalid input part.");
    const keys = Object.keys(part);
    if (part.type === "text" && keys.every(key => ["type", "text"].includes(key)) && typeof part.text === "string" && part.text.trim() && part.text.length <= 32768) return { type: "text", text: part.text };
    if (part.type === "asset" && keys.every(key => ["type", "assetId", "media"].includes(key)) && typeof part.assetId === "string" && /^[a-f0-9]{64}$/.test(part.assetId) && ["image", "audio"].includes(part.media)) return { type: "asset", assetId: part.assetId, media: part.media };
    throw new WebRequestError(400, "invalid_input", "Unsupported or malformed input part.");
  });
}
export function readNeutralSettings(value: Record<string, unknown>): Partial<ThreadSettings> {
  if (!Object.keys(value).length || Object.keys(value).some(key => !["model", "effort", "approvalMode", "sandboxMode"].includes(key))) throw new WebRequestError(400, "invalid_settings", "Choose model, effort, approval mode, or sandbox mode.");
  for (const key of ["model", "effort"]) if (value[key] !== undefined && (typeof value[key] !== "string" || !value[key] || String(value[key]).length > 256)) throw new WebRequestError(400, "invalid_settings", "Invalid model or effort.");
  if (value.approvalMode !== undefined && !["provider_default", "review_sensitive", "review_all", "bypass"].includes(String(value.approvalMode))) throw new WebRequestError(400, "invalid_settings", "Invalid approval mode.");
  if (value.sandboxMode !== undefined && !["read_only", "workspace_write", "unrestricted"].includes(String(value.sandboxMode))) throw new WebRequestError(400, "invalid_settings", "Invalid sandbox mode.");
  return value as Partial<ThreadSettings>;
}
export function readNeutralReply(value: Record<string, unknown>): InteractionReply {
  if (typeof value.optionId !== "string" || !/^[a-f0-9-]{36}$/.test(value.optionId) || (value.reason !== undefined && (typeof value.reason !== "string" || value.reason.length > 4096))) throw new WebRequestError(400, "invalid_reply", "Choose an offered option.");
  return value as unknown as InteractionReply;
}
