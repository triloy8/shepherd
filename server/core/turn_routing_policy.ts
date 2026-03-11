import type { ApprovalPolicy } from "../../shared/protocol/requests.js";

export type TurnRoutingInput = {
  handled: boolean;
  threadId: string | null;
  input: string | null;
  isCommand: boolean;
  isDirectAddressed: boolean;
  activeTurnId: string | null;
  approvalPolicy: ApprovalPolicy;
};

export type TurnRoutingDecision =
  | { type: "ignore" }
  | { type: "submit"; threadId: string; input: string; approvalPolicy: ApprovalPolicy }
  | { type: "steer"; threadId: string; input: string; turnId: string };

export function decideTurnRouting(input: TurnRoutingInput): TurnRoutingDecision {
  if (input.handled || !input.threadId || !input.input) {
    return { type: "ignore" };
  }

  if (!input.isCommand && input.isDirectAddressed && input.activeTurnId) {
    return {
      type: "steer",
      threadId: input.threadId,
      input: input.input,
      turnId: input.activeTurnId,
    };
  }

  return {
    type: "submit",
    threadId: input.threadId,
    input: input.input,
    approvalPolicy: input.approvalPolicy,
  };
}
