import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  loadGeneratedImageAttachment,
  sendDiscordGeneratedImage,
} from "../server/adapters/discord/generated_image_delivery.js";

const temporaryDirectories: string[] = [];

async function temporaryPath(name: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "shepherd-generated-image-"));
  temporaryDirectories.push(directory);
  return path.join(directory, name);
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("Discord generated image delivery", () => {
  test("loads valid generated images through a bounded file handle", async () => {
    const imagePath = await temporaryPath("unicorn.bin");
    const png = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    await writeFile(imagePath, png);

    const attachment = await loadGeneratedImageAttachment(imagePath);

    expect(attachment.name).toBe("unicorn.png");
    expect(attachment.attachment).toEqual(png);
  });

  test("rejects relative, non-file, oversized, and unsupported artifacts", async () => {
    expect(loadGeneratedImageAttachment("relative.png")).rejects.toThrow(
      "path must be absolute",
    );

    const directoryPath = await temporaryPath("directory");
    await mkdir(directoryPath);
    expect(loadGeneratedImageAttachment(directoryPath)).rejects.toThrow(
      "not a regular file",
    );

    const oversizedPath = await temporaryPath("oversized.png");
    await writeFile(
      oversizedPath,
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    expect(
      loadGeneratedImageAttachment(oversizedPath, { maxBytes: 4 }),
    ).rejects.toThrow("exceeds the 4 byte upload limit");

    const unsupportedPath = await temporaryPath("not-image.png");
    await writeFile(unsupportedPath, "not an image");
    expect(loadGeneratedImageAttachment(unsupportedPath)).rejects.toThrow(
      "must be a PNG, JPEG, GIF, or WebP",
    );
  });

  test("uploads prepared image bytes with a bounded description", async () => {
    const payloads: unknown[] = [];
    const channel = {
      async send(payload: unknown) {
        payloads.push(payload);
        return { id: "image-message-1", async edit() {} };
      },
    };
    const result = await sendDiscordGeneratedImage(
      channel as never,
      "/tmp/unicorn.png",
      {
        description: `unicorn ${"x".repeat(2_000)}`,
        async loadAttachment() {
          return {
            attachment: Buffer.from("png"),
            name: "unicorn.png",
          };
        },
      },
    );

    expect(result).toEqual({
      success: true,
      messageId: "image-message-1",
      error: null,
    });
    const payload = payloads[0] as {
      files: Array<{ attachment: Buffer; name: string; description: string }>;
    };
    expect(payload.files[0]?.name).toBe("unicorn.png");
    expect(payload.files[0]?.attachment).toEqual(Buffer.from("png"));
    expect(payload.files[0]?.description.length).toBe(1_024);
  });

  test("returns upload failures without throwing", async () => {
    const channel = {
      async send() {
        throw new Error("Discord rejected attachment");
      },
    };
    const result = await sendDiscordGeneratedImage(
      channel as never,
      "/tmp/unicorn.png",
      {
        async loadAttachment() {
          return {
            attachment: Buffer.from("png"),
            name: "unicorn.png",
          };
        },
      },
    );

    expect(result).toEqual({
      success: false,
      messageId: null,
      error: "Discord rejected attachment",
    });
  });
});
