import { expect, test } from "bun:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { BackgroundTasks } from "../server/providers/claude/background_tasks.js";

test("background snapshots replace edge state and exclude ambient watchers", () => {
  const tasks = new BackgroundTasks();
  tasks.accept({ type: "system", subtype: "task_started", task_id: "old", is_backgrounded: true } as SDKMessage);
  expect(tasks.count).toBe(1);
  tasks.accept({ type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "worker" }, { task_id: "watcher", ambient: true }] } as SDKMessage);
  expect(tasks.count).toBe(1);
  tasks.accept({ type: "system", subtype: "task_notification", task_id: "worker", status: "completed" } as SDKMessage);
  expect(tasks.count).toBe(1); // Edge ordering cannot override a level snapshot.
  tasks.accept({ type: "system", subtype: "background_tasks_changed", tasks: [] } as SDKMessage);
  expect(tasks.count).toBe(0); tasks.reset();
  tasks.accept({ type: "system", subtype: "task_started", task_id: "legacy", is_backgrounded: true } as SDKMessage);
  tasks.accept({ type: "system", subtype: "task_notification", task_id: "legacy", status: "stopped" } as SDKMessage);
  expect(tasks.count).toBe(0);
});
