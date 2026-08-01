import { describe, expect, test } from "bun:test";

import {
  discordAudioAttachmentToDataUrl,
  isDiscordAudioAttachment,
} from "../server/adapters/discord/audio_input.js";

describe("Discord audio input", () => {
  test("downloads Discord voice messages into inline audio data URLs", async () => {
    const seen: Array<{ input: string; init?: RequestInit }> = [];
    const audioBytes = new TextEncoder().encode("OggS\0OpusHead");
    const result = await discordAudioAttachmentToDataUrl(
      {
        url: "https://cdn.discordapp.com/attachments/voice-message.ogg",
        contentType: "audio/ogg; codecs=opus",
        name: "voice-message.ogg",
        size: audioBytes.byteLength,
      },
      {
        async fetchImpl(input, init) {
          seen.push({ input, init });
          return new Response(audioBytes, {
            headers: {
              "content-length": String(audioBytes.byteLength),
              "content-type": "audio/ogg",
            },
          });
        },
      },
    );

    expect(result).toBe(
      `data:audio/ogg;base64,${Buffer.from(audioBytes).toString("base64")}`,
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]?.input).toBe(
      "https://cdn.discordapp.com/attachments/voice-message.ogg",
    );
    expect(seen[0]?.init?.redirect).toBe("follow");
    expect(seen[0]?.init?.signal).toBeInstanceOf(AbortSignal);
  });

  test("normalizes common audio MIME aliases", async () => {
    const wavBytes = new Uint8Array([
      0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45,
    ]);
    const result = await discordAudioAttachmentToDataUrl(
      {
        url: "https://cdn.discordapp.com/attachments/message.wav",
        contentType: "audio/x-wav",
        name: "message.wav",
      },
      {
        async fetchImpl() {
          return new Response(wavBytes, {
            headers: { "content-type": "audio/wave" },
          });
        },
      },
    );

    expect(result.startsWith("data:audio/wav;base64,")).toBe(true);
  });

  test("rejects declared audio that exceeds the byte limit before fetching", async () => {
    let fetched = false;
    expect(
      discordAudioAttachmentToDataUrl(
        {
          url: "https://cdn.discordapp.com/attachments/large.ogg",
          contentType: "audio/ogg",
          name: "large.ogg",
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
    ).rejects.toThrow("exceeds the 4 byte audio limit");
    expect(fetched).toBe(false);
  });

  test("enforces the byte limit while streaming responses without a length", async () => {
    expect(
      discordAudioAttachmentToDataUrl(
        {
          url: "https://cdn.discordapp.com/attachments/large.ogg",
          contentType: "audio/ogg",
          name: "large.ogg",
        },
        {
          maxBytes: 3,
          async fetchImpl() {
            return new Response(new Uint8Array([1, 2, 3, 4]), {
              headers: { "content-type": "audio/ogg" },
            });
          },
        },
      ),
    ).rejects.toThrow("exceeds the 3 byte audio limit");
  });

  test("rejects mismatched response types and spoofed audio", async () => {
    expect(
      discordAudioAttachmentToDataUrl(
        {
          url: "https://cdn.discordapp.com/attachments/not-audio.ogg",
          contentType: "audio/ogg",
          name: "not-audio.ogg",
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

    expect(
      discordAudioAttachmentToDataUrl(
        {
          url: "https://cdn.discordapp.com/attachments/spoofed.ogg",
          contentType: "audio/ogg",
          name: "spoofed.ogg",
        },
        {
          async fetchImpl() {
            return new Response("not ogg audio", {
              headers: { "content-type": "audio/ogg" },
            });
          },
        },
      ),
    ).rejects.toThrow("does not contain valid audio/ogg data");
  });

  test("recognizes voice attachments without treating video as audio", () => {
    expect(
      isDiscordAudioAttachment({
        url: "https://cdn.discordapp.com/attachments/voice-message.ogg",
        contentType: "audio/ogg; codecs=opus",
        name: "voice-message.ogg",
      }),
    ).toBe(true);
    expect(
      isDiscordAudioAttachment({
        url: "https://cdn.discordapp.com/attachments/video.webm",
        contentType: "video/webm",
        name: "video.webm",
      }),
    ).toBe(false);
    expect(
      isDiscordAudioAttachment({
        url: "https://cdn.discordapp.com/attachments/lossless.flac",
        contentType: "audio/flac",
        name: "lossless.flac",
      }),
    ).toBe(true);
  });
});
