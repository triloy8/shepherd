import { randomUUID } from "node:crypto";
import { assertJsonBudget, boundText, V2_BUDGETS } from "../../shared/protocol/v2/budgets.js";
import type { ConversationInput } from "../../shared/protocol/v2/conversation_items.js";
import type { ModelSummary, Page, ThreadSettings } from "../../shared/protocol/v2/conversations.js";
import type { UserInput } from "../../shared/protocol/user_input.js";
import type { NativeConversationSource } from "./neutral_source.js";

import { NeutralInputError } from "../ports/neutral_controls.js";

const metadata = (value: string, max: number) => boundText(value, max).text;

export async function nativeInput(source: NativeConversationSource, input: ConversationInput): Promise<UserInput[]> {
  const result: UserInput[] = [];
  let imageCount = 0, imageBytes = 0;
  for (const part of input) {
    if (part.type === "text") result.push({ type: "text", text: part.text, text_elements: [] });
    else if (part.type === "asset" && part.media === "image") {
      let data;
      try { data = await source.readAsset(part.assetId); }
      catch { throw new NeutralInputError("Input asset is unavailable. Attach the image again."); }
      imageBytes += data.bytes.byteLength; imageCount++;
      if (imageCount > 4 || data.bytes.byteLength > 5 * 1024 * 1024 || imageBytes > 10 * 1024 * 1024) throw new NeutralInputError("Attach up to four images, at most 5 MiB each and 10 MiB total.");
      if (!data.mimeType.startsWith("image/")) throw new NeutralInputError("Input asset is not an image.");
      result.push({ type: "image", url: `data:${data.mimeType};base64,${Buffer.from(data.bytes).toString("base64")}` });
    } else throw new NeutralInputError("Unsupported input reference.");
  }
  return result;
}
export function modelPage(page: { data: Array<{ model: string; displayName: string; description: string; supportedReasoningEfforts?: Array<{ reasoningEffort: string; description: string }>; defaultReasoningEffort?: string | null }>; nextCursor: string | null }): Page<ModelSummary> {
  return { data: page.data.map(model => ({ id: metadata(model.model, 256), displayName: metadata(model.displayName, 256), description: metadata(model.description, 2048),
    efforts: (model.supportedReasoningEfforts ?? []).slice(0, 16).map(effort => ({ id: metadata(effort.reasoningEffort, 256), label: metadata(effort.description || effort.reasoningEffort, 128) })), defaultEffort: model.defaultReasoningEffort ?? null })), nextCursor: page.nextCursor, backwardsCursor: null };
}
/** Native catalog continuations stay private to the session adapter. */
export function modelCatalog(list: (cursor?: string) => Promise<Parameters<typeof modelPage>[0]>) {
  const cursors = new Map<string, string>();
  return async (cursor?: string): Promise<Page<ModelSummary>> => {
    const native = cursor ? cursors.get(cursor) : undefined;
    if (cursor && !native) throw new NeutralInputError("Model cursor expired. Reload models.");
    const page = await list(native);
    if (page.data.length > 100 || (page.nextCursor && page.nextCursor === native)) throw new Error("Model pagination did not progress.");
    const mapped = modelPage(page);
    if (page.nextCursor) {
      const token = [...cursors].find(([, value]) => value === page.nextCursor)?.[0] ?? randomUUID();
      if (!cursors.has(token) && cursors.size >= 128) cursors.delete(cursors.keys().next().value!);
      cursors.set(token, page.nextCursor); mapped.nextCursor = token;
    }
    assertJsonBudget(mapped, V2_BUDGETS.pageBytes, "model page");
    return mapped;
  };
}

export async function configured(current: ThreadSettings, patch: Partial<ThreadSettings>, models: (cursor?: string) => Promise<Page<ModelSummary>>): Promise<ThreadSettings> {
  const next = { ...current, ...patch };
  if (patch.model !== undefined || patch.effort !== undefined) {
    let cursor: string | undefined, selected: ModelSummary | undefined;
    const seen = new Set<string>();
    do {
      const page = await models(cursor); selected = page.data.find(model => model.id === next.model);
      if (selected || !page.nextCursor) break;
      if (seen.has(page.nextCursor) || seen.size >= 100) throw new Error("Model pagination did not progress.");
      seen.add(page.nextCursor); cursor = page.nextCursor;
    } while (true);
    if (!selected) throw new NeutralInputError("Choose an available model.");
    if (patch.model !== undefined && patch.effort === undefined) next.effort = selected.defaultEffort;
    if (next.effort === "default") next.effort = selected.defaultEffort;
    if (next.effort && !selected.efforts.some(effort => effort.id === next.effort)) throw new NeutralInputError("Choose an effort supported by this model.");
  }
  return next;
}
