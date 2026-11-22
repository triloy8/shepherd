import { randomUUID } from "node:crypto";
import { isMessageSource, type MessageSource } from "../../../shared/protocol/message_source.js";

export function codexClientMessageId(source: MessageSource): string {
  return `shepherd:v1:${source}:${randomUUID()}`;
}

export function codexMessageSource(clientId: unknown): MessageSource | undefined {
  if (typeof clientId !== "string") return;
  const match = /^shepherd:v1:([a-z_]+):[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/.exec(clientId);
  const source = match?.[1];
  return isMessageSource(source) ? source : undefined;
}
