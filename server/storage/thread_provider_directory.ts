import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, linkSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { AgentProvider } from "../../shared/protocol/requests.js";
import type { ThreadProviderDirectory } from "../core/agent_provider.js";

/** One atomic file per binding avoids lost updates between Shepherd processes. */
export class FileThreadProviderDirectory implements ThreadProviderDirectory {
  constructor(private readonly directory: string, private readonly legacyResolve: (id: string) => AgentProvider) {}
  private file(id: string) { return join(this.directory, `${createHash("sha256").update(id).digest("hex")}.json`); }
  resolve(id: string): AgentProvider {
    try {
      const value = JSON.parse(readFileSync(this.file(id), "utf8"));
      if (value.threadId !== id || !["codex", "claude"].includes(value.provider)) throw new Error("Invalid thread provider binding.");
      return value.provider;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return this.legacyResolve(id);
    }
  }
  bind(id: string, provider: AgentProvider): void {
    // Persisted bindings cannot be reassigned. Legacy resolution is only a fallback.
    try {
      const existing = JSON.parse(readFileSync(this.file(id), "utf8"));
      if (existing.threadId !== id || existing.provider !== provider) throw new Error("Cannot change the provider of an existing thread.");
      return;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.file(id)}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify({ threadId: id, provider }), { mode: 0o600 });
      try { linkSync(temporary, this.file(id)); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        this.bind(id, provider);
      }
    } finally { rmSync(temporary, { force: true }); }
  }
}
