import type { TurnActivityEvent } from "../../../shared/protocol/events.js";
import type { Activity, ActivityStatus } from "../../../shared/protocol/activity.js";

function asRecord(value: unknown): Record<string, unknown> { return value && typeof value === "object" ? value as Record<string, unknown> : {}; }
function asString(value: unknown): string | null { return typeof value === "string" && value.trim() ? value : null; }
function extractTurnId(value: unknown): string | null { const record = asRecord(value); return asString(record.turnId) ?? asString(asRecord(record.turn).id); }

export type GeneratedImageArtifact = {
  itemId: string;
  turnId: string | null;
  path: string;
  prompt: string | null;
};
export type ViewedImageArtifact = Pick<GeneratedImageArtifact, "itemId" | "turnId" | "path">;

export function extractGeneratedImageArtifact(params: unknown): GeneratedImageArtifact | null {
  const record = asRecord(params);
  const item = asRecord(record.item);
  if (asString(item.type) !== "imageGeneration") {
    return null;
  }

  const status = asString(item.status)?.toLowerCase() ?? "";
  if (
    status.includes("fail") ||
    status.includes("error") ||
    status.includes("cancel")
  ) {
    return null;
  }

  const itemId = asString(item.id);
  const savedPath = asString(item.savedPath);
  if (!itemId || !savedPath) return null;

  return {
    itemId,
    turnId: extractTurnId(params),
    path: savedPath,
    prompt: asString(item.revisedPrompt),
  };
}

export function extractViewedImageArtifact(params: unknown): ViewedImageArtifact | null {
  const record = asRecord(params);
  const item = asRecord(record.item);
  if (item.type !== "imageView") return null;
  // imageView normally has no status. Do not expose unfinished or failed history items.
  const status = asString(item.status)?.toLowerCase() ?? "";
  if (status && status !== "completed" && status !== "success") return null;
  const itemId = asString(item.id);
  const path = asString(item.path);
  if (!itemId || !path) return null;
  return { itemId, turnId: extractTurnId(params), path };
}

export type NormalizedTurnActivity = TurnActivityEvent["payload"];

function activityStatus(item: Record<string, unknown>, lifecycle: "started" | "completed"): ActivityStatus {
  if (lifecycle === "started") return "started";
  const status = asString(item.status)?.toLowerCase() ?? "";
  const success = item.success;
  if (
    success === false ||
    status.includes("fail") ||
    status.includes("error") ||
    status.includes("declin") ||
    status.includes("cancel")
  ) {
    return "failed";
  }
  return "completed";
}

function changedPaths(changes: unknown): string[] {
  if (Array.isArray(changes)) return changes.map((change) => asString(asRecord(change).path)).filter((path): path is string => Boolean(path));
  // Legacy patch approvals key their changes by path.
  return Object.keys(asRecord(changes));
}

/** A Codex command arrives as a shell string or, from legacy approvals, an argument list. */
function commandText(value: unknown): string | null {
  if (Array.isArray(value)) return value.every((part) => typeof part === "string") && value.length ? value.join(" ") : null;
  return asString(value);
}

/** Classify a native Codex thread item. */
export function codexActivity(item: Record<string, unknown>): Activity | null {
  switch (asString(item.type)) {
    case "commandExecution": return { kind: "command", command: commandText(item.command), cwd: asString(item.cwd) };
    case "fileChange": return { kind: "file_change", paths: changedPaths(item.changes) };
    case "mcpToolCall": return { kind: "tool", source: "mcp", server: asString(item.server), name: asString(item.tool) ?? "tool", target: null };
    case "dynamicToolCall": return { kind: "tool", source: "application", server: asString(item.namespace), name: asString(item.tool) ?? "tool", target: null };
    case "webSearch": return { kind: "web", query: asString(item.query), url: null };
    case "collabAgentToolCall": return { kind: "delegation", description: asString(item.tool) };
    case "subAgentActivity": return { kind: "delegation", description: asString(item.kind) };
    case "imageView": return { kind: "image", action: "view", path: asString(item.path), prompt: null };
    case "imageGeneration": return { kind: "image", action: "generate", path: asString(item.savedPath), prompt: asString(item.revisedPrompt) };
    case "sleep": return { kind: "wait", durationMs: typeof item.durationMs === "number" ? item.durationMs : null };
    case "enteredReviewMode": return { kind: "other", title: "Entering review mode", detail: null };
    case "exitedReviewMode": return { kind: "other", title: "Leaving review mode", detail: null };
    case "contextCompaction": return { kind: "other", title: "Compacting context", detail: null };
    default: return null;
  }
}

/** The activity a Codex approval request would allow. */
export function codexApprovalActivity(method: string, params: unknown): Activity {
  const record = asRecord(params);
  switch (method) {
    case "item/commandExecution/requestApproval":
    case "execCommandApproval":
      return { kind: "command", command: commandText(record.command), cwd: asString(record.cwd) };
    case "item/fileChange/requestApproval": {
      const paths = changedPaths(record.changes);
      const root = asString(record.grantRoot);
      return { kind: "file_change", paths: paths.length ? paths : root ? [root] : [] };
    }
    case "applyPatchApproval": return { kind: "file_change", paths: changedPaths(record.fileChanges) };
    default: return { kind: "other", title: "Continue", detail: null };
  }
}

export function mapTurnActivity(
  params: unknown,
  lifecycle: "started" | "completed",
): NormalizedTurnActivity | null {
  const item = asRecord(asRecord(params).item);
  const activity = codexActivity(item);
  if (!activity) return null;
  return { itemId: asString(item.id), turnId: extractTurnId(params), status: activityStatus(item, lifecycle), activity };
}
