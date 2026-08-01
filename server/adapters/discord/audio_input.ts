import { Buffer } from "node:buffer";

export const DISCORD_AUDIO_MAX_BYTES = 10 * 1024 * 1024;
export const DISCORD_AUDIO_FETCH_TIMEOUT_MS = 30_000;

export type DiscordAudioAttachment = {
  contentType?: string | null;
  name?: string | null;
  size?: number;
  url: string;
};

export type DiscordAudioFetch = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

export type DiscordAudioInputOptions = {
  fetchImpl?: DiscordAudioFetch;
  maxBytes?: number;
  timeoutMs?: number;
};

const EXTENSION_MIME_TYPES = new Map([
  [".m4a", "audio/mp4"],
  [".mp3", "audio/mpeg"],
  [".oga", "audio/ogg"],
  [".ogg", "audio/ogg"],
  [".opus", "audio/ogg"],
  [".wav", "audio/wav"],
  [".webm", "audio/webm"],
]);

const SUPPORTED_MIME_TYPES = new Set(EXTENSION_MIME_TYPES.values());

function attachmentName(attachment: DiscordAudioAttachment): string {
  return attachment.name?.trim() || "Discord audio";
}

function baseMimeType(value: string | null | undefined): string | null {
  return value?.split(";", 1)[0]?.trim().toLowerCase() || null;
}

function normalizedMimeType(value: string | null | undefined): string | null {
  const mimeType = baseMimeType(value);
  if (!mimeType) return null;
  if (mimeType === "application/ogg" || mimeType === "audio/opus") return "audio/ogg";
  if (mimeType === "audio/x-m4a") return "audio/mp4";
  if (mimeType === "audio/wave" || mimeType === "audio/x-wav") return "audio/wav";
  return SUPPORTED_MIME_TYPES.has(mimeType) ? mimeType : null;
}

function mimeTypeFromName(name: string | null | undefined): string | null {
  const normalized = name?.trim().toLowerCase() ?? "";
  for (const [extension, mimeType] of EXTENSION_MIME_TYPES) {
    if (normalized.endsWith(extension)) return mimeType;
  }
  return null;
}

function resolveMimeType(
  attachment: DiscordAudioAttachment,
  response: Response,
): string {
  const declared = normalizedMimeType(attachment.contentType) ?? mimeTypeFromName(attachment.name);
  const responseHeader = response.headers.get("content-type");
  const responseBaseType = baseMimeType(responseHeader);
  const received = normalizedMimeType(responseHeader);

  if (responseHeader && !received && responseBaseType !== "application/octet-stream") {
    throw new Error(
      `${attachmentName(attachment)} returned unsupported content type ${responseHeader}.`,
    );
  }
  if (declared && received && declared !== received) {
    throw new Error(
      `${attachmentName(attachment)} content type changed from ${declared} to ${received}.`,
    );
  }

  const resolved = received ?? declared;
  if (!resolved) {
    throw new Error(
      `${attachmentName(attachment)} must be an MP3, MP4/M4A, Ogg/Opus, WAV, or WebM audio file.`,
    );
  }
  return resolved;
}

function validateContentLength(
  attachment: DiscordAudioAttachment,
  response: Response,
  maxBytes: number,
): void {
  const rawLength = response.headers.get("content-length");
  if (!rawLength) return;
  const length = Number(rawLength);
  if (Number.isFinite(length) && length > maxBytes) {
    throw new Error(
      `${attachmentName(attachment)} exceeds the ${maxBytes} byte audio limit.`,
    );
  }
}

function hasPrefix(body: Buffer, prefix: number[]): boolean {
  return prefix.every((byte, index) => body[index] === byte);
}

function hasMp3FrameHeader(body: Buffer): boolean {
  return body.length >= 2 && body[0] === 0xff && (body[1]! & 0xe0) === 0xe0;
}

function validateAudioSignature(
  attachment: DiscordAudioAttachment,
  mimeType: string,
  body: Buffer,
): void {
  const valid =
    (mimeType === "audio/mpeg" &&
      (body.subarray(0, 3).toString("ascii") === "ID3" || hasMp3FrameHeader(body))) ||
    (mimeType === "audio/mp4" && body.subarray(4, 8).toString("ascii") === "ftyp") ||
    (mimeType === "audio/ogg" && body.subarray(0, 4).toString("ascii") === "OggS") ||
    (mimeType === "audio/wav" &&
      body.subarray(0, 4).toString("ascii") === "RIFF" &&
      body.subarray(8, 12).toString("ascii") === "WAVE") ||
    (mimeType === "audio/webm" && hasPrefix(body, [0x1a, 0x45, 0xdf, 0xa3]));

  if (!valid) {
    throw new Error(
      `${attachmentName(attachment)} does not contain valid ${mimeType} data.`,
    );
  }
}

async function readBoundedBody(
  attachment: DiscordAudioAttachment,
  response: Response,
  maxBytes: number,
): Promise<Buffer> {
  if (!response.body) {
    throw new Error(`${attachmentName(attachment)} returned an empty response.`);
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel();
      throw new Error(
        `${attachmentName(attachment)} exceeds the ${maxBytes} byte audio limit.`,
      );
    }
    chunks.push(value);
  }

  if (totalBytes === 0) {
    throw new Error(`${attachmentName(attachment)} returned empty audio.`);
  }
  return Buffer.concat(chunks, totalBytes);
}

export function isDiscordAudioAttachment(
  attachment: DiscordAudioAttachment,
): boolean {
  const contentType = baseMimeType(attachment.contentType);
  if (contentType?.startsWith("video/")) return false;
  return contentType?.startsWith("audio/") === true || mimeTypeFromName(attachment.name) !== null;
}

export async function discordAudioAttachmentToDataUrl(
  attachment: DiscordAudioAttachment,
  options: DiscordAudioInputOptions = {},
): Promise<string> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxBytes = options.maxBytes ?? DISCORD_AUDIO_MAX_BYTES;
  const timeoutMs = options.timeoutMs ?? DISCORD_AUDIO_FETCH_TIMEOUT_MS;

  if (attachment.size !== undefined && attachment.size > maxBytes) {
    throw new Error(
      `${attachmentName(attachment)} exceeds the ${maxBytes} byte audio limit.`,
    );
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(attachment.url);
  } catch {
    throw new Error(`${attachmentName(attachment)} has an invalid attachment URL.`);
  }
  if (parsedUrl.protocol !== "https:") {
    throw new Error(`${attachmentName(attachment)} must use a secure attachment URL.`);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  timeout.unref?.();

  try {
    let response: Response;
    try {
      response = await fetchImpl(attachment.url, {
        redirect: "follow",
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(`${attachmentName(attachment)} download timed out.`);
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${attachmentName(attachment)} could not be downloaded: ${message}`);
    }

    if (!response.ok) {
      throw new Error(
        `${attachmentName(attachment)} download failed with HTTP ${response.status}.`,
      );
    }

    validateContentLength(attachment, response, maxBytes);
    const mimeType = resolveMimeType(attachment, response);
    const body = await readBoundedBody(attachment, response, maxBytes);
    validateAudioSignature(attachment, mimeType, body);
    return `data:${mimeType};base64,${body.toString("base64")}`;
  } finally {
    clearTimeout(timeout);
  }
}
