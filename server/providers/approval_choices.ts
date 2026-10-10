import { randomUUID } from "node:crypto";
import type { ApprovalChoice } from "../../shared/protocol/approvals.js";
/** Native reply values never leave the adapter. Each request gets its own tokens. */
export function approvalChoices(native: Array<{ value: unknown; label: string; intent?: ApprovalChoice["intent"] }>): { choices: ApprovalChoice[]; replies: Map<string, unknown> } {
  const replies = new Map<string, unknown>();
  const choices = native.map(choice => {
    const value = randomUUID(); replies.set(value, choice.value);
    const native = typeof choice.value === "string" ? choice.value : "";
    const intent = choice.intent ?? (native === "submit" ? "answer" : /accept|approve|success/.test(native.toLowerCase()) ? "allow" : /cancel|abort|timed/.test(native) ? "cancel" : "deny");
    return { value, label: choice.label, intent } as ApprovalChoice;
  });
  return { choices, replies };
}
