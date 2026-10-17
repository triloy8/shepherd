import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, linkSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { AgentProvider } from "../../shared/protocol/requests.js";
import type { ThreadProviderDirectory } from "../ports/provider_services.js";

function identity(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.trim() === value; }

/** One atomic file per immutable binding. Unbound stored records are identified by registered adapters. */
export class FileThreadProviderDirectory implements ThreadProviderDirectory {
  constructor(private readonly directory: string, private readonly discoverOwner?: (id: string) => AgentProvider | undefined) {}
  private file(id: string) { if (!identity(id)) throw new Error("Invalid thread identity."); return join(this.directory, `${createHash("sha256").update(id).digest("hex")}.json`); }
  private read(id: string): AgentProvider | undefined {
    try {
      const value = JSON.parse(readFileSync(this.file(id), "utf8"));
      if (!value || value.threadId !== id || !identity(value.provider)) throw new Error("Invalid thread provider binding.");
      return value.provider;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; return undefined; }
  }
  resolve(id: string): AgentProvider {
    const persisted = this.read(id);
    if (persisted) return persisted;
    const owner = this.discoverOwner?.(id);
    if (!owner) throw new Error("Thread ownership is unknown; refresh the conversation list or select a stored provider conversation.");
    this.bind(id, owner);
    return this.read(id)!;
  }
  bind(id: string, provider: AgentProvider): void {
    if (!identity(provider)) throw new Error("Invalid provider identity.");
    const existing = this.read(id);
    if (existing) {
      if (existing !== provider) throw new Error("Cannot change the provider of an existing thread.");
      return;
    }
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
