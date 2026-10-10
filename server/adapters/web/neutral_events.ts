import type { ApplicationConversation } from "../../core/conversation_ports.js";
import type { BridgeEvent } from "../../../shared/protocol/v2/events.js";
import { encodeEventFrame, V2_BUDGETS } from "../../../shared/protocol/v2/budgets.js";
import { ProjectionRecoveryError, type ProjectionCursor } from "../../core/projection_event_log.js";
import { WebRequestError } from "./errors.js";

export function parseProjectionCursor(value: string | null): ProjectionCursor | undefined {
  if (!value) return undefined;
  const match = /^([a-f0-9-]{36}):(\d{1,16})$/.exec(value);
  if (!match || !Number.isSafeInteger(Number(match[2]))) throw new ProjectionRecoveryError("Invalid event cursor.");
  return { epoch: match[1]!, sequence: Number(match[2]) };
}

/** HTTP fanout only. Event IDs, replay, and item versions come from core. */
export class NeutralEventStreams {
  private readonly clients = new Set<() => void>();
  private closed = false;
  open(application: ApplicationConversation, threadId: string, cursor: string | null, signal: AbortSignal): ReadableStream<Uint8Array> {
    if (this.closed) throw new WebRequestError(410, "conversation_closed", "Conversation is closed.");
    if (this.clients.size >= 4) throw new WebRequestError(429, "stream_limit", "Too many event streams for this conversation.");
    const after = parseProjectionCursor(cursor);
    let cleanup = () => {};
    // Validate and subscribe synchronously so a bad cursor returns HTTP 409,
    // before the Response starts streaming; ReadableStream.start catches throws.
    const buffered: Uint8Array[] = [];
    let bufferedBytes = 0, controller: ReadableStreamDefaultController<Uint8Array> | null = null;
    let ended = false, unsubscribe = () => {}, timer: ReturnType<typeof setInterval> | undefined;
    const close = () => { if (ended) return; ended = true; cleanup(); try { controller?.close(); } catch { /* Canceled reader. */ } };
    const send = (bytes: Uint8Array) => {
      if (ended) return;
      if (!controller) {
        bufferedBytes += bytes.byteLength;
        if (bufferedBytes > V2_BUDGETS.clientBytes) { close(); return; }
        buffered.push(bytes); return;
      }
      if ((controller.desiredSize ?? 0) < bytes.byteLength) { close(); return; }
      try { controller.enqueue(bytes); } catch { close(); }
    };
    cleanup = () => { unsubscribe(); if (timer) clearInterval(timer); signal.removeEventListener("abort", close); this.clients.delete(close); };
    unsubscribe = application.subscribeNeutralEvents(threadId, (event: BridgeEvent) => send(encodeEventFrame(event)), after, close);
    this.clients.add(close);
    if (ended) cleanup();
    const stream = new ReadableStream<Uint8Array>({
      start: current => {
        controller = current;
        if (ended || signal.aborted) { if (!ended) close(); else current.close(); return; }
        signal.addEventListener("abort", close, { once: true });
        send(new TextEncoder().encode(": connected\n\n"));
        for (const bytes of buffered) send(bytes);
        buffered.length = 0;
        if (!ended) { timer = setInterval(() => send(new TextEncoder().encode(": heartbeat\n\n")), 15_000); timer.unref?.(); }
      }, cancel: close,
    }, { highWaterMark: V2_BUDGETS.clientBytes, size: bytes => bytes.byteLength });
    return stream;
  }
  close(): void { this.closed = true; for (const close of [...this.clients]) close(); }
}
