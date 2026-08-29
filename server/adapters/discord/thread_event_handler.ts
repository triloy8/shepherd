import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from "discord.js";

import type { ApprovalRequestPayload } from "../../../shared/protocol/approvals.js";
import type {
  BridgeEvent,
  TurnActivityEvent,
  TurnImageGeneratedEvent,
} from "../../../shared/protocol/events.js";
import {
  createResponseStreamState,
  getFinalResponseText,
  reduceResponseStream,
  type AccumulatedMessage,
  type ResponseStreamState,
} from "../../core/response_stream_reducer.js";
import {
  createDiscordEditableSurfaceState,
  createDiscordPreviewState,
  isSendableChannel,
  sendDiscordMarkdown,
  sendDiscordPages,
  updateDiscordEditableSurfaces,
  updateDiscordPreview,
  type DiscordEditableSurfaceState,
  type DiscordPreviewState,
  type SendableChannel,
} from "./stream_delivery.js";
import {
  buildApprovalPages,
  buildCardPages,
  buildEventPages,
  buildProgressPages,
} from "./components_renderer.js";
import {
  sendDiscordGeneratedImage,
  type GeneratedImageAttachmentLoader,
} from "./generated_image_delivery.js";
import {
  encodeApprovalButtonId,
  formatActivityLine,
  formatEventLine,
} from "./message_renderer.js";

export type DiscordThreadEventHandlerClient = {
  channels: {
    fetch: (channelId: string) => Promise<unknown>;
  };
};

export type DiscordThreadEventHandlerOptions = {
  streaming?: boolean;
  typingIntervalMs?: number;
  progressUpdateIntervalMs?: number;
  previewUpdateIntervalMs?: number;
  onError?: (error: unknown) => void;
  timers?: DiscordDeliveryTimers;
  generatedImageLoader?: GeneratedImageAttachmentLoader;
};

export type DiscordDeliveryTimers = {
  setTimeout: (callback: () => void, delayMs: number) => NodeJS.Timeout;
  clearTimeout: (timer: NodeJS.Timeout) => void;
  setInterval: (callback: () => void, delayMs: number) => NodeJS.Timeout;
  clearInterval: (timer: NodeJS.Timeout) => void;
};

type TurnDeliveryStatus = "working" | "finalizing" | "completed" | "failed";

type DiscordTurnDeliveryState = {
  generation: number;
  turnId: string | null;
  replyToMessageId: string | null;
  status: TurnDeliveryStatus;
  stream: ResponseStreamState;
  progressLines: string[];
  progressLineSet: Set<string>;
  generatedImageItemIds: Set<string>;
  progressDelivery: DiscordEditableSurfaceState;
  progressTimer: NodeJS.Timeout | null;
  preview: DiscordPreviewState;
  previewTimer: NodeJS.Timeout | null;
  typingTimer: NodeJS.Timeout | null;
  queue: Promise<void>;
};

function pickButtonStyle(decision: string): ButtonStyle {
  const normalized = decision.toLowerCase();
  if (normalized.includes("accept") || normalized.includes("approve") || normalized === "success") {
    return ButtonStyle.Success;
  }
  if (
    normalized.includes("decline") ||
    normalized.includes("deny") ||
    normalized.includes("reject") ||
    normalized === "failure"
  ) {
    return ButtonStyle.Danger;
  }
  return ButtonStyle.Secondary;
}

export function buildApprovalRows(
  threadId: string,
  approval: ApprovalRequestPayload,
): ActionRowBuilder<ButtonBuilder>[] {
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  let current = new ActionRowBuilder<ButtonBuilder>();
  let count = 0;

  for (const choice of approval.choices) {
    if (count === 5) {
      rows.push(current);
      current = new ActionRowBuilder<ButtonBuilder>();
      count = 0;
    }

    current.addComponents(
      new ButtonBuilder()
        .setCustomId(encodeApprovalButtonId(threadId, approval.approvalId, choice.value))
        .setLabel(choice.label)
        .setStyle(pickButtonStyle(choice.value)),
    );
    count += 1;
  }

  if (count > 0) rows.push(current);
  return rows;
}

function eventTurnId(event: BridgeEvent): string | null {
  const payload = event.payload as { turnId?: string | null };
  return payload.turnId ?? null;
}

function belongsToTurn(state: DiscordTurnDeliveryState, event: BridgeEvent): boolean {
  const turnId = eventTurnId(event);
  return !turnId || !state.turnId || turnId === state.turnId;
}

export function createDiscordThreadEventHandler(
  client: DiscordThreadEventHandlerClient,
  options: DiscordThreadEventHandlerOptions = {},
): {
  handleThreadEvent: (channelId: string, event: BridgeEvent) => void;
  recordUserMessage: (channelId: string, messageId: string) => void;
  waitForIdle: (channelId: string) => Promise<void>;
  dispose: () => void;
} {
  const streaming = options.streaming ?? false;
  const typingIntervalMs = options.typingIntervalMs ?? 8_000;
  const progressUpdateIntervalMs = options.progressUpdateIntervalMs ?? 1_500;
  const previewUpdateIntervalMs = options.previewUpdateIntervalMs ?? 400;
  const onError = options.onError ?? ((error: unknown) => console.error("Discord delivery failed:", error));
  const generatedImageLoader = options.generatedImageLoader;
  const timers: DiscordDeliveryTimers = options.timers ?? {
    setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimeout: (timer) => clearTimeout(timer),
    setInterval: (callback, delayMs) => setInterval(callback, delayMs),
    clearInterval: (timer) => clearInterval(timer),
  };
  const stateByChannel = new Map<string, DiscordTurnDeliveryState>();
  const pendingReplyByChannel = new Map<string, string>();
  let generation = 0;

  const fetchChannel = async (channelId: string): Promise<SendableChannel | null> => {
    const channel = await client.channels.fetch(channelId);
    return isSendableChannel(channel) ? channel : null;
  };

  const enqueue = (
    channelId: string,
    state: DiscordTurnDeliveryState,
    operation: (channel: SendableChannel) => Promise<void>,
    currentGenerationOnly = false,
  ): void => {
    const run = async () => {
      if (
        currentGenerationOnly &&
        stateByChannel.get(channelId)?.generation !== state.generation
      ) {
        return;
      }
      const channel = await fetchChannel(channelId);
      if (!channel) return;
      if (
        currentGenerationOnly &&
        stateByChannel.get(channelId)?.generation !== state.generation
      ) {
        return;
      }
      await operation(channel);
    };
    state.queue = state.queue.then(run, run).catch((error) => {
      onError(error);
    });
  };

  const createState = (
    turnId: string | null,
    priorQueue: Promise<void> = Promise.resolve(),
    replyToMessageId: string | null = null,
  ): DiscordTurnDeliveryState => ({
    generation: ++generation,
    turnId,
    replyToMessageId,
    status: "working",
    stream: createResponseStreamState(turnId),
    progressLines: [],
    progressLineSet: new Set<string>(),
    generatedImageItemIds: new Set<string>(),
    progressDelivery: createDiscordEditableSurfaceState(),
    progressTimer: null,
    preview: createDiscordPreviewState(),
    previewTimer: null,
    typingTimer: null,
    queue: priorQueue,
  });

  const currentOrCreate = (channelId: string, turnId: string | null): DiscordTurnDeliveryState => {
    const current = stateByChannel.get(channelId);
    if (current) return current;
    const replyToMessageId = turnId ? pendingReplyByChannel.get(channelId) ?? null : null;
    const created = createState(turnId, Promise.resolve(), replyToMessageId);
    if (turnId) pendingReplyByChannel.delete(channelId);
    stateByChannel.set(channelId, created);
    return created;
  };

  const stopTyping = (state: DiscordTurnDeliveryState): void => {
    if (state.typingTimer) timers.clearInterval(state.typingTimer);
    state.typingTimer = null;
  };

  const startTyping = (channelId: string, state: DiscordTurnDeliveryState): void => {
    const sendTyping = (channel: SendableChannel): Promise<void> =>
      channel.sendTyping ? channel.sendTyping().then(() => undefined) : Promise.resolve();
    enqueue(channelId, state, sendTyping, true);
    state.typingTimer = timers.setInterval(() => {
      if (stateByChannel.get(channelId) !== state || state.status !== "working") {
        stopTyping(state);
        return;
      }
      enqueue(channelId, state, sendTyping, true);
    }, typingIntervalMs);
    state.typingTimer.unref?.();
  };

  const flushProgress = (channelId: string, state: DiscordTurnDeliveryState): void => {
    if (state.progressTimer) timers.clearTimeout(state.progressTimer);
    state.progressTimer = null;
    if (state.progressLines.length === 0) return;
    const text = state.progressLines.join("\n");
    const pages = buildProgressPages(text);
    const delivery = state.progressDelivery;
    enqueue(channelId, state, async (channel) => {
      const result = await updateDiscordEditableSurfaces(channel, delivery, pages);
      if (!result.success) {
        onError(new Error(`Progress delivery stopped after ${result.deliveredChunks}/${result.totalChunks} parts.`));
      }
    }, true);
  };

  const sealProgressSegment = (channelId: string, state: DiscordTurnDeliveryState): void => {
    flushProgress(channelId, state);
    state.progressLines = [];
    state.progressDelivery = createDiscordEditableSurfaceState();
  };

  const sendCommentary = (
    channelId: string,
    state: DiscordTurnDeliveryState,
    commentary: AccumulatedMessage | null,
  ): void => {
    const text = commentary?.text.trim();
    if (!text) return;
    sealProgressSegment(channelId, state);
    enqueue(channelId, state, async (channel) => {
      const result = await sendDiscordMarkdown(channel, text);
      if (!result.success) {
        onError(new Error(`Commentary delivery stopped after ${result.deliveredChunks}/${result.totalChunks} parts.`));
      }
    });
  };

  const scheduleProgress = (channelId: string, state: DiscordTurnDeliveryState): void => {
    if (state.progressTimer) return;
    state.progressTimer = timers.setTimeout(() => flushProgress(channelId, state), progressUpdateIntervalMs);
    state.progressTimer.unref?.();
  };

  const flushPreview = (channelId: string, state: DiscordTurnDeliveryState): void => {
    if (state.previewTimer) timers.clearTimeout(state.previewTimer);
    state.previewTimer = null;
    const text = getFinalResponseText(state.stream);
    if (!text) return;
    enqueue(channelId, state, async (channel) => {
      const result = await updateDiscordPreview(channel, state.preview, text, {
        replyToMessageId: state.replyToMessageId,
      });
      if (!result.success) {
        onError(new Error(result.error ?? "Discord preview update failed."));
      }
    }, true);
  };

  const schedulePreview = (channelId: string, state: DiscordTurnDeliveryState): void => {
    if (!streaming || state.previewTimer) return;
    state.previewTimer = timers.setTimeout(() => flushPreview(channelId, state), previewUpdateIntervalMs);
    state.previewTimer.unref?.();
  };

  const reportInterruptedDelivery = async (
    channel: SendableChannel,
    deliveredChunks: number,
    totalChunks: number,
  ): Promise<void> => {
    try {
      const notice = await sendDiscordPages(
        channel,
        buildCardPages({
          title: "Delivery interrupted",
          text: `Response delivery was interrupted after ${deliveredChunks}/${totalChunks} parts. The error was logged.`,
          tone: "danger",
        }),
      );
      if (!notice.success) {
        onError(new Error(notice.error ?? "Interrupted-delivery notice failed."));
      }
    } catch (error) {
      onError(error);
    }
  };

  const finalizeTurn = (
    channelId: string,
    state: DiscordTurnDeliveryState,
    failed: boolean,
  ): void => {
    if (state.status !== "working") return;
    state.status = "finalizing";
    stopTyping(state);
    flushProgress(channelId, state);
    if (state.previewTimer) timers.clearTimeout(state.previewTimer);
    state.previewTimer = null;

    const finalText = getFinalResponseText(state.stream);
    enqueue(channelId, state, async (channel) => {
      if (failed) {
        if (finalText) {
          const partial = await sendDiscordPages(
            channel,
            buildCardPages({
              title: "Partial response",
              text: finalText,
              tone: "warning",
            }),
            { replyToMessageId: state.replyToMessageId },
          );
          if (!partial.success) {
            onError(new Error(partial.error ?? "Partial response delivery failed."));
            await reportInterruptedDelivery(channel, partial.deliveredChunks, partial.totalChunks);
          }
        }
        state.status = "failed";
        return;
      }

      if (!finalText) {
        state.status = "completed";
        return;
      }

      const result = streaming
        ? await updateDiscordPreview(channel, state.preview, finalText, {
            finalize: true,
            replyToMessageId: state.replyToMessageId,
          })
        : await sendDiscordMarkdown(channel, finalText, {
            replyToMessageId: state.replyToMessageId,
          });
      if (!result.success) {
        onError(new Error(result.error ?? "Final response delivery failed."));
        await reportInterruptedDelivery(channel, result.deliveredChunks, result.totalChunks);
      }
      state.status = "completed";
    });
  };

  const enqueuePlainMessage = (
    channelId: string,
    state: DiscordTurnDeliveryState,
    text: string,
  ): void => {
    enqueue(channelId, state, async (channel) => {
      const result = await sendDiscordMarkdown(channel, text);
      if (!result.success) {
        onError(new Error(result.error ?? "Discord message delivery failed."));
      }
    });
  };

  const enqueueSurfacePages = (
    channelId: string,
    state: DiscordTurnDeliveryState,
    pages: ReturnType<typeof buildCardPages>,
  ): void => {
    enqueue(channelId, state, async (channel) => {
      const result = await sendDiscordPages(channel, pages);
      if (!result.success) {
        onError(new Error(result.error ?? "Discord Components V2 delivery failed."));
      }
    });
  };

  const handleThreadEvent = (channelId: string, event: BridgeEvent): void => {
    const prior = stateByChannel.get(channelId) ?? null;
    const reduction = reduceResponseStream(prior?.stream ?? null, event);

    if (reduction.type === "reset") {
      if (prior) {
        stopTyping(prior);
        if (prior.progressTimer) timers.clearTimeout(prior.progressTimer);
        if (prior.previewTimer) timers.clearTimeout(prior.previewTimer);
      }
      const next = createState(
        reduction.state.turnId,
        prior?.queue,
        pendingReplyByChannel.get(channelId) ?? null,
      );
      pendingReplyByChannel.delete(channelId);
      next.stream = reduction.state;
      stateByChannel.set(channelId, next);
      startTyping(channelId, next);
      return;
    }

    const state = currentOrCreate(channelId, eventTurnId(event));
    if (!belongsToTurn(state, event)) return;
    if (
      state.status !== "working" &&
      (
        [
          "turn.stream.delta",
          "turn.message.completed",
          "turn.image.generated",
          "turn.activity",
          "turn.completed",
          "turn.failed",
        ] as BridgeEvent["type"][]
      ).includes(event.type)
    ) {
      return;
    }

    if (event.type === "turn.activity") {
      const activity = event.payload as TurnActivityEvent["payload"];
      if (activity.status === "started" || activity.status === "failed") {
        const line = formatActivityLine(activity);
        if (!state.progressLineSet.has(line)) {
          state.progressLineSet.add(line);
          state.progressLines.push(line);
          scheduleProgress(channelId, state);
        }
      }
      return;
    }

    if (event.type === "turn.image.generated") {
      const image = event.payload as TurnImageGeneratedEvent["payload"];
      if (state.generatedImageItemIds.has(image.itemId)) return;
      state.generatedImageItemIds.add(image.itemId);
      flushProgress(channelId, state);
      enqueue(channelId, state, async (channel) => {
        const result = await sendDiscordGeneratedImage(channel, image.path, {
          description: image.revisedPrompt,
          ...(generatedImageLoader ? { loadAttachment: generatedImageLoader } : {}),
        });
        if (result.success) return;

        onError(new Error(`Generated image delivery failed: ${result.error ?? "unknown error"}`));
        const notice = await sendDiscordPages(
          channel,
          buildCardPages({
            title: "Generated image delivery failed",
            text: "The generated image could not be uploaded to Discord. The error was logged.",
            tone: "danger",
          }),
        );
        if (!notice.success) {
          onError(new Error(notice.error ?? "Generated image failure notice delivery failed."));
        }
      });
      return;
    }

    if (reduction.type === "updated" || reduction.type === "message-completed") {
      state.stream = reduction.state;
      sendCommentary(channelId, state, reduction.completedCommentary);
      if (reduction.phase === "final_answer") {
        schedulePreview(channelId, state);
      }
    } else if (reduction.type === "finish") {
      if (reduction.state) state.stream = reduction.state;
      sendCommentary(channelId, state, reduction.completedCommentary);
      finalizeTurn(channelId, state, reduction.failed);
    }

    if (event.type === "approval.requested") {
      const approval = event.payload as ApprovalRequestPayload;
      enqueue(channelId, state, async (channel) => {
        const result = await sendDiscordPages(
          channel,
          buildApprovalPages(
            event.threadId,
            approval,
            buildApprovalRows(event.threadId, approval),
          ),
        );
        if (!result.success) {
          onError(new Error(result.error ?? "Approval prompt delivery failed."));
        }
      });
      return;
    }

    const line = formatEventLine(event);
    if (line) {
      sealProgressSegment(channelId, state);
      const pages = buildEventPages(event);
      if (pages.length > 0) enqueueSurfacePages(channelId, state, pages);
      else enqueuePlainMessage(channelId, state, line);
    }
  };

  const waitForIdle = async (channelId: string): Promise<void> => {
    const state = stateByChannel.get(channelId);
    if (!state) return;
    await state.queue;
  };

  const recordUserMessage = (channelId: string, messageId: string): void => {
    pendingReplyByChannel.set(channelId, messageId);
  };

  const dispose = (): void => {
    for (const state of stateByChannel.values()) {
      stopTyping(state);
      if (state.progressTimer) timers.clearTimeout(state.progressTimer);
      if (state.previewTimer) timers.clearTimeout(state.previewTimer);
    }
    stateByChannel.clear();
    pendingReplyByChannel.clear();
  };

  return { handleThreadEvent, recordUserMessage, waitForIdle, dispose };
}
