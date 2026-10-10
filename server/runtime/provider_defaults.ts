type ApprovalMode = "provider_default" | "review_all" | "review_sensitive" | "bypass";
type SandboxMode = "read_only" | "workspace_write" | "unrestricted";

/** Host configuration is independent of any installed provider. */
export function readProviderDefaults(env: Readonly<Record<string, string | undefined>>): {
  approvalMode?: ApprovalMode; sandboxMode?: SandboxMode;
} {
  const approval = env.SHEPHERD_APPROVAL_MODE?.trim();
  const sandbox = env.SHEPHERD_SANDBOX_MODE?.trim();
  const approvals: ApprovalMode[] = ["provider_default", "review_sensitive", "review_all", "bypass"];
  const sandboxes: SandboxMode[] = ["read_only", "workspace_write", "unrestricted"];
  if (approval && !approvals.includes(approval as ApprovalMode)) throw new Error("Invalid SHEPHERD_APPROVAL_MODE.");
  if (sandbox && !sandboxes.includes(sandbox as SandboxMode)) throw new Error("Invalid SHEPHERD_SANDBOX_MODE.");
  return {
    ...(approval ? { approvalMode: approval as ApprovalMode } : {}),
    ...(sandbox ? { sandboxMode: sandbox as SandboxMode } : {}),
  };
}
