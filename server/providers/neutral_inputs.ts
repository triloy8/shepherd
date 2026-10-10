import { Buffer } from "node:buffer";
import type { ConversationItem, HistoryInputPart, ItemStatus } from "../../shared/protocol/v2/conversation_items.js";
import { boundText, jsonBytes, V2_BUDGETS } from "../../shared/protocol/v2/budgets.js";
import { loadGeneratedImage } from "../core/generated_image.js";
import { detectImageMimeType } from "../core/image_media.js";
import { itemBase, publicItemId, record, string } from "./neutral_items.js";
import type { NativeConversationSource } from "./neutral_source.js";

export function userItem(source: NativeConversationSource, threadId: string, turnId: string, id: string, input: unknown,
  status: ItemStatus): ConversationItem {
  const native = Array.isArray(input) ? input : [];
  const content: HistoryInputPart[] = [];
  let remaining = V2_BUDGETS.messageTextBytes, omitted = Math.max(0, native.length - 100), incomplete = !Array.isArray(input);
  for (const [index, value] of native.slice(0, 100).entries()) {
    const part = record(value);
    if (part.type === "text" && typeof part.text === "string") {
      if (remaining < 16) { omitted++; incomplete = true; continue; }
      const text = boundText(part.text, remaining);
      remaining -= jsonBytes(text.text);
      content.push({ type: "text", text }); incomplete ||= text.truncated;
    } else if (part.type === "image" || part.type === "localImage") {
      const url = string(part.url);
      const path = string(part.path);
      let data: Uint8Array | (() => Promise<import("../ports/neutral_conversation.js").AssetData>) | undefined;
      let mime: string | null = null;
      if (url && url.length <= 14 * 1024 * 1024) {
        const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=]+)$/.exec(url);
        if (match) { const bytes = Buffer.from(match[2]!, "base64"); mime = detectImageMimeType(bytes); if (mime === match[1]) data = bytes; }
      } else if (path) data = async () => { const image = await loadGeneratedImage(path); return { bytes: new Uint8Array(image.attachment), mimeType: image.mimeType, name: image.name }; };
      const asset = source.asset(`${id}:input:${index}`, "image", mime, "image", data);
      content.push({ type: "asset", assetId: asset.id, media: "image" });
      incomplete ||= asset.availability === "unavailable";
    } else if (part.type === "skill" || part.type === "mention") {
      content.push({ type: part.type, name: boundText(string(part.name) ?? "reference", 256).text,
        referenceId: publicItemId(threadId, `${part.type}:${string(part.path) ?? index}`) });
    } else { omitted++; incomplete = true; }
  }
  const item: ConversationItem = { ...itemBase(threadId, turnId, id, status), type: "user_message", content,
    recovery: incomplete ? "partial" : "complete", unavailableFields: incomplete ? ["startedAt", "completedAt", "content"] : ["startedAt", "completedAt"], omitted: omitted ? { content: omitted } : {} };
  if (content.some(part => part.type === "text" && part.text.truncated)) {
    const text = native.map(value => string(record(value).text) ?? "").join("\n");
    item.detailAsset = source.asset(`${id}:full-input`, "text", "text/plain; charset=utf-8", "prompt.txt", new TextEncoder().encode(text));
  }
  return item;
}
