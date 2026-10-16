import type { BridgeEvent, MessagePhase } from "../../shared/protocol/events.js";
import { answerMessages } from "../../shared/protocol/item_stream.js";

export type AccumulatedMessage = {
  itemId: string | null;
  text: string;
};

export type ResponseStreamState = {
  turnId: string | null;
  finalMessages: AccumulatedMessage[];
  /** Without explicit final metadata, the last unphased message is the answer, as in application history. */
  unphasedMessages?: AccumulatedMessage[];
  activeInterim: AccumulatedMessage | null;
  /** Phase knowledge outlives completion and is scoped to this turn. */
  messagePhases?: ReadonlyMap<string, MessagePhase>;
  pendingItemId?: string | null;
};

export type ResponseStreamReduction =
  | { type: "none"; state: ResponseStreamState | null }
  | { type: "reset"; state: ResponseStreamState }
  | {
      type: "updated";
      phase: MessagePhase | null;
      state: ResponseStreamState;
      completedInterim: AccumulatedMessage | null;
    }
  | {
      type: "message-completed";
      phase: MessagePhase | null;
      state: ResponseStreamState;
      completedInterim: AccumulatedMessage | null;
    }
  | {
      type: "finish";
      failed: boolean;
      state: ResponseStreamState | null;
      completedInterim: AccumulatedMessage | null;
    };

export function createResponseStreamState(turnId: string | null = null): ResponseStreamState {
  return {
    turnId,
    finalMessages: [],
    activeInterim: null,
  };
}

export function getFinalResponseText(state: ResponseStreamState | null): string {
  if (!state) return "";
  const messages = answerMessages([...state.finalMessages.map(message => ({ ...message, phase: "final" as const })), ...(state.unphasedMessages ?? []).map(message => ({ ...message, phase: null }))]);
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
  let index = messages.findIndex(message => message.itemId === itemId);
  if (index < 0 && itemId && messages.at(-1)?.itemId === null) index = messages.length - 1;
  if (index >= 0) {
    return messages.map((message, messageIndex) =>
      messageIndex === index ? { ...message, itemId: itemId ?? message.itemId, text: update(message.text) } : message,
    );
  }
  return [...messages, { itemId, text: update("") }];
}

function completeInterim(
  state: ResponseStreamState,
): { state: ResponseStreamState; completedInterim: AccumulatedMessage | null } {
  if (!state.activeInterim?.text.trim()) {
    return {
      state: state.activeInterim ? { ...state, activeInterim: null } : state,
      completedInterim: null,
    };
  }
  return {
    state: { ...state, activeInterim: null },
    completedInterim: state.activeInterim,
  };
}

function sameTurn(state: ResponseStreamState | null, turnId: string | null | undefined): boolean {
  return !state?.turnId || !turnId || state.turnId === turnId;
}

function knownPhase(state: ResponseStreamState | null, itemId: string | null | undefined): MessagePhase | null {
  if (itemId && state?.messagePhases?.has(itemId)) return state.messagePhases.get(itemId)!;
  if (state?.finalMessages.some(message => message.itemId === itemId)) return "final";
  if (state?.activeInterim && (state.activeInterim.itemId === itemId || state.activeInterim.itemId === null)) return "interim";
  return state?.finalMessages.at(-1)?.itemId === null ? "final" : null;
}

function rememberPhase(state: ResponseStreamState, itemId: string | null, phase: MessagePhase | null): ResponseStreamState {
  if (!itemId || !phase || state.messagePhases?.get(itemId) === phase) return state;
  return { ...state, messagePhases: new Map([...state.messagePhases ?? [], [itemId, phase]]) };
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

  if (event.type === "item.delta") {
    const payload = event.payload;
    const itemId = payload.itemId ?? state?.pendingItemId ?? null;
    const phase = payload.phase ?? knownPhase(state, itemId);
    const delta = payload.delta;
    if (
      payload.channel !== "message" ||
      !delta ||
      !sameTurn(state, payload.turnId)
    ) {
      return { type: "none", state };
    }

    let next = state ? { ...state } : createResponseStreamState(payload.turnId ?? null);
    next.pendingItemId = itemId;
    next = rememberPhase(next, itemId, phase);
    const unphased = next.unphasedMessages?.find(message => message.itemId === itemId) ?? (next.unphasedMessages?.at(-1)?.itemId === null ? next.unphasedMessages.at(-1) : undefined);
    const unphasedText = unphased?.text ?? "";
    if (phase !== null && unphased) next.unphasedMessages = next.unphasedMessages?.filter(message => message !== unphased);
    let completedInterim: AccumulatedMessage | null = null;

    if (phase === "interim") {
      if (next.activeInterim && next.activeInterim.itemId !== null && next.activeInterim.itemId !== itemId) {
        const completed = completeInterim(next);
        next = completed.state;
        completedInterim = completed.completedInterim;
      }
      next.activeInterim = {
        itemId,
        text: `${next.activeInterim?.text ?? unphasedText}${delta}`,
      };
    } else if (phase === "final") {
      const completed = completeInterim(next);
      next = completed.state;
      completedInterim = completed.completedInterim;
      next.finalMessages = upsertMessage(next.finalMessages, itemId, (text) => `${text || unphasedText}${delta}`);
    } else {
      next.unphasedMessages = upsertMessage(next.unphasedMessages ?? [], itemId, (text) => `${text}${delta}`);
    }

    return { type: "updated", phase, state: next, completedInterim };
  }

  // A subagent's text is its own progress inside a delegation, never the conversation's answer.
  if (event.type === "item.completed" && event.payload.item.type === "assistant_message" && !event.payload.item.parentItemId) {
    const { item, turnId } = event.payload;
    const payload = { itemId: item.id, phase: item.phase ?? null, text: item.text, turnId };
    if (!payload.itemId || !sameTurn(state, payload.turnId)) {
      return { type: "none", state };
    }
    state ??= createResponseStreamState(payload.turnId ?? null);

    const phase = payload.phase ?? knownPhase(state, payload.itemId);
    state = rememberPhase(state, payload.itemId, phase);
    if (state.pendingItemId === null || state.pendingItemId === payload.itemId) state = { ...state, pendingItemId: undefined };
    const text = payload.text ?? "";
    const unphased = state.unphasedMessages?.find(message => message.itemId === payload.itemId) ?? (state.unphasedMessages?.at(-1)?.itemId === null ? state.unphasedMessages.at(-1) : undefined);
    if (phase !== null && unphased) state = { ...state, unphasedMessages: state.unphasedMessages?.filter(message => message !== unphased) };
    if (phase === "interim") {
      const active = { itemId: payload.itemId, text };
      return {
        type: "message-completed",
        phase,
        state: { ...state, activeInterim: null },
        completedInterim: active.text.trim() ? active : null,
      };
    }

    if (phase === "final") {
      return {
        type: "message-completed",
        phase,
        state: {
          ...state,
          finalMessages: upsertMessage(state.finalMessages, payload.itemId, () => text),
        },
        completedInterim: null,
      };
    }

    return {
      type: "message-completed",
      phase,
      state: {
        ...state,
        unphasedMessages: upsertMessage(state.unphasedMessages ?? [], payload.itemId, () => text),
      },
      completedInterim: null,
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
        completedInterim: null,
      };
    }
    const completed = completeInterim(state);
    return {
      type: "finish",
      failed: event.type === "turn.failed",
      state: completed.state,
      completedInterim: completed.completedInterim,
    };
  }

  return { type: "none", state };
}
