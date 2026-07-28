import { Buffer } from "node:buffer";

export const DISCORD_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const DISCORD_IMAGE_FETCH_TIMEOUT_MS = 30_000;

export type DiscordImageAttachment = {
  contentType?: string | null;
  name?: string | null;
  size?: number;
  url: string;
};

export type DiscordImageFetch = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

export type DiscordImageInputOptions = {
  fetchImpl?: DiscordImageFetch;
  maxBytes?: number;
  timeoutMs?: number;
};

const EXTENSION_MIME_TYPES = new Map([
  [".gif", "image/gif"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".png", "image/png"],
  [".webp", "image/webp"],
]);

const SUPPORTED_MIME_TYPES = new Set(EXTENSION_MIME_TYPES.values());

function attachmentName(attachment: DiscordImageAttachment): string {
  return attachment.name?.trim() || "Discord image";
}

function normalizedMimeType(value: string | null | undefined): string | null {
  const mimeType = value?.split(";", 1)[0]?.trim().toLowerCase();
  if (!mimeType) return null;
  if (mimeType === "image/jpg") return "image/jpeg";
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
  attachment: DiscordImageAttachment,
  response: Response,
): string {
  const declared = normalizedMimeType(attachment.contentType) ?? mimeTypeFromName(attachment.name);
  const responseHeader = response.headers.get("content-type");
  const responseBaseType = responseHeader?.split(";", 1)[0]?.trim().toLowerCase();
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
      `${attachmentName(attachment)} must be a PNG, JPEG, GIF, or WebP image.`,
    );
  }
  return resolved;
}

function validateContentLength(
  attachment: DiscordImageAttachment,
  response: Response,
  maxBytes: number,
): void {
  const rawLength = response.headers.get("content-length");
  if (!rawLength) return;
  const length = Number(rawLength);
  if (Number.isFinite(length) && length > maxBytes) {
    throw new Error(
      `${attachmentName(attachment)} exceeds the ${maxBytes} byte image limit.`,
    );
  }
}

function hasPrefix(body: Buffer, prefix: number[]): boolean {
  return prefix.every((byte, index) => body[index] === byte);
}

function validateImageSignature(
  attachment: DiscordImageAttachment,
  mimeType: string,
  body: Buffer,
): void {
  const valid =
    (mimeType === "image/png" &&
      hasPrefix(body, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) ||
    (mimeType === "image/jpeg" && hasPrefix(body, [0xff, 0xd8, 0xff])) ||
    (mimeType === "image/gif" &&
      (body.subarray(0, 6).toString("ascii") === "GIF87a" ||
        body.subarray(0, 6).toString("ascii") === "GIF89a")) ||
    (mimeType === "image/webp" &&
      body.subarray(0, 4).toString("ascii") === "RIFF" &&
      body.subarray(8, 12).toString("ascii") === "WEBP");

  if (!valid) {
    throw new Error(
      `${attachmentName(attachment)} does not contain valid ${mimeType} data.`,
    );
  }
}

async function readBoundedBody(
  attachment: DiscordImageAttachment,
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
        `${attachmentName(attachment)} exceeds the ${maxBytes} byte image limit.`,
      );
    }
    chunks.push(value);
  }

  if (totalBytes === 0) {
    throw new Error(`${attachmentName(attachment)} returned an empty image.`);
  }
  return Buffer.concat(chunks, totalBytes);
}

export function isDiscordImageAttachment(
  attachment: DiscordImageAttachment,
): boolean {
  return (
    attachment.contentType?.toLowerCase().startsWith("image/") === true ||
    mimeTypeFromName(attachment.name) !== null
  );
}

export async function discordImageAttachmentToDataUrl(
  attachment: DiscordImageAttachment,
  options: DiscordImageInputOptions = {},
): Promise<string> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxBytes = options.maxBytes ?? DISCORD_IMAGE_MAX_BYTES;
  const timeoutMs = options.timeoutMs ?? DISCORD_IMAGE_FETCH_TIMEOUT_MS;

  if (attachment.size !== undefined && attachment.size > maxBytes) {
    throw new Error(
      `${attachmentName(attachment)} exceeds the ${maxBytes} byte image limit.`,
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
    validateImageSignature(attachment, mimeType, body);
    return `data:${mimeType};base64,${body.toString("base64")}`;
  } finally {
    clearTimeout(timeout);
  }
}
