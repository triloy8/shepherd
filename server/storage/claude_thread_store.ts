import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ClaudeThread, ClaudeThreadRepository } from "../ports/claude_thread_store.js";

/** Shepherd metadata complements the SDK's persisted conversation transcript. */
export class ClaudeThreadStore implements ClaudeThreadRepository {
  constructor(private readonly directory = process.env.SHEPHERD_CLAUDE_STATE_DIR ?? join(homedir(), ".shepherd", "claude")) {}
  read(id: string): ClaudeThread {
    if (!/^claude-[0-9a-f-]{36}$/.test(id)) throw new Error("Invalid Claude thread id.");
    const value = JSON.parse(readFileSync(join(this.directory, `${id}.json`), "utf8")) as ClaudeThread;
    validateSnapshot(value, id);
    return value;
  }
  write(thread: ClaudeThread): void {
    validateSnapshot(thread, thread.id);
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const file = join(this.directory, `${thread.id}.json`);
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(thread), { mode: 0o600 });
      renameSync(temporary, file);
    } finally { rmSync(temporary, { force: true }); }
  }
  list(): ClaudeThread[] {
    let files: string[];
    try { files = readdirSync(this.directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    return files.filter((file) => /^claude-[0-9a-f-]{36}\.json$/.test(file)).map((file) => this.read(file.slice(0, -5)));
  }
}


function validateSnapshot(value: ClaudeThread, id: string): void {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  if (!value || value.id !== id || !id.startsWith("claude-") || !uuid.test(id.slice(7)) || !uuid.test(value.nativeId) ||
      typeof value.materialized !== "boolean" || typeof value.archived !== "boolean" ||
      typeof value.cwd !== "string" || !value.cwd || typeof value.model !== "string" || !value.model ||
      (value.name !== null && typeof value.name !== "string") || typeof value.preview !== "string" || typeof value.instructions !== "string" ||
      !Number.isFinite(value.createdAt) || !Number.isFinite(value.updatedAt) ||
      (value.effort !== undefined && !["low", "medium", "high", "xhigh", "max"].includes(value.effort)) ||
      !Array.isArray(value.turns) || value.turns.some(turn => !turn || typeof turn.id !== "string" || !["completed", "interrupted", "failed", "inProgress"].includes(turn.status) || !Array.isArray(turn.items) || turn.items.some(item => !item || typeof item.id !== "string" || typeof item.type !== "string"))) {
    throw new Error("Invalid Claude thread metadata.");
  }
}
