import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Ownership comes from Codex records, never from an ID prefix or a default-provider guess. */
export function codexOwnsStoredThread(id: string, directory = process.env.CODEX_HOME ?? join(homedir(), ".codex")): boolean {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return false;
  try {
    for (const line of readFileSync(join(directory, "session_index.jsonl"), "utf8").split("\n")) {
      if (!line.trim()) continue;
      try { if (JSON.parse(line).id === id) return true; } catch { /* An interrupted index write is not authoritative. */ }
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  for (const folder of ["sessions", "archived_sessions"]) {
    try {
      if (readdirSync(join(directory, folder), { recursive: true }).some(file => typeof file === "string" && file.endsWith(`-${id}.jsonl`))) return true;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  return false;
}
