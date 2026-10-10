import type { BridgeEvent as NeutralEvent } from "../../shared/protocol/v2/events.js";

// Protocol test reader; not part of the shipped UI.
export async function readNeutralEvents(body: ReadableStream<Uint8Array>, receive: (event: NeutralEvent) => void, progress: () => void = () => {}, signal?: AbortSignal): Promise<void> {
  const reader = body.getReader(), decoder = new TextDecoder();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener("abort", cancel, { once: true });
  let pending = "", fields: string[] = [], bytes = 0;
  try {
    while (!signal?.aborted) {
      const result = await reader.read(); if (result.done || signal?.aborted) return;
      progress(); pending += decoder.decode(result.value, { stream: true });
      let newline: number;
      while ((newline = pending.indexOf("\n")) >= 0) {
        if (signal?.aborted) return;
        const line = pending.slice(0, newline).replace(/\r$/, ""); pending = pending.slice(newline + 1);
        bytes += new TextEncoder().encode(line).byteLength + 1;
        if (bytes > 320 * 1024) throw new Error("Event exceeds the client buffer limit.");
        if (!line) {
          const read = (prefix: string) => fields.filter(field => field.startsWith(prefix)).map(field => field.slice(prefix.length).replace(/^ /, ""));
          const data = read("data:").join("\n");
          if (data) {
            const event = JSON.parse(data) as NeutralEvent;
            if (event.id !== read("id:").at(-1) || event.type !== read("event:").at(-1) || !Number.isSafeInteger(event.sequence) || event.sequence < 0 || typeof event.epoch !== "string" || event.id !== `${event.epoch}:${event.sequence}` || typeof event.threadId !== "string" || typeof event.sessionId !== "string") throw new Error("Invalid event envelope.");
            receive(event);
          }
          fields = []; bytes = 0;
        } else if (!line.startsWith(":")) fields.push(line);
      }
      if (bytes + new TextEncoder().encode(pending).byteLength > 320 * 1024) throw new Error("Event exceeds the client buffer limit.");
    }
  } finally { signal?.removeEventListener("abort", cancel); await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
