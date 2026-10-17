import type { UserQuestionAnswers } from "./user_questions.js";
import type {
  ApprovalDecisionApiRequest,
  CreateThreadRequest,
  ForkThreadRequest,
  ListLoadedThreadsRequest,
  ListStoredThreadsRequest,
  ReadThreadRequest,
  ResumeThreadRequest,
  RevertThreadRequest,
  SortDirection,
  SteerTurnRequest,
  SetThreadNameRequest,
  SkillsConfigWriteRequest,
  SkillsListRequest,
  InterruptTurnRequest,
  ThreadSortKey,
  SubmitTurnRequest,
} from "./requests.js";
import { IMAGE_DETAILS, toTextUserInput, type ImageDetail, type UserInput } from "./user_input.js";
import { isExecutionPolicy, type ExecutionPolicy } from "./execution_policy.js";

const THREAD_SORT_KEYS: ThreadSortKey[] = ["created_at", "updated_at"];
const SORT_DIRECTIONS: SortDirection[] = ["asc", "desc"];
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function validateCreateThreadRequest(value: unknown): CreateThreadRequest {
  if (!isRecord(value)) {
    throw new Error("Invalid create thread payload.");
  }
  const overrides = parseCommonThreadOverrides(value);
  const cwd = parseOptionalString(value.cwd, "cwd");
  return {
    ...overrides,
    ...(cwd ? { cwd } : {}),
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

function assertFields(value: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`Unsupported request field: ${key}.`);
}

function parseCommonThreadOverrides(value: Record<string, unknown>) {
  assertFields(value, ["provider", "policy", "cwd", "model", "effort"]);
  return {
    provider: parseOptionalString(value.provider, "provider"),
    ...(value.policy === undefined ? {} : { policy: parseExecutionPolicy(value.policy) }),
    model: parseOpaqueSelection(value.model, "model"),
    effort: parseOpaqueSelection(value.effort, "effort"),
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

  const fields: Record<string, readonly string[]> = {
    text: ["type", "text"], image: ["type", "url", "detail"],
    image_file: ["type", "path", "detail"], audio: ["type", "url"], audio_file: ["type", "path"],
    skill: ["type", "name", "path"],
  };
  const allowed = Object.hasOwn(fields, value.type) ? fields[value.type] : undefined;
  if (!allowed) throw new Error(`Invalid ${name}.`);
  assertFields(value, allowed);
  switch (value.type) {
    case "text": {
      if (typeof value.text !== "string" || !value.text.trim()) {
        throw new Error(`Invalid ${name}.`);
      }
      return { type: "text", text: value.text };
    }
    case "image": {
      if (typeof value.url !== "string" || !value.url.trim()) {
        throw new Error(`Invalid ${name}.`);
      }
      const detail = parseImageDetail(value.detail, name);
      return { type: "image", url: value.url.trim(), ...(detail ? { detail } : {}) };
    }
    case "image_file": {
      if (typeof value.path !== "string" || !value.path.trim()) {
        throw new Error(`Invalid ${name}.`);
      }
      const detail = parseImageDetail(value.detail, name);
      return { type: "image_file", path: value.path.trim(), ...(detail ? { detail } : {}) };
    }
    case "audio":
      if (typeof value.url !== "string" || !value.url.trim()) {
        throw new Error(`Invalid ${name}.`);
      }
      return { type: "audio", url: value.url.trim() };
    case "audio_file":
      if (typeof value.path !== "string" || !value.path.trim()) {
        throw new Error(`Invalid ${name}.`);
      }
      return { type: "audio_file", path: value.path.trim() };
    case "skill":
      if (typeof value.name !== "string" || !value.name.trim()) {
        throw new Error(`Invalid ${name}.`);
      }
      if (typeof value.path !== "string" || !value.path.trim()) {
        throw new Error(`Invalid ${name}.`);
      }
      return { type: "skill", name: value.name.trim(), path: value.path.trim() };
    default:
      throw new Error(`Invalid ${name}.`);
  }
}

function parseImageDetail(value: unknown, name: string): ImageDetail | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "string" && (IMAGE_DETAILS as readonly string[]).includes(value)) {
    return value as ImageDetail;
  }
  throw new Error(`Invalid ${name}.`);
}

export function validateListStoredThreadsRequest(value: unknown): ListStoredThreadsRequest {
  if (!isRecord(value)) throw new Error("Invalid list threads payload.");
  assertFields(value, ["archived", "cursor", "cwd", "limit", "searchTerm", "sortDirection", "sortKey"]);

  const sortKey = parseOptionalString(value.sortKey, "sortKey");
  if (sortKey && !THREAD_SORT_KEYS.includes(sortKey as ThreadSortKey)) {
    throw new Error("Invalid sort key.");
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
    searchTerm: parseOptionalString(value.searchTerm, "searchTerm"),
    sortDirection: sortDirection as SortDirection | undefined,
    sortKey: sortKey as ThreadSortKey | undefined,
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

function parseExecutionPolicy(value: unknown): ExecutionPolicy {
  if (!isExecutionPolicy(value)) throw new Error("Invalid execution policy: expected writes (none, workspace, any), network (none, any) and review (risky, none).");
  return { writes: value.writes, network: value.network, review: value.review };
}

export function validateResumeThreadRequest(value: unknown): ResumeThreadRequest {
  if (!isRecord(value)) throw new Error("Invalid resume payload.");
  const overrides = parseCommonThreadOverrides(value);
  const cwd = parseOptionalString(value.cwd, "cwd");
  return {
    ...overrides,
    ...(cwd ? { cwd } : {}),
  };
}

export function validateForkThreadRequest(value: unknown): ForkThreadRequest {
  if (!isRecord(value)) throw new Error("Invalid fork payload.");
  const overrides = parseCommonThreadOverrides(value);
  const cwd = parseOptionalString(value.cwd, "cwd");
  return {
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

export function validateRevertThreadRequest(value: unknown): RevertThreadRequest {
  if (!isRecord(value) || typeof value.beforeTurnId !== "string" || !value.beforeTurnId.trim() || value.beforeTurnId.length > 256) {
    throw new Error("beforeTurnId must be a non-empty string of at most 256 characters.");
  }
  return { beforeTurnId: value.beforeTurnId };
}

function parseOpaqueSelection(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !value.trim()) throw new Error(`Invalid ${name}.`);
  return value;
}

export function validateSubmitTurnRequest(value: unknown): SubmitTurnRequest {
  if (!isRecord(value)) {
    throw new Error("Invalid turn payload.");
  }
  assertFields(value, ["input", "model", "effort"]);
  return {
    input: parseUserInputArray(value.input, "input"),
    model: parseOpaqueSelection(value.model, "model"),
    effort: value.effort === null ? null : parseOpaqueSelection(value.effort, "effort"),
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
  assertFields(value, ["input", "turnId"]);
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
    ...(value.answers !== undefined ? { answers: value.answers as UserQuestionAnswers } : {}),
  };
}

export function validateSkillsListRequest(value: unknown): SkillsListRequest {
  if (!isRecord(value) || Object.keys(value).some(key => key !== "refresh")) throw new Error("Invalid skills list payload.");
  return {
    refresh: parseOptionalBoolean(value.refresh, "refresh"),
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
