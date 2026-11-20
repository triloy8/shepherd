import { randomUUID } from "node:crypto";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { MessageSource } from "../../../shared/protocol/message_source.js";

// Claude Code preserves the SDK's prompt UUID in history, but drops host-supplied origin.
// Reserve a version-8 namespace (SHPD, layout 01) for sourced prompts; the rest stays random.
const sourceCodes = { human: "0", webhook: "1", thread_watch: "2", swarm_assignment: "3" } as const satisfies Record<MessageSource, string>;
const sources = Object.keys(sourceCodes) as MessageSource[];

export function claudeMessageId(source?: MessageSource): NonNullable<SDKUserMessage["uuid"]> {
  const id = randomUUID();
  if (!source) return id;
  const [, , version, variant, tail] = id.split("-");
  return `53485044-010${sourceCodes[source]}-8${version!.slice(1)}-${variant!}-${tail!}`;
}

export function claudeMessageSource(id: string, origin: unknown): MessageSource | undefined {
  const tag = /^53485044-010([\da-f])-8[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i.exec(id)?.[1];
  const source = sources.find(candidate => sourceCodes[candidate] === tag);
  if (source) return source;
  if (origin && typeof origin === "object" && "kind" in origin && origin.kind === "human") return "human";
}
