import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type { PolicyProfile } from "../../../shared/protocol/execution_policy.js";

/** Claude Code permission modes. `default` asks before any action its permission rules have not
 * allowed; `plan` makes no changes. Without a profile, the settings' `defaultMode` applies. */
export const claudeProfiles: readonly PolicyProfile[] = [
  { id: "bypassPermissions", label: "Bypass permissions", policy: { writes: "any", network: "any", review: "none" } },
  { id: "default", label: "Ask before actions", policy: { writes: "any", network: "any", review: "risky" } },
  { id: "plan", label: "Plan without changes", policy: { writes: "none", network: "any", review: "risky" } },
];

export const bypassProfile = "bypassPermissions";

export function claudePermissionOptions(profile: string | null): Pick<Options, "permissionMode" | "allowDangerouslySkipPermissions"> {
  switch (profile) {
    case null: return {};
    case "bypassPermissions": return { permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true };
    case "default": return { permissionMode: "default" };
    case "plan": return { permissionMode: "plan" };
    default: throw new Error(`Unknown Claude policy profile ${profile}.`);
  }
}
