import { randomUUID } from "node:crypto";
import type { BridgeEvent, EventPayloads } from "../../shared/protocol/v2/events.js";
import { encodeEventFrame, V2_BUDGETS } from "../../shared/protocol/v2/budgets.js";

export class ProjectionRecoveryError extends Error {}
export interface ProjectionCursor { epoch: string; sequence: number }

/** Process-local event ordering and bounded replay for the forthcoming v2 projection.
 * Core supplies item revisions; transports keep these envelopes unchanged.
 * No native SDK reads, callbacks, or transport IO happen inside publication.
 */
export class ProjectionEventLog {
  readonly epoch = randomUUID();
  private sequence = 0;
  private readonly replay: Array<{ event: BridgeEvent; bytes: number }> = [];
  private replayBytes = 0;

  constructor(private readonly threadId: string, private readonly sessionId: string) {}

  cursor(): ProjectionCursor { return { epoch: this.epoch, sequence: this.sequence }; }

  publish<K extends keyof EventPayloads>(type: K, payload: EventPayloads[K]): BridgeEvent {
    const sequence = this.sequence + 1;
    const event = structuredClone({ id: `${this.epoch}:${sequence}`, epoch: this.epoch, sequence, threadId: this.threadId,
      sessionId: this.sessionId, ts: Date.now() / 1000, type, payload }) as BridgeEvent;
    const bytes = encodeEventFrame(event).byteLength;
    // Invalid payloads do not consume a sequence or enter replay.
    this.sequence = sequence;
    this.replay.push({ event, bytes }); this.replayBytes += bytes;
    while (this.replay.length > V2_BUDGETS.replayEvents || this.replayBytes > V2_BUDGETS.replayBytes) {
      this.replayBytes -= this.replay.shift()!.bytes;
    }
    return structuredClone(event);
  }

  eventsAfter(cursor: ProjectionCursor): BridgeEvent[] {
    if (cursor.epoch !== this.epoch || !Number.isSafeInteger(cursor.sequence) || cursor.sequence < 0 || cursor.sequence > this.sequence ||
        cursor.sequence < (this.replay[0]?.event.sequence ?? this.sequence + 1) - 1) {
      throw new ProjectionRecoveryError("Replay cursor requires a new snapshot.");
    }
    return this.replay.filter(({ event }) => event.sequence > cursor.sequence).map(({ event }) => structuredClone(event));
  }

  /** Revert invalidates cursors which could restore removed history. */
  invalidateHistory(historyRevision: string): BridgeEvent {
    const event = this.publish("thread.reverted", { historyRevision });
    this.replay.splice(0, this.replay.length - 1);
    this.replayBytes = this.replay[0]!.bytes;
    return event;
  }
}
