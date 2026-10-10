import type { ConversationItem, InputPart } from "../shared/protocol/v2/conversation_items.js";
import type { BridgeEvent, ItemDeltaContent, ProviderMutation } from "../shared/protocol/v2/events.js";
import type { ProviderSession } from "../server/ports/provider_v2.js";
import { assistantItem } from "./helpers/provider_v2.js";

const item = assistantItem();
// @ts-expect-error Missing output is invalid on an assistant message.
item.unavailableFields.push("output");
// @ts-expect-error Omission counts refer to arrays on this specific variant.
item.omitted.changes = 3;
// Full-text output assets do not imply file/text attachment input support.
item.detailAsset = { id: "full-answer", media: "text", mimeType: "text/plain", name: null, availability: "available" };
// @ts-expect-error File attachment input is not supported in v2 yet.
const input: InputPart = { type: "asset", assetId: "file", media: "file" };
void input;
// @ts-expect-error Reasoning deltas require an explicit summary block index.
const missingIndex: ItemDeltaContent = { itemId: "item", turnId: "turn", offset: 0, delta: "text", field: "summary", index: null };
// @ts-expect-error Plain-text deltas cannot carry a reasoning block index.
const extraIndex: ItemDeltaContent = { itemId: "item", turnId: "turn", offset: 0, delta: "text", field: "text", index: 1 };
void missingIndex; void extraIndex;

function inspect(event: BridgeEvent, adapter: ProviderSession, mutation: ProviderMutation, storedItem: ConversationItem) {
  if (event.type === "item.delta") {
    event.payload.baseRevision;
    // @ts-expect-error A delta is not a replacement.
    event.payload.item;
  }
  if (mutation.type === "item.started") {
    mutation.payload.type;
    // @ts-expect-error Adapters cannot supply core-assigned revisions.
    mutation.payload.revision;
  }
  // @ts-expect-error Runtime revisions are not fields on stored conversation items.
  storedItem.revision;
  // @ts-expect-error Optional capabilities must be checked before calling.
  adapter.fork.fork("thread", {});
  // @ts-expect-error Native account data is not a session concern.
  adapter.readAccountRateLimits();
}
void inspect;
