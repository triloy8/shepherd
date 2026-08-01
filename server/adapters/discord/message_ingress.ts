import type { Message } from "discord.js";

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
  discordAudioAttachmentToDataUrl,
  isDiscordAudioAttachment,
  type DiscordAudioFetch,
} from "./audio_input.js";
import {
  discordImageAttachmentToDataUrl,
  isDiscordImageAttachment,
  type DiscordImageFetch,
} from "./image_input.js";

export type DiscordMessageIngressDeps = {
  botUserId: string;
  conversation: ConversationService;
  commandContext: CommandContext;
  approvalPolicy: ApprovalPolicy;
  classifyInput?: typeof classifySurfaceInput;
  fetchAudio?: DiscordAudioFetch;
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
  if (!isCommand && !isMentioned) return;

  const mentionPattern = new RegExp(`<@!?${deps.botUserId}>`, "g");
  const sanitizedContent = isCommand ? raw : raw.replace(mentionPattern, "").trim();
  const structuredInput = await buildDiscordUserInput(
    message,
    sanitizedContent,
    deps.fetchAudio,
    deps.fetchImage,
  );
  const classify = deps.classifyInput ?? classifySurfaceInput;
  const classified: SurfaceInputClassification = classify({
    adapter: "discord",
    surfaceId: message.channelId,
    content: sanitizedContent,
    input: structuredInput,
    isCommand,
    isDirectAddressed: isMentioned,
  });
  if (classified.type === "ignore") return;

  const handle = deps.handleCommandMessage ?? handleMessage;
  const result =
    classified.surface.content.length > 0
      ? await handle(message, deps.commandContext, classified.surface.content)
      : { handled: false, threadId: deps.commandContext.getSurfaceThreadId(message.channelId), input: null };

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
  message: Message,
  sanitizedContent: string,
  fetchAudio?: DiscordAudioFetch,
  fetchImage?: DiscordImageFetch,
): Promise<UserInput[]> {
  const input: UserInput[] = [];

  if (sanitizedContent) {
    input.push(toTextUserInput(sanitizedContent));
  }

  for (const attachment of message.attachments?.values?.() ?? []) {
    if (isDiscordAudioAttachment(attachment)) {
      const url = await discordAudioAttachmentToDataUrl(attachment, {
        ...(fetchAudio ? { fetchImpl: fetchAudio } : {}),
      });
      input.push({ type: "audio", url });
    } else if (isDiscordImageAttachment(attachment)) {
      const url = await discordImageAttachmentToDataUrl(attachment, {
        ...(fetchImage ? { fetchImpl: fetchImage } : {}),
      });
      input.push({ type: "image", url });
    }
  }

  return input;
}
