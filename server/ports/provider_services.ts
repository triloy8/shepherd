import type { AgentProvider, ListStoredThreadsRequest } from "../../shared/protocol/requests.js";
import type { Provider } from "./provider_session.js";

/** The installed provider for an ID. */
export type ProviderLookup = (provider: AgentProvider) => Provider;

/** Identity is supplied by composition; application code never inspects native IDs. */
export interface ThreadProviderDirectory {
  resolve(threadId: string): AgentProvider;
  bind(threadId: string, provider: AgentProvider): void;
}

export interface ProviderAccount {
  read(refresh?: boolean): Promise<import("../../shared/protocol/account_limits.js").ProviderAccountLimits>;
  reset?: (input: import("../../shared/protocol/account_limits.js").AccountResetRequest) => Promise<import("../../shared/protocol/account_limits.js").AccountResetResponse>;
}
export interface ProviderServices {
  shutdown?: () => void;
  descriptors: import("../../shared/protocol/providers.js").ProviderDescriptor[];
  accounts: ReadonlyMap<string, ProviderAccount>;
  providers: readonly AgentProvider[];
  /** Used when a request names no provider. Always one of `providers`. */
  defaultProvider: AgentProvider;
  provider: ProviderLookup;
  hasStoredThreads: (provider: AgentProvider, request: ListStoredThreadsRequest) => boolean;
  directory: ThreadProviderDirectory;
}
