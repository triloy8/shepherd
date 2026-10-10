import type { ProviderAccountLimits, ReadProviderAccountLimitsOptions } from "../../shared/protocol/provider_account_limits.js";

/** Runtime-owned account reader. It must not submit a model turn to refresh. */
export interface ProviderAccountLimitsReader {
  read(options?: ReadProviderAccountLimitsOptions): Promise<ProviderAccountLimits>;
  stop(): void;
}
