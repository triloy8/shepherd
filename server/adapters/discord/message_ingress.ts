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

export type DiscordMessageIngressDeps = {
  botUserId: string;
  conversation: ConversationService;
  commandContext: CommandContext;
  approvalPolicy: ApprovalPolicy;
  classifyInput?: typeof classifySurfaceInput;
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

  const mentionPattern = new RegExp(`<@!?${deps.botUserId}>`, "g");
  const sanitizedContent = isCommand ? raw : raw.replace(mentionPattern, "").trim();
  const structuredInput = buildDiscordUserInput(message, sanitizedContent);
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

function buildDiscordUserInput(message: Message, sanitizedContent: string): UserInput[] {
  const input: UserInput[] = [];

  if (sanitizedContent) {
    input.push(toTextUserInput(sanitizedContent));
  }

  for (const attachment of message.attachments?.values?.() ?? []) {
    if (isImageAttachment(attachment)) {
      input.push({ type: "image", url: attachment.url });
    }
  }

  return input;
}

function isImageAttachment(attachment: {
  contentType?: string | null;
  name?: string | null;
  url: string;
}): boolean {
  if (attachment.contentType?.startsWith("image/")) {
    return true;
  }

  const name = attachment.name?.toLowerCase() ?? "";
  return [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg", ".heic", ".heif"].some((ext) =>
    name.endsWith(ext),
  );
}
