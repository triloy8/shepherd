import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from "discord.js";

import type { ApprovalRequestPayload } from "../../../shared/protocol/approvals.js";
import type { BridgeEvent } from "../../../shared/protocol/events.js";
import {
  createResponseStreamState,
  reduceResponseStream,
} from "../../core/response_stream_reducer.js";
import {
  createDiscordStreamState,
  flushDiscordStream,
  isSendableChannel,
  type DiscordStreamState,
} from "./stream_delivery.js";
import {
  encodeApprovalButtonId,
  formatApprovalText,
  formatEventLine,
} from "./message_renderer.js";

export type DiscordThreadEventHandlerClient = {
  channels: {
    fetch: (channelId: string) => Promise<unknown>;
  };
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

  if (count > 0) {
    rows.push(current);
  }

  return rows;
}

async function sendChannelMessage(
  client: DiscordThreadEventHandlerClient,
  channelId: string,
  text: string,
): Promise<void> {
  const channel = await client.channels.fetch(channelId);
  if (!isSendableChannel(channel)) return;
  await channel.send(text);
}

export function createDiscordThreadEventHandler(client: DiscordThreadEventHandlerClient): {
  handleThreadEvent: (channelId: string, event: BridgeEvent) => void;
} {
  const streamByChannel = new Map<string, DiscordStreamState>();

  const flushStream = async (channelId: string): Promise<void> => {
    const state = streamByChannel.get(channelId);
    if (!state || !state.stream.text.trim()) return;
    if (state.flushing) {
      state.pendingFlush = true;
      return;
    }
    state.flushing = true;

    try {
      const channel = await client.channels.fetch(channelId);
      if (!isSendableChannel(channel)) return;
      await flushDiscordStream(channel, state);
    } finally {
      state.flushing = false;
      if (state.pendingFlush) {
        state.pendingFlush = false;
        queueMicrotask(() => {
          void flushStream(channelId);
        });
      }
    }
  };

  const scheduleStreamFlush = (channelId: string): void => {
    const state = streamByChannel.get(channelId);
    if (!state || state.timer) return;

    state.timer = setTimeout(() => {
      state.timer = null;
      void flushStream(channelId);
    }, 400);
  };

  const handleThreadEvent = (channelId: string, event: BridgeEvent): void => {
    const prior = streamByChannel.get(channelId) ?? null;
    const reduction = reduceResponseStream(prior?.stream ?? null, event);
    if (reduction.type === "reset") {
      if (prior?.timer) clearTimeout(prior.timer);
      streamByChannel.set(channelId, createDiscordStreamState(reduction.state));
      return;
    }
    if (reduction.type === "schedule-flush") {
      const nextState = prior ?? createDiscordStreamState(createResponseStreamState());
      nextState.stream = reduction.state;
      streamByChannel.set(channelId, nextState);
      scheduleStreamFlush(channelId);
      return;
    }

    if (event.type === "approval.requested") {
      const approval = event.payload as ApprovalRequestPayload;
      void (async () => {
        const channel = await client.channels.fetch(channelId);
        if (!isSendableChannel(channel)) return;
        await channel.send({
          content: formatApprovalText(approval),
          components: buildApprovalRows(event.threadId, approval),
        });
      })();
      return;
    }

    if (reduction.type === "flush-now") {
      const state = streamByChannel.get(channelId);
      if (state && reduction.state) {
        state.stream = reduction.state;
      }
      if (state?.timer) {
        clearTimeout(state.timer);
        state.timer = null;
      }
      void flushStream(channelId);
    }

    const line = formatEventLine(event);
    if (line) {
      void sendChannelMessage(client, channelId, line);
    }
  };

  return { handleThreadEvent };
}
