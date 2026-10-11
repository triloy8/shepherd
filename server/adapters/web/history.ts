import { validImageData, WEB_MESSAGE_MAX_BODY_BYTES } from "./image_input.js";
import type { HistoryItem } from "../../../shared/protocol/requests.js";
import type { WebHistoryItem } from "../../../shared/protocol/web.js";
import type { WebImages } from "./images.js";
export function presentHistoryItem(item: HistoryItem, turnId: string, images: WebImages): WebHistoryItem {
  switch (item.type) {
    case "user_message": {
      // Never turn provider history into arbitrary remote browser fetches.
      let bytes = 0; let count = 0;
      return { id: item.id, type: item.type, content: item.content.map((part) => {
        if (part.type !== "image") return part;
        const allowed = count++ < 4 && validImageData(part.url) && (bytes += part.url.length) <= WEB_MESSAGE_MAX_BODY_BYTES;
        return allowed ? { type: "image", url: part.url } : { type: "image" };
      }) };
    }
    case "assistant_message": return { id: item.id, type: item.type, text: item.text, ...(item.phase ? { phase: item.phase } : {}) };
    case "image": return { id: item.id, type: item.type, webImage: images.present(turnId, item.image.itemId, item.image.path, item.image.revisedPrompt ?? null, item.image.kind) };
    case "activity": return { id: item.id, type: item.type, webActivity: item.activity };
    default: return { id: item.id, type: item.type };
  }
}
