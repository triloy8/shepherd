import { describe, expect, test } from "bun:test";

import {
  discordImageAttachmentToDataUrl,
  isDiscordImageAttachment,
} from "../server/adapters/discord/image_input.js";

describe("Discord image input", () => {
  test("downloads supported images into inline data URLs", async () => {
    const seen: Array<{ input: string; init?: RequestInit }> = [];
    const imageBytes = new TextEncoder().encode("RIFF0000WEBP");
    const result = await discordImageAttachmentToDataUrl(
      {
        url: "https://cdn.discordapp.com/attachments/image.webp",
        contentType: "image/webp",
        name: "image.webp",
        size: imageBytes.byteLength,
      },
      {
        async fetchImpl(input, init) {
          seen.push({ input, init });
          return new Response(imageBytes, {
            headers: {
              "content-length": String(imageBytes.byteLength),
              "content-type": "image/webp",
            },
          });
        },
      },
    );

    expect(result).toBe(
      `data:image/webp;base64,${Buffer.from(imageBytes).toString("base64")}`,
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]?.input).toBe("https://cdn.discordapp.com/attachments/image.webp");
    expect(seen[0]?.init?.redirect).toBe("follow");
    expect(seen[0]?.init?.signal).toBeInstanceOf(AbortSignal);
  });

  test("rejects declared images that exceed the byte limit before fetching", async () => {
    let fetched = false;
    expect(
      discordImageAttachmentToDataUrl(
        {
          url: "https://cdn.discordapp.com/attachments/large.png",
          contentType: "image/png",
          name: "large.png",
          size: 5,
        },
        {
          maxBytes: 4,
          async fetchImpl() {
            fetched = true;
            return new Response();
          },
        },
      ),
    ).rejects.toThrow("exceeds the 4 byte image limit");
    expect(fetched).toBe(false);
  });

  test("enforces the byte limit while streaming responses without a length", async () => {
    expect(
      discordImageAttachmentToDataUrl(
        {
          url: "https://cdn.discordapp.com/attachments/large.png",
          contentType: "image/png",
          name: "large.png",
        },
        {
          maxBytes: 3,
          async fetchImpl() {
            return new Response(new Uint8Array([1, 2, 3, 4]), {
              headers: { "content-type": "image/png" },
            });
          },
        },
      ),
    ).rejects.toThrow("exceeds the 3 byte image limit");
  });

  test("rejects failed downloads and mismatched response types", async () => {
    expect(
      discordImageAttachmentToDataUrl(
        {
          url: "https://cdn.discordapp.com/attachments/missing.png",
          contentType: "image/png",
          name: "missing.png",
        },
        {
          async fetchImpl() {
            return new Response("missing", { status: 404 });
          },
        },
      ),
    ).rejects.toThrow("download failed with HTTP 404");

    expect(
      discordImageAttachmentToDataUrl(
        {
          url: "https://cdn.discordapp.com/attachments/not-image.png",
          contentType: "image/png",
          name: "not-image.png",
        },
        {
          async fetchImpl() {
            return new Response("<html></html>", {
              headers: { "content-type": "text/html" },
            });
          },
        },
      ),
    ).rejects.toThrow("returned unsupported content type text/html");
  });

  test("rejects content that does not match the declared image signature", async () => {
    expect(
      discordImageAttachmentToDataUrl(
        {
          url: "https://cdn.discordapp.com/attachments/spoofed.png",
          contentType: "image/png",
          name: "spoofed.png",
        },
        {
          async fetchImpl() {
            return new Response("not a png", {
              headers: { "content-type": "image/png" },
            });
          },
        },
      ),
    ).rejects.toThrow("does not contain valid image/png data");
  });

  test("recognizes supported extensions without trusting unsupported formats", () => {
    expect(
      isDiscordImageAttachment({
        url: "https://cdn.discordapp.com/attachments/photo.JPG",
        name: "photo.JPG",
      }),
    ).toBe(true);
    expect(
      isDiscordImageAttachment({
        url: "https://cdn.discordapp.com/attachments/vector.svg",
        name: "vector.svg",
      }),
    ).toBe(false);
  });
});
