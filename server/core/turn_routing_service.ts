import type {
  ApprovalPolicy,
  GetThreadStateResponse,
  SteerTurnResponse,
  SubmitTurnResponse,
} from "../../shared/protocol/requests.js";
import { decideTurnRouting, type NormalizedSurfaceInput, type TurnRoutingDecision } from "./turn_routing_policy.js";

export type TurnRoutingExecutionInput = {
  surface: NormalizedSurfaceInput;
  handled: boolean;
  threadId: string | null;
  input: string | null;
  approvalPolicy: ApprovalPolicy;
};

type TurnRoutingConversation = {
  getThreadState: (threadId: string) => GetThreadStateResponse;
  submitTurn: (
    threadId: string,
    request: { input: string; approvalPolicy?: ApprovalPolicy },
  ) => Promise<SubmitTurnResponse>;
  steerTurn: (
    threadId: string,
    request: { input: string; turnId?: string },
  ) => Promise<SteerTurnResponse>;
};

export type TurnRoutingExecutionContext = {
  conversation: TurnRoutingConversation;
};

export type TurnRoutingExecutionResult =
  | { type: "ignore" }
  | { type: "submit"; threadId: string; turnId: string | null }
  | { type: "steer"; threadId: string; turnId: string | null };

export async function executeTurnRouting(
  context: TurnRoutingExecutionContext,
  input: TurnRoutingExecutionInput,
): Promise<TurnRoutingExecutionResult> {
  const activeTurnId = input.threadId
    ? context.conversation.getThreadState(input.threadId).activeTurnId
    : null;

  const decision: TurnRoutingDecision = decideTurnRouting({
    surface: input.surface,
    handled: input.handled,
    threadId: input.threadId,
    input: input.input,
    activeTurnId,
    approvalPolicy: input.approvalPolicy,
  });

  if (decision.type === "ignore") {
    return { type: "ignore" };
  }

  if (decision.type === "steer") {
    const steered = await context.conversation.steerTurn(decision.threadId, {
      input: decision.input,
      turnId: decision.turnId,
    });
    return {
      type: "steer",
      threadId: decision.threadId,
      turnId: steered.turnId,
    };
  }

  const submitted = await context.conversation.submitTurn(decision.threadId, {
    input: decision.input,
    approvalPolicy: decision.approvalPolicy,
  });
  return {
    type: "submit",
    threadId: decision.threadId,
    turnId: submitted.turnId,
  };
}
