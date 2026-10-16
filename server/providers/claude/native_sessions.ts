import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { forkSession, getSessionInfo, getSessionMessages, getSubagentMessages, listSessions, listSubagents, query, renameSession, tagSession } from "@anthropic-ai/claude-agent-sdk";

/** The Claude Agent SDK operations this adapter uses. Claude's sessions are the record. */
export const claudeNative = { query, forkSession, listSessions, getSessionInfo, getSessionMessages, listSubagents, getSubagentMessages, renameSession, tagSession };
export type ClaudeNative = typeof claudeNative;

/** Archived conversations carry this session tag. A session has one tag, so archiving replaces any other. */
export const archivedTag = "archived";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function projectDirectories(configDirectory: string): string[] {
  try { return readdirSync(join(configDirectory, "projects")).map(name => join(configDirectory, "projects", name)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}

/* Thread ownership is resolved synchronously, and the SDK only reads sessions asynchronously, so
 * these checks look for the session file where Claude Code keeps it. They answer only whether a
 * session exists; its content is always read through the SDK. */
const configDirectory = () => process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");

export function claudeSessionExists(id: string, directory = configDirectory()): boolean {
  return uuid.test(id) && projectDirectories(directory).some(project => existsSync(join(project, `${id}.jsonl`)));
}

export function claudeHasSessions(directory = configDirectory()): boolean {
  return projectDirectories(directory).some(project => { try { return readdirSync(project).some(file => file.endsWith(".jsonl")); } catch { return false; } });
}
