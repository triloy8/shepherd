import { expect, test } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { webHarness } from "./helpers/web_harness";
import { WebImages } from "../server/adapters/web/images";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=", "base64");

test("history exposes scoped images and shared activity mapping; image reads respect origin and detach", async () => {
  const dir = await mkdtemp(join(tmpdir(), "web-images-"));
  const h = webHarness();
  try {
    const path = join(dir, "output.png"); await writeFile(path, png);
    h.application.conversation.listThreadTurns = async () => ({ data: [{ id: "turn", items: [
      { id: "image", type: "imageGeneration", status: "completed", savedPath: path, revisedPrompt: "A picture" },
      { id: "command", type: "commandExecution", status: "failed", command: "bun test" },
    ] }], nextCursor: null, backwardsCursor: null });
    const a = await h.create(); const b = await h.create();
    const page = await (await h.request(`/conversations/${a.id}/turns`)).json();
    const url = page.data[0].items[0].webImage.url as string;
    expect(page.data[0].items[1].webActivity.status).toBe("failed");
    const response = await h.request(url.replace("/api/v1", ""));
    expect(response.status).toBe(200); expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-control")).toBe("no-store");
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
