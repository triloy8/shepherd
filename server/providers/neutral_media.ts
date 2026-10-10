import type { ConversationItem, ItemStatus } from "../../shared/protocol/v2/conversation_items.js";
import { boundText } from "../../shared/protocol/v2/budgets.js";
import { loadGeneratedImage } from "../core/generated_image.js";
import { itemBase } from "./neutral_items.js";
import type { NativeConversationSource } from "./neutral_source.js";

/** Only adapter-reported paths are registered; public asset requests cannot supply a path. */
export function imageItem(source: NativeConversationSource, thread: string, turn: string, id: string, origin: "generated" | "viewed", path: string | null, prompt: string | null, status: ItemStatus): ConversationItem {
  const asset = source.asset(`${id}:image`, "image", null, "image", path ? async () => {
    const image = await loadGeneratedImage(path);
    return { bytes: new Uint8Array(image.attachment), mimeType: image.mimeType, name: image.name };
  } : undefined);
  return { ...itemBase(thread, turn, id, status), type: "image", origin, asset, prompt: prompt === null ? null : boundText(prompt),
    recovery: asset.availability === "available" ? "complete" : "partial" };
}
