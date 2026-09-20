import { extractGeneratedImageArtifact, mapTurnActivity } from "../../core/codex_rpc_mapper.js";
import { validImageData, WEB_MESSAGE_MAX_BODY_BYTES } from "./image_input.js";
import type { HistoryItem } from "../../../shared/protocol/requests.js";
import type { WebImages } from "./images.js";
export function presentHistoryItem(item: HistoryItem, turnId: string, images: WebImages) {
  if (item.type === "userMessage" && Array.isArray(item.content)) {
    // Never turn provider history into arbitrary remote browser fetches.
    let bytes = 0; let count = 0;
    return { ...item, content: item.content.map((part: unknown) => {
      const value = part && typeof part === "object" ? part as Record<string, unknown> : {};
      if (value.type !== "image") return part;
      const allowed = count++ < 4 && validImageData(value.url) && (bytes += value.url.length) <= WEB_MESSAGE_MAX_BODY_BYTES;
      return allowed ? { type: "image", url: value.url } : { type: "image" };
    }) };
  }
  const image = extractGeneratedImageArtifact({ turnId, item });
  if (image) return { ...item, webImage: { url: images.register(turnId, image.itemId, image.path), prompt: image.revisedPrompt } };
  const activity = mapTurnActivity({ turnId, item }, item.status === "inProgress" ? "started" : "completed");
  return activity ? { ...item, webActivity: activity } : item;
}
