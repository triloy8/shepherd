import type {
  ApprovalDecisionApiRequest,
  ApprovalPolicy,
  BindSurfaceThreadRequest,
  CreateThreadRequest,
  CreateSurfaceThreadRequest,
  ForkThreadRequest,
  ForkSurfaceThreadRequest,
  ListLoadedThreadsRequest,
  ListModelsRequest,
  ListStoredThreadsRequest,
  ProductSurface,
  Personality,
  ReadThreadRequest,
  ResumeThreadRequest,
  ResumeSurfaceThreadRequest,
  RollbackThreadRequest,
  SandboxMode,
  SteerTurnRequest,
  SubmitSurfaceTurnRequest,
  SetThreadNameRequest,
  SetSurfaceWorkspaceTargetRequest,
  SetThreadModelRequest,
  SkillsConfigWriteRequest,
  SkillsListRequest,
  SkillsRemoteExportRequest,
  SkillsRemoteListRequest,
  InterruptTurnRequest,
  HazelnutScope,
  ThreadSortKey,
  ThreadSourceKind,
  SubmitTurnRequest,
  WorkspaceTarget,
} from "./requests.js";

const APPROVAL_POLICIES: ApprovalPolicy[] = ["untrusted", "on-failure", "on-request", "never"];
const SANDBOX_MODES: SandboxMode[] = ["read-only", "workspace-write", "danger-full-access"];
const PERSONALITIES: Personality[] = ["none", "friendly", "pragmatic"];
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
const HAZELNUT_SCOPES: HazelnutScope[] = ["example", "workspace-shared", "all-shared", "personal"];
const PRODUCT_SURFACES: ProductSurface[] = ["chatgpt", "codex", "api", "atlas"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

export function validateCreateThreadRequest(value: unknown): CreateThreadRequest {
  if (!isRecord(value)) {
    throw new Error("Invalid create thread payload.");
  }
  const overrides = parseCommonThreadOverrides(value);
  const cwd = parseOptionalString(value.cwd, "cwd");
  if (!cwd) {
    throw new Error("Invalid cwd.");
  }
  return {
    approvalPolicy: parseApprovalPolicy(value.approvalPolicy) ?? "on-request",
    ...overrides,
    cwd,
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

function parseWorkspaceTarget(value: unknown): WorkspaceTarget {
  if (!isRecord(value) || typeof value.kind !== "string") {
    throw new Error("Invalid workspace target.");
  }

  if (value.kind === "github") {
    const repoSlug = parseOptionalString(value.repoSlug, "repoSlug");
    const display = parseOptionalString(value.display, "display");
    if (!repoSlug || !display) {
      throw new Error("Invalid github workspace target.");
    }
    return { kind: "github", repoSlug, display };
  }

  if (value.kind === "local") {
    const rootPath = parseOptionalString(value.rootPath, "rootPath");
    const display = parseOptionalString(value.display, "display");
    if (!rootPath || !display) {
      throw new Error("Invalid local workspace target.");
    }
    return {
      kind: "local",
      rootPath,
      display,
      appendWorkspaceId: parseOptionalBoolean(value.appendWorkspaceId, "appendWorkspaceId") ?? false,
    };
  }

  throw new Error("Invalid workspace target.");
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

export function validateListModelsRequest(value: unknown): ListModelsRequest {
  if (!isRecord(value)) throw new Error("Invalid list models payload.");
  return {
    cursor: parseOptionalString(value.cursor, "cursor"),
    limit: parseOptionalPositiveInteger(value.limit, "limit"),
    includeHidden: parseOptionalBoolean(value.includeHidden, "includeHidden"),
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
  const overrides = parseCommonThreadOverrides(value);
  const cwd = parseOptionalString(value.cwd, "cwd");
  if (!cwd) {
    throw new Error("Invalid cwd.");
  }
  return {
    approvalPolicy: parseApprovalPolicy(value.approvalPolicy),
    ...overrides,
    cwd,
    personality: parseOptionalEnum(value.personality, "personality", PERSONALITIES),
  };
}

export function validateForkThreadRequest(value: unknown): ForkThreadRequest {
  if (!isRecord(value)) throw new Error("Invalid fork payload.");
  const overrides = parseCommonThreadOverrides(value);
  const cwd = parseOptionalString(value.cwd, "cwd");
  if (!cwd) {
    throw new Error("Invalid cwd.");
  }
  return {
    approvalPolicy: parseApprovalPolicy(value.approvalPolicy),
    ...overrides,
    cwd,
  };
}

export function validateCreateSurfaceThreadRequest(value: unknown): CreateSurfaceThreadRequest {
  if (!isRecord(value)) {
    return {};
  }
  const overrides = parseCommonThreadOverrides(value);
  return {
    approvalPolicy: parseApprovalPolicy(value.approvalPolicy),
    ...overrides,
    personality: parseOptionalEnum(value.personality, "personality", PERSONALITIES),
    ephemeral: parseOptionalBoolean(value.ephemeral, "ephemeral"),
    serviceName: parseOptionalString(value.serviceName, "serviceName"),
  };
}

export function validateResumeSurfaceThreadRequest(value: unknown): ResumeSurfaceThreadRequest {
  if (!isRecord(value)) {
    return {};
  }
  const overrides = parseCommonThreadOverrides(value);
  return {
    approvalPolicy: parseApprovalPolicy(value.approvalPolicy),
    ...overrides,
    personality: parseOptionalEnum(value.personality, "personality", PERSONALITIES),
  };
}

export function validateForkSurfaceThreadRequest(value: unknown): ForkSurfaceThreadRequest {
  if (!isRecord(value)) {
    return {};
  }
  const overrides = parseCommonThreadOverrides(value);
  return {
    approvalPolicy: parseApprovalPolicy(value.approvalPolicy),
    ...overrides,
  };
}

export function validateSetThreadNameRequest(value: unknown): SetThreadNameRequest {
  if (!isRecord(value) || typeof value.name !== "string" || !value.name.trim()) {
    throw new Error("Invalid thread name.");
  }
  return { name: value.name.trim() };
}

export function validateSetThreadModelRequest(value: unknown): SetThreadModelRequest {
  if (!isRecord(value) || typeof value.model !== "string" || !value.model.trim()) {
    throw new Error("Invalid model.");
  }
  return { model: value.model.trim() };
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
  if (!isRecord(value) || typeof value.input !== "string" || !value.input.trim()) {
    throw new Error("Invalid steer payload.");
  }
  if (value.turnId !== undefined && typeof value.turnId !== "string") {
    throw new Error("Invalid turn id.");
  }
  return {
    input: value.input.trim(),
    turnId: value.turnId as string | undefined,
  };
}

export function validateSubmitSurfaceTurnRequest(value: unknown): SubmitSurfaceTurnRequest {
  if (!isRecord(value) || typeof value.input !== "string" || !value.input.trim()) {
    throw new Error("Invalid surface turn payload.");
  }
  if (value.approvalPolicy && !APPROVAL_POLICIES.includes(value.approvalPolicy as ApprovalPolicy)) {
    throw new Error("Invalid approval policy.");
  }
  return {
    input: value.input.trim(),
    approvalPolicy: value.approvalPolicy as ApprovalPolicy | undefined,
    model: parseOptionalString(value.model, "model"),
    explicitThreadId: parseOptionalString(value.explicitThreadId, "explicitThreadId"),
    autoCreateIfMissing: parseOptionalBoolean(value.autoCreateIfMissing, "autoCreateIfMissing"),
    autoSteerActiveTurn: parseOptionalBoolean(value.autoSteerActiveTurn, "autoSteerActiveTurn"),
    sandbox: parseOptionalEnum(value.sandbox, "sandbox", SANDBOX_MODES),
  };
}

export function validateSetSurfaceWorkspaceTargetRequest(value: unknown): SetSurfaceWorkspaceTargetRequest {
  if (!isRecord(value)) {
    throw new Error("Invalid workspace target payload.");
  }
  return { target: parseWorkspaceTarget(value.target) };
}

export function validateBindSurfaceThreadRequest(value: unknown): BindSurfaceThreadRequest {
  if (!isRecord(value) || typeof value.threadId !== "string" || !value.threadId.trim()) {
    throw new Error("Invalid threadId.");
  }
  return { threadId: value.threadId.trim() };
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
  const perCwd = value.perCwdExtraUserRoots;
  if (perCwd !== undefined && perCwd !== null) {
    if (!Array.isArray(perCwd)) throw new Error("Invalid perCwdExtraUserRoots.");
    for (const entry of perCwd) {
      if (!isRecord(entry)) throw new Error("Invalid perCwdExtraUserRoots entry.");
      if (typeof entry.cwd !== "string") throw new Error("Invalid perCwdExtraUserRoots.cwd.");
      if (!Array.isArray(entry.extraUserRoots) || entry.extraUserRoots.some((root) => typeof root !== "string")) {
        throw new Error("Invalid perCwdExtraUserRoots.extraUserRoots.");
      }
    }
  }

  return {
    cwds: parseOptionalStringList(value.cwds, "cwds"),
    forceReload: parseOptionalBoolean(value.forceReload, "forceReload"),
    perCwdExtraUserRoots: perCwd as SkillsListRequest["perCwdExtraUserRoots"],
  };
}

export function validateSkillsRemoteListRequest(value: unknown): SkillsRemoteListRequest {
  if (!isRecord(value)) throw new Error("Invalid remote skills list payload.");
  return {
    enabled: parseOptionalBoolean(value.enabled, "enabled"),
    hazelnutScope: parseOptionalEnum(value.hazelnutScope, "hazelnutScope", HAZELNUT_SCOPES),
    productSurface: parseOptionalEnum(value.productSurface, "productSurface", PRODUCT_SURFACES),
  };
}

export function validateSkillsRemoteExportRequest(value: unknown): SkillsRemoteExportRequest {
  if (!isRecord(value) || typeof value.hazelnutId !== "string" || !value.hazelnutId.trim()) {
    throw new Error("Invalid remote skill export payload.");
  }
  return { hazelnutId: value.hazelnutId.trim() };
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
