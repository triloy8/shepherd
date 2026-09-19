import { randomUUID } from "node:crypto";
import type { WebEventData } from "../../../shared/protocol/web.js";
import { WebRequestError } from "./errors.js";

const encoder = new TextEncoder();
const MAX_HISTORY_BYTES = 128 * 1024;
const MAX_HISTORY_EVENTS = 256;
const MAX_CLIENTS = 4;
const MAX_CLIENT_BYTES = 256 * 1024;

/** Bounded per-conversation replay; closing a browser never cancels a turn. */
export class WebEventFeed {
  private readonly epoch = randomUUID();
  private sequence = 0;
  private history: Array<{ id: string; bytes: Uint8Array }> = [];
  private bytes = 0;
  private closed = false;
  private readonly clients = new Set<{ send: (bytes: Uint8Array) => void; close: () => void }>();

  publish<K extends keyof WebEventData>(type: K, data: WebEventData[K]): void {
    if (this.closed) return;
    const id = `${this.epoch}:${++this.sequence}`;
    let bytes = encoder.encode(`id: ${id}\nevent: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    if (bytes.byteLength > MAX_HISTORY_BYTES) {
      bytes = encoder.encode(`id: ${id}\nevent: reset\ndata: {"reason":"event_too_large"}\n\n`);
    }
    this.history.push({ id, bytes }); this.bytes += bytes.byteLength;
    while (this.history.length > MAX_HISTORY_EVENTS || this.bytes > MAX_HISTORY_BYTES) {
      this.bytes -= this.history.shift()!.bytes.byteLength;
    }
    for (const client of this.clients) client.send(bytes);
  }

  open(cursor: string | null, signal: AbortSignal): ReadableStream<Uint8Array> {
    if (this.closed) throw new WebRequestError(410, "conversation_closed", "Conversation is closed.");
    if (this.clients.size >= MAX_CLIENTS) throw new WebRequestError(429, "stream_limit", "Too many event streams for this conversation.");
    let replay = this.history;
    if (cursor) {
      const index = this.history.findIndex((entry) => entry.id === cursor);
      if (index < 0) throw new WebRequestError(409, "event_cursor_expired", "Reload state/history and reconnect without a cursor.");
      replay = this.history.slice(index + 1);
    }
    let cleanup = () => {};
    return new ReadableStream<Uint8Array>({
      start: (controller) => {
        let ended = false;
        let timer: ReturnType<typeof setInterval> | undefined;
        const client = {
          send: (bytes: Uint8Array) => {
            if (ended) return;
            if ((controller.desiredSize ?? 0) < bytes.byteLength) { client.close(); return; }
            try { controller.enqueue(bytes); } catch { cleanup(); }
          },
          close: () => {
            if (ended) return;
            cleanup();
            try { controller.close(); } catch { /* Reader already cancelled. */ }
          },
        };
        cleanup = () => {
          ended = true;
          if (timer) clearInterval(timer);
          signal.removeEventListener("abort", client.close);
          this.clients.delete(client);
        };
        this.clients.add(client);
        signal.addEventListener("abort", client.close, { once: true });
        if (signal.aborted) { client.close(); return; }
        client.send(encoder.encode(": connected\n\n"));
        for (const entry of replay) client.send(entry.bytes);
        if (!ended) {
          timer = setInterval(() => client.send(encoder.encode(": heartbeat\n\n")), 15_000);
          timer.unref?.();
        }
      },
      cancel: () => cleanup(),
    }, { highWaterMark: MAX_CLIENT_BYTES, size: (chunk) => chunk.byteLength });
  }

  close(): void {
    this.closed = true;
    for (const client of this.clients) client.close();
    this.history = []; this.bytes = 0;
  }
}
