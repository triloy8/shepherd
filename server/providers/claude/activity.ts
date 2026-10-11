import type { TurnActivityKind } from "../../../shared/protocol/events.js";

const fileTools = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);
const webTools = new Set(["WebSearch", "WebFetch"]);
const agentTools = new Set(["Agent", "Task"]);
const mcpResourceTools = new Set(["ListMcpResourcesTool", "ReadMcpResourceTool", "ReadMcpResourceDirTool"]);

/** Classify a Claude Code tool call. Shepherd's own tools arrive through its in-process MCP server. */
export function claudeActivityKind(tool: string): TurnActivityKind {
  if (tool === "Bash") return "command";
  if (fileTools.has(tool)) return "file_change";
  if (webTools.has(tool)) return "web_search";
  if (agentTools.has(tool)) return "collaboration";
  if (tool.startsWith("mcp__shepherd__")) return "dynamic_tool";
  if (tool.startsWith("mcp__") || mcpResourceTools.has(tool)) return "mcp_tool";
  return "other";
}
