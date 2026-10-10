import { createHash, randomUUID } from "node:crypto";
import type { NeutralConversationControls } from "../ports/neutral_controls.js";
import type { AssetData, NeutralConversationSource } from "../ports/neutral_conversation.js";
import type { AssetReference, ConversationItem } from "../../shared/protocol/v2/conversation_items.js";
import type { HistoryPage, ProviderCapabilities } from "../../shared/protocol/v2/conversations.js";
import type { ProviderMutation } from "../../shared/protocol/v2/events.js";
import { assertItemBudget, assertJsonBudget, boundText, V2_BUDGETS } from "../../shared/protocol/v2/budgets.js";
import { ProjectionRecoveryError } from "../core/projection_event_log.js";

const MAX_ASSET_BYTES = 10 * 1024 * 1024;
const MAX_RETAINED_BYTES = 32 * 1024 * 1024;
type NativePage = { data: Array<{ turnId: string; item: ConversationItem }>; nextCursor: string | null };

/** Shared adapter plumbing; all native decoding is supplied by the individual adapter. */
export class NativeConversationSource implements NeutralConversationSource {
  controls?: NeutralConversationControls;
  private boundThread: string | null = null;
  private revision = randomUUID();
  private readonly listeners = new Set<(mutation: ProviderMutation) => void>();
  private readonly cursors = new Map<string, { native: string; revision: string }>();
  private readonly assets = new Map<string, { bytes?: Uint8Array; load?: () => Promise<AssetData>; reference: AssetReference }>();
  private assetBytes = 0;
  private closed = false;

  constructor(readonly capabilities: ProviderCapabilities, private readonly fetchPage: (threadId: string, cursor?: string) => Promise<NativePage>) {}
  get historyRevision(): string { return this.revision; }
  bind(threadId: string): void {
    if (this.boundThread && this.boundThread !== threadId) throw new Error("A neutral source cannot change conversation identity.");
    this.boundThread = threadId;
  }
  subscribe(listener: (mutation: ProviderMutation) => void): () => void {
    if (this.closed) throw new Error("Neutral source is closed.");
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit(mutation: ProviderMutation): void {
    if (this.closed) return;
    for (const listener of this.listeners) { try { listener(structuredClone(mutation)); } catch { /* A consumer cannot fail native provider work. */ } }
  }
  warn(): void { this.emit({ type: "session.warning", payload: { code: "projection_incomplete", message: boundText("Some provider data could not be projected. Refresh neutral history."), retryable: true } }); }
  invalidateHistory(): void {
    this.revision = randomUUID(); this.cursors.clear(); this.assets.clear(); this.assetBytes = 0;
    this.emit({ type: "thread.reverted", payload: { historyRevision: this.revision } });
  }
  async readItems(cursor?: string): Promise<HistoryPage> {
    if (!this.boundThread || this.closed) throw new Error("Neutral source is not available.");
    const continuation = cursor ? this.cursors.get(cursor) : undefined;
    if (cursor && (!continuation || continuation.revision !== this.revision)) throw new ProjectionRecoveryError("History cursor requires a new page.");
    const revision = this.revision;
    const page = await this.fetchPage(this.boundThread, continuation?.native);
    if (this.closed || revision !== this.revision) throw new ProjectionRecoveryError("History changed during its native read.");
    // Fetch three records at a time: three maximum-sized messages fit a 1 MiB page.
    if (page.data.length > 3 || page.nextCursor === continuation?.native) throw new Error("Provider history pagination did not progress.");
    for (const { item } of page.data) assertItemBudget(item);
    // Repeated first-page reads reuse the same continuation instead of evicting
    // the reader’s expanded-history cursor during foreground refreshes.
    const nextCursor = page.nextCursor ? [...this.cursors].find(([, entry]) => entry.native === page.nextCursor && entry.revision === revision)?.[0] ?? randomUUID() : null;
    const result: HistoryPage = { data: page.data, nextCursor, backwardsCursor: null, historyRevision: revision };
    assertJsonBudget(result, V2_BUDGETS.pageBytes, "history page");
    if (nextCursor) {
      if (this.cursors.size >= 128) this.cursors.delete(this.cursors.keys().next().value!);
      this.cursors.set(nextCursor, { native: page.nextCursor!, revision });
    }
    return structuredClone(result);
  }
  asset(key: string, media: AssetReference["media"], mimeType: string | null, name: string | null,
    data?: Uint8Array | (() => Promise<AssetData>)): AssetReference {
    const id = createHash("sha256").update(JSON.stringify([this.boundThread, key])).digest("hex");
    const available = !!data && (typeof data === "function" || data.byteLength <= MAX_ASSET_BYTES);
    const reference: AssetReference = { id, media, mimeType, name, availability: available ? "available" : "unavailable" };
    if (!available) return reference;
    const previous = this.assets.get(id);
    this.assetBytes -= previous?.bytes?.byteLength ?? 0;
    this.assets.delete(id);
    this.assets.set(id, { reference, ...(typeof data === "function" ? { load: data } : { bytes: data!.slice() }) });
    this.assetBytes += typeof data === "function" ? 0 : data!.byteLength;
    while (this.assetBytes > MAX_RETAINED_BYTES || this.assets.size > 256) {
      const oldest = this.assets.keys().next().value!;
      this.assetBytes -= this.assets.get(oldest)!.bytes?.byteLength ?? 0;
      this.assets.delete(oldest);
    }
    return structuredClone(reference);
  }
  uploadAsset(media: "image" | "audio", data: AssetData): AssetReference {
    if (this.closed || !this.boundThread || !this.capabilities.inputMedia.includes(media)) throw new Error("Input media is unavailable.");
    const asset = this.asset(randomUUID(), media, data.mimeType, data.name, data.bytes);
    if (asset.availability !== "available") throw new Error("Asset exceeds the upload limit.");
    return asset;
  }
  async readAsset(id: string): Promise<AssetData> {
    if (this.closed) throw new Error("Asset is unavailable.");
    const asset = this.assets.get(id);
    if (!asset) throw new Error("Asset is unavailable. Refresh conversation history.");
    const data = asset.bytes ? { bytes: asset.bytes.slice(), mimeType: asset.reference.mimeType!, name: asset.reference.name ?? "asset" } : await asset.load!();
    if (this.closed || this.assets.get(id) !== asset || data.bytes.byteLength > MAX_ASSET_BYTES) throw new Error("Asset is unavailable.");
    return data;
  }
  close(): void { this.closed = true; this.listeners.clear(); this.cursors.clear(); this.assets.clear(); this.assetBytes = 0; }
}
