import type { BoundedText, ConversationItem } from "./conversation_items.js";
import type { BridgeEvent } from "./events.js";

const KiB = 1024;
export const V2_BUDGETS = Object.freeze({
  textBytes: 16 * KiB,
  inputTextBytes: 8 * KiB,
  messageTextBytes: 256 * KiB,
  itemBytes: 48 * KiB,
  messageItemBytes: 304 * KiB,
  interactionBytes: 64 * KiB,
  frameBytes: 96 * KiB,
  messageFrameBytes: 320 * KiB,
  pageBytes: 1024 * KiB,
  deltaBytes: 4 * KiB,
  stringBytes: 4 * KiB,
  arrayEntries: 100,
  replayBytes: 4 * 1024 * KiB,
  replayEvents: 512,
  clientBytes: 4 * 320 * KiB,
});

const encoder = new TextEncoder();
export function jsonBytes(value: unknown): number {
  const json = JSON.stringify(value);
  if (json === undefined) throw new Error("Value is not JSON serializable.");
  return encoder.encode(json).byteLength;
}
export class ProtocolBudgetError extends Error {
  constructor(readonly field: string, readonly actualBytes: number, readonly maximumBytes: number) {
    super(`${field} exceeds its encoded budget (${actualBytes} > ${maximumBytes}).`);
  }
}
export function assertJsonBudget(value: unknown, maximumBytes: number, field: string): void {
  const bytes = jsonBytes(value);
  if (bytes > maximumBytes) throw new ProtocolBudgetError(field, bytes, maximumBytes);
}

function safeEnd(text: string, end: number): number {
  const before = text.charCodeAt(end - 1), after = text.charCodeAt(end);
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff ? end - 1 : end;
}
function safeStart(text: string, start: number): number {
  const before = text.charCodeAt(start - 1), after = text.charCodeAt(start);
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff ? start + 1 : start;
}
function fittingSlice(text: string, budget: number, tail: boolean): string {
  let low = 0, high = text.length;
  while (low < high) {
    const length = Math.ceil((low + high) / 2);
    const candidate = tail ? text.slice(safeStart(text, text.length - length)) : text.slice(0, safeEnd(text, length));
    if (jsonBytes(candidate) <= budget) low = length;
    else high = length - 1;
  }
  return tail ? text.slice(safeStart(text, text.length - low)) : text.slice(0, safeEnd(text, low));
}

/** Budget the escaped JSON string, not its source character or UTF-8 length. */
export function boundText(text: string, maximumBytes = V2_BUDGETS.textBytes, tailBytes = 2 * KiB): BoundedText {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 16 || !Number.isSafeInteger(tailBytes) || tailBytes < 0) {
    throw new Error("Invalid text budget.");
  }
  const totalBytes = encoder.encode(text).byteLength;
  if (jsonBytes(text) <= maximumBytes) return { text, truncated: false, totalBytes };
  const marker = "\n…\n";
  const contentBudget = maximumBytes - jsonBytes(marker);
  const tail = fittingSlice(text, Math.min(tailBytes, contentBudget) + 2, true);
  const head = fittingSlice(text, contentBudget - (jsonBytes(tail) - 2) + 2, false);
  return { text: head + marker + tail, truncated: true, totalBytes };
}

/** A bounded rolling preview; retained text never grows with command output. */
export class OutputAccumulator {
  private head = "";
  private tail = "";
  private complete = "";
  private truncated = false;
  private totalBytes = 0;
  private pendingSurrogate = "";
  constructor(private readonly maximumBytes = V2_BUDGETS.textBytes) {
    boundText("", maximumBytes);
  }
  append(chunk: string): void {
    // SDK chunks may split a surrogate pair. Count and retain that pair together.
    let text = this.pendingSurrogate + chunk;
    this.pendingSurrogate = "";
    const last = text.charCodeAt(text.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) {
      this.pendingSurrogate = text.slice(-1);
      text = text.slice(0, -1);
    }
    this.totalBytes += encoder.encode(text).byteLength;
    if (!this.truncated) {
      const candidate = this.complete + text;
      const bounded = boundText(candidate, this.maximumBytes);
      if (!bounded.truncated) { this.complete = candidate; return; }
      this.truncated = true;
      this.head = fittingSlice(candidate, Math.max(2, this.maximumBytes - 2 * KiB - 16), false);
      this.tail = fittingSlice(candidate, Math.min(2 * KiB, Math.floor(this.maximumBytes / 2)), true);
      this.complete = "";
    } else {
      // Slice a huge chunk before concatenating it with the retained tail.
      const incomingTail = fittingSlice(text, Math.min(2 * KiB, Math.floor(this.maximumBytes / 2)), true);
      this.tail = fittingSlice(this.tail + incomingTail, Math.min(2 * KiB, Math.floor(this.maximumBytes / 2)), true);
    }
  }
  read(): BoundedText {
    const totalBytes = this.totalBytes + encoder.encode(this.pendingSurrogate).byteLength;
    const text = this.truncated ? this.head + "\n…\n" + this.tail + this.pendingSurrogate : this.complete + this.pendingSurrogate;
    const preview = boundText(text, this.maximumBytes);
    return { ...preview, truncated: this.truncated || preview.truncated, totalBytes };
  }
}

export function assertItemBudget(item: ConversationItem): void {
  const message = item.type === "assistant_message" || item.type === "user_message";
  assertJsonBudget(item, message ? V2_BUDGETS.messageItemBytes : V2_BUDGETS.itemBytes, "item");
  const messageTexts: BoundedText[] = [];
  if (item.type === "assistant_message") messageTexts.push(item.text);
  if (item.type === "user_message") for (const part of item.content) if (part.type === "text") messageTexts.push(part.text);
  const messageFields = new Set(messageTexts);
  const messageBytes = messageTexts.reduce((sum, field) => sum + jsonBytes(field.text), 0);
  if (messageBytes > V2_BUDGETS.messageTextBytes) throw new ProtocolBudgetError("message text", messageBytes, V2_BUDGETS.messageTextBytes);
  const metadataBytes = jsonBytes(item) - messageBytes + 2 * messageTexts.length;
  if (metadataBytes > V2_BUDGETS.itemBytes) throw new ProtocolBudgetError("item metadata", metadataBytes, V2_BUDGETS.itemBytes);
  let diffBytes = 0;
  function visit(value: unknown, field: string): void {
    if (typeof value === "string") { assertJsonBudget(value, V2_BUDGETS.stringBytes, field); return; }
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      if (value.length > V2_BUDGETS.arrayEntries) throw new Error(`${field} has too many entries.`);
      for (const entry of value) visit(entry, field);
    } else if ("text" in value && "truncated" in value && "totalBytes" in value) {
      const bounded = value as BoundedText;
      const limit = messageFields.has(bounded) ? V2_BUDGETS.messageTextBytes
        : ["input", "prompt", "command"].includes(field) ? V2_BUDGETS.inputTextBytes : V2_BUDGETS.textBytes;
      assertJsonBudget(bounded.text, limit, field);
      if (field === "diff") diffBytes += jsonBytes(bounded.text);
    } else for (const [key, entry] of Object.entries(value)) visit(entry, key);
  }
  visit(item, "item");
  if (diffBytes > 24 * KiB) throw new ProtocolBudgetError("combined diffs", diffBytes, 24 * KiB);
}

/** Includes SSE framing and the full envelope; transports check again after decoration. */
export function encodeEventFrame(event: BridgeEvent): Uint8Array {
  const item = "item" in event.payload ? event.payload.item : null;
  if (item) assertItemBudget(item);
  if (event.type.startsWith("interaction.")) assertJsonBudget(event.payload, V2_BUDGETS.interactionBytes, "interaction");
  if (event.type === "item.delta") assertJsonBudget(event.payload.delta, V2_BUDGETS.deltaBytes, "delta");
  const message = item && ["assistant_message", "user_message"].includes(item.type);
  const maximum = message ? V2_BUDGETS.messageFrameBytes : V2_BUDGETS.frameBytes;
  const bytes = encoder.encode(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  if (bytes.byteLength > maximum) throw new ProtocolBudgetError("event frame", bytes.byteLength, maximum);
  return bytes;
}

export function* splitTextDeltas(text: string): Generator<string> {
  let offset = 0;
  while (offset < text.length) {
    const part = fittingSlice(text.slice(offset), V2_BUDGETS.deltaBytes, false);
    yield part;
    offset += part.length;
  }
}
