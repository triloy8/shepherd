export class ThreadStore {
  private threadByChannel = new Map<string, string>();

  getThreadId(channelId: string): string | null {
    return this.threadByChannel.get(channelId) ?? null;
  }

  setThreadId(channelId: string, threadId: string): void {
    this.threadByChannel.set(channelId, threadId);
  }

  clearThread(channelId: string): void {
    this.threadByChannel.delete(channelId);
  }
}
