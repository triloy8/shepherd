import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { query, type AccountInfo, type Query, type SDKRateLimitInfo, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ProviderAccountLimits, ReadProviderAccountLimitsOptions } from "../../../shared/protocol/provider_account_limits.js";
import type { ProviderAccountLimitsReader } from "../../ports/provider_account_limits.js";
import { claudeAuthenticationOptions } from "./authentication.js";
import { claudeExecutablePath } from "./claude_executable.js";
import { InputQueue } from "./input_queue.js";
import { claudeAccount, emptyClaudeLimits, mapClaudeRateLimit, mapClaudeUsage } from "./account_limits_mapper.js";

export interface ClaudeLimitsObserver {
  observe(info: SDKRateLimitInfo, account: AccountInfo, scope: string): void;
  scope(): string;
}

type Options = { now?: () => number; timeoutMs?: number; cacheSeconds?: number; staleSeconds?: number };

/** One reader/collector per runtime, shared by every Claude conversation. */
export class ClaudeAccountLimits implements ProviderAccountLimitsReader, ClaudeLimitsObserver {
  private snapshot = emptyClaudeLimits();
  private accountKey: string | null = null;
  private credentialScope: string | null = null;
  private pending: Promise<ProviderAccountLimits> | null = null;
  private lastAttempt = -Infinity;
  private stopped = false;
  private readonly queries = new Map<Query, () => void>();
  private readonly now: () => number;
  constructor(private readonly open = query, private readonly options: Options = {}) {
    this.now = options.now ?? (() => Date.now() / 1000);
  }

  // Fingerprints are private. Neither credential material nor account identity
  // is returned to the browser. Old sessions cannot contaminate a changed login.
  scope(): string {
    const env = claudeAuthenticationOptions().env;
    let savedLogin: [number, number, number] | null = null;
    try {
      const stat = statSync(join(env.CLAUDE_CONFIG_DIR ?? join(env.HOME ?? homedir(), ".claude"), ".credentials.json"));
      savedLogin = [stat.ino, stat.mtimeMs, stat.size];
    } catch { /* Keychain-backed installations need not have a credential file. */ }
    return createHash("sha256").update(JSON.stringify([
      env.HOME, env.CLAUDE_CONFIG_DIR, env.CLAUDE_AUTH_MODE ?? "subscription",
      env.CLAUDE_CODE_OAUTH_TOKEN, env.ANTHROPIC_API_KEY, env.ANTHROPIC_AUTH_TOKEN,
      env.ANTHROPIC_PROFILE, env.CLAUDE_CODE_USE_BEDROCK, env.CLAUDE_CODE_USE_VERTEX,
      env.CLAUDE_CODE_USE_FOUNDRY,
      savedLogin,
    ])).digest("hex");
  }

  private key(account: AccountInfo, scope: string): string {
    return createHash("sha256").update(JSON.stringify([scope, account.email, account.organization, account.subscriptionType, account.apiProvider, account.apiKeySource])).digest("hex");
  }

  private selectAccount(account: AccountInfo, scope: string): boolean {
    if (scope !== this.scope()) return false;
    const key = this.key(account, scope);
    if (key !== this.accountKey) {
      this.snapshot = emptyClaudeLimits(account);
      this.accountKey = key;
    }
    this.credentialScope = scope;
    return true;
  }

  observe(info: SDKRateLimitInfo, account: AccountInfo, scope: string): void {
    if (this.accountKey !== null && this.credentialScope === scope && this.accountKey !== this.key(account, scope)) return;
    if (this.stopped || !this.selectAccount(account, scope) || claudeAccount(account).authentication === "api") return;
    const update = mapClaudeRateLimit(info, this.now());
    if (!update) return;
    // Replace this window in full. An omitted percentage is unknown, including
    // after reset; never carry a previous window's utilization forward.
    const windows = this.snapshot.windows.filter(window => window.id !== update.window.id);
    windows.push(update.window);
    this.snapshot = { ...this.snapshot, availability: "available", source: "events", stale: false, windows,
      extraUsage: update.extraUsage ?? this.snapshot.extraUsage, message: null };
  }

  async read(options: ReadProviderAccountLimitsOptions = {}): Promise<ProviderAccountLimits> {
    if (this.stopped) throw new Error("Claude account reader is stopped.");
    const scope = this.scope();
    if (this.credentialScope !== scope) {
      this.snapshot = emptyClaudeLimits(); this.accountKey = null;
      this.credentialScope = scope; this.lastAttempt = -Infinity;
    }
    if (this.pending) return this.pending;
    const age = this.now() - this.lastAttempt;
    // Coalesce browsers and cap explicit refreshes; polling never opens one
    // native process per conversation or sends a model prompt.
    if (age < (options.refresh ? 5 : this.options.cacheSeconds ?? 30)) return this.current();
    this.lastAttempt = this.now();
    const operation = this.refresh(scope);
    this.pending = operation;
    try { return await operation; }
    finally { if (this.pending === operation) this.pending = null; }
  }

  private async refresh(scope: string): Promise<ProviderAccountLimits> {
    const input = new InputQueue<SDKUserMessage>();
    let running: Query | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let accepting = true;
    try {
      const path = claudeExecutablePath();
      running = this.open({ prompt: input, options: { ...claudeAuthenticationOptions(),
        ...(path ? { pathToClaudeCodeExecutable: path } : {}), permissionMode: "dontAsk",
        settingSources: [], tools: [], mcpServers: {},
      } });
      const current = running;
      const cancelled = new Promise<never>((_, reject) => {
        this.queries.set(current, () => { accepting = false; reject(new Error("Claude account reader is stopped.")); });
      });
      const operation = (async () => {
        const account = await current.accountInfo();
        if (!accepting || this.stopped || !this.selectAccount(account, scope)) return;
        if (claudeAccount(account).authentication === "api" || !claudeAccount(account).signedIn) {
          this.snapshot = { ...emptyClaudeLimits(account), checkedAt: this.now() };
          return;
        }
        // The unstable SDK call and its reply shape stay inside this adapter.
        const read = current.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET;
        if (typeof read !== "function") throw new Error("Structured usage control unavailable.");
        const previousWindows = new Map(this.snapshot.windows.map(window => [window.id, window]));
        const previousExtra = this.snapshot.extraUsage;
        const reply = await read.call(current, { skipBehaviors: true });
        if (!accepting || this.stopped || scope !== this.scope()) return;
        const snapshot = mapClaudeUsage(reply, account, this.now());
        if (!snapshot) throw new Error("Invalid structured usage reply.");
        // A concurrent event newer than the read's start takes precedence.
        for (const window of this.snapshot.windows.filter(window => previousWindows.get(window.id) !== window)) {
          snapshot.windows = snapshot.windows.filter(row => row.id !== window.id);
          snapshot.windows.push(window);
        }
        if (this.snapshot.extraUsage !== previousExtra) snapshot.extraUsage = this.snapshot.extraUsage;
        this.snapshot = snapshot;
      })();
      await Promise.race([operation, cancelled, new Promise<never>((_, reject) => {
        timer = setTimeout(() => { accepting = false; reject(new Error("Claude usage read timed out.")); }, this.options.timeoutMs ?? 10_000);
      })]);
    } catch {
      if (!this.stopped && scope === this.scope()) {
        this.snapshot = { ...this.snapshot, stale: this.snapshot.windows.length > 0 || this.snapshot.extraUsage !== null,
          windows: this.snapshot.windows.map(window => ({ ...window, stale: true })),
          extraUsage: this.snapshot.extraUsage ? { ...this.snapshot.extraUsage, stale: true } : null,
          message: this.snapshot.windows.length ? "Could not refresh Claude limits. Showing the last reported values."
            : "Claude limits could not be refreshed. Try again or check usage in Claude.",
        };
      }
    } finally {
      accepting = false;
      if (timer) clearTimeout(timer);
      input.close();
      if (running && this.queries.delete(running)) running.close();
    }
    if (this.stopped) throw new Error("Claude account reader is stopped.");
    return this.current();
  }

  private current(): ProviderAccountLimits {
    const result = structuredClone(this.snapshot);
    const now = this.now();
    for (const window of result.windows) window.stale = window.stale || result.stale
      || now - window.observedAt > (this.options.staleSeconds ?? 120)
      || (window.resetsAt !== null && window.resetsAt <= now);
    if (result.extraUsage) result.extraUsage.stale = result.extraUsage.stale || result.stale
      || now - result.extraUsage.observedAt > (this.options.staleSeconds ?? 120);
    result.stale ||= result.windows.some(window => window.stale) || Boolean(result.extraUsage?.stale);
    return result;
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const [running, cancel] of this.queries) { cancel(); running.close(); }
    this.queries.clear();
  }
}
