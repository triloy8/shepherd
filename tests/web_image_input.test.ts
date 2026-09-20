import { expect, test } from "bun:test";
import { webHarness } from "./helpers/web_harness";
import { readImageInputs, WEB_MESSAGE_MAX_BODY_BYTES } from "../server/adapters/web/image_input";
import { WEB_IMAGE_MAX_BYTES } from "../shared/protocol/image_input";
const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=";

test("web images use shared submit and steer input including image-only messages", async () => {
  const h = webHarness(); let captured: unknown;
  h.context.ingress.submitTurn = async (_id, request) => { captured = request.input; return { ok: true, turnId: "first" }; };
  h.context.ingress.steerTurn = async (_id, request) => { captured = request.input; return { ok: true, turnId: "active" }; };
  try {
    const c = await h.create(); const path = `/conversations/${c.id}/messages`;
    expect((await h.request(path, "POST", { text: "", images: [png] })).status).toBe(200);
    expect(captured).toEqual([{ type: "image", url: png }]);
    h.active.set(c.threadId, "active");
    const response = await h.request(path, "POST", { text: "Compare", images: [png, png] });
    expect((await response.json()).type).toBe("steer");
    expect(captured).toEqual([{ type: "text", text: "Compare", text_elements: [] }, { type: "image", url: png }, { type: "image", url: png }]);
  } finally { h.api.dispose(); }
});

test("web image input rejects unsupported content, remote URLs, invalid base64, size/count excess and empty messages", async () => {
  expect(readImageInputs([png])).toEqual([png]);
  for (const value of ["https://example.test/image.png", "file:///private/image.png", "data:image/svg+xml;base64,PHN2Zy8+", png.replace("image/png", "image/jpeg"), "data:image/png;base64,!!!!", "data:image/png;base64,", png + " "]) expect(() => readImageInputs([value])).toThrow();
  expect(() => readImageInputs(Array(5).fill(png))).toThrow();
  const big = Buffer.alloc(WEB_IMAGE_MAX_BYTES); Buffer.from(png.split(",")[1]!, "base64").copy(big);
  const data = `data:image/png;base64,${big.toString("base64")}`;
  expect(() => readImageInputs([data, data, data])).toThrow("10 MiB");
  expect(() => readImageInputs([`data:image/png;base64,${Buffer.concat([big, Buffer.of(0)]).toString("base64")}`])).toThrow("5 MiB");
  const h = webHarness();
  try {
    const c = await h.create(); const path = `/conversations/${c.id}/messages`;
    for (const input of [{ text: "", images: [] }, { images: [png] }, { text: "x", images: "bad" }, { text: "x", images: [png], path: "/private" }]) expect((await h.request(path, "POST", input)).status).toBe(400);
    expect((await h.request(path, "POST", { text: "", images: [png] }, { origin: "https://evil.test" })).status).toBe(403);
    expect((await h.request(path, "POST", { text: "x" }, { "content-length": String(WEB_MESSAGE_MAX_BODY_BYTES + 1) })).status).toBe(413);
  } finally { h.api.dispose(); }
});

test("history permits inline raster previews and strips remote or invalid image URLs", async () => {
  const h = webHarness();
  h.application.conversation.listThreadTurns = async () => ({ data: [{ id: "turn", items: [{ id: "user", type: "userMessage", content: [{ type: "image", url: png }, { type: "image", url: "https://evil.test/track" }, { type: "image", url: "data:image/svg+xml;base64,PHN2Zy8+" }] }] }], nextCursor: null, backwardsCursor: null });
  try {
    const c = await h.create();
    const response = await (await h.request(`/conversations/${c.id}/turns`)).json();
    expect(response.data[0].items[0].content).toEqual([{ type: "image", url: png }, { type: "image" }, { type: "image" }]);
  } finally { h.api.dispose(); }
});

test("failed image sends keep the binding and release the mutation slot for retry", async () => {
  const h = webHarness(); const submit = h.context.ingress.submitTurn;
  h.context.ingress.submitTurn = async () => { throw new Error("image backend unavailable"); };
  try {
    const c = await h.create(); const path = `/conversations/${c.id}/messages`;
    expect((await h.request(path, "POST", { text: "", images: [png] })).status).toBe(502);
    expect(h.bindings.get(c.id)).toBe(c.threadId);
    h.context.ingress.submitTurn = submit;
    expect((await h.request(path, "POST", { text: "", images: [png] })).status).toBe(200);
  } finally { h.api.dispose(); }
});

test("message concurrency is bounded across conversations while preserving retry", async () => {
  const h = webHarness(); const releases: Array<() => void> = [];
  h.context.ingress.submitTurn = async () => { await new Promise<void>((resolve) => releases.push(resolve)); return { ok: true, turnId: "turn" }; };
  try {
    const conversations = await Promise.all([h.create(), h.create(), h.create()]);
    const path = (index: number) => `/conversations/${conversations[index]!.id}/messages`;
    const first = h.request(path(0), "POST", { text: "", images: [png] });
    const second = h.request(path(1), "POST", { text: "", images: [png] });
    while (releases.length < 2) await new Promise((resolve) => setTimeout(resolve, 1));
    expect((await h.request(path(2), "POST", { text: "", images: [png] })).status).toBe(429);
    releases.forEach((release) => release());
    expect((await first).status).toBe(200); expect((await second).status).toBe(200);
  } finally { releases.forEach((release) => release()); h.api.dispose(); }
});
