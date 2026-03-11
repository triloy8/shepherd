import type { BridgeEvent, MessagePhase } from "../../shared/protocol/events.js";

export type ResponseStreamState = {
  text: string;
  lastPhase: MessagePhase | null;
  lastItemId: string | null;
  commentaryOpen: boolean;
  commentaryLineStart: boolean;
};

export type ResponseStreamReduction =
  | { type: "none"; state: ResponseStreamState | null }
  | { type: "reset"; state: ResponseStreamState }
  | { type: "schedule-flush"; state: ResponseStreamState }
  | { type: "flush-now"; state: ResponseStreamState | null };

export function createResponseStreamState(): ResponseStreamState {
  return {
    text: "",
    lastPhase: null,
    lastItemId: null,
    commentaryOpen: false,
    commentaryLineStart: true,
  };
}

export function phaseHeader(phase: MessagePhase, hasExistingText: boolean): string {
  if (phase === "commentary") {
    return "";
  }
  return hasExistingText ? "\n\n" : "";
}

export function formatCommentaryDelta(delta: string, atLineStart: boolean): {
  text: string;
  endsAtLineStart: boolean;
} {
  if (!delta) {
    return { text: "", endsAtLineStart: atLineStart };
  }

  const lines = delta.split("\n");
  let text = "";

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const isLast = index === lines.length - 1;
    const needsPrefix = index === 0 ? atLineStart : true;

    if (isLast) {
      if (!delta.endsWith("\n")) {
        text += `${needsPrefix ? "> " : ""}${line}`;
      }
      continue;
    }

    text += `${needsPrefix ? "> " : ""}${line}\n`;
  }

  return {
    text,
    endsAtLineStart: delta.endsWith("\n"),
  };
}

export function reduceResponseStream(
  state: ResponseStreamState | null,
  event: BridgeEvent,
): ResponseStreamReduction {
  if (event.type === "turn.started") {
    return {
      type: "reset",
      state: createResponseStreamState(),
    };
  }

  if (event.type === "turn.stream.delta") {
    const payload = event.payload as {
      textDelta?: string;
      method?: string;
      phase?: MessagePhase | null;
      itemId?: string | null;
    };
    const method = payload.method?.toLowerCase() ?? "";
    if (method && !method.includes("agentmessage")) {
      return { type: "none", state };
    }

    const delta = payload.textDelta ?? "";
    if (!delta) {
      return { type: "none", state };
    }

    const next = state ? { ...state } : createResponseStreamState();
    const phase = payload.phase;
    const itemId = payload.itemId ?? null;

    if (next.lastPhase === "commentary" && phase !== "commentary" && next.commentaryOpen) {
      next.commentaryOpen = false;
      next.commentaryLineStart = true;
    }

    if ((phase === "commentary" || phase === "final_answer") && phase !== next.lastPhase) {
      next.text += phaseHeader(phase, next.text.length > 0);
      next.lastPhase = phase;
    }

    if (phase === "commentary") {
      const switchedItem = Boolean(itemId && next.lastItemId && itemId !== next.lastItemId);
      if (switchedItem && next.commentaryOpen) {
        if (!next.text.endsWith("\n")) {
          next.text += "\n";
        }
        next.commentaryOpen = false;
        next.commentaryLineStart = true;
      }
      if (!next.commentaryOpen) {
        if (!next.text.endsWith("\n")) {
          next.text += "\n";
        }
        next.commentaryOpen = true;
        next.commentaryLineStart = true;
      }
      const formatted = formatCommentaryDelta(delta, next.commentaryLineStart);
      next.text += formatted.text;
      next.commentaryLineStart = formatted.endsAtLineStart;
    } else {
      next.text += delta;
    }

    if (itemId) {
      next.lastItemId = itemId;
    }

    return {
      type: "schedule-flush",
      state: next,
    };
  }

  if (event.type === "turn.completed" || event.type === "turn.failed") {
    if (!state) {
      return { type: "flush-now", state: null };
    }
    const next = { ...state };
    if (next.commentaryOpen) {
      next.commentaryOpen = false;
      next.commentaryLineStart = true;
    }
    return {
      type: "flush-now",
      state: next,
    };
  }

  return { type: "none", state };
}
