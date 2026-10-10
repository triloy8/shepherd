import type { AgentProvider } from "../../shared/protocol/requests.js";
import type { ProviderAccountLimits, ReadProviderAccountLimitsOptions } from "../../shared/protocol/provider_account_limits.js";
import type { ProviderAccountLimitsReader } from "../ports/provider_account_limits.js";
import { UnsupportedProviderOperationError } from "./agent_session.js";

/** Accounts belong to the host, not the selected conversation/session. */
export class AccountLimitsService {
  private stopped = false;
  constructor(private readonly readers: Partial<Record<AgentProvider, ProviderAccountLimitsReader>> = {}) {}

  async read(provider: AgentProvider, options?: ReadProviderAccountLimitsOptions): Promise<ProviderAccountLimits> {
    if (this.stopped) throw new Error("Account limits service is stopped.");
    const reader = this.readers[provider];
    if (!reader) throw new UnsupportedProviderOperationError(provider, "account allowance reporting");
    const result = await reader.read(options);
    if (this.stopped) throw new Error("Account limits service is stopped.");
    if (result.provider !== provider) throw new Error("Account limits reader returned another provider's data.");
    return result;
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const reader of new Set(Object.values(this.readers))) reader?.stop();
  }
}
