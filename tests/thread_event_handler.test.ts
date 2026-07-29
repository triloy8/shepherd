import { describe, expect, test } from "bun:test";

import type { ApprovalRequestPayload } from "../shared/protocol/approvals.js";
import type { BridgeEvent } from "../shared/protocol/events.js";
import {
  buildApprovalRows,
  createDiscordThreadEventHandler,
  type DiscordDeliveryTimers,
} from "../server/adapters/discord/thread_event_handler.js";
import { formatApprovalText } from "../server/adapters/discord/message_renderer.js";

let eventCounter = 0;

function makeEvent<TPayload>(type: BridgeEvent["type"], payload: TPayload): BridgeEvent<TPayload> {
  return {
    id: `evt-${++eventCounter}`,
    type,
    threadId: "thread-1",
    sessionId: "session-1",
    ts: new Date().toISOString(),
    payload,
  };
}

function finalDelta(textDelta: string, turnId = "turn-1"): BridgeEvent {
  return makeEvent("turn.stream.delta", {
    method: "item/agentMessage/delta",
    textDelta,
    itemId: `final-${turnId}`,
    phase: "final_answer",
    turnId,
  });
}

function commentaryDelta(textDelta: string, turnId = "turn-1"): BridgeEvent {
  return makeEvent("turn.stream.delta", {
    method: "item/agentMessage/delta",
    textDelta,
    itemId: `comment-${turnId}`,
    phase: "commentary",
    turnId,
  });
}

function createHarness(options: { failSendAt?: number } = {}) {
  const sent: Array<{
    content?: string;
    components?: unknown[];
    files?: Array<{
      attachment: Buffer;
      name: string;
      description?: string;
    }>;
    reply?: { messageReference: string; failIfNotExists?: boolean };
    allowedMentions?: { repliedUser?: boolean };
  }> = [];
  const edits: Array<{ id: string; content: string }> = [];
  const typing: number[] = [];
  const messages = new Map<string, { id: string; edit: (content: string) => Promise<void> }>();
  let sendAttempts = 0;

  const channel = {
    async send(
      payload:
        | string
        | {
            content?: string;
            components?: unknown[];
            files?: Array<{
              attachment: Buffer;
              name: string;
              description?: string;
            }>;
            reply?: { messageReference: string; failIfNotExists?: boolean };
            allowedMentions?: { repliedUser?: boolean };
          },
    ) {
      sendAttempts += 1;
      if (options.failSendAt === sendAttempts) throw new Error("send failed");
      const normalized = typeof payload === "string" ? { content: payload } : payload;
      sent.push(normalized);
      const id = `msg-${sendAttempts}`;
      const message = {
        id,
        async edit(content: string) {
          edits.push({ id, content });
        },
      };
      messages.set(id, message);
      return message;
    },
    async sendTyping() {
      typing.push(Date.now());
    },
    messages: {
      async fetch(id: string) {
        const message = messages.get(id);
        if (!message) throw new Error(`unknown message ${id}`);
        return message;
      },
    },
  };

  const errors: unknown[] = [];
  const client = {
    channels: {
      async fetch() {
        return channel;
      },
    },
  };
  return { channel, client, sent, edits, typing, errors };
}

function createDeterministicTimers() {
  let nextId = 0;
  const timeouts = new Map<NodeJS.Timeout, () => void>();
  const intervals = new Map<NodeJS.Timeout, () => void>();
  const handle = (): NodeJS.Timeout =>
    ({
      id: ++nextId,
      unref() {
        return this;
      },
    }) as unknown as NodeJS.Timeout;

  const timers: DiscordDeliveryTimers = {
    setTimeout(callback) {
      const timer = handle();
      timeouts.set(timer, callback);
      return timer;
    },
    clearTimeout(timer) {
      timeouts.delete(timer);
    },
    setInterval(callback) {
      const timer = handle();
      intervals.set(timer, callback);
      return timer;
    },
    clearInterval(timer) {
      intervals.delete(timer);
    },
  };

  return {
    timers,
    runTimeouts() {
      const pending = [...timeouts.entries()];
      timeouts.clear();
      for (const [, callback] of pending) callback();
    },
    tickIntervals() {
      for (const callback of [...intervals.values()]) callback();
    },
  };
}

describe("Discord thread event handler", () => {
  test("builds approval button rows with encoded decisions", () => {
    const approval: ApprovalRequestPayload = {
      approvalId: "approval-1",
      method: "shell.exec",
      prompt: "Approve?",
      params: {},
      choices: [
        { value: "approve", label: "Approve" },
        { value: "reject", label: "Reject" },
      ],
    };

    const rows = buildApprovalRows("thread-1", approval);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.components).toHaveLength(2);
    expect(rows[0]?.components[0]?.data.custom_id).toBe("approval|thread-1|approval-1|approve");
    expect(rows[0]?.components[1]?.data.custom_id).toBe("approval|thread-1|approval-1|reject");
  });

  test("formats approval content as a structured prompt", () => {
    const approval: ApprovalRequestPayload = {
      approvalId: "approval-1",
      method: "shell.exec",
      prompt: "Run `bun install`?",
      params: {},
      choices: [
        { value: "approve", label: "Approve" },
        { value: "reject", label: "Reject" },
      ],
    };
    expect(formatApprovalText(approval)).toContain("Approval Required");
    expect(formatApprovalText(approval)).toContain("Action: shell.exec");
  });

  test("buffers final deltas until completion while showing typing", async () => {
    const harness = createHarness();
    const handler = createDiscordThreadEventHandler(harness.client, {
      onError: (error) => harness.errors.push(error),
    });

    handler.handleThreadEvent("chan-1", makeEvent("turn.started", { turnId: "turn-1" }));
    handler.handleThreadEvent("chan-1", finalDelta("hello"));
    await handler.waitForIdle("chan-1");

    expect(harness.typing).toHaveLength(1);
    expect(harness.sent).toHaveLength(0);

    handler.handleThreadEvent("chan-1", makeEvent("turn.completed", { turnId: "turn-1" }));
    await handler.waitForIdle("chan-1");
    expect(harness.sent.map((message) => message.content)).toEqual(["hello"]);
    expect(harness.errors).toHaveLength(0);
    handler.dispose();
  });

  test("replies from the first final chunk without chaining continuations", async () => {
    const harness = createHarness();
    const handler = createDiscordThreadEventHandler(harness.client);
    handler.recordUserMessage("chan-1", "user-message-1");
    handler.handleThreadEvent("chan-1", makeEvent("turn.started", { turnId: "turn-1" }));
    handler.handleThreadEvent("chan-1", finalDelta("x".repeat(5_000)));
    handler.handleThreadEvent("chan-1", makeEvent("turn.completed", { turnId: "turn-1" }));
    await handler.waitForIdle("chan-1");

    expect(harness.sent.length).toBeGreaterThan(1);
    expect(harness.sent[0]?.reply).toEqual({
      messageReference: "user-message-1",
      failIfNotExists: false,
    });
    expect(harness.sent[0]?.allowedMentions).toEqual({ repliedUser: false });
    expect(harness.sent.slice(1).every((message) => message.reply === undefined)).toBe(true);
    handler.dispose();
  });

  test("orders completed commentary, progress, and the final answer independently", async () => {
    const harness = createHarness();
    const handler = createDiscordThreadEventHandler(harness.client, {
      progressUpdateIntervalMs: 60_000,
      onError: (error) => harness.errors.push(error),
    });

    handler.handleThreadEvent("chan-1", makeEvent("turn.started", { turnId: "turn-1" }));
    handler.handleThreadEvent("chan-1", commentaryDelta("I found the issue."));
    handler.handleThreadEvent(
      "chan-1",
      makeEvent("turn.message.completed", {
        itemId: "comment-turn-1",
        phase: "commentary",
        text: "I found the issue.",
        turnId: "turn-1",
      }),
    );
    handler.handleThreadEvent(
      "chan-1",
      makeEvent("turn.activity", {
        itemId: "command-1",
        turnId: "turn-1",
        kind: "command",
        label: "Running command",
        detail: "bun test",
        status: "started",
      }),
    );
    handler.handleThreadEvent("chan-1", finalDelta("The tests pass."));
    handler.handleThreadEvent("chan-1", makeEvent("turn.completed", { turnId: "turn-1" }));
    await handler.waitForIdle("chan-1");

    expect(harness.sent.map((message) => message.content)).toEqual([
      "I found the issue.",
      "🔧 Running command: bun test",
      "The tests pass.",
    ]);
    expect(harness.errors).toHaveLength(0);
    handler.dispose();
  });

  test("starts a new progress bubble after completed commentary", async () => {
    const harness = createHarness();
    const clock = createDeterministicTimers();
    const handler = createDiscordThreadEventHandler(harness.client, {
      timers: clock.timers,
      onError: (error) => harness.errors.push(error),
    });

    handler.handleThreadEvent("chan-1", makeEvent("turn.started", { turnId: "turn-1" }));
    handler.handleThreadEvent(
      "chan-1",
      makeEvent("turn.activity", {
        itemId: "command-1",
        turnId: "turn-1",
        kind: "command",
        label: "Running command",
        detail: "bun test",
        status: "started",
      }),
    );
    handler.handleThreadEvent("chan-1", commentaryDelta("The first check passed."));
    handler.handleThreadEvent(
      "chan-1",
      makeEvent("turn.message.completed", {
        itemId: "comment-turn-1",
        phase: "commentary",
        text: "The first check passed.",
        turnId: "turn-1",
      }),
    );
    handler.handleThreadEvent(
      "chan-1",
      makeEvent("turn.activity", {
        itemId: "search-1",
        turnId: "turn-1",
        kind: "web_search",
        label: "Searching the web",
        detail: "Discord ordering",
        status: "started",
      }),
    );
    clock.runTimeouts();
    await handler.waitForIdle("chan-1");

    expect(harness.sent.map((message) => message.content)).toEqual([
      "🔧 Running command: bun test",
      "The first check passed.",
      "🔎 Searching the web: Discord ordering",
    ]);
    expect(harness.edits).toHaveLength(0);

    handler.handleThreadEvent(
      "chan-1",
      makeEvent("turn.activity", {
        itemId: "command-2",
        turnId: "turn-1",
        kind: "command",
        label: "Running command",
        detail: "bun run check",
        status: "started",
      }),
    );
    clock.runTimeouts();
    await handler.waitForIdle("chan-1");

    expect(harness.edits).toEqual([
      {
        id: "msg-3",
        content: "🔎 Searching the web: Discord ordering\n🔧 Running command: bun run check",
      },
    ]);
    expect(harness.errors).toHaveLength(0);
    handler.dispose();
  });

  test("deduplicates activity and edits one accumulated progress bubble", async () => {
    const harness = createHarness();
    const clock = createDeterministicTimers();
    const handler = createDiscordThreadEventHandler(harness.client, {
      timers: clock.timers,
      onError: (error) => harness.errors.push(error),
    });
    const firstActivity = makeEvent("turn.activity", {
      itemId: "command-1",
      turnId: "turn-1",
      kind: "command",
      label: "Running command",
      detail: "bun test",
      status: "started",
    });
    handler.handleThreadEvent("chan-1", makeEvent("turn.started", { turnId: "turn-1" }));
    handler.handleThreadEvent("chan-1", firstActivity);
    handler.handleThreadEvent("chan-1", firstActivity);
    clock.runTimeouts();
    await handler.waitForIdle("chan-1");
    expect(harness.sent.map((message) => message.content)).toEqual(["🔧 Running command: bun test"]);

    handler.handleThreadEvent(
      "chan-1",
      makeEvent("turn.activity", {
        itemId: "search-1",
        turnId: "turn-1",
        kind: "web_search",
        label: "Searching the web",
        detail: "Discord limits",
        status: "started",
      }),
    );
    clock.runTimeouts();
    await handler.waitForIdle("chan-1");
    expect(harness.edits.map((edit) => edit.content)).toEqual([
      "🔧 Running command: bun test\n🔎 Searching the web: Discord limits",
    ]);

    handler.handleThreadEvent("chan-1", makeEvent("turn.completed", { turnId: "turn-1" }));
    await handler.waitForIdle("chan-1");
    handler.dispose();
  });

  test("delivers generated images once and before the final answer", async () => {
    const harness = createHarness();
    const clock = createDeterministicTimers();
    const loadedPaths: string[] = [];
    const handler = createDiscordThreadEventHandler(harness.client, {
      timers: clock.timers,
      async generatedImageLoader(imagePath) {
        loadedPaths.push(imagePath);
        return {
          attachment: Buffer.from("png"),
          name: imagePath.endsWith(".webp") ? "landscape.webp" : "unicorn.png",
        };
      },
      onError: (error) => harness.errors.push(error),
    });
    const generated = makeEvent("turn.image.generated", {
      itemId: "image-1",
      turnId: "turn-1",
      path: "/tmp/unicorn.png",
      revisedPrompt: "A pastel unicorn",
    });

    handler.handleThreadEvent("chan-1", makeEvent("turn.started", { turnId: "turn-1" }));
    handler.handleThreadEvent(
      "chan-1",
      makeEvent("turn.activity", {
        itemId: "image-1",
        turnId: "turn-1",
        kind: "image",
        label: "Generating image",
        detail: "A pastel unicorn",
        status: "started",
      }),
    );
    handler.handleThreadEvent("chan-1", generated);
    handler.handleThreadEvent("chan-1", generated);
    handler.handleThreadEvent(
      "chan-1",
      makeEvent("turn.image.generated", {
        itemId: "image-2",
        turnId: "turn-1",
        path: "/tmp/landscape.webp",
        revisedPrompt: "A pastel landscape",
      }),
    );
    handler.handleThreadEvent("chan-1", finalDelta("Here is the generated image."));
    handler.handleThreadEvent("chan-1", makeEvent("turn.completed", { turnId: "turn-1" }));
    await handler.waitForIdle("chan-1");

    expect(loadedPaths).toEqual(["/tmp/unicorn.png", "/tmp/landscape.webp"]);
    expect(harness.sent).toHaveLength(4);
    expect(harness.sent[0]?.content).toBe("🖼️ Generating image: A pastel unicorn");
    expect(harness.sent[1]?.files).toHaveLength(1);
    expect(harness.sent[1]?.files?.[0]).toMatchObject({
      name: "unicorn.png",
      description: "A pastel unicorn",
    });
    expect(harness.sent[2]?.files?.[0]).toMatchObject({
      name: "landscape.webp",
      description: "A pastel landscape",
    });
    expect(harness.sent[3]?.content).toBe("Here is the generated image.");
    expect(harness.errors).toHaveLength(0);
    handler.dispose();
  });

  test("ignores generated images from a replaced turn", async () => {
    const harness = createHarness();
    let loadCount = 0;
    const handler = createDiscordThreadEventHandler(harness.client, {
      async generatedImageLoader() {
        loadCount += 1;
        return {
          attachment: Buffer.from("png"),
          name: "stale.png",
        };
      },
    });

    handler.handleThreadEvent("chan-1", makeEvent("turn.started", { turnId: "turn-old" }));
    handler.handleThreadEvent("chan-1", makeEvent("turn.started", { turnId: "turn-new" }));
    handler.handleThreadEvent(
      "chan-1",
      makeEvent("turn.image.generated", {
        itemId: "image-old",
        turnId: "turn-old",
        path: "/tmp/stale.png",
        revisedPrompt: null,
      }),
    );
    await handler.waitForIdle("chan-1");

    expect(loadCount).toBe(0);
    expect(harness.sent).toHaveLength(0);
    handler.dispose();
  });

  test("surfaces generated image upload failures without exposing paths", async () => {
    const harness = createHarness();
    const handler = createDiscordThreadEventHandler(harness.client, {
      async generatedImageLoader() {
        throw new Error("ENOENT /private/generated.png");
      },
      onError: (error) => harness.errors.push(error),
    });

    handler.handleThreadEvent("chan-1", makeEvent("turn.started", { turnId: "turn-1" }));
    handler.handleThreadEvent(
      "chan-1",
      makeEvent("turn.image.generated", {
        itemId: "image-1",
        turnId: "turn-1",
        path: "/private/generated.png",
        revisedPrompt: null,
      }),
    );
    await handler.waitForIdle("chan-1");

    expect(harness.sent.map((message) => message.content)).toEqual([
      "Generated Image Delivery Failed\n\nThe generated image could not be uploaded to Discord. The error was logged.",
    ]);
    expect(harness.sent[0]?.content).not.toContain("/private/generated.png");
    expect(harness.errors).toHaveLength(1);
    handler.dispose();
  });

  test("refreshes typing and stops refreshing when the turn completes", async () => {
    const harness = createHarness();
    const clock = createDeterministicTimers();
    const handler = createDiscordThreadEventHandler(harness.client, {
      timers: clock.timers,
      onError: (error) => harness.errors.push(error),
    });
    handler.handleThreadEvent("chan-1", makeEvent("turn.started", { turnId: "turn-1" }));
    clock.tickIntervals();
    clock.tickIntervals();
    await handler.waitForIdle("chan-1");
    expect(harness.typing.length).toBeGreaterThan(1);

    handler.handleThreadEvent("chan-1", makeEvent("turn.completed", { turnId: "turn-1" }));
    await handler.waitForIdle("chan-1");
    const stoppedAt = harness.typing.length;
    clock.tickIntervals();
    expect(harness.typing).toHaveLength(stoppedAt);
    handler.dispose();
  });

  test("labels partial content and posts the failure after a failed turn", async () => {
    const harness = createHarness();
    const handler = createDiscordThreadEventHandler(harness.client, {
      onError: (error) => harness.errors.push(error),
    });
    handler.handleThreadEvent("chan-1", makeEvent("turn.started", { turnId: "turn-1" }));
    handler.handleThreadEvent("chan-1", finalDelta("unfinished"));
    handler.handleThreadEvent(
      "chan-1",
      makeEvent("turn.failed", { turnId: "turn-1", message: "Provider failed." }),
    );
    await handler.waitForIdle("chan-1");

    expect(harness.sent.map((message) => message.content)).toEqual([
      "Partial response\n\nunfinished",
      "Turn Failed\n\nProvider failed.",
    ]);
    handler.dispose();
  });

  test("does not send an empty final response", async () => {
    const harness = createHarness();
    const handler = createDiscordThreadEventHandler(harness.client);
    handler.handleThreadEvent("chan-1", makeEvent("turn.started", { turnId: "turn-1" }));
    handler.handleThreadEvent("chan-1", makeEvent("turn.completed", { turnId: "turn-1" }));
    await handler.waitForIdle("chan-1");
    expect(harness.sent).toHaveLength(0);
    handler.dispose();
  });

  test("ignores late output from a replaced turn and finalizes only once", async () => {
    const harness = createHarness();
    const handler = createDiscordThreadEventHandler(harness.client, {
      onError: (error) => harness.errors.push(error),
    });
    handler.handleThreadEvent("chan-1", makeEvent("turn.started", { turnId: "turn-old" }));
    handler.handleThreadEvent("chan-1", makeEvent("turn.started", { turnId: "turn-new" }));
    handler.handleThreadEvent("chan-1", finalDelta("stale", "turn-old"));
    handler.handleThreadEvent("chan-1", finalDelta("fresh", "turn-new"));
    handler.handleThreadEvent("chan-1", makeEvent("turn.completed", { turnId: "turn-new" }));
    handler.handleThreadEvent("chan-1", makeEvent("turn.completed", { turnId: "turn-new" }));
    await handler.waitForIdle("chan-1");

    expect(harness.sent.map((message) => message.content)).toEqual(["fresh"]);
    expect(harness.typing).toHaveLength(1);
    handler.dispose();
  });

  test("optional streaming uses one oversized preview until finalization", async () => {
    const harness = createHarness();
    const clock = createDeterministicTimers();
    const handler = createDiscordThreadEventHandler(harness.client, {
      streaming: true,
      timers: clock.timers,
      onError: (error) => harness.errors.push(error),
    });
    handler.handleThreadEvent("chan-1", makeEvent("turn.started", { turnId: "turn-1" }));
    handler.handleThreadEvent("chan-1", finalDelta(`${"x".repeat(5_000)}END_MARKER`));
    clock.runTimeouts();
    await handler.waitForIdle("chan-1");
    expect(harness.sent).toHaveLength(1);

    handler.handleThreadEvent("chan-1", makeEvent("turn.completed", { turnId: "turn-1" }));
    await handler.waitForIdle("chan-1");
    expect(harness.edits).toHaveLength(1);
    expect(harness.sent.length).toBeGreaterThan(1);
    expect([...harness.edits.map((edit) => edit.content), ...harness.sent.map((item) => item.content)].join("")).toContain(
      "END_MARKER",
    );

    const editCount = harness.edits.length;
    const sendCount = harness.sent.length;
    handler.handleThreadEvent("chan-1", finalDelta("late output"));
    clock.runTimeouts();
    await handler.waitForIdle("chan-1");
    expect(harness.edits).toHaveLength(editCount);
    expect(harness.sent).toHaveLength(sendCount);
    handler.dispose();
  });

  test("reports interrupted final continuation delivery in Discord", async () => {
    const harness = createHarness({ failSendAt: 2 });
    const handler = createDiscordThreadEventHandler(harness.client, {
      onError: (error) => harness.errors.push(error),
    });
    handler.handleThreadEvent("chan-1", makeEvent("turn.started", { turnId: "turn-1" }));
    handler.handleThreadEvent("chan-1", finalDelta("x".repeat(5_000)));
    handler.handleThreadEvent("chan-1", makeEvent("turn.completed", { turnId: "turn-1" }));
    await handler.waitForIdle("chan-1");

    expect(harness.sent.at(-1)?.content).toContain("Response delivery was interrupted");
    expect(harness.errors).toHaveLength(1);
    handler.dispose();
  });

  test("keeps approval prompts interactive during a turn", async () => {
    const harness = createHarness();
    const handler = createDiscordThreadEventHandler(harness.client);
    const approval: ApprovalRequestPayload = {
      approvalId: "approval-1",
      method: "item/commandExecution/requestApproval",
      prompt: "Run tests?",
      params: {},
      choices: [{ value: "accept", label: "Allow Once" }],
    };
    handler.handleThreadEvent("chan-1", makeEvent("turn.started", { turnId: "turn-1" }));
    handler.handleThreadEvent("chan-1", makeEvent("approval.requested", approval));
    await handler.waitForIdle("chan-1");

    expect(harness.sent[0]?.content).toContain("Approval Required");
    expect(harness.sent[0]?.components).toHaveLength(1);
    handler.dispose();
  });
});
