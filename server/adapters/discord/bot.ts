import { formatApplicationError } from "./action_error.js";

import {
  ChannelType,
  Client,
  GatewayIntentBits,
  Partials,
  type Message,
  type TextBasedChannel,
} from "discord.js";

import { readBoolean } from "../../config/environment.js";
import type { SurfaceAdapter, SurfaceAdapterContext, SurfaceDefinition } from "../../runtime/surface_adapter.js";
import { handleInteraction } from "./interactions.js";
import { processDiscordMessage } from "./message_ingress.js";
import { presentDiscordSignalNotice } from "./signal_notice.js";
import { createDiscordThreadEventHandler } from "./thread_event_handler.js";
import { replyDiscordCard } from "./stream_delivery.js";

function isSupportedChannel(channel: Message["channel"]): channel is TextBasedChannel {
  return (
    channel.type === ChannelType.GuildText ||
    channel.type === ChannelType.PublicThread ||
    channel.type === ChannelType.PrivateThread ||
    channel.type === ChannelType.DM
  );
}

export const discordSurface: SurfaceDefinition = {
  configure(environment) {
    const token = environment.DISCORD_BOT_TOKEN;
    if (!token?.trim()) throw new Error("Missing DISCORD_BOT_TOKEN for selected surface discord.");
    const streaming = readBoolean(environment.SHEPHERD_DISCORD_STREAMING, "SHEPHERD_DISCORD_STREAMING", false);
    return (context) => createDiscordAdapter(context, { token, streaming });
  },
};

export function createDiscordAdapter(
  context: SurfaceAdapterContext,
  options: { token: string; streaming: boolean },
  client: Client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel],
  }),
): SurfaceAdapter {
  const { approvalPolicy } = context;

  const threadEvents = createDiscordThreadEventHandler(client, {
    streaming: options.streaming,
  });
  const { handleThreadEvent, recordReplyTarget } = threadEvents;
  const commandContext = context.createApplication(handleThreadEvent);
  let stopping = false;
  let stopPromise: Promise<void> | undefined;
  const report = (state: "ready" | "degraded", detail?: string) => {
    if (!stopping) context.reportHealth({ state, detail });
  };
  client.on("shardDisconnect", (_event, shardId) => report("degraded", `shard ${shardId} disconnected`));
  client.on("shardReconnecting", (shardId) => report("degraded", `shard ${shardId} reconnecting`));
  client.on("shardResume", () => { if (client.isReady()) report("ready"); });
  client.on("shardReady", () => { if (client.isReady()) report("ready"); });
  client.on("error", (error) => { report("degraded", "client error"); console.error("Discord client error:", error); });
  client.on("shardError", (error) => { report("degraded", "gateway error"); console.error("Discord gateway error:", error); });
  client.on("invalidated", () => report("degraded", "session invalidated; restart required"));

  client.once("clientReady", () => {
    report("ready");
    console.log(`discord bridge ready as ${client.user?.tag ?? "unknown"}`);
  });

  client.on("messageCreate", async (message) => {
    if (context.isQuiescing() || stopping) return;
    if (message.author.bot) return;
    if (!isSupportedChannel(message.channel)) return;
    if (!client.user) return;

    try {
      recordReplyTarget(message.channelId, message.id);
      await processDiscordMessage(message, {
        botUserId: client.user.id,
        conversation: context.ingress,
        commandContext,
        approvalPolicy,
      });
    } catch (error) {
      const text = formatApplicationError(error, "Failed to process message.");
      try {
        const delivered = await replyDiscordCard(message, {
          title: "Request failed",
          text,
          tone: "danger",
        });
        if (!delivered.success) throw new Error(delivered.error ?? "Discord delivery failed.");
      } catch (deliveryError) {
        console.error("Discord request failure notice could not be delivered:", deliveryError);
      }
    }
  });

  client.on("interactionCreate", async (interaction) => {
    if (context.isQuiescing() || stopping) return;
    if (!interaction.isButton()) return;
    try { await handleInteraction(interaction, context.interactions, commandContext); }
    catch (error) { console.error("Discord interaction failed:", error); }
  });

  return {
    async start() {
      if (stopping) throw new Error("Discord adapter is stopping.");
      await client.login(options.token);
      if (stopping || context.signal.aborted) {
        await client.destroy();
        throw new Error("Discord adapter stopped during login.");
      }
    },
    stop() {
      return stopPromise ??= Promise.resolve().then(async () => {
        stopping = true;
        try { threadEvents.dispose(); }
        finally { await client.destroy(); }
      });
    },
    presentSignal: (signal) => presentDiscordSignalNotice({ client, signal, recordReplyTarget }),
  };
}
