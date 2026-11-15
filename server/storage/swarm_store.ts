import { mkdirSync, readFileSync, readdirSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { isSwarmGroup, type SwarmGroup } from "../../shared/protocol/swarm.js";
import type { SwarmStore } from "../ports/swarm_store.js";

/** Atomic snapshots for one host process. This directory is not the skill helper's manifests. */
export class FileSwarmStore implements SwarmStore {
  constructor(private readonly directory: string) {}
  private file(id: string) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new Error("Invalid swarm identity.");
    return join(this.directory, `${id}.json`);
  }
  list(): SwarmGroup[] {
    let files: string[];
    try { files = readdirSync(this.directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    return files.filter(f => /^[A-Za-z0-9_-]{1,64}\.json$/.test(f)).map(f => this.read(f.slice(0, -5))!)
      .filter(Boolean).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  read(id: string): SwarmGroup | null {
    try {
      const record: unknown = JSON.parse(readFileSync(this.file(id), "utf8"));
      if (!isSwarmGroup(record) || record.id !== id) throw new Error("Invalid swarm record.");
      return record;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  }
  save(group: SwarmGroup, expectedRevision: number | null): void {
    if (!isSwarmGroup(group)) throw new Error("Invalid swarm record.");
    if ((this.read(group.id)?.revision ?? null) !== expectedRevision) throw new Error("Swarm storage revision conflict.");
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.file(group.id)}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify(group, null, 2)}\n`, { mode: 0o600, flag: "wx" });
      renameSync(temporary, this.file(group.id));
    } finally {
      try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
  }
}
