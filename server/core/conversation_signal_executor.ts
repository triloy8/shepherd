import type { BridgeEvent } from "../../shared/protocol/events.js";
import type { SubmitTurnResponse } from "../../shared/protocol/requests.js";
import type { UserInput } from "../../shared/protocol/user_input.js";
import type { ResolvedSignalTarget, SignalExecutor } from "./signal_dispatcher.js";
import type { SignalTarget } from "./signal_registry.js";

type ConversationSignalPort = {
  getSurfaceThread: (adapter: string, surfaceId: string) => string | null;
  getThreadCwd: (threadId: string) => Promise<string>;
  getThreadState: (threadId: string) => { activeTurnId: string | null };
  subscribeToThreadEvents: (
    threadId: string,
    listener: (event: BridgeEvent) => void,
    options: { replay: false },
  ) => () => void;
  submitTurn: (threadId: string, request: { input: UserInput[] }) => Promise<SubmitTurnResponse>;
};

function eventTurnId(event: BridgeEvent): string | null {
  const payload = event.payload as { turnId?: string | null };
  return payload.turnId ?? null;
}

function isTerminalTurnEvent(event: BridgeEvent): boolean {
  return event.type === "turn.completed" || event.type === "turn.failed";
}

export class ConversationSignalExecutor implements SignalExecutor {
  constructor(private readonly conversation: ConversationSignalPort) {}

  async resolveTarget(target: SignalTarget): Promise<ResolvedSignalTarget | null> {
    const threadId = this.conversation.getSurfaceThread(target.adapter, target.surfaceId);
    if (!threadId) return null;
    return {
      threadId,
      cwd: await this.conversation.getThreadCwd(threadId),
    };
  }

  async waitUntilIdle(target: ResolvedSignalTarget): Promise<void> {
    while (true) {
      const activeTurnId = this.conversation.getThreadState(target.threadId).activeTurnId;
      if (!activeTurnId) return;
      await this.waitForTurnEnd(target.threadId, activeTurnId);
    }
  }

  executeTurn(target: ResolvedSignalTarget, input: UserInput[]): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let expectedTurnId: string | null | undefined;
      const earlyTerminalTurnIds = new Set<string | null>();
      let settled = false;

      const finish = (error?: unknown): void => {
        if (settled) return;
        settled = true;
        unsubscribe();
        if (error) reject(error);
        else resolve();
      };

      const listener = (event: BridgeEvent): void => {
        if (event.type === "session.error") {
          const payload = event.payload as { message?: string };
          finish(new Error(payload.message ?? "Codex session failed during signal turn."));
          return;
        }
        if (!isTerminalTurnEvent(event)) return;
        const turnId = eventTurnId(event);
        if (event.type === "turn.failed" && this.conversation.getThreadState(target.threadId).activeTurnId) {
          return;
        }
        if (expectedTurnId === undefined) {
          earlyTerminalTurnIds.add(turnId);
          return;
        }
        if (expectedTurnId === null || turnId === expectedTurnId) finish();
      };

      const unsubscribe = this.conversation.subscribeToThreadEvents(
        target.threadId,
        listener,
        { replay: false },
      );

      void this.conversation.submitTurn(target.threadId, { input }).then(
        (result) => {
          expectedTurnId = result.turnId;
          if (
            earlyTerminalTurnIds.has(result.turnId) ||
            (result.turnId === null && earlyTerminalTurnIds.size > 0)
          ) {
            finish();
          }
        },
        (error) => finish(error),
      );
    });
  }

  private waitForTurnEnd(threadId: string, activeTurnId: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: unknown): void => {
        if (settled) return;
        settled = true;
        unsubscribe();
        if (error) reject(error);
        else resolve();
      };
      const listener = (event: BridgeEvent): void => {
        if (event.type === "session.error") {
          const payload = event.payload as { message?: string };
          finish(new Error(payload.message ?? "Codex session failed while waiting for the active turn."));
          return;
        }
        if (!isTerminalTurnEvent(event) || eventTurnId(event) !== activeTurnId) return;
        if (event.type === "turn.failed" && this.conversation.getThreadState(threadId).activeTurnId) return;
        finish();
      };
      const unsubscribe = this.conversation.subscribeToThreadEvents(threadId, listener, { replay: false });

      try {
        if (this.conversation.getThreadState(threadId).activeTurnId !== activeTurnId) finish();
      } catch (error) {
        finish(error);
      }
    });
  }
}
