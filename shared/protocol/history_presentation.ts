import type { TurnActivityEvent, TurnActivityKind, TurnActivityStatus } from "./events.js";

function asRecord(value: unknown): Record<string, unknown> { return value && typeof value === "object" ? value as Record<string, unknown> : {}; }
function asString(value: unknown): string | null { return typeof value === "string" && value.trim() ? value : null; }
function extractTurnId(value: unknown): string | null { const record = asRecord(value); return asString(record.turnId) ?? asString(asRecord(record.turn).id); }

export type GeneratedImageArtifact = {
  itemId: string;
  turnId: string | null;
  path: string;
  revisedPrompt: string | null;
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
    revisedPrompt: asString(item.revisedPrompt),
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

function activityResult(
  params: unknown,
  item: Record<string, unknown>,
  status: TurnActivityStatus,
  kind: TurnActivityKind,
  label: string,
  detail: string | null,
): NormalizedTurnActivity {
  return {
    itemId: asString(item.id),
    turnId: extractTurnId(params),
    kind,
    label,
    detail,
    status,
  };
}

function activityStatus(item: Record<string, unknown>, lifecycle: "started" | "completed"): TurnActivityStatus {
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

function summarizeFileChanges(item: Record<string, unknown>): string | null {
  if (!Array.isArray(item.changes)) return null;
  const paths = item.changes
    .map((change) => asString(asRecord(change).path))
    .filter((path): path is string => Boolean(path));
  if (paths.length === 0) return null;
  const visible = paths.slice(0, 3);
  const suffix = paths.length > visible.length ? ` +${paths.length - visible.length} more` : "";
  return `${visible.join(", ")}${suffix}`;
}

export function mapTurnActivity(
  params: unknown,
  lifecycle: "started" | "completed",
): NormalizedTurnActivity | null {
  const record = asRecord(params);
  const item = asRecord(record.item);
  const type = asString(item.type);
  if (!type) return null;
  const status = activityStatus(item, lifecycle);

  switch (type) {
    case "commandExecution":
      return activityResult(params, item, status, "command", "Running command", asString(item.command));
    case "fileChange":
      return activityResult(params, item, status, "file_change", "Changing files", summarizeFileChanges(item));
    case "mcpToolCall": {
      const server = asString(item.server);
      const tool = asString(item.tool);
      const detail = [server, tool].filter(Boolean).join(".");
      const kind = item.activityKind === "command" || item.activityKind === "file_change" ? item.activityKind : "mcp_tool";
      return activityResult(params, item, status, kind, kind === "command" ? "Running command" : kind === "file_change" ? "Changing files" : "Calling MCP tool", detail || null);
    }
    case "dynamicToolCall": {
      const namespace = asString(item.namespace);
      const tool = asString(item.tool);
      const detail = [namespace, tool].filter(Boolean).join(".");
      return activityResult(params, item, status, "dynamic_tool", "Calling tool", detail || null);
    }
    case "webSearch":
      return activityResult(params, item, status, "web_search", "Searching the web", asString(item.query));
    case "collabAgentToolCall":
      return activityResult(params, item, status, "collaboration", "Coordinating agents", asString(item.tool));
    case "subAgentActivity":
      return activityResult(params, item, status, "collaboration", "Agent activity", asString(item.kind));
    case "imageView":
      return activityResult(params, item, status, "image", "Viewing image", asString(item.path));
    case "imageGeneration":
      return activityResult(params, item, status, "image", "Generating image", asString(item.revisedPrompt));
    case "sleep": {
      const durationMs = typeof item.durationMs === "number" ? item.durationMs : null;
      return activityResult(
        params,
        item,
        status,
        "wait",
        "Waiting",
        durationMs === null ? null : `${durationMs} ms`,
      );
    }
    case "enteredReviewMode":
      return activityResult(params, item, status, "other", "Entering review mode", null);
    case "exitedReviewMode":
      return activityResult(params, item, status, "other", "Leaving review mode", null);
    case "contextCompaction":
      return activityResult(params, item, status, "other", "Compacting context", null);
    default:
      return null;
  }
}
