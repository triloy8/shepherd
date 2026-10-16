import type { ExecutionPolicy, PolicyProfile } from "../../../shared/protocol/execution_policy.js";

export type NativeApprovalPolicy = "on-request" | "never";
type NativeSandbox = "read-only" | "workspace-write" | "danger-full-access";

const sandboxes: Array<{ native: NativeSandbox; label: string; writes: ExecutionPolicy["writes"]; network: ExecutionPolicy["network"]; response: string }> = [
  { native: "danger-full-access", label: "Full access", writes: "any", network: "any", response: "dangerFullAccess" },
  // Codex's workspace-write and read-only sandboxes block the network unless configured otherwise.
  { native: "workspace-write", label: "Workspace writes", writes: "workspace", network: "none", response: "workspaceWrite" },
  { native: "read-only", label: "Read-only", writes: "none", network: "none", response: "readOnly" },
];
const approvals: Array<{ native: NativeApprovalPolicy; label: string; review: ExecutionPolicy["review"] }> = [
  { native: "never", label: "no approvals", review: "none" },
  { native: "on-request", label: "asks when needed", review: "risky" },
];

/** Codex's sandbox and approval combinations. Profile IDs are `<sandbox>:<approval>`. */
export const codexProfiles: readonly PolicyProfile[] = sandboxes.flatMap(sandbox => approvals.map(approval => ({
  id: `${sandbox.native}:${approval.native}`,
  label: `${sandbox.label}, ${approval.label}`,
  policy: { writes: sandbox.writes, network: sandbox.network, review: approval.review },
})));

/** Native settings for a profile; null sends none, so Codex's own configuration applies. */
export function codexProfileSettings(profile: string | null): { sandbox?: NativeSandbox; approvalPolicy?: NativeApprovalPolicy } {
  if (profile === null) return {};
  const [sandbox, approval] = profile.split(":");
  const native = { sandbox: sandboxes.find(entry => entry.native === sandbox)?.native, approval: approvals.find(entry => entry.native === approval)?.native };
  if (!native.sandbox || !native.approval) throw new Error(`Unknown Codex policy profile ${profile}.`);
  return { sandbox: native.sandbox, approvalPolicy: native.approval };
}

/** The profile a thread runs with, read from Codex's response. Settings a profile does not
 * describe, including network access a sandbox normally blocks, report no profile. */
export function codexProfileFromNative(approvalPolicy: unknown, sandbox: unknown): string | null {
  const policy = sandbox && typeof sandbox === "object" ? sandbox as { type?: unknown; networkAccess?: unknown } : {};
  const matched = sandboxes.find(entry => entry.response === policy.type);
  const approval = approvals.find(entry => entry.native === approvalPolicy);
  if (!matched || !approval || (matched.network === "none" && policy.networkAccess !== false)) return null;
  return `${matched.native}:${approval.native}`;
}
