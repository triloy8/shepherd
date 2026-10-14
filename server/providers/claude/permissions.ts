import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type { ApprovalPolicy } from "../../../shared/protocol/requests.js";

/** Claude permission options for an application approval mode. The provider default passes no
 * mode, so Claude applies the `defaultMode` from the user's, project's or local settings. */
export function claudePermissionOptions(policy: ApprovalPolicy): Pick<Options, "permissionMode" | "allowDangerouslySkipPermissions"> {
  switch (policy) {
    case "provider_default": return {};
    case "review_sensitive": return { permissionMode: "default" };
    case "bypass": return { permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true };
    default: throw new Error(`Claude does not support approval mode ${policy}.`);
  }
}

/** Saved approval modes are adapter-owned values, translated explicitly in both directions. */
export const claudeStoredApprovalModes = ["provider_default", "review_sensitive", "bypass"] as const;
export type ClaudeStoredApprovalMode = typeof claudeStoredApprovalModes[number];
export const isClaudeStoredApprovalMode = (value: unknown): value is ClaudeStoredApprovalMode => claudeStoredApprovalModes.includes(value as ClaudeStoredApprovalMode);

export function storedApprovalMode(policy: ApprovalPolicy): ClaudeStoredApprovalMode {
  switch (policy) {
    case "provider_default": return "provider_default";
    case "review_sensitive": return "review_sensitive";
    case "bypass": return "bypass";
    default: throw new Error(`Claude does not support approval mode ${policy}.`);
  }
}

export function approvalPolicyFromStored(mode: ClaudeStoredApprovalMode): ApprovalPolicy {
  switch (mode) {
    case "provider_default": return "provider_default";
    case "review_sensitive": return "review_sensitive";
    case "bypass": return "bypass";
  }
}
