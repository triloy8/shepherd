import type {
  ApprovalDecisionApiRequest,
  ApprovalPolicy,
  CreateThreadRequest,
  ForkThreadRequest,
  ListLoadedThreadsRequest,
  ListStoredThreadsRequest,
  ReadThreadRequest,
  ResumeThreadRequest,
  RollbackThreadRequest,
  SetThreadNameRequest,
  InterruptTurnRequest,
  ThreadSortKey,
  ThreadSourceKind,
  SubmitTurnRequest,
} from "./requests.js";

const APPROVAL_POLICIES: ApprovalPolicy[] = ["untrusted", "on-failure", "on-request", "never"];
const THREAD_SORT_KEYS: ThreadSortKey[] = ["created_at", "updated_at"];
const THREAD_SOURCE_KINDS: ThreadSourceKind[] = [
  "cli",
  "vscode",
  "exec",
  "appServer",
  "subAgent",
  "subAgentReview",
  "subAgentCompact",
  "subAgentThreadSpawn",
  "subAgentOther",
  "unknown",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

export function validateCreateThreadRequest(value: unknown): CreateThreadRequest {
  if (!isRecord(value) || typeof value.approvalPolicy !== "string") {
    throw new Error("Invalid create thread payload.");
  }
  if (!APPROVAL_POLICIES.includes(value.approvalPolicy as ApprovalPolicy)) {
    throw new Error("Invalid approval policy.");
  }
  return { approvalPolicy: value.approvalPolicy as ApprovalPolicy };
}

function parseOptionalPositiveInteger(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid ${name}.`);
  }
  return parsed;
}

function parseOptionalBoolean(value: unknown, name: string): boolean | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value === "true") return true;
    if (value === "false") return false;
  }
  throw new Error(`Invalid ${name}.`);
}

function parseOptionalString(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new Error(`Invalid ${name}.`);
  return value.trim();
}

function parseOptionalStringList(value: unknown, name: string): string[] | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (Array.isArray(value)) {
    const all = value.map((entry) => {
      if (typeof entry !== "string") throw new Error(`Invalid ${name}.`);
      return entry.trim();
    });
    return all;
  }
  if (typeof value === "string") {
    return value
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  throw new Error(`Invalid ${name}.`);
}

export function validateListStoredThreadsRequest(value: unknown): ListStoredThreadsRequest {
  if (!isRecord(value)) throw new Error("Invalid list threads payload.");

  const sortKey = parseOptionalString(value.sortKey, "sortKey");
  if (sortKey && !THREAD_SORT_KEYS.includes(sortKey as ThreadSortKey)) {
    throw new Error("Invalid sort key.");
  }

  const sourceKinds = parseOptionalStringList(value.sourceKinds, "sourceKinds");
  if (sourceKinds && sourceKinds.some((kind) => !THREAD_SOURCE_KINDS.includes(kind as ThreadSourceKind))) {
    throw new Error("Invalid source kind.");
  }

  return {
    archived: parseOptionalBoolean(value.archived, "archived"),
    cursor: parseOptionalString(value.cursor, "cursor"),
    cwd: parseOptionalString(value.cwd, "cwd"),
    limit: parseOptionalPositiveInteger(value.limit, "limit"),
    modelProviders: parseOptionalStringList(value.modelProviders, "modelProviders"),
    searchTerm: parseOptionalString(value.searchTerm, "searchTerm"),
    sortKey: sortKey as ThreadSortKey | undefined,
    sourceKinds: sourceKinds as ThreadSourceKind[] | undefined,
  };
}

export function validateListLoadedThreadsRequest(value: unknown): ListLoadedThreadsRequest {
  if (!isRecord(value)) throw new Error("Invalid list loaded threads payload.");
  return {
    cursor: parseOptionalString(value.cursor, "cursor"),
    limit: parseOptionalPositiveInteger(value.limit, "limit"),
  };
}

export function validateReadThreadRequest(value: unknown): ReadThreadRequest {
  if (!isRecord(value)) throw new Error("Invalid read thread payload.");
  return {
    includeTurns: parseOptionalBoolean(value.includeTurns, "includeTurns"),
  };
}

function parseApprovalPolicy(value: unknown): ApprovalPolicy | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !APPROVAL_POLICIES.includes(value as ApprovalPolicy)) {
    throw new Error("Invalid approval policy.");
  }
  return value as ApprovalPolicy;
}

export function validateResumeThreadRequest(value: unknown): ResumeThreadRequest {
  if (!isRecord(value)) throw new Error("Invalid resume payload.");
  return {
    approvalPolicy: parseApprovalPolicy(value.approvalPolicy),
  };
}

export function validateForkThreadRequest(value: unknown): ForkThreadRequest {
  if (!isRecord(value)) throw new Error("Invalid fork payload.");
  return {
    approvalPolicy: parseApprovalPolicy(value.approvalPolicy),
  };
}

export function validateSetThreadNameRequest(value: unknown): SetThreadNameRequest {
  if (!isRecord(value) || typeof value.name !== "string" || !value.name.trim()) {
    throw new Error("Invalid thread name.");
  }
  return { name: value.name.trim() };
}

export function validateRollbackThreadRequest(value: unknown): RollbackThreadRequest {
  if (!isRecord(value)) throw new Error("Invalid rollback payload.");
  const numTurns = parseOptionalPositiveInteger(value.numTurns, "numTurns");
  if (!numTurns || numTurns < 1) {
    throw new Error("numTurns must be >= 1.");
  }
  return { numTurns };
}

export function validateSubmitTurnRequest(value: unknown): SubmitTurnRequest {
  if (!isRecord(value) || typeof value.input !== "string" || !value.input.trim()) {
    throw new Error("Invalid turn payload.");
  }
  if (value.approvalPolicy && !APPROVAL_POLICIES.includes(value.approvalPolicy as ApprovalPolicy)) {
    throw new Error("Invalid approval policy.");
  }
  return {
    input: value.input.trim(),
    approvalPolicy: value.approvalPolicy as ApprovalPolicy | undefined,
  };
}

export function validateInterruptTurnRequest(value: unknown): InterruptTurnRequest {
  if (!isRecord(value)) {
    return {};
  }
  if (value.turnId !== undefined && typeof value.turnId !== "string") {
    throw new Error("Invalid turn id.");
  }
  return { turnId: value.turnId as string | undefined };
}

export function validateApprovalDecisionRequest(value: unknown): ApprovalDecisionApiRequest {
  if (!isRecord(value) || typeof value.decision !== "string" || !value.decision.trim()) {
    throw new Error("Invalid approval decision payload.");
  }
  if (value.reason !== undefined && typeof value.reason !== "string") {
    throw new Error("Invalid approval decision reason.");
  }
  return {
    decision: value.decision.trim(),
    reason: typeof value.reason === "string" ? value.reason.trim() : undefined,
  };
}
