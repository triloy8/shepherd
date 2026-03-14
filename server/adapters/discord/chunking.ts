export type DiscordChunkingOptions = {
  maxChars?: number;
  maxLines?: number;
};

type OpenFence = {
  indent: string;
  markerChar: string;
  markerLen: number;
  openLine: string;
};

export const DISCORD_STREAM_CHUNK_LIMIT = 1900;
export const DISCORD_STREAM_SOFT_LINE_LIMIT = 18;

const FENCE_RE = /^( {0,3})(`{3,}|~{3,})(.*)$/;

function countLines(text: string): number {
  if (!text) return 0;
  return text.split("\n").length;
}

function parseFenceLine(line: string): OpenFence | null {
  const match = line.match(FENCE_RE);
  if (!match) return null;
  const indent = match[1] ?? "";
  const marker = match[2] ?? "";
  return {
    indent,
    markerChar: marker[0] ?? "`",
    markerLen: marker.length,
    openLine: line,
  };
}

function closeFenceLine(openFence: OpenFence): string {
  return `${openFence.indent}${openFence.markerChar.repeat(openFence.markerLen)}`;
}

function closeFenceIfNeeded(text: string, openFence: OpenFence | null): string {
  if (!openFence) return text;
  const closeLine = closeFenceLine(openFence);
  if (!text) return closeLine;
  return text.endsWith("\n") ? `${text}${closeLine}` : `${text}\n${closeLine}`;
}

function splitLongLine(
  line: string,
  maxChars: number,
  opts: { preserveWhitespace: boolean },
): string[] {
  const limit = Math.max(1, Math.floor(maxChars));
  if (line.length <= limit) return [line];

  const segments: string[] = [];
  let remaining = line;
  while (remaining.length > limit) {
    if (opts.preserveWhitespace) {
      segments.push(remaining.slice(0, limit));
      remaining = remaining.slice(limit);
      continue;
    }

    const window = remaining.slice(0, limit);
    let breakAt = Math.max(window.lastIndexOf("\n"), window.lastIndexOf(" "), window.lastIndexOf("\t"));
    if (breakAt <= 0) {
      breakAt = limit;
    }
    segments.push(remaining.slice(0, breakAt));
    remaining = remaining.slice(breakAt);
  }

  if (remaining.length > 0) {
    segments.push(remaining);
  }

  return segments;
}

export function chunkForDiscord(
  text: string,
  maxChunkSizeOrOptions: number | DiscordChunkingOptions = {},
): string[] {
  if (!text) return [];

  const options =
    typeof maxChunkSizeOrOptions === "number"
      ? { maxChars: maxChunkSizeOrOptions }
      : maxChunkSizeOrOptions;
  const maxChars = Math.max(1, Math.floor(options.maxChars ?? DISCORD_STREAM_CHUNK_LIMIT));
  const maxLines = Math.max(1, Math.floor(options.maxLines ?? DISCORD_STREAM_SOFT_LINE_LIMIT));

  if (text.length <= maxChars && countLines(text) <= maxLines) {
    return [text];
  }

  const lines = text.split("\n");
  const chunks: string[] = [];

  let current = "";
  let currentLines = 0;
  let openFence: OpenFence | null = null;
  let reopenedFencePrefix = false;

  const flush = () => {
    if (!current) return;
    const payload = closeFenceIfNeeded(current, openFence);
    if (payload.trim().length > 0) {
      chunks.push(payload);
    }
    current = "";
    currentLines = 0;
    reopenedFencePrefix = false;
    if (openFence) {
      current = openFence.openLine;
      currentLines = 1;
      reopenedFencePrefix = true;
    }
  };

  for (const originalLine of lines) {
    const fenceInfo = parseFenceLine(originalLine);
    const wasInsideFence = openFence !== null;
    let nextOpenFence: OpenFence | null = openFence;

    if (fenceInfo) {
      if (!openFence) {
        nextOpenFence = fenceInfo;
      } else if (
        openFence.markerChar === fenceInfo.markerChar &&
        fenceInfo.markerLen >= openFence.markerLen
      ) {
        nextOpenFence = null;
      }
    }

    const reserveChars = nextOpenFence ? closeFenceLine(nextOpenFence).length + 1 : 0;
    const reserveLines = nextOpenFence ? 1 : 0;
    const effectiveMaxChars = maxChars - reserveChars;
    const effectiveMaxLines = maxLines - reserveLines;
    const charLimit = effectiveMaxChars > 0 ? effectiveMaxChars : maxChars;
    const lineLimit = effectiveMaxLines > 0 ? effectiveMaxLines : maxLines;
    const prefixLen = current.length > 0 ? current.length + 1 : 0;
    const segmentLimit = Math.max(1, charLimit - prefixLen);
    const segments = splitLongLine(originalLine, segmentLimit, {
      preserveWhitespace: wasInsideFence,
    });

    for (let segIndex = 0; segIndex < segments.length; segIndex += 1) {
      const segment = segments[segIndex]!;
      const isLineContinuation = segIndex > 0;
      const projectedDelimiter =
        current.length > 0 ? (reopenedFencePrefix || !isLineContinuation ? "\n" : "") : "";
      const projectedLength = current.length + projectedDelimiter.length + segment.length;
      const projectedLineCount = currentLines + (isLineContinuation ? 0 : 1);

      if ((projectedLength > charLimit || projectedLineCount > lineLimit) && current.length > 0) {
        flush();
      }

      const delimiter =
        current.length > 0 ? (reopenedFencePrefix || !isLineContinuation ? "\n" : "") : "";
      const addition = `${delimiter}${segment}`;

      if (current.length > 0) {
        current += addition;
        reopenedFencePrefix = false;
        if (!isLineContinuation) {
          currentLines += 1;
        }
      } else {
        current = segment;
        currentLines = 1;
        reopenedFencePrefix = false;
      }
    }

    openFence = nextOpenFence;
  }

  if (current.length > 0) {
    const payload = closeFenceIfNeeded(current, openFence);
    if (payload.trim().length > 0) {
      chunks.push(payload);
    }
  }

  return chunks;
}
