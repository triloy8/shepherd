import type { UserInput } from "../../../shared/protocol/user_input.js";
import type { MessageSource } from "../../../shared/protocol/message_source.js";
import type { RegisteredSignal, SignalTarget } from "./signal_registry.js";

export type ResolvedSignalTarget = {
  threadId: string;
  cwd: string;
};

export type SignalExecutor = {
  resolveTarget: (target: SignalTarget) => Promise<ResolvedSignalTarget | null>;
  waitUntilIdle: (target: ResolvedSignalTarget) => Promise<void>;
  executeTurn: (target: ResolvedSignalTarget, input: UserInput[], source?: MessageSource) => Promise<void>;
};

export type SignalDispatchResult =
  | { type: "accepted"; threadId: string }
  | { type: "coalesced"; threadId: string }
  | { type: "saturated" }
  | { type: "target-unavailable" }
  | { type: "unavailable" };

export type SignalDispatcherOptions = {
  capacity?: number;
  beforeExecute?: (signal: RegisteredSignal) => Promise<void>;
  onError?: (error: unknown, signal: RegisteredSignal) => void;
};

type QueuedSignal = {
  key: string;
  signal: RegisteredSignal;
  target: ResolvedSignalTarget;
};

type TargetQueue = {
  target: ResolvedSignalTarget;
  order: string[];
  pending: Map<string, QueuedSignal>;
  activeCoalesceKey: string | null;
  running: boolean;
};

function sameBinding(a: SignalTarget, b: SignalTarget): boolean {
  return a.threadId === b.threadId && a.cwd === b.cwd &&
    a.delivery.adapter === b.delivery.adapter && a.delivery.surfaceId === b.delivery.surfaceId;
}

export class SignalDispatcher {
  private readonly capacity: number;
  private readonly beforeExecute: (signal: RegisteredSignal) => Promise<void>;
  private readonly onError: (error: unknown, signal: RegisteredSignal) => void;
  private readonly queuesByThread = new Map<string, TargetQueue>();
  private pendingCount = 0;
  private sequence = 0;
  private disposed = false;

  constructor(
    private readonly executor: SignalExecutor,
    options: SignalDispatcherOptions = {},
  ) {
    this.capacity = options.capacity ?? 100;
    if (!Number.isInteger(this.capacity) || this.capacity < 1) {
      throw new Error("Signal dispatcher capacity must be a positive integer.");
    }
    this.beforeExecute = options.beforeExecute ?? (async () => {});
    this.onError = options.onError ?? ((error) => console.error("Signal dispatch failed:", error));
  }

  async accept(signal: RegisteredSignal): Promise<SignalDispatchResult> {
    if (this.disposed) return { type: "unavailable" };

    const target = await this.executor.resolveTarget(signal.target);
    if (this.disposed) return { type: "unavailable" };
    if (!target) return { type: "target-unavailable" };

    const queue = this.queuesByThread.get(target.threadId) ?? {
      target,
      order: [],
      pending: new Map<string, QueuedSignal>(),
      activeCoalesceKey: null,
      running: false,
    };
    this.queuesByThread.set(target.threadId, queue);

    const key = signal.coalesceKey ?? `signal-${++this.sequence}`;
    const existing = queue.pending.get(key);
    if (existing) {
      const merged = signal.batch && existing.signal.batch && sameBinding(existing.signal.target, signal.target)
        ? signal.batch.merge(existing.signal) : signal;
      queue.pending.set(key, { key, signal: merged, target });
      return { type: "coalesced", threadId: target.threadId };
    }

    if (this.pendingCount >= this.capacity) return { type: "saturated" };

    queue.pending.set(key, { key, signal, target });
    queue.order.push(key);
    this.pendingCount += 1;
    const coalescedWithActive = signal.coalesceKey !== null && queue.activeCoalesceKey === key;
    this.startQueue(queue);
    return {
      type: coalescedWithActive ? "coalesced" : "accepted",
      threadId: target.threadId,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const queue of this.queuesByThread.values()) {
      queue.order = [];
      queue.pending.clear();
    }
    this.pendingCount = 0;
  }

  private startQueue(queue: TargetQueue): void {
    if (queue.running) return;
    queue.running = true;
    void this.drainQueue(queue).finally(() => {
      queue.running = false;
      if (!this.disposed && queue.order.length > 0) {
        this.startQueue(queue);
      } else if (queue.order.length === 0) {
        this.queuesByThread.delete(queue.target.threadId);
      }
    });
  }

  private removePending(queue: TargetQueue, key: string): void {
    if (queue.pending.delete(key)) this.pendingCount -= 1;
  }

  private async drainQueue(queue: TargetQueue): Promise<void> {
    while (!this.disposed) {
      const key = queue.order.shift();
      if (!key) return;
      let queued = queue.pending.get(key);
      if (!queued) continue;
      let collecting = Boolean(queued.signal.batch);
      if (!collecting) this.removePending(queue, key);
      queue.activeCoalesceKey = queued.signal.coalesceKey;

      try {
        await this.executor.waitUntilIdle(queued.target);
        if (this.disposed) return;
        // The conversation may have moved to another surface or workspace while this waited.
        let current = await this.executor.resolveTarget(queued.signal.target);
        if (this.disposed) return;
        if (collecting) {
          let latest = queue.pending.get(key)!;
          while (!sameBinding(queued.signal.target, latest.signal.target)) {
            queued = latest;
            await this.executor.waitUntilIdle(queued.target);
            if (this.disposed) return;
            current = await this.executor.resolveTarget(queued.signal.target);
            if (this.disposed) return;
            latest = queue.pending.get(key)!;
          }
          queued = latest;
          this.removePending(queue, key);
          collecting = false;
        }
        if (!current || current.threadId !== queued.target.threadId || current.cwd !== queued.target.cwd) {
          this.onError(new Error("Signal target is no longer bound to its conversation; dropped the signal."), queued.signal);
          continue;
        }
        const signal = queued.signal.batch?.prepare() ?? queued.signal;
        await this.beforeExecute(signal);
        if (this.disposed) return;
        await this.executor.executeTurn(queued.target, signal.input, signal.source);
      } catch (error) {
        this.onError(error, queued.signal);
      } finally {
        if (collecting) this.removePending(queue, key);
        queue.activeCoalesceKey = null;
      }
    }
  }
}
