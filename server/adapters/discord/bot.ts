import path from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  ChannelType,
  Client,
  GatewayIntentBits,
  type Message,
  type TextBasedChannel,
} from "discord.js";

import type { ApprovalPolicy, SandboxMode } from "../../../shared/protocol/requests.js";
import { loadEnvironment } from "../../config/environment.js";
import { ConversationService } from "../../core/conversation_service.js";
import { SurfaceConversationOrchestrator } from "../../core/surface_conversation_orchestrator.js";
import { SurfaceStateService } from "../../core/surface_state_service.js";
import { classifySurfaceInput } from "../../core/turn_routing_policy.js";
import { executeTurnRouting } from "../../core/turn_routing_service.js";
import { WorkspaceProvisioner } from "../../core/workspace_provisioner.js";
import { handleMessage } from "./commands.js";
import { handleInteraction } from "./interactions.js";
import { createDiscordThreadEventHandler } from "./thread_event_handler.js";

const execFileAsync = promisify(execFile);

const SANDBOX_MODES: SandboxMode[] = ["read-only", "workspace-write", "danger-full-access"];

function readSandboxMode(value: string | undefined): SandboxMode | undefined {
  if (!value) return undefined;
  if (SANDBOX_MODES.includes(value as SandboxMode)) {
    return value as SandboxMode;
  }
  return undefined;
}

function isSupportedChannel(channel: Message["channel"]): channel is TextBasedChannel {
  return (
    channel.type === ChannelType.GuildText ||
    channel.type === ChannelType.PublicThread ||
    channel.type === ChannelType.PrivateThread
  );
}

function repoNameFromSlug(slug: string): string {
  return slug.split("/")[1] ?? slug;
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

  const approvalPolicy = (process.env.CODEX_APPROVAL_POLICY ?? "on-request") as ApprovalPolicy;
  const defaultSandbox = readSandboxMode(process.env.CODEX_SANDBOX);

  const conversation = new ConversationService({
    routing: {
      autoCreateIfMissing: true,
      defaultApprovalPolicy: approvalPolicy,
      defaultSandbox,
      exclusiveThreadBinding: true,
    },
  });

  const surfaceState = new SurfaceStateService();
  const workspaceProvisioner = new WorkspaceProvisioner({
    async cloneGithubRepo(slug, workspacePath) {
      await runGh(["repo", "clone", slug, workspacePath, "--", "--recurse-submodules"]);
    },
  });

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });
  const { handleThreadEvent } = createDiscordThreadEventHandler(client);

  const orchestrator = new SurfaceConversationOrchestrator(
    conversation,
    surfaceState,
    workspaceProvisioner,
    {
      adapter: "discord",
      approvalPolicy,
      sandbox: defaultSandbox,
      projectTargetResolver: {
        resolveGithubRepo: async (slug) =>
          runGh(["repo", "view", slug, "--json", "nameWithOwner", "--jq", ".nameWithOwner"]),
      },
    },
  );

  const bindChannelToThread = async (surfaceId: string, threadId: string): Promise<void> => {
    await orchestrator.bindSurfaceToThread(surfaceId, threadId, (event) => handleThreadEvent(surfaceId, event));
  };

  const clearSurfaceThread = (surfaceId: string): void => {
    orchestrator.clearSurfaceThread(surfaceId);
  };

  const createSurfaceThread = async (surfaceId: string): Promise<string> => {
    return orchestrator.createAndBindSurfaceThread(surfaceId, (event) => handleThreadEvent(surfaceId, event));
  };

  const forkSurfaceThread = async (surfaceId: string, sourceThreadId: string): Promise<string> => {
    return orchestrator.forkSurfaceThread(surfaceId, sourceThreadId, (event) => handleThreadEvent(surfaceId, event));
  };

  const switchSurfaceThread = async (surfaceId: string, threadId: string): Promise<string> => {
    return orchestrator.switchSurfaceThread(surfaceId, threadId, (event) => handleThreadEvent(surfaceId, event));
  };

  const ensureSurfaceThread = async (surfaceId: string): Promise<string> => {
    return orchestrator.ensureSurfaceThread(surfaceId, (event) => handleThreadEvent(surfaceId, event));
  };

  client.once("clientReady", () => {
    console.log(`discord bridge ready as ${client.user?.tag ?? "unknown"}`);
  });

  client.on("messageCreate", async (message) => {
    if (message.author.bot) return;
    if (!isSupportedChannel(message.channel)) return;
    if (!client.user) return;

    const raw = message.content.trim();
    const isCommand = raw.startsWith("!");
    const isMentioned = message.mentions.users.has(client.user.id);

    const mentionPattern = new RegExp(`<@!?${client.user.id}>`, "g");
    const sanitizedContent = isCommand ? raw : raw.replace(mentionPattern, "").trim();
    const classified = classifySurfaceInput({
      adapter: "discord",
      surfaceId: message.channelId,
      content: sanitizedContent,
      isCommand,
      isDirectAddressed: isMentioned,
    });
    if (classified.type === "ignore") return;

    try {
      const result = await handleMessage(message, {
        conversation,
        getSurfaceThreadId: (surfaceId) => conversation.getSurfaceThread("discord", surfaceId),
        getSurfaceProject: (surfaceId) => orchestrator.getSurfaceProjectDisplay(surfaceId),
        setSurfaceProject: async (surfaceId, repoSlug) => orchestrator.setSurfaceProject(surfaceId, repoSlug),
        ensureSurfaceThread,
        createSurfaceThread,
        switchSurfaceThread,
        forkSurfaceThread,
        clearSurfaceThread,
      }, classified.surface.content);

      await executeTurnRouting(
        { conversation },
        {
          surface: classified.surface,
          handled: result.handled,
          threadId: result.threadId,
          input: result.input,
          approvalPolicy,
        },
      );
    } catch (error) {
      await message.reply(error instanceof Error ? error.message : "Failed to process message.");
    }
  });

  client.on("interactionCreate", async (interaction) => {
    if (!interaction.isButton()) return;
    await handleInteraction(interaction, conversation);
  });

  await client.login(token);

  const shutdown = async (): Promise<void> => {
    conversation.stopAll();
    await client.destroy();
  };

  process.on("SIGINT", () => {
    void shutdown().finally(() => process.exit(0));
  });
  process.on("SIGTERM", () => {
    void shutdown().finally(() => process.exit(0));
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
