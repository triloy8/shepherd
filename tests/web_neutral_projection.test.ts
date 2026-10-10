import { expect, test } from "bun:test";
import { webHarness } from "./helpers/web_harness.js";
import { NativeConversationSource } from "../server/providers/neutral_source.js";
import { ConversationProjection } from "../server/core/conversation_projection.js";
import { capabilities, assistantItem } from "./helpers/provider_v2.js";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { NeutralConversationItems } from "../ui/src/components/NeutralConversationItems.js";

async function setup() {
  const h = webHarness(), conversation = await h.create();
  const source = new NativeConversationSource(capabilities(), async () => ({ data: [{ turnId: "turn", item: assistantItem("history") }], nextCursor: null }));
  source.bind(conversation.threadId);
  const projection = new ConversationProjection(conversation.threadId, "session", source);
  Object.assign(h.application.conversation, {
    readNeutralSnapshot: () => projection.snapshot(), readNeutralSnapshotItems: (_id: string, cursor: string) => projection.snapshotItems(cursor),
    readNeutralItems: (_id: string, cursor?: string) => projection.readItems(cursor), readNeutralAsset: (_id: string, id: string) => projection.readAsset(id),
    subscribeNeutralEvents: (_id: string, listener: Parameters<ConversationProjection["subscribe"]>[0], cursor?: Parameters<ConversationProjection["subscribe"]>[1], onClose?: () => void) => projection.subscribe(listener, cursor, onClose),
  });
  const request = (path: string, options: RequestInit = {}) => h.api.fetch(new Request(`http://127.0.0.1/api/v2/conversations/${conversation.id}/${path}`, options));
  return { h, source, projection, request, conversation };
}

test("v2 snapshot and native history stay separate and read-only with the existing origin policy", async () => {
  const { h, source, projection, request } = await setup();
  try {
    source.emit({ type: "item.started", payload: assistantItem("live") });
    const snapshot = await (await request("snapshot")).json();
    expect(snapshot.items).toMatchObject([{ revision: 1, item: { text: { text: "live" } } }]);
    expect((await (await request("items")).json()).data).toMatchObject([{ item: { text: { text: "history" } } }]);
    expect((await request("snapshot", { method: "POST" })).status).toBe(405);
    expect((await request("snapshot", { headers: { origin: "https://evil.test" } })).status).toBe(403);
    expect((await request("snapshot?cursor=unknown")).status).toBe(400);
    expect((await request("snapshot-items")).status).toBe(400);
    expect((await request("items?limit=10")).status).toBe(400);
    expect((await request("items?cursor=unknown")).status).toBe(409);
    expect((await request("snapshot", { method: "OPTIONS", headers: { origin: "https://ui.example.test", "access-control-request-method": "GET" } })).status).toBe(204);
  } finally { projection.close(); h.api.dispose(); }
});

test("v2 SSE preserves core event IDs, replays after a watermark, and rejects invalid cursors before opening a stream", async () => {
  const { h, source, projection, request } = await setup();
  try {
    source.emit({ type: "item.started", payload: assistantItem("hello") });
    const watermark = projection.cursor();
    source.emit({ type: "item.delta", payload: { itemId: "message", turnId: "turn", field: "text", index: null, offset: 5, delta: " world" } });
    const response = await request("events", { headers: { "last-event-id": `${watermark.epoch}:${watermark.sequence}` } });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const reader = response.body!.getReader(), decoder = new TextDecoder();
    await reader.read();
    const replay = decoder.decode((await reader.read()).value);
    expect(replay).toContain(`id: ${watermark.epoch}:2`);
    expect(replay).toContain('"baseRevision":1');
    expect(replay).not.toContain("item.started");
    await reader.cancel();
    expect((await request("events", { headers: { "last-event-id": "invalid" } })).status).toBe(409);
    expect((await request("events", { headers: { "last-event-id": `${crypto.randomUUID()}:1` } })).status).toBe(409);
    expect((await request("events?cursor=anything")).status).toBe(400);
  } finally { projection.close(); h.api.dispose(); }
});

test("v2 asset reads are scoped to the attached conversation and cannot request filesystem paths", async () => {
  const { h, source, projection, request, conversation } = await setup();
  try {
    const asset = source.asset("answer", "text", "text/plain", "answer.txt", new TextEncoder().encode("full answer"));
    const response = await request(`assets/${asset.id}`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("full answer");
    expect(response.headers.get("content-security-policy")).toContain("sandbox");
    expect((await request(`assets/${"0".repeat(64)}`)).status).toBe(404);
    expect((await request("assets/..%2F..%2Fetc%2Fpasswd")).status).toBe(404);
    expect((await request("assets")).status).toBe(404);
    expect((await h.api.fetch(new Request(`http://127.0.0.1/api/v2/conversations/unknown/assets/${asset.id}`))).status).toBe(404);
    await h.request(`/conversations/${conversation.id}`, "DELETE");
    expect((await request(`assets/${asset.id}`)).status).toBe(404);
  } finally { projection.close(); h.api.dispose(); }
});

test("detach closes neutral streams and client limits reject excess streams", async () => {
  const { h, projection, request, conversation } = await setup();
  try {
    const streams = [];
    for (let i = 0; i < 4; i++) streams.push((await request("events")).body!.getReader());
    expect((await request("events")).status).toBe(429);
    for (const reader of streams) await reader.read();
    await h.request(`/conversations/${conversation.id}`, "DELETE");
    for (const reader of streams) expect((await reader.read()).done).toBe(true);
  } finally { projection.close(); h.api.dispose(); }
});

test("closing the projection closes existing HTTP streams even before the web adapter is disposed", async () => {
  const { h, projection, request } = await setup();
  try {
    const reader = (await request("events")).body!.getReader();
    await reader.read(); projection.close();
    expect((await reader.read()).done).toBe(true);
  } finally { h.api.dispose(); }
});

test("one neutral renderer shows escaped content and full-text links without provider branches", () => {
  const item = assistantItem("<script>unsafe()</script>");
  item.text.truncated = true;
  item.detailAsset = { id: "asset", media: "text", mimeType: "text/plain", name: "answer.txt", availability: "available" };
  const html = renderToStaticMarkup(createElement(NeutralConversationItems, { items: [item], assetUrl: id => `/api/v2/conversations/conversation/assets/${id}` }));
  expect(html).toContain("&lt;script&gt;");
  expect(html).toContain("Preview shortened.");
  expect(html).toContain("/api/v2/conversations/conversation/assets/asset");
  expect(html).not.toContain("<script>");
});

test("slow neutral consumers are closed within the byte budget and release their stream slots", async () => {
  const { h, source, projection, request } = await setup();
  try {
    const slow = (await request("events")).body!.getReader();
    for (let i = 0; i < 10; i++) source.emit({ type: "item.completed", payload: { ...assistantItem("x".repeat(240 * 1024), `large-${i}`), status: "completed" } });
    let bytes = 0;
    while (true) { const read = await slow.read(); if (read.done) break; bytes += read.value.byteLength; }
    expect(bytes).toBeLessThanOrEqual(1.25 * 1024 * 1024);
    const replacement = await request("events");
    expect(replacement.status).toBe(200);
    await replacement.body!.cancel();
  } finally { projection.close(); h.api.dispose(); }
});
