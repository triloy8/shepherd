import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isClaudeEffort, type ClaudeThread, type ClaudeThreadRepository, type ClaudeThreadSummary } from "./thread_store.js";

const threadFile = /^(claude-[0-9a-f-]{36})\.json$/;

/** Shepherd metadata complements the SDK's persisted conversation transcript. */
export class ClaudeThreadStore implements ClaudeThreadRepository {
  constructor(
    private readonly directory = process.env.SHEPHERD_CLAUDE_STATE_DIR ?? join(homedir(), ".shepherd", "claude"),
    private readonly warn: (message: string) => void = message => console.warn(message),
  ) {}
  read(id: string): ClaudeThread {
    if (!/^claude-[0-9a-f-]{36}$/.test(id)) throw new Error("Invalid Claude thread id.");
    const value = JSON.parse(readFileSync(join(this.directory, `${id}.json`), "utf8")) as ClaudeThread;
    validateSnapshot(value, id);
    return value;
  }
  write(thread: ClaudeThread): void {
    validateSnapshot(thread, thread.id);
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    this.atomicWrite(join(this.directory, `${thread.id}.json`), thread);
    // Written second: a crash in between leaves at most a stale listing row.
    this.atomicWrite(join(this.directory, `${thread.id}.meta.json`), summary(thread));
  }
  /** Lists summaries only. Invalid snapshots are skipped so one file cannot hide every conversation. */
  list(): ClaudeThreadSummary[] {
    const rows: ClaudeThreadSummary[] = [];
    for (const id of this.ids()) {
      try { rows.push(this.readSummary(id)); }
      catch (error) { this.warn(`Skipping unreadable Claude thread ${id}: ${error instanceof Error ? error.message : String(error)}`); }
    }
    return rows;
  }
  hasThreads(): boolean { return this.ids().length > 0; }
  private ids(): string[] {
    let files: string[];
    try { files = readdirSync(this.directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    return files.flatMap(file => threadFile.exec(file)?.[1] ?? []);
  }
  private readSummary(id: string): ClaudeThreadSummary {
    try {
      const value = JSON.parse(readFileSync(join(this.directory, `${id}.meta.json`), "utf8")) as ClaudeThreadSummary;
      validateSummary(value, id);
      return value;
    } catch (error) {
      if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof InvalidSnapshotError)) throw error;
    }
    // Snapshots written before summaries existed, or an interrupted summary write.
    const thread = this.read(id);
    const row = summary(thread);
    try { this.atomicWrite(join(this.directory, `${id}.meta.json`), row); } catch { /* Listing still succeeds without the cache. */ }
    return row;
  }
  private atomicWrite(file: string, value: unknown): void {
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
      renameSync(temporary, file);
    } finally { rmSync(temporary, { force: true }); }
  }
}

class InvalidSnapshotError extends Error {
  constructor() { super("Invalid Claude thread metadata."); }
}

function summary(thread: ClaudeThread): ClaudeThreadSummary {
  const { turns: _turns, tokenUsage: _tokenUsage, ...row } = thread;
  return row;
}

function validateSummary(value: ClaudeThreadSummary, id: string): void {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  if (!value || value.id !== id || !id.startsWith("claude-") || !uuid.test(id.slice(7)) || !uuid.test(value.nativeId) ||
      typeof value.materialized !== "boolean" || typeof value.archived !== "boolean" ||
      typeof value.cwd !== "string" || !value.cwd || typeof value.model !== "string" || !value.model ||
      (value.name !== null && typeof value.name !== "string") || typeof value.preview !== "string" || typeof value.instructions !== "string" ||
      !Number.isFinite(value.createdAt) || !Number.isFinite(value.updatedAt) ||
      (value.effort !== undefined && !isClaudeEffort(value.effort)) ||
      (value.approvalMode !== undefined && !["provider_default", "review_sensitive", "bypass"].includes(value.approvalMode))) {
    throw new InvalidSnapshotError();
  }
}

function validateSnapshot(value: ClaudeThread, id: string): void {
  validateSummary(value, id);
  if (!Array.isArray(value.turns) || value.turns.some(turn => !turn || typeof turn.id !== "string" || !["completed", "interrupted", "failed", "inProgress"].includes(turn.status) || !Array.isArray(turn.items) || turn.items.some(item => !item || typeof item.id !== "string" || typeof item.type !== "string"))) {
    throw new InvalidSnapshotError();
  }
}
