import type { ApprovalPolicy as ApprovalMode, SandboxMode } from "../../shared/protocol/requests.js";

/** Host configuration is independent of any installed provider. */
export function readProviderDefaults(env: Readonly<Record<string, string | undefined>>): {
  approvalMode?: ApprovalMode; sandboxMode?: SandboxMode; defaultProvider?: string;
} {
  const defaultProvider = env.SHEPHERD_DEFAULT_PROVIDER?.trim();
  if (defaultProvider !== undefined && defaultProvider !== "" && !/^[A-Za-z0-9_.-]+$/.test(defaultProvider)) throw new Error("Invalid SHEPHERD_DEFAULT_PROVIDER.");
  const approval = env.SHEPHERD_APPROVAL_MODE?.trim();
  const sandbox = env.SHEPHERD_SANDBOX_MODE?.trim();
  if (approval === "review_all") throw new Error("SHEPHERD_APPROVAL_MODE=review_all was misleading; use review_untrusted for provider trust-based review. No adapter promises review of every action.");
  const approvals: ApprovalMode[] = ["provider_default", "review_sensitive", "review_untrusted", "bypass"];
  const sandboxes: SandboxMode[] = ["read_only", "workspace_write", "unrestricted"];
  if (approval && !approvals.includes(approval as ApprovalMode)) throw new Error("Invalid SHEPHERD_APPROVAL_MODE.");
  if (sandbox && !sandboxes.includes(sandbox as SandboxMode)) throw new Error("Invalid SHEPHERD_SANDBOX_MODE.");
  return {
    ...(approval ? { approvalMode: approval as ApprovalMode } : {}),
    ...(sandbox ? { sandboxMode: sandbox as SandboxMode } : {}),
    ...(defaultProvider ? { defaultProvider } : {}),
  };
}
