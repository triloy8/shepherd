import { homedir } from "node:os";
import path from "node:path";

type LocalPathFormattingOptions = {
  cwd?: string;
  homePath?: string;
};

type FenceState = {
  marker: "`" | "~";
  length: number;
};

const FENCE_RE = /^( {0,3})(`{3,}|~{3,})/;
const ANGLED_LOCAL_LINK_RE = /(?<!!)\[([^\]\n]+)\]\(<((?:file:\/\/)?\/[^>\n]+)>\)/g;
const BARE_LOCAL_LINK_RE = /(?<!!)\[([^\]\n]+)\]\(((?:file:\/\/)?\/(?:\\\)|[^)\n])*)\)/g;
const ANGLED_LOCAL_CODE_LABEL_LINK_RE =
  /(?<!!)\[(`+)[^\]\n]*?\1\]\(<((?:file:\/\/)?\/[^>\n]+)>\)/g;
const BARE_LOCAL_CODE_LABEL_LINK_RE =
  /(?<!!)\[(`+)[^\]\n]*?\1\]\(((?:file:\/\/)?\/(?:\\\)|[^)\n])*)\)/g;

function safeDecodeUri(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function splitLocationSuffix(value: string): { filePath: string; suffix: string } {
  const match = value.match(/:(\d+)(?::(\d+))?$/);
  if (!match || match.index === undefined) return { filePath: value, suffix: "" };
  return {
    filePath: value.slice(0, match.index),
    suffix: value.slice(match.index),
  };
}

function isWithin(parentPath: string, filePath: string): boolean {
  const relative = path.relative(parentPath, filePath);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

function shortenLocalPath(
  destination: string,
  options: Required<LocalPathFormattingOptions>,
): string {
  const decoded = safeDecodeUri(destination)
    .replace(/^file:\/\//, "")
    .replace(/\\([\\() ])/g, "$1");
  const { filePath: rawFilePath, suffix } = splitLocationSuffix(decoded);
  const filePath = path.normalize(rawFilePath);

  if (isWithin(options.cwd, filePath)) {
    const relative = path.relative(options.cwd, filePath) || path.basename(filePath);
    return `${relative}${suffix}`;
  }

  const workspaceMarker = `${path.sep}.agent-workspaces${path.sep}`;
  const markerIndex = filePath.indexOf(workspaceMarker);
  if (markerIndex >= 0) {
    const workspaceParts = filePath
      .slice(markerIndex + workspaceMarker.length)
      .split(path.sep)
      .filter(Boolean);
    if (workspaceParts.length > 2) {
      return `${workspaceParts.slice(2).join(path.sep)}${suffix}`;
    }
  }

  if (isWithin(options.homePath, filePath)) {
    return `~/${path.relative(options.homePath, filePath)}${suffix}`;
  }
  return `${filePath}${suffix}`;
}

function inlineCode(value: string): string {
  const backtickRuns = value.match(/`+/g) ?? [];
  const delimiterLength = Math.max(1, ...backtickRuns.map((run) => run.length + 1));
  const delimiter = "`".repeat(delimiterLength);
  return delimiterLength === 1
    ? `${delimiter}${value}${delimiter}`
    : `${delimiter} ${value} ${delimiter}`;
}

function replaceLocalLinks(
  text: string,
  options: Required<LocalPathFormattingOptions>,
): string {
  const replace = (_match: string, _label: string, destination: string) =>
    inlineCode(shortenLocalPath(destination, options));
  return text
    .replace(ANGLED_LOCAL_LINK_RE, replace)
    .replace(BARE_LOCAL_LINK_RE, replace);
}

function replaceLocalLinksWithCodeLabels(
  text: string,
  options: Required<LocalPathFormattingOptions>,
): string {
  const replace = (_match: string, _delimiter: string, destination: string) =>
    inlineCode(shortenLocalPath(destination, options));
  return text
    .replace(ANGLED_LOCAL_CODE_LABEL_LINK_RE, replace)
    .replace(BARE_LOCAL_CODE_LABEL_LINK_RE, replace);
}

function normalizeOutsideInlineCode(
  line: string,
  options: Required<LocalPathFormattingOptions>,
): string {
  let output = "";
  let plainStart = 0;
  let index = 0;
  let openDelimiterLength = 0;

  while (index < line.length) {
    if (line[index] === "\\") {
      index += 2;
      continue;
    }
    if (line[index] !== "`") {
      index += 1;
      continue;
    }

    let runEnd = index + 1;
    while (line[runEnd] === "`") runEnd += 1;
    const runLength = runEnd - index;
    if (openDelimiterLength === 0) {
      output += replaceLocalLinks(line.slice(plainStart, index), options);
      output += line.slice(index, runEnd);
      openDelimiterLength = runLength;
      plainStart = runEnd;
    } else if (runLength === openDelimiterLength) {
      output += line.slice(plainStart, runEnd);
      openDelimiterLength = 0;
      plainStart = runEnd;
    }
    index = runEnd;
  }

  const remainder = line.slice(plainStart);
  output += openDelimiterLength === 0 ? replaceLocalLinks(remainder, options) : remainder;
  return output;
}

function updateFenceState(line: string, state: FenceState | null): FenceState | null {
  const match = line.match(FENCE_RE);
  if (!match) return state;
  const run = match[2]!;
  const marker = run[0] as "`" | "~";
  if (!state) return { marker, length: run.length };
  return state.marker === marker && run.length >= state.length ? null : state;
}

export function normalizeDiscordMarkdown(
  markdown: string,
  options: LocalPathFormattingOptions = {},
): string {
  const resolvedOptions = {
    cwd: path.resolve(options.cwd ?? process.cwd()),
    homePath: path.resolve(options.homePath ?? homedir()),
  };
  let fence: FenceState | null = null;

  return markdown.split("\n").map((line) => {
    const previousFence = fence;
    fence = updateFenceState(line, fence);
    if (previousFence || line.match(FENCE_RE)) return line;
    return normalizeOutsideInlineCode(
      replaceLocalLinksWithCodeLabels(line, resolvedOptions),
      resolvedOptions,
    );
  }).join("\n");
}
