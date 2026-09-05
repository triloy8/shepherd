import { expect, test } from "bun:test";

import type { BridgeEvent } from "../shared/protocol/events.js";
import type { UserInput } from "../shared/protocol/user_input.js";
import { startWebhookSignalServer } from "../server/adapters/webhook/server.js";
import { ConversationSignalExecutor } from "../server/core/conversation_signal_executor.js";
import { SignalDispatcher } from "../server/core/signal_dispatcher.js";
import { SignalRegistry } from "../server/core/signal_registry.js";
import { SignalRouteRegistry } from "../server/core/signal_route_registry.js";
import { createResearchStateChangedDefinition } from "../server/signals/research_state_changed.js";

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Condition was not met.");
}

test("a webhook signal starts a turn observed by the configured surface", async () => {
  const listeners = new Set<(event: BridgeEvent) => void>();
  const delivered: BridgeEvent[] = [];
  const submitted: UserInput[][] = [];
  let activeTurnId: string | null = null;
  const conversation = {
    getSurfaceThread(adapter: string, surfaceId: string) {
      return adapter === "discord" && surfaceId === "channel-1" ? "thread-1" : null;
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
    async submitTurn(_threadId: string, request: { input: UserInput[] }) {
      submitted.push(request.input);
      activeTurnId = "turn-signal";
      return { ok: true as const, turnId: activeTurnId };
    },
  };
  conversation.subscribeToThreadEvents("thread-1", (event) => delivered.push(event));

  const registry = new SignalRegistry();
  registry.register(createResearchStateChangedDefinition());
  const routes = new SignalRouteRegistry({ generateId: () => "integration_route_0000000000000001" });
  const route = routes.create({
    allowedSignal: { kind: "research.state-changed", version: 1 },
    target: {
      type: "conversation",
      threadId: "thread-1",
      cwd: "/workspace",
      delivery: { adapter: "discord", surfaceId: "channel-1" },
    },
    originTurnId: "turn-origin",
  });
  const dispatcher = new SignalDispatcher(new ConversationSignalExecutor(conversation));
  const server = startWebhookSignalServer({
    registry,
    routes,
    dispatcher,
    hostname: "127.0.0.1",
    port: 0,
  });

  try {
    const response = await fetch(`${server.url}/signals/${route.id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "research.state-changed",
        version: 1,
        subject: { type: "research-run", id: "run-123" },
        payload: { state: "COMPLETE", verified: true, researchProject: "P001" },
      }),
    });

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ accepted: true, coalesced: false });
    await waitFor(() => submitted.length === 1);
    const prompt = submitted[0]?.[0];
    expect(prompt?.type === "text" ? prompt.text : "").toContain("run-123");

    activeTurnId = null;
    const completed: BridgeEvent = {
      id: "event-1",
      type: "turn.completed",
      threadId: "thread-1",
      sessionId: "session-1",
      ts: new Date().toISOString(),
      payload: { turnId: "turn-signal" },
    };
    for (const listener of listeners) listener(completed);
    await waitFor(() => delivered.length === 1);
    expect(delivered).toEqual([completed]);
  } finally {
    dispatcher.dispose();
    routes.dispose();
    await server.stop();
  }
});
