import type { AccountResetRequest, AccountResetResponse } from "../../../shared/protocol/account_limits.js";
import { CodexSession } from "./session.js";
import { codexAccount } from "./account_presentation.js";
/** Account transport and native quota/reset decoding are private to this adapter. */
export class CodexAccount {
  private session: CodexSession | null = null;
  private stopped = false;
  constructor(private readonly create = () => new CodexSession("review_sensitive")) {}
  private async control() {
    if (this.stopped) throw new Error("Account service is stopped.");
    const session = this.session ??= this.create();
    await session.initialize();
    if (this.stopped) throw new Error("Account service is stopped.");
    return session;
  }
  async read() { return codexAccount(await (await this.control()).readAccountRateLimits()); }
  async reset(input: AccountResetRequest): Promise<AccountResetResponse> {
    const result = await (await this.control()).consumeRateLimitReset(input);
    const outcomes = { reset: "reset", alreadyRedeemed: "already_redeemed", nothingToReset: "nothing_to_reset", noCredit: "no_credit" } as const;
    return { outcome: outcomes[result.outcome] };
  }
  stop() { this.stopped = true; this.session?.stop(); this.session = null; }
}
