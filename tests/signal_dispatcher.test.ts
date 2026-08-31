import { describe, expect, test } from "bun:test";

import { toTextUserInput } from "../shared/protocol/user_input.js";
import type { RegisteredSignal } from "../server/core/signal_registry.js";
import { SignalDispatcher, type SignalExecutor } from "../server/core/signal_dispatcher.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function signal(subject: string, text = subject): RegisteredSignal {
  return {
    envelope: {
      kind: "research.state-changed",
      version: 1,
      subject: { type: "research-run", id: subject },
      payload: { text },
    },
    target: {
      type: "conversation",
      threadId: "thread-1",
      cwd: "/workspace",
      delivery: { adapter: "discord", surfaceId: "channel-1" },
    },
    input: [toTextUserInput(text)],
    coalesceKey: `research.state-changed@1:${subject}`,
    terminal: false,
  };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Condition was not met.");
}

describe("SignalDispatcher", () => {
  test("coalesces pending and active signals while retaining the latest follow-up", async () => {
    const idle = deferred();
    const releases: Array<ReturnType<typeof deferred>> = [];
    const executed: string[] = [];
    const executor: SignalExecutor = {
      async resolveTarget() {
        return { threadId: "thread-1", cwd: "/workspace" };
      },
      async waitUntilIdle() {
        await idle.promise;
      },
      async executeTurn(_target, input) {
        executed.push(input[0]?.type === "text" ? input[0].text : "unknown");
        const release = deferred();
        releases.push(release);
        await release.promise;
      },
    };
    const dispatcher = new SignalDispatcher(executor);

    expect(await dispatcher.accept(signal("run-1", "first"))).toEqual({
      type: "accepted",
      threadId: "thread-1",
    });
    expect(await dispatcher.accept(signal("run-1", "second"))).toEqual({
      type: "coalesced",
      threadId: "thread-1",
    });
    expect(await dispatcher.accept(signal("run-1", "latest"))).toEqual({
      type: "coalesced",
      threadId: "thread-1",
    });

    idle.resolve();
    await settle();
    expect(executed).toEqual(["first"]);
    releases[0]?.resolve();
    await waitFor(() => executed.length === 2);
    expect(executed).toEqual(["first", "latest"]);
    releases[1]?.resolve();
    dispatcher.dispose();
  });

  test("keeps different subjects separate and enforces pending capacity", async () => {
    const idle = deferred();
    const executor: SignalExecutor = {
      async resolveTarget() {
        return { threadId: "thread-1", cwd: "/workspace" };
      },
      async waitUntilIdle() {
        await idle.promise;
      },
      async executeTurn() {},
    };
    const dispatcher = new SignalDispatcher(executor, { capacity: 1 });

    expect((await dispatcher.accept(signal("run-1"))).type).toBe("accepted");
    expect((await dispatcher.accept(signal("run-2"))).type).toBe("accepted");
    expect(await dispatcher.accept(signal("run-3"))).toEqual({ type: "saturated" });
    dispatcher.dispose();
    idle.resolve();
  });

  test("reports missing targets and refuses work after disposal", async () => {
    const executor: SignalExecutor = {
      async resolveTarget() {
        return null;
      },
      async waitUntilIdle() {},
      async executeTurn() {},
    };
    const dispatcher = new SignalDispatcher(executor);

    expect(await dispatcher.accept(signal("run-1"))).toEqual({ type: "target-unavailable" });
    dispatcher.dispose();
    expect(await dispatcher.accept(signal("run-1"))).toEqual({ type: "unavailable" });
  });

  test("continues after a signal execution fails", async () => {
    const errors: string[] = [];
    const executed: string[] = [];
    const executor: SignalExecutor = {
      async resolveTarget() {
        return { threadId: "thread-1", cwd: "/workspace" };
      },
      async waitUntilIdle() {},
      async executeTurn(_target, input) {
        const text = input[0]?.type === "text" ? input[0].text : "unknown";
        executed.push(text);
        if (text === "first") throw new Error("failed");
      },
    };
    const dispatcher = new SignalDispatcher(executor, {
      onError: (error) => errors.push(error instanceof Error ? error.message : String(error)),
    });

    await dispatcher.accept(signal("run-1", "first"));
    await dispatcher.accept(signal("run-2", "second"));
    await settle();

    expect(executed).toEqual(["first", "second"]);
    expect(errors).toEqual(["failed"]);
    dispatcher.dispose();
  });
});
