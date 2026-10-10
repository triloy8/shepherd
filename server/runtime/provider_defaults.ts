import type { ApprovalMode, SandboxMode } from "../../shared/protocol/v2/conversations.js";

/** Composition owns legacy config decoding. Core receives neutral values only. */
export function readProviderDefaults(env: Readonly<Record<string, string | undefined>>): {
  approvalMode?: ApprovalMode; sandboxMode?: SandboxMode;
} {
  const approval = env.SHEPHERD_APPROVAL_MODE?.trim();
  const sandbox = env.SHEPHERD_SANDBOX_MODE?.trim();
  const legacyApproval = env.CODEX_APPROVAL_POLICY?.trim();
  const legacySandbox = env.CODEX_SANDBOX?.trim();
  const approvals: ApprovalMode[] = ["provider_default", "review_sensitive", "review_all", "bypass"];
  const sandboxes: SandboxMode[] = ["read_only", "workspace_write", "unrestricted"];
  const approvalAliases: Record<string, ApprovalMode> = { untrusted: "review_all", "on-request": "review_sensitive", never: "bypass" };
  const sandboxAliases: Record<string, SandboxMode> = { "read-only": "read_only", "workspace-write": "workspace_write", "danger-full-access": "unrestricted" };
  if (approval && !approvals.includes(approval as ApprovalMode)) throw new Error("Invalid SHEPHERD_APPROVAL_MODE.");
  if (sandbox && !sandboxes.includes(sandbox as SandboxMode)) throw new Error("Invalid SHEPHERD_SANDBOX_MODE.");
  if (!approval && legacyApproval && !Object.hasOwn(approvalAliases, legacyApproval)) throw new Error("Invalid CODEX_APPROVAL_POLICY alias.");
  if (!sandbox && legacySandbox && !Object.hasOwn(sandboxAliases, legacySandbox)) throw new Error("Invalid CODEX_SANDBOX alias.");
  return {
    ...(approval || legacyApproval ? { approvalMode: approval ? approval as ApprovalMode : approvalAliases[legacyApproval!] } : {}),
    ...(sandbox || legacySandbox ? { sandboxMode: sandbox ? sandbox as SandboxMode : sandboxAliases[legacySandbox!] } : {}),
  };
}
