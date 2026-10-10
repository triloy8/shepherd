import type { NeutralConversationControls } from "./neutral_controls.js";
import type { AssetReference } from "../../shared/protocol/v2/conversation_items.js";
import type { HistoryPage, ProviderCapabilities } from "../../shared/protocol/v2/conversations.js";
import type { ProviderMutation } from "../../shared/protocol/v2/events.js";

export interface AssetData { bytes: Uint8Array; mimeType: string; name: string }

/** Read-only migration port. Native pages and wire frames never cross this port. */
export interface NeutralConversationSource {
  readonly controls?: NeutralConversationControls;
  readonly capabilities: ProviderCapabilities;
  readonly historyRevision: string;
  subscribe(listener: (mutation: ProviderMutation) => void): () => void;
  readItems(cursor?: string): Promise<HistoryPage>;
  uploadAsset?(media: "image" | "audio", data: AssetData): AssetReference;
  readAsset(id: AssetReference["id"]): Promise<AssetData>;
  close(): void;
}
