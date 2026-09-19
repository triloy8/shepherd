import { expect, test } from "bun:test";
import { WebEventFeed } from "../server/adapters/web/event_feed.js";
import type { BridgeEvent } from "../shared/protocol/events.js";

const decode = (value: Uint8Array | undefined) => new TextDecoder().decode(value);
const event = (n: number): BridgeEvent => ({ id: `bridge-${n}`, type: "turn.stream.delta", threadId: "thread", sessionId: "session", ts: "now", payload: { textDelta: `${n}` } });

test("SSE replays only events after its opaque cursor and delivers live events", async () => {
  const feed = new WebEventFeed();
  try {
    feed.publish("bridge", event(1));
    const reader = feed.open(null, new AbortController().signal).getReader();
    expect(decode((await reader.read()).value)).toContain(": connected");
    const first = decode((await reader.read()).value);
    const cursor = /^id: (.+)$/m.exec(first)![1]!;
    expect(first).toContain('"bridge-1"');
    await reader.cancel();
    feed.publish("bridge", event(2));
    const resumed = feed.open(cursor, new AbortController().signal).getReader();
    await resumed.read();
    expect(decode((await resumed.read()).value)).toContain('"bridge-2"');
    feed.publish("bridge", event(3));
    expect(decode((await resumed.read()).value)).toContain('"bridge-3"');
    await resumed.cancel();
  } finally { feed.close(); }
});

test("expired cursors are explicit and oversized events request snapshot recovery", async () => {
  const feed = new WebEventFeed();
  try {
    feed.publish("bridge", event(0));
    const initial = feed.open(null, new AbortController().signal).getReader(); await initial.read();
    const cursor = /^id: (.+)$/m.exec(decode((await initial.read()).value))![1]!;
    await initial.cancel();
    for (let i = 1; i < 300; i++) feed.publish("bridge", event(i));
    expect(() => feed.open(cursor, new AbortController().signal)).toThrow("Reload state/history");
    expect(() => feed.open("other-instance:1", new AbortController().signal)).toThrow("Reload state/history");
    feed.publish("bridge", { ...event(400), payload: "x".repeat(150_000) });
    const reader = feed.open(null, new AbortController().signal).getReader();
    let reset = false;
    for (let i = 0; i < 257; i++) {
      const text = decode((await reader.read()).value);
      if (text.includes("event: reset")) { reset = true; break; }
    }
    expect(reset).toBe(true); await reader.cancel();
  } finally { feed.close(); }
});

test("stream slots are released on cancel/abort and slow readers are bounded", async () => {
  const feed = new WebEventFeed();
  const abort = new AbortController();
  const streams = [feed.open(null, abort.signal), ...Array.from({ length: 3 }, () => feed.open(null, new AbortController().signal))];
  try {
    expect(() => feed.open(null, new AbortController().signal)).toThrow("Too many");
    abort.abort();
    const replacement = feed.open(null, new AbortController().signal);
    await replacement.cancel();
    for (let n = 0; n < 100; n++) feed.publish("bridge", { ...event(n), payload: "x".repeat(8192) });
    // Full readers were disconnected; opening another stream proves their slots were released.
    const afterOverflow = feed.open(null, new AbortController().signal);
    await afterOverflow.cancel();
    feed.close();
    expect(() => feed.open(null, new AbortController().signal)).toThrow("closed");
  } finally { feed.close(); for (const stream of streams) await stream.cancel(); }
});
