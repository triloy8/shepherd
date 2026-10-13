import type { BridgeEvent, MessagePhase } from "../../shared/protocol/events.js";

export type AccumulatedMessage = {
  itemId: string | null;
  text: string;
};

export type ResponseStreamState = {
  turnId: string | null;
  finalMessages: AccumulatedMessage[];
  /** Without explicit final metadata, the last unphased message is the answer, as in application history. */
  unphasedMessages?: AccumulatedMessage[];
  activeCommentary: AccumulatedMessage | null;
};

export type ResponseStreamReduction =
  | { type: "none"; state: ResponseStreamState | null }
  | { type: "reset"; state: ResponseStreamState }
  | {
      type: "updated";
      phase: MessagePhase | null;
      state: ResponseStreamState;
      completedCommentary: AccumulatedMessage | null;
    }
  | {
      type: "message-completed";
      phase: MessagePhase | null;
      state: ResponseStreamState;
      completedCommentary: AccumulatedMessage | null;
    }
  | {
      type: "finish";
      failed: boolean;
      state: ResponseStreamState | null;
      completedCommentary: AccumulatedMessage | null;
    };

export function createResponseStreamState(turnId: string | null = null): ResponseStreamState {
  return {
    turnId,
    finalMessages: [],
    activeCommentary: null,
  };
}

export function getFinalResponseText(state: ResponseStreamState | null): string {
  if (!state) return "";
  const messages = state.finalMessages.length ? state.finalMessages : state.unphasedMessages?.slice(-1) ?? [];
  return messages
    .map((message) => message.text)
    .filter((text) => Boolean(text.trim()))
    .join("\n\n");
}

function upsertMessage(
  messages: AccumulatedMessage[],
  itemId: string | null,
  update: (text: string) => string,
): AccumulatedMessage[] {
  const index = itemId ? messages.findIndex((message) => message.itemId === itemId) : messages.length - 1;
  if (index >= 0) {
    return messages.map((message, messageIndex) =>
      messageIndex === index ? { ...message, text: update(message.text) } : message,
    );
  }
  return [...messages, { itemId, text: update("") }];
}

function completeCommentary(
  state: ResponseStreamState,
): { state: ResponseStreamState; completedCommentary: AccumulatedMessage | null } {
  if (!state.activeCommentary?.text.trim()) {
    return {
      state: state.activeCommentary ? { ...state, activeCommentary: null } : state,
      completedCommentary: null,
    };
  }
  return {
    state: { ...state, activeCommentary: null },
    completedCommentary: state.activeCommentary,
  };
}

function sameTurn(state: ResponseStreamState | null, turnId: string | null | undefined): boolean {
  return !state?.turnId || !turnId || state.turnId === turnId;
}

function knownPhase(state: ResponseStreamState | null, itemId: string | null | undefined): MessagePhase | null {
  if (!itemId) return null;
  if (state?.finalMessages.some(message => message.itemId === itemId)) return "final";
  return state?.activeCommentary?.itemId === itemId ? "interim" : null;
}

export function reduceResponseStream(
  state: ResponseStreamState | null,
  event: BridgeEvent,
): ResponseStreamReduction {
  if (event.type === "turn.started") {
    const payload = event.payload as { turnId?: string | null };
    return {
      type: "reset",
      state: createResponseStreamState(payload.turnId ?? null),
    };
  }

  if (event.type === "turn.stream.delta") {
    const payload = event.payload as {
      textDelta?: string;
      kind?: "assistant_text" | "other";
      phase?: MessagePhase | null;
      itemId?: string | null;
      turnId?: string | null;
    };
    const phase = payload.phase ?? knownPhase(state, payload.itemId);
    const delta = payload.textDelta ?? "";
    if (
      payload.kind !== "assistant_text" ||
      !delta ||
      !sameTurn(state, payload.turnId)
    ) {
      return { type: "none", state };
    }

    let next = state ? { ...state } : createResponseStreamState(payload.turnId ?? null);
    const itemId = payload.itemId ?? null;
    const unphasedText = itemId ? next.unphasedMessages?.find(message => message.itemId === itemId)?.text ?? "" : "";
    if (phase !== null && itemId && next.unphasedMessages) next.unphasedMessages = next.unphasedMessages.filter(message => message.itemId !== itemId);
    let completedCommentary: AccumulatedMessage | null = null;

    if (phase === "interim") {
      if (next.activeCommentary && next.activeCommentary.itemId !== itemId) {
        const completed = completeCommentary(next);
        next = completed.state;
        completedCommentary = completed.completedCommentary;
      }
      next.activeCommentary = {
        itemId,
        text: `${next.activeCommentary?.text ?? unphasedText}${delta}`,
      };
    } else if (phase === "final") {
      const completed = completeCommentary(next);
      next = completed.state;
      completedCommentary = completed.completedCommentary;
      next.finalMessages = upsertMessage(next.finalMessages, itemId, (text) => `${text || unphasedText}${delta}`);
    } else {
      next.unphasedMessages = upsertMessage(next.unphasedMessages ?? [], itemId, (text) => `${text}${delta}`);
    }

    return { type: "updated", phase, state: next, completedCommentary };
  }

  if (event.type === "turn.message.completed") {
    const payload = event.payload as {
      itemId?: string;
      phase?: MessagePhase | null;
      text?: string;
      turnId?: string | null;
    };
    if (!payload.itemId || !sameTurn(state, payload.turnId)) {
      return { type: "none", state };
    }
    state ??= createResponseStreamState(payload.turnId ?? null);

    const phase = payload.phase ?? knownPhase(state, payload.itemId);
    const text = payload.text ?? "";
    const unphasedText = state.unphasedMessages?.find(message => message.itemId === payload.itemId)?.text ?? "";
    if (phase !== null && state.unphasedMessages) state = { ...state, unphasedMessages: state.unphasedMessages.filter(message => message.itemId !== payload.itemId) };
    if (phase === "interim") {
      const active =
        state.activeCommentary?.itemId === payload.itemId
          ? { itemId: payload.itemId, text: text || state.activeCommentary.text }
          : { itemId: payload.itemId, text: text || unphasedText };
      return {
        type: "message-completed",
        phase,
        state: { ...state, activeCommentary: null },
        completedCommentary: active.text.trim() ? active : null,
      };
    }

    if (phase === "final") {
      return {
        type: "message-completed",
        phase,
        state: {
          ...state,
          finalMessages: upsertMessage(state.finalMessages, payload.itemId, (current) => text || current || unphasedText),
        },
        completedCommentary: null,
      };
    }

    return {
      type: "message-completed",
      phase,
      state: {
        ...state,
        unphasedMessages: upsertMessage(state.unphasedMessages ?? [], payload.itemId, current => text || current),
      },
      completedCommentary: null,
    };
  }

  if (event.type === "turn.completed" || event.type === "turn.failed") {
    const payload = event.payload as { turnId?: string | null };
    if (!sameTurn(state, payload.turnId)) {
      return { type: "none", state };
    }
    if (!state) {
      return {
        type: "finish",
        failed: event.type === "turn.failed",
        state: null,
        completedCommentary: null,
      };
    }
    const completed = completeCommentary(state);
    return {
      type: "finish",
      failed: event.type === "turn.failed",
      state: completed.state,
      completedCommentary: completed.completedCommentary,
    };
  }

  return { type: "none", state };
}
