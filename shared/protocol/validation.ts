import type {
  ApprovalDecisionApiRequest,
  ApprovalPolicy,
  CreateThreadRequest,
  ForkThreadRequest,
  ListLoadedThreadsRequest,
  ListStoredThreadsRequest,
  Personality,
  ReadThreadRequest,
  ResumeThreadRequest,
  RollbackThreadRequest,
  SandboxMode,
  SortDirection,
  SteerTurnRequest,
  SetThreadNameRequest,
  SkillsConfigWriteRequest,
  SkillsListRequest,
  InterruptTurnRequest,
  ThreadSortKey,
  ThreadSourceKind,
  SubmitTurnRequest,
} from "./requests.js";
import { toTextUserInput, type UserInput, type UserInputTextElement } from "./user_input.js";

const APPROVAL_POLICIES = ["untrusted", "on-request", "never"] as const;
const SANDBOX_MODES: SandboxMode[] = ["read-only", "workspace-write", "danger-full-access"];
const PERSONALITIES: Personality[] = ["none", "friendly", "pragmatic"];
const THREAD_SORT_KEYS: ThreadSortKey[] = ["created_at", "updated_at", "recency_at"];
const SORT_DIRECTIONS: SortDirection[] = ["asc", "desc"];
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
  if (!isRecord(value)) {
    throw new Error("Invalid create thread payload.");
  }
  const overrides = parseCommonThreadOverrides(value);
  const cwd = parseOptionalString(value.cwd, "cwd");
  return {
    approvalPolicy: parseApprovalPolicy(value.approvalPolicy) ?? "on-request",
    ...overrides,
    ...(cwd ? { cwd } : {}),
    personality: parseOptionalEnum(value.personality, "personality", PERSONALITIES),
    ephemeral: parseOptionalBoolean(value.ephemeral, "ephemeral"),
    serviceName: parseOptionalString(value.serviceName, "serviceName"),
  };
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

function parseOptionalObject(value: unknown, name: string): Record<string, unknown> | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (!isRecord(value)) throw new Error(`Invalid ${name}.`);
  return value;
}

function parseOptionalEnum<T extends string>(
  value: unknown,
  name: string,
  allowed: readonly T[],
): T | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new Error(`Invalid ${name}.`);
  }
  return value as T;
}

function parseCommonThreadOverrides(value: Record<string, unknown>) {
  return {
    baseInstructions: parseOptionalString(value.baseInstructions, "baseInstructions"),
    developerInstructions: parseOptionalString(value.developerInstructions, "developerInstructions"),
    config: parseOptionalObject(value.config, "config"),
    sandbox: parseOptionalEnum(value.sandbox, "sandbox", SANDBOX_MODES),
    model: parseOptionalString(value.model, "model"),
    modelProvider: parseOptionalString(value.modelProvider, "modelProvider"),
  };
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

function parseUserInputArray(value: unknown, name: string): UserInput[] {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) throw new Error(`Invalid ${name}.`);
    return [toTextUserInput(trimmed)];
  }
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`Invalid ${name}.`);
  }

  return value.map((entry) => parseUserInput(entry, name));
}

function parseUserInput(value: unknown, name: string): UserInput {
  if (!isRecord(value) || typeof value.type !== "string") {
    throw new Error(`Invalid ${name}.`);
  }

  switch (value.type) {
    case "text": {
      if (typeof value.text !== "string" || !value.text.trim()) {
        throw new Error(`Invalid ${name}.`);
      }
      if (!Array.isArray(value.text_elements)) {
        throw new Error(`Invalid ${name}.`);
      }
      return {
        type: "text",
        text: value.text,
        text_elements: value.text_elements.map((element) => parseTextElement(element, name)),
      };
    }
    case "image": {
      if (typeof value.url !== "string" || !value.url.trim()) {
        throw new Error(`Invalid ${name}.`);
      }
      const detail = parseImageDetail(value.detail, name);
      return { type: "image", url: value.url.trim(), ...(detail ? { detail } : {}) };
    }
    case "localImage": {
      if (typeof value.path !== "string" || !value.path.trim()) {
        throw new Error(`Invalid ${name}.`);
      }
      const detail = parseImageDetail(value.detail, name);
      return { type: "localImage", path: value.path.trim(), ...(detail ? { detail } : {}) };
    }
    case "audio":
      if (typeof value.url !== "string" || !value.url.trim()) {
        throw new Error(`Invalid ${name}.`);
      }
      return { type: "audio", url: value.url.trim() };
    case "localAudio":
      if (typeof value.path !== "string" || !value.path.trim()) {
        throw new Error(`Invalid ${name}.`);
      }
      return { type: "localAudio", path: value.path.trim() };
    case "skill":
    case "mention":
      if (typeof value.name !== "string" || !value.name.trim()) {
        throw new Error(`Invalid ${name}.`);
      }
      if (typeof value.path !== "string" || !value.path.trim()) {
        throw new Error(`Invalid ${name}.`);
      }
      return { type: value.type, name: value.name.trim(), path: value.path.trim() };
    default:
      throw new Error(`Invalid ${name}.`);
  }
}

function parseTextElement(value: unknown, name: string): UserInputTextElement {
  if (!isRecord(value) || !isRecord(value.byteRange)) {
    throw new Error(`Invalid ${name}.`);
  }
  const start = value.byteRange.start;
  const end = value.byteRange.end;
  if (
    typeof start !== "number" ||
    !Number.isInteger(start) ||
    start < 0 ||
    typeof end !== "number" ||
    !Number.isInteger(end) ||
    end < start ||
    (value.placeholder !== null && typeof value.placeholder !== "string")
  ) {
    throw new Error(`Invalid ${name}.`);
  }
  return {
    byteRange: { start, end },
    placeholder: value.placeholder,
  };
}

function parseImageDetail(value: unknown, name: string): "auto" | "low" | "high" | "original" | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (value === "auto" || value === "low" || value === "high" || value === "original") {
    return value;
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

  const sortDirection = parseOptionalString(value.sortDirection, "sortDirection");
  if (sortDirection && !SORT_DIRECTIONS.includes(sortDirection as SortDirection)) {
    throw new Error("Invalid sort direction.");
  }

  const cwd =
    Array.isArray(value.cwd)
      ? parseOptionalStringList(value.cwd, "cwd")
      : parseOptionalString(value.cwd, "cwd");

  return {
    archived: parseOptionalBoolean(value.archived, "archived"),
    cursor: parseOptionalString(value.cursor, "cursor"),
    cwd,
    limit: parseOptionalPositiveInteger(value.limit, "limit"),
    modelProviders: parseOptionalStringList(value.modelProviders, "modelProviders"),
    searchTerm: parseOptionalString(value.searchTerm, "searchTerm"),
    sortDirection: sortDirection as SortDirection | undefined,
    sortKey: sortKey as ThreadSortKey | undefined,
    sourceKinds: sourceKinds as ThreadSourceKind[] | undefined,
    useStateDbOnly: parseOptionalBoolean(value.useStateDbOnly, "useStateDbOnly"),
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
  if (typeof value === "string" && APPROVAL_POLICIES.includes(value as (typeof APPROVAL_POLICIES)[number])) {
    return value as ApprovalPolicy;
  }
  if (isRecord(value) && isRecord(value.granular)) {
    const granular = value.granular;
    const keys = [
      "sandbox_approval",
      "rules",
      "skill_approval",
      "request_permissions",
      "mcp_elicitations",
    ] as const;
    if (keys.every((key) => typeof granular[key] === "boolean")) {
      return {
        granular: {
          sandbox_approval: granular.sandbox_approval as boolean,
          rules: granular.rules as boolean,
          skill_approval: granular.skill_approval as boolean,
          request_permissions: granular.request_permissions as boolean,
          mcp_elicitations: granular.mcp_elicitations as boolean,
        },
      };
    }
  }
  throw new Error("Invalid approval policy.");
}

export function validateResumeThreadRequest(value: unknown): ResumeThreadRequest {
  if (!isRecord(value)) throw new Error("Invalid resume payload.");
  const overrides = parseCommonThreadOverrides(value);
  const cwd = parseOptionalString(value.cwd, "cwd");
  return {
    approvalPolicy: parseApprovalPolicy(value.approvalPolicy),
    ...overrides,
    ...(cwd ? { cwd } : {}),
    personality: parseOptionalEnum(value.personality, "personality", PERSONALITIES),
  };
}

export function validateForkThreadRequest(value: unknown): ForkThreadRequest {
  if (!isRecord(value)) throw new Error("Invalid fork payload.");
  const overrides = parseCommonThreadOverrides(value);
  const cwd = parseOptionalString(value.cwd, "cwd");
  return {
    approvalPolicy: parseApprovalPolicy(value.approvalPolicy),
    ...overrides,
    ...(cwd ? { cwd } : {}),
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
  if (!isRecord(value)) {
    throw new Error("Invalid turn payload.");
  }
  return {
    input: parseUserInputArray(value.input, "input"),
    approvalPolicy: parseApprovalPolicy(value.approvalPolicy),
    model: parseOptionalString(value.model, "model"),
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

export function validateSteerTurnRequest(value: unknown): SteerTurnRequest {
  if (!isRecord(value)) {
    throw new Error("Invalid steer payload.");
  }
  if (value.turnId !== undefined && typeof value.turnId !== "string") {
    throw new Error("Invalid turn id.");
  }
  return {
    input: parseUserInputArray(value.input, "input"),
    turnId: value.turnId as string | undefined,
  };
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

export function validateSkillsListRequest(value: unknown): SkillsListRequest {
  if (!isRecord(value)) throw new Error("Invalid skills list payload.");
  return {
    cwds: parseOptionalStringList(value.cwds, "cwds"),
    forceReload: parseOptionalBoolean(value.forceReload, "forceReload"),
  };
}

export function validateSkillsConfigWriteRequest(value: unknown): SkillsConfigWriteRequest {
  if (!isRecord(value)) throw new Error("Invalid skills config payload.");
  if (typeof value.path !== "string" || !value.path.trim()) {
    throw new Error("Invalid path.");
  }
  if (typeof value.enabled !== "boolean") {
    throw new Error("Invalid enabled flag.");
  }
  return {
    path: value.path.trim(),
    enabled: value.enabled,
  };
}
