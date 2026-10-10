import type { ApprovalPolicy, SandboxMode } from "../../../shared/protocol/requests.js";

export type NativeApprovalPolicy = "on-request" | "untrusted" | "never";
/** Default means inherit native configuration, not a host-invented permission policy. */
export function codexApproval(policy: ApprovalPolicy): NativeApprovalPolicy | undefined {
  switch (policy) {
    case "provider_default": return undefined;
    case "review_sensitive": return "on-request";
    case "review_untrusted": return "untrusted";
    case "bypass": return "never";
    default: throw new Error("Unsupported approval mode.");
  }
}
export function applicationApproval(native: unknown): ApprovalPolicy | null {
  switch (native) {
    case "on-request": return "review_sensitive";
    case "untrusted": return "review_untrusted";
    case "never": return "bypass";
    default: return null;
  }
}
export function codexSandbox(mode: SandboxMode): string {
  switch (mode) {
    case "read_only": return "read-only";
    case "workspace_write": return "workspace-write";
    case "unrestricted": return "danger-full-access";
    default: throw new Error("Unsupported sandbox mode.");
  }
}
