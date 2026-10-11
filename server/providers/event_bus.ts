import type { BridgeEvent } from "../../shared/protocol/events.js";

type Listener = (event: BridgeEvent) => void;
type SubscribeOptions = {
  afterId?: string;
  replay?: boolean;
};

export class EventBus {
  private listeners = new Set<Listener>();
  private replay: BridgeEvent[] = [];
  private maxReplay: number;

  constructor(maxReplay = 300) {
    this.maxReplay = maxReplay;
  }

  publish(event: BridgeEvent): void {
    this.replay.push(event);
    if (this.replay.length > this.maxReplay) {
      this.replay.splice(0, this.replay.length - this.maxReplay);
    }
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  subscribe(listener: Listener, cursorOrOptions?: string | SubscribeOptions): () => void {
    const options: SubscribeOptions =
      typeof cursorOrOptions === "string"
        ? { afterId: cursorOrOptions, replay: true }
        : (cursorOrOptions ?? { replay: true });
    const shouldReplay = options.replay ?? true;
    const afterId = options.afterId;

    if (shouldReplay && afterId) {
      let seen = false;
      for (const event of this.replay) {
        if (!seen) {
          seen = event.id === afterId;
          continue;
        }
        listener(event);
      }
    } else if (shouldReplay) {
      for (const event of this.replay) {
        listener(event);
      }
    }

    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
