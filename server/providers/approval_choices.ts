import { randomUUID } from "node:crypto";
import type { ApprovalChoice } from "../../shared/protocol/approvals.js";
export type NativeApprovalChoice = { value: unknown; label: string; intent: ApprovalChoice["intent"] };
/** Native reply values never leave the adapter. Each request gets its own tokens; adapters state each intent. */
export function approvalChoices(native: NativeApprovalChoice[]): { choices: ApprovalChoice[]; replies: Map<string, unknown> } {
  const replies = new Map<string, unknown>();
  const choices = native.map(choice => {
    const value = randomUUID(); replies.set(value, choice.value);
    return { value, label: choice.label, intent: choice.intent };
  });
  return { choices, replies };
}
