import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import { claudeCredentialScope } from "./authentication.js";

type Options = { now?: () => number; freshMs?: number; maxAgeMs?: number; scope?: () => string };

/**
 * Claude's model list can only be read through a CLI process, so a lookup costs a
 * process start. The list rarely changes: a fresh copy is reused, a stale copy is
 * served while it refreshes in the background, and only a missing or expired copy
 * (or a changed login) waits for the CLI.
 */
export class ClaudeModelCache {
  private entry: { scope: string; models: ModelInfo[]; at: number } | null = null;
  private loading: { scope: string; promise: Promise<ModelInfo[]> } | null = null;
  private readonly now: () => number;
  private readonly freshMs: number;
  private readonly maxAgeMs: number;
  private readonly scope: () => string;
  constructor(options: Options = {}) {
    this.now = options.now ?? Date.now;
    this.freshMs = options.freshMs ?? 10 * 60_000;
    this.maxAgeMs = options.maxAgeMs ?? 24 * 60 * 60_000;
    this.scope = options.scope ?? claudeCredentialScope;
  }

  get(load: () => Promise<ModelInfo[]>): Promise<ModelInfo[]> {
    const scope = this.scope();
    const entry = this.entry?.scope === scope ? this.entry : null;
    const age = entry ? this.now() - entry.at : Infinity;
    if (entry && age < this.freshMs) return Promise.resolve(entry.models);
    const refresh = this.refresh(scope, load);
    if (entry && age < this.maxAgeMs) {
      void refresh.catch(() => { /* Keep serving the previous list; the next lookup retries. */ });
      return Promise.resolve(entry.models);
    }
    return refresh;
  }

  private refresh(scope: string, load: () => Promise<ModelInfo[]>): Promise<ModelInfo[]> {
    if (this.loading?.scope === scope) return this.loading.promise;
    // Clear the in-flight marker before callers see the result, so the next lookup starts fresh.
    const loading: { scope: string; promise: Promise<ModelInfo[]> } = { scope, promise: load().then(models => {
      if (this.scope() === scope) this.entry = { scope, models, at: this.now() };
      return models;
    }).finally(() => { if (this.loading === loading) this.loading = null; }) };
    this.loading = loading;
    return loading.promise;
  }
}
