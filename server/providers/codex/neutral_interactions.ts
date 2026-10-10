import type { InteractionReply, InteractionRequest, PermissionDetails } from "../../../shared/protocol/v2/interactions.js";
import type { UserQuestionRequest } from "../../../shared/protocol/user_questions.js";
import { boundText, jsonBytes } from "../../../shared/protocol/v2/budgets.js";
import { fallbackItem, publicItemId, record, string } from "../neutral_items.js";
import type { NativeOption } from "../neutral_interactions.js";

export function codexInteraction(id: string, threadId: string, turnId: string | null, method: string, value: unknown, questions: UserQuestionRequest | undefined,
  apply: (reply: unknown) => Promise<void>): { request: Omit<InteractionRequest, "options">; options: NativeOption[] } {
  const params = record(value), legacy = !method.includes("/"), file = method.toLowerCase().includes("filechange") || method === "applyPatchApproval";
  const permissions: PermissionDetails = { cwd: string(params.cwd), filesystem: typeof params.grantRoot === "string" ? [{ path: params.grantRoot, access: "write" }] : [], network: [], commands: [], explanation: null };
  const command = string(params.command) ?? (Array.isArray(params.command) && params.command.every(part => typeof part === "string") ? JSON.stringify(params.command) : null), network = record(params.networkApprovalContext);
  if (command) permissions.commands.push({ match: boundText(command, 8192), scope: "once" });
  if (typeof network.host === "string") permissions.network.push({ host: network.host, access: "allow" });
  if (legacy && file && params.fileChanges) {
    const changes = Object.entries(record(params.fileChanges));
    permissions.filesystem.push(...changes.map(([path]) => ({ path, access: "write" as const })));
    permissions.explanation = boundText(changes.map(([path, value]) => { const change = record(value); return `${path}\n${string(change.unified_diff) ?? string(change.content) ?? "Change details unavailable."}`; }).join("\n\n"));
  }
  const options: NativeOption[] = [];
  const option = (label: string, intent: NativeOption["intent"], scope: NativeOption["scope"], reply: unknown, effect: PermissionDetails | null = null) => options.push({ label, intent, scope, effect, apply: async () => apply(reply) });
  if (questions) {
    options.push({ label: "Submit answers", intent: "submit", scope: null, effect: null, apply: async (reply: InteractionReply) => apply({ answers: reply.answers }) });
    option("Skip questions", "cancel", null, { answers: {} });
  } else {
    option("Allow once", "allow", "once", { decision: legacy ? "approved" : "accept" });
    if (!file) option("Allow for session", "allow", "session", { decision: legacy ? "approved_for_session" : "acceptForSession" }, { ...permissions, commands: permissions.commands.map(command => ({ ...command, scope: "session" })) });
    const exec = params.proposedExecpolicyAmendment;
    if (!legacy && !file && Array.isArray(exec) && exec.length && exec.every(part => typeof part === "string") && jsonBytes(exec) <= 8192) {
      const effect = { ...permissions, commands: [{ match: boundText(exec.join(" "), 8192), scope: "persistent" as const }], explanation: boundText(`Allows future commands with this argument prefix: ${JSON.stringify(exec)}`) };
      option("Always allow matching commands", "allow", "persistent", { decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: exec } } }, effect);
    }
    if (!legacy && !file && Array.isArray(params.proposedNetworkPolicyAmendments)) for (const amendment of params.proposedNetworkPolicyAmendments.slice(0, 20)) {
      const rule = record(amendment);
      if (typeof rule.host !== "string" || !["allow", "deny"].includes(String(rule.action))) continue;
      const access = rule.action as "allow" | "deny";
      option(`${access === "allow" ? "Always allow" : "Always deny"} network access to ${rule.host}`, access === "allow" ? "allow" : "deny", "persistent",
        { decision: { applyNetworkPolicyAmendment: { network_policy_amendment: amendment } } }, { ...permissions, network: [{ host: rule.host, access }] });
    }
    option("Deny", "deny", "once", { decision: legacy ? { denied: { rejection: "Denied by user." } } : "decline" });
    option("Cancel", "cancel", "once", { decision: legacy ? "abort" : "cancel" });
  }
  const nativeItem = string(params.itemId) ?? string(params.callId);
  return { request: { id, threadId, turnId, itemId: nativeItem ? publicItemId(threadId, nativeItem) : null,
    kind: questions ? "user_input" : file ? "file_change" : "command", title: questions ? "Answer the agent’s questions" : file ? "Review file changes" : "Review command",
    item: turnId && command ? fallbackItem(threadId, turnId, nativeItem ?? id, "Command", command, null, "in_progress") : null,
    reason: typeof params.reason === "string" ? boundText(params.reason) : null, permissions: questions ? null : permissions,
    questions: questions ? { ...questions, itemId: publicItemId(threadId, questions.itemId) } : null }, options };
}
