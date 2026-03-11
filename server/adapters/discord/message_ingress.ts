import type { Message } from "discord.js";

import type { ApprovalPolicy } from "../../../shared/protocol/requests.js";
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
  const classify = deps.classifyInput ?? classifySurfaceInput;
  const classified: SurfaceInputClassification = classify({
    adapter: "discord",
    surfaceId: message.channelId,
    content: sanitizedContent,
    isCommand,
    isDirectAddressed: isMentioned,
  });
  if (classified.type === "ignore") return;

  const handle = deps.handleCommandMessage ?? handleMessage;
  const result = await handle(message, deps.commandContext, classified.surface.content);

  const execute = deps.executeRouting ?? executeTurnRouting;
  await execute(
    { conversation: deps.conversation },
    {
      surface: classified.surface,
      handled: result.handled,
      threadId: result.threadId,
      input: result.input,
      approvalPolicy: deps.approvalPolicy,
    },
  );
}
