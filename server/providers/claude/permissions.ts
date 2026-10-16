import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type { ApprovalPolicy } from "../../../shared/protocol/requests.js";

/** Claude permission options for an application approval mode. The provider default passes no
 * mode, so Claude applies the `defaultMode` from the user's, project's or local settings. */
export function claudePermissionOptions(policy: ApprovalPolicy): Pick<Options, "permissionMode" | "allowDangerouslySkipPermissions"> {
  switch (policy) {
    case "provider_default": return {};
    // Claude's default mode asks before any action its permission rules have not already
    // allowed, which satisfies both review thresholds; Claude has no looser review mode here.
    case "review_sensitive": case "review_untrusted": return { permissionMode: "default" };
    case "bypass": return { permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true };
    default: throw new Error(`Claude does not support approval mode ${policy}.`);
  }
}
