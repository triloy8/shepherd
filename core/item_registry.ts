import type { ThreadItemType } from "./types.js";

type ItemTypeMeta = {
  label: string;
  accent: string;
  role: "user" | "assistant" | "system";
};

export const ITEM_TYPE_REGISTRY: Record<ThreadItemType, ItemTypeMeta> = {
  userMessage: { label: "User Message", accent: "slate", role: "user" },
  agentMessage: { label: "Agent Message", accent: "indigo", role: "assistant" },
  plan: { label: "Plan", accent: "sky", role: "system" },
  reasoning: { label: "Reasoning", accent: "blue", role: "system" },
  commandExecution: { label: "Command Execution", accent: "red", role: "system" },
  fileChange: { label: "File Change", accent: "teal", role: "system" },
  mcpToolCall: { label: "MCP Tool Call", accent: "amber", role: "system" },
  collabToolCall: { label: "Collab Tool Call", accent: "orange", role: "system" },
  webSearch: { label: "Web Search", accent: "cyan", role: "system" },
  imageView: { label: "Image View", accent: "violet", role: "system" },
  enteredReviewMode: { label: "Entered Review Mode", accent: "purple", role: "system" },
  exitedReviewMode: { label: "Exited Review Mode", accent: "purple", role: "system" },
  contextCompaction: { label: "Context Compaction", accent: "gray", role: "system" },
  unknown: { label: "Unknown Item", accent: "gray", role: "system" },
};

export function normalizeThreadItemType(raw: unknown): ThreadItemType {
  if (typeof raw !== "string") return "unknown";
  const cleaned = raw.replace(/[^a-zA-Z]/g, "").toLowerCase();

  if (cleaned === "usermessage") return "userMessage";
  if (cleaned === "agentmessage") return "agentMessage";
  if (cleaned === "plan") return "plan";
  if (cleaned === "reasoning") return "reasoning";
  if (cleaned === "commandexecution") return "commandExecution";
  if (cleaned === "filechange") return "fileChange";
  if (cleaned === "mcptoolcall") return "mcpToolCall";
  if (cleaned === "collabtoolcall") return "collabToolCall";
  if (cleaned === "websearch") return "webSearch";
  if (cleaned === "imageview") return "imageView";
  if (cleaned === "enteredreviewmode") return "enteredReviewMode";
  if (cleaned === "exitedreviewmode") return "exitedReviewMode";
  if (cleaned === "contextcompaction") return "contextCompaction";
  return "unknown";
}
