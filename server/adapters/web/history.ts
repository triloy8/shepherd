import { validImageData, WEB_MESSAGE_MAX_BODY_BYTES } from "./image_input.js";
import type { HistoryItem } from "../../../shared/protocol/requests.js";
import type { WebImages } from "./images.js";
export function presentHistoryItem(item: HistoryItem, turnId: string, images: WebImages) {
  if (item.type === "userMessage" && Array.isArray(item.content)) {
    // Never turn provider history into arbitrary remote browser fetches.
    let bytes = 0; let count = 0;
    return { id: item.id, type: item.type, content: item.content.map((part: unknown) => {
      const value = part && typeof part === "object" ? part as Record<string, unknown> : {};
      if (value.type !== "image") return part;
      const allowed = count++ < 4 && validImageData(value.url) && (bytes += value.url.length) <= WEB_MESSAGE_MAX_BODY_BYTES;
      return allowed ? { type: "image", url: value.url } : { type: "image" };
    }) };
  }
  if (item.type === "agentMessage") return { id: item.id, type: item.type, text: item.text, ...(item.phase ? { phase: item.phase } : {}) };
  if (item.image) return { id: item.id, type: item.type, webImage: images.present(turnId, item.image.itemId, item.image.path, item.image.revisedPrompt ?? null, item.image.kind) };
  return item.activity ? { id: item.id, type: item.type, webActivity: item.activity } : { id: item.id, type: item.type };
}
