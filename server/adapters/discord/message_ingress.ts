import type { Attachment, Message } from "discord.js";

import type { ApprovalPolicy } from "../../../shared/protocol/requests.js";
import { toTextUserInput, type UserInput } from "../../../shared/protocol/user_input.js";
import type { ConversationService } from "../../core/conversation_service.js";
import {
  classifySurfaceInput,
  type SurfaceInputClassification,
} from "../../core/turn_routing_policy.js";
import { executeTurnRouting } from "../../core/turn_routing_service.js";
import { handleMessage, type CommandContext } from "./commands.js";
import {
  isDiscordAudioAttachment,
} from "./audio_attachment.js";
import {
  discordImageAttachmentToDataUrl,
  isDiscordImageAttachment,
  type DiscordImageFetch,
} from "./image_input.js";
import { replyDiscordCard } from "./stream_delivery.js";

export type DiscordMessageIngressDeps = {
  botUserId: string;
  conversation: ConversationService;
  commandContext: CommandContext;
  approvalPolicy: ApprovalPolicy;
  classifyInput?: typeof classifySurfaceInput;
  fetchImage?: DiscordImageFetch;
  handleCommandMessage?: typeof handleMessage;
  executeRouting?: typeof executeTurnRouting;
};

export async function processDiscordMessage(
  message: Message,
  deps: DiscordMessageIngressDeps,
): Promise<void> {
  const raw = message.content.trim();
  const isCommand = raw.startsWith("!");
  const isMentioned = message.mentions.users.has(deps.botUserId);
  const listeningMode =
    deps.commandContext.getSurfaceListeningMode?.(message.channelId) ?? "mention";
  const isDirectMessage = message.guildId === null;
  const isAddressed =
    listeningMode !== "paused" && (isMentioned || listeningMode === "open" || isDirectMessage);
  if (!isCommand && !isAddressed) return;

  const attachments = [...(message.attachments?.values?.() ?? [])];
  if (attachments.some(isDiscordAudioAttachment)) {
    const delivered = await replyDiscordCard(message, {
      title: "Unsupported input",
      text: "Audio input is not supported. Use your phone's dictation to send the message as text.",
      tone: "warning",
    });
    if (!delivered.success) throw new Error(delivered.error ?? "Discord delivery failed.");
    return;
  }

  const mentionPattern = new RegExp(`<@!?${deps.botUserId}>`, "g");
  const sanitizedContent = isCommand ? raw : raw.replace(mentionPattern, "").trim();
  const structuredInput = await buildDiscordUserInput(
    attachments,
    sanitizedContent,
    deps.fetchImage,
  );
  const classify = deps.classifyInput ?? classifySurfaceInput;
  const classified: SurfaceInputClassification = classify({
    adapter: "discord",
    surfaceId: message.channelId,
    content: sanitizedContent,
    input: structuredInput,
    isCommand,
    isDirectAddressed: isAddressed,
  });
  if (classified.type === "ignore") return;

  const handle = deps.handleCommandMessage ?? handleMessage;
  const result =
    classified.surface.content.length > 0
      ? await handle(message, deps.commandContext, classified.surface.content)
      : {
          handled: false,
          threadId:
            deps.commandContext.getSurfaceThreadId(message.channelId) ??
            (await deps.commandContext.ensureSurfaceThread(message.channelId)),
          input: null,
        };

  const execute = deps.executeRouting ?? executeTurnRouting;
  await execute(
    { conversation: deps.conversation },
    {
      surface: classified.surface,
      handled: result.handled,
      threadId: result.threadId,
      input: result.handled ? result.input : classified.surface.input,
      approvalPolicy: deps.approvalPolicy,
    },
  );
}

async function buildDiscordUserInput(
  attachments: Attachment[],
  sanitizedContent: string,
  fetchImage?: DiscordImageFetch,
): Promise<UserInput[]> {
  const input: UserInput[] = [];

  if (sanitizedContent) {
    input.push(toTextUserInput(sanitizedContent));
  }

  for (const attachment of attachments) {
    if (isDiscordImageAttachment(attachment)) {
      const url = await discordImageAttachmentToDataUrl(attachment, {
        ...(fetchImage ? { fetchImpl: fetchImage } : {}),
      });
      input.push({ type: "image", url });
    }
  }

  return input;
}
