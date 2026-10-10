import type { AgentProvider, ApprovalPolicy, ListStoredThreadsRequest } from "../../shared/protocol/requests.js";
import type { AgentSession } from "./agent_session.js";
import type { DynamicToolRegistry } from "./dynamic_tool_registry.js";
import type { ProviderAccountLimitsReader } from "../ports/provider_account_limits.js";

export type AgentSessionFactory = (policy: ApprovalPolicy, tools: DynamicToolRegistry, provider: AgentProvider) => AgentSession;

/** Identity is supplied by composition; application code never inspects native IDs. */
export interface ThreadProviderDirectory {
  resolve(threadId: string): AgentProvider;
  bind(threadId: string, provider: AgentProvider): void;
}

export interface ProviderServices {
  shutdown?: () => void;
  descriptors?: import("../../shared/protocol/v2/conversations.js").ProviderDescriptor[];
  neutralAccounts?: ReadonlyMap<string, { read(refresh?: boolean): Promise<import("../../shared/protocol/v2/account_limits.js").ProviderAccountLimits>; reset?: (input: { idempotencyKey: string; creditId?: string }) => Promise<{ outcome: "reset" | "already_redeemed" | "nothing_to_reset" | "no_credit" }> }>;
  providers: readonly AgentProvider[];
  createSession: AgentSessionFactory;
  hasStoredThreads: (provider: AgentProvider, request: ListStoredThreadsRequest) => boolean;
  directory: ThreadProviderDirectory;
  accountLimits?: Partial<Record<AgentProvider, ProviderAccountLimitsReader>>;
}

/** Pure defaults for isolated application tests. Production supplies persistent services. */
export function memoryProviderDirectory(): ThreadProviderDirectory {
  const bindings = new Map<string, AgentProvider>();
  return {
    resolve: (id) => bindings.get(id) ?? "codex",
    bind(id, provider) {
      const existing = bindings.get(id);
      if (existing && existing !== provider) throw new Error("Cannot change the provider of an existing thread.");
      bindings.set(id, provider);
    },
  };
}

export const missingSessionFactory: AgentSessionFactory = () => {
  throw new Error("Provider services were not supplied at the runtime composition boundary.");
};
