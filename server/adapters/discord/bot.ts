import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  ChannelType,
  Client,
  GatewayIntentBits,
  Partials,
  type Message,
  type TextBasedChannel,
} from "discord.js";

import type { SandboxMode } from "../../../shared/protocol/requests.js";
import { loadEnvironment, readApprovalPolicy, readBoolean } from "../../config/environment.js";
import { readSignalRuntimeConfig } from "../../config/signal_environment.js";
import { ConversationSignalExecutor } from "../../core/conversation_signal_executor.js";
import { DeploymentService } from "../../core/deployment_service.js";
import { SignalDispatcher } from "../../core/signal_dispatcher.js";
import { SignalRegistry } from "../../core/signal_registry.js";
import { SignalRouteRegistry } from "../../core/signal_route_registry.js";
import { SignalRouteService } from "../../core/signal_route_service.js";
import { ShepherdRuntime } from "../../runtime/shepherd_runtime.js";
import { createResearchStateChangedDefinition } from "../../signals/research_state_changed.js";
import {
  startWebhookSignalServer,
  type WebhookSignalServer,
} from "../webhook/server.js";
import { handleInteraction } from "./interactions.js";
import { processDiscordMessage } from "./message_ingress.js";
import { createDiscordSurfaceRuntime } from "./surface_runtime.js";
import { createDiscordThreadEventHandler } from "./thread_event_handler.js";
import { replyDiscordCard } from "./stream_delivery.js";

const execFileAsync = promisify(execFile);

const SANDBOX_MODES: SandboxMode[] = ["read-only", "workspace-write", "danger-full-access"];

function readSandboxMode(value: string | undefined): SandboxMode | undefined {
  if (!value) return undefined;
  if (SANDBOX_MODES.includes(value as SandboxMode)) {
    return value as SandboxMode;
  }
  return undefined;
}

function readPositiveNumber(value: string | undefined, name: string): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive number.`);
  }
  return parsed;
}

function isSupportedChannel(channel: Message["channel"]): channel is TextBasedChannel {
  return (
    channel.type === ChannelType.GuildText ||
    channel.type === ChannelType.PublicThread ||
    channel.type === ChannelType.PrivateThread ||
    channel.type === ChannelType.DM
  );
}

async function runGh(args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("gh", args, {
      cwd: process.cwd(),
      env: process.env,
      maxBuffer: 1024 * 1024 * 10,
    });
    return stdout.trim();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`gh ${args.join(" ")} failed: ${message}`);
  }
}

export async function startDiscordBot(): Promise<void> {
  loadEnvironment("discord");
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    throw new Error("Missing DISCORD_BOT_TOKEN.");
  }

  const approvalPolicy = readApprovalPolicy(process.env.CODEX_APPROVAL_POLICY);
  const defaultSandbox = readSandboxMode(process.env.CODEX_SANDBOX);
  const discordStreaming = readBoolean(
    process.env.SHEPHERD_DISCORD_STREAMING,
    "SHEPHERD_DISCORD_STREAMING",
    false,
  );
  const deploymentCommandTimeoutMs = readPositiveNumber(
    process.env.SHEPHERD_DEPLOY_COMMAND_TIMEOUT_MS,
    "SHEPHERD_DEPLOY_COMMAND_TIMEOUT_MS",
  );
  const signalConfig = readSignalRuntimeConfig();
  const deployment = new DeploymentService({
    ...(deploymentCommandTimeoutMs ? { commandTimeoutMs: deploymentCommandTimeoutMs } : {}),
  });
  await deployment.removeLegacyState();

  const shepherd = new ShepherdRuntime({
    approvalPolicy,
    defaultSandbox,
    deployment,
  });
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
  let webhookServer: WebhookSignalServer | null = null;

  const threadEvents = createDiscordThreadEventHandler(client, {
    streaming: discordStreaming,
  });
  const { handleThreadEvent, recordUserMessage } = threadEvents;
  disposeThreadEvents = threadEvents.dispose;
  const runtime = createDiscordSurfaceRuntime({
    conversation,
    approvalPolicy,
    defaultSandbox,
    onThreadEvent: handleThreadEvent,
    cloneGithubRepo: async (slug, workspacePath) => {
      await runGh(["repo", "clone", slug, workspacePath, "--", "--recurse-submodules"]);
    },
    resolveGithubRepo: async (slug) =>
      runGh(["repo", "view", slug, "--json", "nameWithOwner", "--jq", ".nameWithOwner"]),
    runtimeLifecycle: shepherd.lifecycle,
  });

  const signalRegistry = new SignalRegistry();
  signalRegistry.register(createResearchStateChangedDefinition());
  const signalRoutes = new SignalRouteRegistry({
    onEvent: (event) => {
      console.info(
        `signal route ${event.type}: ${event.routePrefix} (${event.kind}@${event.version})`,
      );
    },
  });
  const signalRouteService = new SignalRouteService({
    routes: signalRoutes,
    signals: signalRegistry,
    conversation,
    getWebhookBaseUrl: () => webhookServer?.url ?? null,
  });
  const unregisterSignalTool = signalConfig.enabled
    ? conversation.registerDynamicTool(signalRouteService.registration())
    : (): void => {};
  const signalDispatcher = new SignalDispatcher(
    new ConversationSignalExecutor(conversation),
    {
      capacity: signalConfig.queueCapacity,
    },
  );

  shepherd.registerShutdownHook(async () => {
    unregisterSignalTool();
    signalRoutes.dispose();
    signalDispatcher.dispose();
    await webhookServer?.stop();
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
      recordUserMessage(message.channelId, message.id);
      await processDiscordMessage(message, {
        botUserId: client.user.id,
        conversation,
        commandContext: runtime.commandContext,
        approvalPolicy,
      });
    } catch (error) {
      const text = error instanceof Error ? error.message : "Failed to process message.";
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
    if (signalConfig.enabled) {
      webhookServer = startWebhookSignalServer({
        registry: signalRegistry,
        routes: signalRoutes,
        dispatcher: signalDispatcher,
        hostname: signalConfig.hostname,
        port: signalConfig.port,
        maxBodyBytes: signalConfig.maxBodyBytes,
        isAvailable: () => !shepherd.isQuiescing(),
      });
      console.log(`signal webhook ready at ${webhookServer.url}`);
    }
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
