export class InputQueue<T> implements AsyncIterable<T> {
  private messages: T[] = [];
  private wake: (() => void) | null = null;
  private ended = false;
  push(message: T) { if (this.ended) throw new Error("Turn input is closed."); this.messages.push(message); this.wake?.(); this.wake = null; }
  close() { this.ended = true; this.wake?.(); this.wake = null; }
  async *[Symbol.asyncIterator]() {
    while (!this.ended || this.messages.length) {
      const message = this.messages.shift();
      if (message) yield message;
      else await new Promise<void>((resolve) => { this.wake = resolve; });
    }
  }
}

