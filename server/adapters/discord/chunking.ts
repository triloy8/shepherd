export type DiscordChunkingOptions = {
  maxChars?: number;
  maxLines?: number;
  includePageIndicators?: boolean;
};

type OpenFence = {
  indent: string;
  markerChar: string;
  markerLen: number;
  openLine: string;
};

export const DISCORD_MESSAGE_LIMIT = 2000;
export const DISCORD_CHUNK_TARGET = 1900;

const PAGE_INDICATOR_RESERVE = 18;
const FENCE_RE = /^( {0,3})(`{3,}|~{3,})(.*)$/;

export function discordTextLength(text: string): number {
  // Discord.js validates JavaScript strings, so count UTF-16 units
  // conservatively while splitting only at complete code-point boundaries.
  return text.length;
}

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

function countUnescapedBackticks(text: string): number {
  let count = 0;
  let escaped = false;
  for (const character of text) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character === "`") count += 1;
  }
  return count;
}

function chooseNaturalBreak(points: string[], limit: number): number {
  if (points.length <= limit) return points.length;

  let breakAt = limit;
  for (let index = limit - 1; index > 0; index -= 1) {
    if (points[index] === " " || points[index] === "\t") {
      breakAt = index;
      break;
    }
  }

  const prefix = points.slice(0, breakAt).join("");
  if (countUnescapedBackticks(prefix) % 2 === 1) {
    const openingBacktick = prefix.lastIndexOf("`");
    const beforeOpening = Array.from(prefix.slice(0, openingBacktick)).length;
    if (beforeOpening >= Math.floor(limit / 4)) {
      breakAt = beforeOpening;
    }
  }
  return Math.max(1, breakAt);
}

function splitLongLine(
  line: string,
  maxChars: number,
  opts: { preserveWhitespace: boolean },
): string[] {
  const limit = Math.max(1, Math.floor(maxChars));
  let remaining = Array.from(line);
  let remainingLength = discordTextLength(line);
  if (remainingLength <= limit) return [line];

  const segments: string[] = [];
  while (remainingLength > limit) {
    let fittedPoints = 0;
    let fittedLength = 0;
    while (fittedPoints < remaining.length) {
      const pointLength = remaining[fittedPoints]!.length;
      if (fittedPoints > 0 && fittedLength + pointLength > limit) break;
      fittedLength += pointLength;
      fittedPoints += 1;
      if (fittedLength >= limit) break;
    }
    const breakAt = opts.preserveWhitespace
      ? fittedPoints
      : chooseNaturalBreak(remaining, fittedPoints);
    const segment = remaining.slice(0, breakAt).join("");
    segments.push(segment);
    remaining = remaining.slice(breakAt);
    remainingLength -= discordTextLength(segment);
  }

  if (remaining.length > 0) segments.push(remaining.join(""));
  return segments;
}

function rawDiscordChunks(text: string, maxChars: number, maxLines: number): string[] {
  const lines = text.split("\n");
  const chunks: string[] = [];

  let current = "";
  let currentLength = 0;
  let currentLines = 0;
  let openFence: OpenFence | null = null;
  let reopenedFencePrefix = false;

  const flush = () => {
    if (!current) return;
    const payload = closeFenceIfNeeded(current, openFence);
    if (payload.length > 0) {
      chunks.push(payload);
    }
    current = "";
    currentLength = 0;
    currentLines = 0;
    reopenedFencePrefix = false;
    if (openFence) {
      current = openFence.openLine;
      currentLength = discordTextLength(openFence.openLine);
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

    const reserveChars = nextOpenFence ? discordTextLength(closeFenceLine(nextOpenFence)) + 1 : 0;
    const reserveLines = nextOpenFence ? 1 : 0;
    const effectiveMaxChars = maxChars - reserveChars;
    const effectiveMaxLines = maxLines - reserveLines;
    const charLimit = effectiveMaxChars > 0 ? effectiveMaxChars : maxChars;
    const lineLimit = effectiveMaxLines > 0 ? effectiveMaxLines : maxLines;
    const prefixLen = current.length > 0 ? currentLength + 1 : 0;
    const segmentLimit = Math.max(1, charLimit - prefixLen);
    const segments = splitLongLine(originalLine, segmentLimit, {
      preserveWhitespace: wasInsideFence,
    });

    for (let segIndex = 0; segIndex < segments.length; segIndex += 1) {
      const segment = segments[segIndex]!;
      const isLineContinuation = segIndex > 0;
      const projectedDelimiter =
        current.length > 0 ? (reopenedFencePrefix || !isLineContinuation ? "\n" : "") : "";
      const segmentLength = discordTextLength(segment);
      const projectedLength = currentLength + projectedDelimiter.length + segmentLength;
      const projectedLineCount = currentLines + (isLineContinuation ? 0 : 1);

      if ((projectedLength > charLimit || projectedLineCount > lineLimit) && current.length > 0) {
        flush();
      }

      const delimiter =
        current.length > 0 ? (reopenedFencePrefix || !isLineContinuation ? "\n" : "") : "";
      if (current.length > 0) {
        current += `${delimiter}${segment}`;
        currentLength += delimiter.length + segmentLength;
        reopenedFencePrefix = false;
        if (!isLineContinuation) currentLines += 1;
      } else {
        current = segment;
        currentLength = segmentLength;
        currentLines = 1;
        reopenedFencePrefix = false;
      }
    }

    openFence = nextOpenFence;
  }

  if (current.length > 0) {
    const payload = closeFenceIfNeeded(current, openFence);
    if (payload.length > 0) chunks.push(payload);
  }

  return chunks;
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
  const maxChars = Math.max(1, Math.floor(options.maxChars ?? DISCORD_MESSAGE_LIMIT));
  const maxLines =
    options.maxLines === undefined ? Number.POSITIVE_INFINITY : Math.max(1, Math.floor(options.maxLines));
  const includePageIndicators = options.includePageIndicators ?? true;

  if (discordTextLength(text) <= maxChars && countLines(text) <= maxLines) {
    return [text];
  }

  const contentLimit = includePageIndicators
    ? Math.max(1, maxChars - PAGE_INDICATOR_RESERVE)
    : maxChars;
  const chunks = rawDiscordChunks(text, contentLimit, maxLines);
  if (!includePageIndicators || chunks.length <= 1) {
    return chunks;
  }

  return chunks.map((chunk, index) => `(${index + 1}/${chunks.length})\n${chunk}`);
}
