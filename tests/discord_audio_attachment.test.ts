import { describe, expect, test } from "bun:test";

import { isDiscordAudioAttachment } from "../server/adapters/discord/audio_attachment.js";

describe("Discord audio attachment detection", () => {
  test("recognizes audio MIME types and known audio extensions", () => {
    expect(
      isDiscordAudioAttachment({
        contentType: "audio/ogg; codecs=opus",
        name: "voice-message.ogg",
      }),
    ).toBe(true);
    expect(
      isDiscordAudioAttachment({
        contentType: "application/octet-stream",
        name: "recording.m4a",
      }),
    ).toBe(true);
  });

  test("does not misclassify video or unrelated attachments", () => {
    expect(
      isDiscordAudioAttachment({
        contentType: "video/webm",
        name: "video.webm",
      }),
    ).toBe(false);
    expect(
      isDiscordAudioAttachment({
        contentType: "image/png",
        name: "image.png",
      }),
    ).toBe(false);
  });
});
