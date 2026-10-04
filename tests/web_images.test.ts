import { expect, test } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { webHarness } from "./helpers/web_harness";
import { WebImages } from "../server/adapters/web/images";
import { mergeHistory, emptyChat, reduceBridge } from "../ui/src/chat-state";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Timeline } from "../ui/src/components/Timeline";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=", "base64");

test("viewed screenshots reload as visible images and use the existing bounded asset route", async () => {
  const dir = await mkdtemp(join(tmpdir(), "web-viewed-images-"));
  const path = join(dir, "desktop-screenshot.png");
  const h = webHarness();
  await writeFile(path, png);
  h.application.conversation.listThreadTurns = async () => ({ data: [{ id: "turn", status: "completed", items: [
    { id: "view", type: "imageView", path },
    { id: "failed", type: "imageView", path, status: "failed" },
    { id: "running", type: "imageView", path, status: "inProgress" },
  ] }], nextCursor: null, backwardsCursor: null });
  try {
    const a = await h.create(); const b = await h.create();
    const load = async () => (await h.request(`/conversations/${a.id}/turns`)).json();
    const first = await load(); const reloaded = await load();
    const image = first.data[0].items[0].webImage;
    expect(reloaded.data[0].items[0].webImage).toEqual(image);
    expect(image).toMatchObject({ prompt: null, name: "desktop-screenshot.png", path, kind: "viewed" });
    expect(first.data[0].items[1].webImage).toBeUndefined();
    expect(first.data[0].items[2].webImage).toBeUndefined();
    const html = renderToStaticMarkup(createElement(Timeline, { chat: mergeHistory(emptyChat(), reloaded.data) }));
    expect(html).not.toContain(`src="${image.url}"`);
    expect(html).toContain("Work completed");
    expect(html).not.toContain("Generated image");
    const route = image.url.replace("/api/v1", "");
    const response = await h.request(route);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(png);
    expect((await h.request(route.replace(a.id, b.id))).status).toBe(404);
    expect((await h.request(route, "GET", undefined, { origin: "https://evil.test" })).status).toBe(403);
    await writeFile(path, "<svg/>");
    expect((await h.request(route)).status).toBe(422);
    await writeFile(path, Buffer.alloc(10 * 1024 * 1024 + 1));
    expect((await h.request(route)).status).toBe(422);
    await rm(path);
    expect((await h.request(route)).status).toBe(422);
  } finally { h.api.dispose(); await rm(dir, { recursive: true, force: true }); }
});

test("live viewed image events replace activity and survive replay without duplicate cards", async () => {
  const h = webHarness(); const a = await h.create();
  const response = await h.request(`/conversations/${a.id}/events`);
  const reader = response.body!.getReader();
  try {
    await reader.read();
    const viewed = { id: "viewed", type: "turn.image.viewed" as const, threadId: a.threadId, sessionId: "session", ts: new Date().toISOString(), payload: { itemId: "view", turnId: "turn", path: "/tmp/desktop-screenshot.png" } };
    h.publish(a.id, viewed);
    const chunk = new TextDecoder().decode((await reader.read()).value);
    const event = JSON.parse(chunk.split("\n").find((line) => line.startsWith("data:"))!.slice(5));
    expect(event.payload.url).toMatch(/^\/api\/v1\/conversations\/[\w-]+\/images\/[\w-]+$/);
    expect(event.payload.name).toBe("desktop-screenshot.png");
    let state = reduceBridge(emptyChat(), { ...viewed, id: "started", type: "turn.activity", payload: { itemId: "view", turnId: "turn", kind: "image", label: "Viewing image", detail: viewed.payload.path, status: "started" } });
    state = reduceBridge(state, event);
    state = reduceBridge(state, { ...event, id: "replay" });
    state = reduceBridge(state, { ...viewed, id: "finished", type: "turn.activity", payload: { itemId: "view", turnId: "turn", kind: "image", label: "Viewing image", detail: viewed.payload.path, status: "completed" } });
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]?.image).toMatchObject({ url: event.payload.url, name: "desktop-screenshot.png", prompt: null, path: viewed.payload.path });
    const html = renderToStaticMarkup(createElement(Timeline, { chat: state }));
    expect(html).not.toContain('<img');
    expect(html).toContain("viewed-image-disclosure");
    expect(html).not.toContain(" open=");
    state = reduceBridge(state, { ...viewed, id: "answer", type: "turn.message.completed", payload: { itemId: "answer", turnId: "turn", phase: "final_answer", text: `Here is your screenshot:\n\n![Desktop view](${viewed.payload.path})` } });
    const answerHtml = renderToStaticMarkup(createElement(Timeline, { chat: state }));
    expect(answerHtml).toContain('alt="Desktop view"');
    expect(answerHtml).toContain(`src="${event.payload.url}"`);
  } finally { await reader.cancel(); h.api.dispose(); }
});

test("history exposes scoped images and shared activity mapping; image reads respect origin and detach", async () => {
  const dir = await mkdtemp(join(tmpdir(), "web-images-"));
  const h = webHarness();
  try {
    const path = join(dir, "output.png"); await writeFile(path, png);
    h.application.conversation.listThreadTurns = async () => ({ data: [{ id: "turn", items: [
      { id: "image", type: "imageGeneration", status: "completed", savedPath: path, revisedPrompt: "A picture" },
      { id: "command", type: "commandExecution", status: "failed", command: "bun test", aggregatedOutput: "x".repeat(1024 * 1024) },
    ] }], nextCursor: null, backwardsCursor: null });
    const a = await h.create(); const b = await h.create();
    const page = await (await h.request(`/conversations/${a.id}/turns`)).json();
    const url = page.data[0].items[0].webImage.url as string;
    expect(page.data[0].items[1].webActivity.status).toBe("failed");
    expect(JSON.stringify(page)).not.toContain("aggregatedOutput");
    expect(JSON.stringify(page).length).toBeLessThan(10_000);
    const response = await h.request(url.replace("/api/v1", ""));
    expect(response.status).toBe(200); expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-control")).toBe("private, max-age=0, must-revalidate");
    const etag = response.headers.get("etag"); expect(etag).toBeTruthy();
    const unchanged = await h.request(url.replace("/api/v1", ""), "GET", undefined, { "if-none-match": etag! });
    expect(unchanged.status).toBe(304); expect(await unchanged.text()).toBe("");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(png);
    expect((await h.request(url.replace("/api/v1", "").replace(a.id, b.id))).status).toBe(404);
    expect((await h.request(url.replace("/api/v1", ""), "GET", undefined, { origin: "https://evil.test" })).status).toBe(403);
    expect((await h.request(`/conversations/${a.id}/images/unknown?path=${path}`)).status).toBe(404);
    await writeFile(path, "<svg onload='alert(1)'/>");
    expect((await h.request(url.replace("/api/v1", ""))).status).toBe(422);
    await h.request(`/conversations/${a.id}`, "DELETE");
    expect((await h.request(url.replace("/api/v1", ""))).status).toBe(404);
  } finally { h.api.dispose(); await rm(dir, { recursive: true, force: true }); }
});

test("image registry deduplicates artifacts and bounds retained paths", async () => {
  const images = new WebImages("conversation");
  const first = images.register("turn", "item", "/missing.png");
  expect(images.register("turn", "item", "/missing.png")).toBe(first);
  for (let i = 0; i < 256; i++) images.register("turn", String(i), "/missing.png");
  await expect(images.response(first.split("/").at(-1)!, new Headers())).rejects.toThrow("Image not found");
});

test("live image events receive a scoped asset URL before entering the event feed", async () => {
  const h = webHarness();
  const conversation = await h.create();
  const response = await h.request(`/conversations/${conversation.id}/events`);
  const reader = response.body!.getReader();
  try {
    await reader.read(); // connection comment
    h.publish(conversation.id, { id: "image-event", type: "turn.image.generated", threadId: conversation.threadId, sessionId: "session", ts: new Date().toISOString(), payload: { itemId: "image", turnId: "turn", path: "/missing.png", revisedPrompt: "Image" } });
    const chunk = new TextDecoder().decode((await reader.read()).value);
    expect(chunk).toContain(`/api/v1/conversations/${conversation.id}/images/`);
    expect(chunk).toContain('"revisedPrompt":"Image"');
  } finally { await reader.cancel(); h.api.dispose(); }
});
