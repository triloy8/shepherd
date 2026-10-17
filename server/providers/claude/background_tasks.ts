import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

/** Prefer level snapshots; older CLIs need task edge events as a fallback. */
export class BackgroundTasks {
  private tasks = new Map<string, boolean>();
  private hasSnapshots = false;
  get count(): number { return [...this.tasks.values()].filter(ambient => !ambient).length; }
  reset(): void { this.tasks.clear(); this.hasSnapshots = false; }
  accept(message: SDKMessage): boolean {
    if (message.type !== "system") return false;
    if (message.subtype === "background_tasks_changed") {
      this.hasSnapshots = true;
      this.tasks = new Map(message.tasks.map(task => [task.task_id, task.ambient ?? false]));
      return true;
    }
    if (!this.hasSnapshots) {
      if (message.subtype === "task_started" && message.is_backgrounded) this.tasks.set(message.task_id, message.ambient ?? false);
      if (message.subtype === "task_notification") this.tasks.delete(message.task_id);
      if (message.subtype === "task_updated" && message.patch.is_backgrounded) this.tasks.set(message.task_id, this.tasks.get(message.task_id) ?? false);
    }
    return ["task_started", "task_progress", "task_notification", "task_updated"].includes(message.subtype);
  }
}
