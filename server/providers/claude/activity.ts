import type { Activity } from "../../../shared/protocol/activity.js";

const fileTools = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);
const agentTools = new Set(["Agent", "Task"]);
const mcpResourceTools = new Set(["ListMcpResourcesTool", "ReadMcpResourceTool", "ReadMcpResourceDirTool"]);
const maxFieldChars = 8_000;

/** Tool arguments an activity is described from. Only these are kept, bounded; the rest of a
 * native tool input never leaves the adapter or reaches a saved snapshot. */
const activityFields = ["command", "file_path", "notebook_path", "path", "pattern", "query", "url", "description", "server", "uri"] as const;
export type ClaudeActivityFields = Partial<Record<typeof activityFields[number], string>>;

export function claudeActivityFields(input: unknown): ClaudeActivityFields {
  const record = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const fields: ClaudeActivityFields = {};
  for (const key of activityFields) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) fields[key] = value.length > maxFieldChars ? `${value.slice(0, maxFieldChars)}…` : value;
  }
  return fields;
}

/** Classify a Claude Code tool call. Shepherd's own tools arrive through its in-process MCP
 * server `shepherd`, whose tool names join a namespace and tool with `__`. */
export function claudeActivity(tool: string, fields: ClaudeActivityFields): Activity {
  if (tool === "Bash") return { kind: "command", command: fields.command ?? null, cwd: null };
  if (fileTools.has(tool)) {
    const path = fields.file_path ?? fields.notebook_path;
    return { kind: "file_change", paths: path ? [path] : [] };
  }
  if (tool === "WebSearch") return { kind: "web", query: fields.query ?? null, url: null };
  if (tool === "WebFetch") return { kind: "web", query: null, url: fields.url ?? null };
  if (agentTools.has(tool)) return { kind: "delegation", description: fields.description ?? null };
  if (tool.startsWith("mcp__shepherd__")) {
    const [namespace, name] = tool.slice("mcp__shepherd__".length).split(/__(.*)/s);
    return name ? { kind: "tool", source: "application", server: namespace!, name, target: null } : { kind: "tool", source: "application", server: null, name: namespace!, target: null };
  }
  if (tool.startsWith("mcp__")) {
    const [server, name] = tool.slice("mcp__".length).split(/__(.*)/s);
    return { kind: "tool", source: "mcp", server: name ? server! : null, name: name || server!, target: null };
  }
  if (mcpResourceTools.has(tool)) return { kind: "tool", source: "mcp", server: fields.server ?? null, name: tool, target: fields.uri ?? null };
  return { kind: "tool", source: "builtin", server: null, name: tool, target: fields.file_path ?? fields.notebook_path ?? fields.path ?? fields.pattern ?? fields.query ?? fields.url ?? fields.description ?? null };
}
