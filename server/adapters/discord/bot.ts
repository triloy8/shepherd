import { formatApplicationError } from "./action_error.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ChannelType,
  Client,
  GatewayIntentBits,
  Partials,
  type Message,
  type TextBasedChannel,
} from "discord.js";

import { loadEnvironment, readBoolean } from "../../config/environment.js";
import { createHostRuntime } from "../../runtime/host_runtime.js";
import { SignalRuntime } from "../../runtime/signal_runtime.js";
import { handleInteraction } from "./interactions.js";
import { processDiscordMessage } from "./message_ingress.js";
import { presentDiscordSignalNotice } from "./signal_notice.js";
import { createDiscordSurfaceRuntime } from "./surface_runtime.js";
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

export async function startDiscordBot(): Promise<void> {
  loadEnvironment("discord");
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    throw new Error("Missing DISCORD_BOT_TOKEN.");
  }

  const { config, shepherd, workspace } = createHostRuntime();
  const { approvalPolicy, defaultSandbox } = config;
  const discordStreaming = readBoolean(
    process.env.SHEPHERD_DISCORD_STREAMING,
    "SHEPHERD_DISCORD_STREAMING",
    false,
  );
  const { conversation } = shepherd;

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel],
  });
  let disposeThreadEvents = (): void => {};

  const threadEvents = createDiscordThreadEventHandler(client, {
    streaming: discordStreaming,
  });
  const { handleThreadEvent, recordReplyTarget } = threadEvents;
  disposeThreadEvents = threadEvents.dispose;
  const runtime = createDiscordSurfaceRuntime({
    conversation,
    approvalPolicy,
    defaultSandbox,
    onThreadEvent: handleThreadEvent,
    ...workspace,
    runtimeLifecycle: shepherd.lifecycle,
  });

  const signals = new SignalRuntime(shepherd, {
    config: config.signals,
    beforeExecute: async (signal) => {
      try {
        await presentDiscordSignalNotice({ client, signal, recordReplyTarget });
      } catch (error) {
        console.error("Discord signal notice delivery failed:", error);
      }
    },
  });

  shepherd.registerShutdownHook(async () => {
    disposeThreadEvents();
    await client.destroy();
  });

  client.once("clientReady", () => {
    console.log(`discord bridge ready as ${client.user?.tag ?? "unknown"}`);
  });

  client.on("messageCreate", async (message) => {
    if (shepherd.isQuiescing()) return;
    if (message.author.bot) return;
    if (!isSupportedChannel(message.channel)) return;
    if (!client.user) return;

    try {
      recordReplyTarget(message.channelId, message.id);
      await processDiscordMessage(message, {
        botUserId: client.user.id,
        conversation,
        commandContext: runtime.commandContext,
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
    if (shepherd.isQuiescing()) return;
    if (!interaction.isButton()) return;
    await handleInteraction(interaction, conversation, runtime.commandContext);
  });

  try {
    await client.login(token);
    signals.start();
    if (signals.url) console.log(`signal webhook ready at ${signals.url}`);
  } catch (error) {
    try {
      await shepherd.shutdown();
    } catch (shutdownError) {
      console.error("Shepherd startup cleanup failed:", shutdownError);
    }
    throw error;
  }

  process.on("SIGINT", () => {
    void shepherd.shutdown().finally(() => process.exit(0));
  });
  process.on("SIGTERM", () => {
    void shepherd.shutdown().finally(() => process.exit(0));
  });
}

const __filename = fileURLToPath(import.meta.url);
const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === __filename;

if (isDirectRun) {
  void startDiscordBot().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
