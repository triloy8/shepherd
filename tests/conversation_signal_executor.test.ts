import { describe, expect, test } from "bun:test";

import type { BridgeEvent, BridgeEventType } from "../shared/protocol/events.js";
import { toTextUserInput } from "../shared/protocol/user_input.js";
import { ConversationSignalExecutor } from "../server/core/conversation_signal_executor.js";

function makeEvent(type: BridgeEventType, turnId: string | null): BridgeEvent {
  return {
    id: `${type}:${turnId}`,
    type,
    threadId: "thread-1",
    sessionId: "session-1",
    ts: new Date().toISOString(),
    payload: { turnId },
  };
}

function makeConversation() {
  const listeners = new Set<(event: BridgeEvent) => void>();
  const submitted: unknown[] = [];
  let activeTurnId: string | null = null;
  return {
    submitted,
    setActiveTurnId(value: string | null) {
      activeTurnId = value;
    },
    emit(event: BridgeEvent) {
      if (event.type === "turn.completed") activeTurnId = null;
      for (const listener of listeners) listener(event);
    },
    conversation: {
      getSurfaceThread(_adapter: string, surfaceId: string) {
        return surfaceId === "channel-1" ? "thread-1" : null;
      },
      async getThreadCwd() {
        return "/workspace";
      },
      getThreadState() {
        return { activeTurnId };
      },
      subscribeToThreadEvents(_threadId: string, listener: (event: BridgeEvent) => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      async submitTurn(_threadId: string, request: unknown) {
        submitted.push(request);
        activeTurnId = "turn-signal";
        return { ok: true as const, turnId: "turn-signal" };
      },
    },
  };
}

describe("ConversationSignalExecutor", () => {
  test("resolves a live surface binding and its workspace", async () => {
    const { conversation } = makeConversation();
    const executor = new ConversationSignalExecutor(conversation);

    await expect(
      executor.resolveTarget({
        type: "conversation",
        threadId: "thread-1",
        cwd: "/workspace",
        delivery: { adapter: "discord", surfaceId: "channel-1" },
      }),
    ).resolves.toEqual({ threadId: "thread-1", cwd: "/workspace" });
    await expect(
      executor.resolveTarget({
        type: "conversation",
        threadId: "thread-1",
        cwd: "/workspace",
        delivery: { adapter: "discord", surfaceId: "missing" },
      }),
    ).resolves.toBeNull();
  });

  test("waits for an existing active turn to complete", async () => {
    const state = makeConversation();
    state.setActiveTurnId("turn-human");
    const executor = new ConversationSignalExecutor(state.conversation);
    let resolved = false;
    const waiting = executor
      .waitUntilIdle({ threadId: "thread-1", cwd: "/workspace" })
      .then(() => { resolved = true; });

    await Promise.resolve();
    expect(resolved).toBe(false);
    state.emit(makeEvent("turn.completed", "turn-human"));
    await waiting;
    expect(resolved).toBe(true);
  });

  test("submits a signal turn and resolves after its terminal event", async () => {
    const state = makeConversation();
    const executor = new ConversationSignalExecutor(state.conversation);
    const input = [toTextUserInput("inspect")];
    let resolved = false;
    const executing = executor
      .executeTurn({ threadId: "thread-1", cwd: "/workspace" }, input)
      .then(() => { resolved = true; });

    await Promise.resolve();
    expect(state.submitted).toEqual([{ input }]);
    expect(resolved).toBe(false);
    state.emit(makeEvent("turn.completed", "turn-signal"));
    await executing;
    expect(resolved).toBe(true);
  });
});
