import type { ApprovalChoice } from "../../shared/protocol/approvals.js";
import type {
  MessagePhase,
  TurnActivityEvent,
  TurnActivityKind,
  TurnActivityStatus,
} from "../../shared/protocol/events.js";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

export function extractThreadId(result: unknown): string | null {
  const record = asRecord(result);
  return (
    asString(record.threadId) ||
    asString(record.thread_id) ||
    asString(record.id) ||
    asString(asRecord(record.thread).id) ||
    asString(asRecord(record.thread).threadId)
  );
}

export function extractTurnId(result: unknown): string | null {
  const record = asRecord(result);
  return (
    asString(record.turnId) ||
    asString(record.turn_id) ||
    asString(record.id) ||
    asString(asRecord(record.turn).id) ||
    asString(asRecord(record.turn).turnId)
  );
}

export function extractTextDelta(method: string, params: unknown): string {
  const lower = method.toLowerCase();
  if (!lower.includes("delta")) {
    return "";
  }

  const record = asRecord(params);
  const msg = asRecord(record.msg);
  const candidates = [
    record.delta,
    record.text,
    record.chunk,
    record.outputDelta,
    record.textDelta,
    msg.delta,
    msg.text,
    msg.chunk,
    msg.outputDelta,
    msg.textDelta,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.length > 0) {
      return candidate;
    }
  }
  return "";
}

export function extractItemId(params: unknown): string | null {
  const record = asRecord(params);
  const item = asRecord(record.item);
  const msg = asRecord(record.msg);
  return (
    asString(record.itemId) ||
    asString(record.item_id) ||
    asString(item.id) ||
    asString(msg.itemId) ||
    asString(msg.item_id)
  );
}

export type CompletedAgentMessage = {
  itemId: string;
  phase: MessagePhase | null;
  text: string;
  turnId: string | null;
};

export type GeneratedImageArtifact = {
  itemId: string;
  turnId: string | null;
  path: string;
  revisedPrompt: string | null;
};

export function extractCompletedAgentMessage(params: unknown): CompletedAgentMessage | null {
  const record = asRecord(params);
  const item = asRecord(record.item);
  if (asString(item.type)?.toLowerCase() !== "agentmessage") {
    return null;
  }

  const itemId = asString(item.id);
  if (!itemId) return null;

  const rawPhase = asString(item.phase);
  const phase = rawPhase === "commentary" || rawPhase === "final_answer" ? rawPhase : null;
  return {
    itemId,
    phase,
    text: typeof item.text === "string" ? item.text : "",
    turnId: extractTurnId(params),
  };
}

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
      return activityResult(params, item, status, "mcp_tool", "Calling MCP tool", detail || null);
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

export function mapApprovalChoices(method: string): ApprovalChoice[] {
  const normalized = method.toLowerCase();

  if (normalized === "item/commandexecution/requestapproval" || normalized === "item/filechange/requestapproval") {
    return [
      { value: "accept", label: "Allow Once" },
      { value: "acceptForSession", label: "Allow Session" },
      { value: "decline", label: "Deny" },
      { value: "cancel", label: "Cancel" },
    ];
  }

  if (normalized === "execcommandapproval" || normalized === "applypatchapproval") {
    return [
      { value: "approved", label: "Approve Once" },
      { value: "approved_for_session", label: "Approve Session" },
      { value: "denied", label: "Deny" },
      { value: "abort", label: "Abort" },
    ];
  }

  return [];
}

export function mapApprovalPrompt(method: string, params: unknown): string {
  const record = asRecord(params);
  const reason = asString(record.reason);
  if (reason) return reason;

  if (method === "item/commandExecution/requestApproval") {
    const command = asString(record.command);
    return command ? `Command approval requested: ${command}` : "Command approval requested";
  }

  if (method === "item/fileChange/requestApproval") {
    return "File change approval requested";
  }

  return `${method} requires a decision`;
}
