import type { AgentProvider, ApprovalPolicy, ListStoredThreadsRequest } from "../../shared/protocol/requests.js";
import type { AgentSession } from "./agent_session.js";
import { CodexSession } from "./codex_session.js";
import { ClaudeSession, ClaudeThreadStore } from "./claude_session.js";
import type { DynamicToolRegistry } from "./dynamic_tool_registry.js";

export type AgentSessionFactory = (policy: ApprovalPolicy, tools: DynamicToolRegistry, provider: AgentProvider) => AgentSession;

type ProviderDefinition = {
  createSession: (policy: ApprovalPolicy, tools: DynamicToolRegistry) => AgentSession;
  ownsThread: (threadId: string) => boolean;
  hasStoredThreads?: (request: ListStoredThreadsRequest) => boolean;
};

/** Native SDKs, thread identity, and discovery stay behind this registry. */
const providers: Record<AgentProvider, ProviderDefinition> = {
  codex: { createSession: (policy, tools) => new CodexSession(policy, tools), ownsThread: () => true },
  claude: {
    createSession: (policy, tools) => new ClaudeSession(policy, tools),
    ownsThread: (id) => id.startsWith("claude-"),
    hasStoredThreads: (request) => new ClaudeThreadStore().list().some((t) => t.archived === (request.archived ?? false) && (!request.searchTerm || `${t.name ?? ""} ${t.preview}`.toLowerCase().includes(request.searchTerm.toLowerCase())) && (!request.cwd || (Array.isArray(request.cwd) ? request.cwd.includes(t.cwd) : request.cwd === t.cwd)) && (!request.modelProviders || request.modelProviders.includes("anthropic")) && (!request.sourceKinds || request.sourceKinds.includes("appServer"))),
  },
};

export function providerForThread(threadId: string): AgentProvider {
  return (Object.keys(providers) as AgentProvider[]).find((id) => id !== "codex" && providers[id].ownsThread(threadId)) ?? "codex";
}

export function hasProviderThreads(provider: AgentProvider, request: ListStoredThreadsRequest): boolean {
  return providers[provider].hasStoredThreads?.(request) ?? false;
}

export const createAgentSession: AgentSessionFactory = (policy, tools, provider) => {
  const definition = providers[provider];
  if (!definition) throw new Error(`Unknown agent provider: ${provider}`);
  return definition.createSession(policy, tools);
};
