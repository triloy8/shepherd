import type { ApprovalPolicy } from "../../shared/protocol/requests.js";
import type { UserInput } from "../../shared/protocol/user_input.js";

export type NormalizedSurfaceInput = {
  adapter: string;
  surfaceId: string;
  content: string;
  input: UserInput[];
  isCommand: boolean;
  isDirectAddressed: boolean;
};

export type SurfaceInputClassificationInput = NormalizedSurfaceInput;

export type SurfaceInputClassification =
  | { type: "ignore" }
  | { type: "process"; surface: NormalizedSurfaceInput };

export type TurnRoutingInput = {
  surface: NormalizedSurfaceInput;
  handled: boolean;
  threadId: string | null;
  input: UserInput[] | null;
  activeTurnId: string | null;
  approvalPolicy: ApprovalPolicy;
};

export type TurnRoutingDecision =
  | { type: "ignore" }
  | { type: "submit"; threadId: string; input: UserInput[]; approvalPolicy: ApprovalPolicy }
  | { type: "steer"; threadId: string; input: UserInput[]; turnId: string };

export function classifySurfaceInput(
  input: SurfaceInputClassificationInput,
): SurfaceInputClassification {
  const content = input.content.trim();
  if (!content && input.input.length === 0) {
    return { type: "ignore" };
  }

  if (!input.isCommand && !input.isDirectAddressed) {
    return { type: "ignore" };
  }

  return {
    type: "process",
    surface: {
      ...input,
      content,
    },
  };
}

export function decideTurnRouting(input: TurnRoutingInput): TurnRoutingDecision {
  if (input.handled || !input.threadId || !input.input || input.input.length === 0) {
    return { type: "ignore" };
  }

  if (!input.surface.isCommand && input.surface.isDirectAddressed && input.activeTurnId) {
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
