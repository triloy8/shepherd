import { describe, expect, test } from "bun:test";

import { describeActivity } from "../shared/protocol/activity.js";
import {
  codexApprovalActivity,
  extractGeneratedImageArtifact,
  extractViewedImageArtifact,
} from "../server/providers/codex/rpc_mapper.js";
import { historyItem } from "../server/providers/codex/history.js";

/** Live notifications and history share one decoder; activities are its activity items. */
function mapTurnActivity(params: { turnId: string; item: Record<string, unknown> }, lifecycle: "started" | "completed") {
  const item = historyItem(params.item, params.turnId, lifecycle);
  return item.type === "activity" ? item : null;
}

function params(item: Record<string, unknown>) {
  return {
    threadId: "thread-1",
    turnId: "turn-1",
    item,
  };
}

describe("Codex RPC activity mapping", () => {
  test("extracts real imageView items and rejects missing or unsuccessful artifacts", () => {
    const item = { type: "imageView", id: "exec-screenshot", path: "/tmp/desktop-conversation.png" };
    expect(extractViewedImageArtifact(params(item))).toEqual({ itemId: item.id, turnId: "turn-1", path: item.path });
    expect(extractViewedImageArtifact(params({ ...item, status: "completed" }))).not.toBeNull();
    for (const changed of [{ type: "commandExecution" }, { id: "" }, { path: "" }, { path: null }, { status: "inProgress" }, { status: "failed" }, { status: "cancelled" }]) {
      expect(extractViewedImageArtifact(params({ ...item, ...changed }))).toBeNull();
    }
  });
  test("classifies command, file, MCP, dynamic, and web items by their targets", () => {
    expect(
      mapTurnActivity(
        params({ type: "commandExecution", id: "command-1", command: "bun test", cwd: "/repo", status: "inProgress" }),
        "started",
      ),
    ).toEqual({
      id: "command-1",
      type: "activity",
      status: "started",
      activity: { kind: "command", command: "bun test", cwd: "/repo" },
    });
    const files = mapTurnActivity(
      params({
        type: "fileChange",
        id: "file-1",
        changes: [
          { path: "one.ts", kind: "update" },
          { path: "two.ts", kind: "add" },
          { path: "three.ts", kind: "delete" },
          { path: "four.ts", kind: "update" },
        ],
        status: "completed",
      }),
      "started",
    )!;
    expect(files.activity).toEqual({ kind: "file_change", paths: ["one.ts", "two.ts", "three.ts", "four.ts"] });
    expect(describeActivity(files.activity).detail).toBe("one.ts, two.ts, three.ts +1 more");
    expect(
      mapTurnActivity(params({ type: "mcpToolCall", id: "mcp-1", server: "github", tool: "get_pr", status: "inProgress" }), "started")?.activity,
    ).toEqual({ kind: "tool", source: "mcp", server: "github", name: "get_pr", target: null });
    expect(
      mapTurnActivity(params({ type: "dynamicToolCall", id: "tool-1", namespace: "browser", tool: "open", status: "inProgress" }), "started")?.activity,
    ).toEqual({ kind: "tool", source: "application", server: "browser", name: "open", target: null });
    expect(
      mapTurnActivity(params({ type: "webSearch", id: "search-1", query: "Discord limits" }), "started")?.activity,
    ).toEqual({ kind: "web", query: "Discord limits", url: null });
  });

  test("classifies delegation, image, wait, and lifecycle items", () => {
    expect(
      mapTurnActivity(params({ type: "collabAgentToolCall", id: "collab-1", tool: "spawnAgent", status: "inProgress" }), "started")?.activity,
    ).toEqual({ kind: "delegation", description: "spawnAgent" });
    expect(
      mapTurnActivity(params({ type: "subAgentActivity", id: "sub-1", kind: "message", agentThreadId: "agent-1" }), "started")?.activity,
    ).toEqual({ kind: "delegation", description: "message" });
    expect(
      mapTurnActivity(params({ type: "imageView", id: "image-1", path: "/tmp/example.png" }), "started")?.activity,
    ).toEqual({ kind: "image", action: "view", path: "/tmp/example.png", prompt: null });
    const wait = mapTurnActivity(params({ type: "sleep", id: "sleep-1", durationMs: 1_500 }), "started")!;
    expect(wait.activity).toEqual({ kind: "wait", durationMs: 1_500 });
    expect(describeActivity(wait.activity).detail).toBe("1500 ms");
    expect(
      mapTurnActivity(params({ type: "contextCompaction", id: "compact-1" }), "started")?.activity,
    ).toEqual({ kind: "other", title: "Compacting context", detail: null });
  });

  test("describes approval requests by the activity they would allow", () => {
    expect(codexApprovalActivity("item/commandExecution/requestApproval", { command: "rm -rf build", cwd: "/repo", reason: "cleanup" }))
      .toEqual({ kind: "command", command: "rm -rf build", cwd: "/repo" });
    expect(codexApprovalActivity("execCommandApproval", { command: ["git", "push"], cwd: "/repo" }))
      .toEqual({ kind: "command", command: "git push", cwd: "/repo" });
    expect(codexApprovalActivity("item/fileChange/requestApproval", { grantRoot: "/repo/out" }))
      .toEqual({ kind: "file_change", paths: ["/repo/out"] });
    expect(codexApprovalActivity("applyPatchApproval", { fileChanges: { "a.ts": {}, "b.ts": {} } }))
      .toEqual({ kind: "file_change", paths: ["a.ts", "b.ts"] });
  });

  test("marks failed completed activity", () => {
    expect(
      mapTurnActivity(
        params({ type: "commandExecution", id: "command-1", command: "false", status: "failed" }),
        "completed",
      ),
    ).toMatchObject({ status: "failed" });
    expect(
      mapTurnActivity(
        params({ type: "dynamicToolCall", id: "tool-1", tool: "run", status: "completed", success: false }),
        "completed",
      ),
    ).toMatchObject({ status: "failed" });
  });

  test("decodes canonical agent messages with application phases", () => {
    expect(historyItem({ type: "agentMessage", id: "message-1", phase: "final_answer", text: "Canonical final answer" }, "turn-1", "completed"))
      .toEqual({ id: "message-1", type: "assistant_message", text: "Canonical final answer", phase: "final" });
    expect(historyItem({ type: "reasoning", id: "reason-1", summary: ["Checked"] }, "turn-1", "completed"))
      .toEqual({ id: "reason-1", type: "reasoning", summary: ["Checked"] });
  });

  test("an image is an activity until it exists", () => {
    const generation = { type: "imageGeneration", id: "image-1", revisedPrompt: "A unicorn", savedPath: "/tmp/u.png" };
    expect(historyItem({ ...generation, status: "inProgress" }, "turn-1", "started")).toMatchObject({ type: "activity", status: "started", activity: { kind: "image", action: "generate" } });
    expect(historyItem({ ...generation, status: "completed" }, "turn-1", "completed")).toEqual({ id: "image-1", type: "image", image: { itemId: "image-1", turnId: "turn-1", path: "/tmp/u.png", prompt: "A unicorn", kind: "generated" } });
  });

  test("extracts successful generated image artifacts with saved paths", () => {
    expect(
      extractGeneratedImageArtifact(
        params({
          type: "imageGeneration",
          id: "image-1",
          status: "completed",
          revisedPrompt: "A pastel unicorn",
          result: "Image generated",
          savedPath: "/tmp/generated-unicorn.png",
        }),
      ),
    ).toEqual({
      itemId: "image-1",
      turnId: "turn-1",
      path: "/tmp/generated-unicorn.png",
      prompt: "A pastel unicorn",
    });
    expect(
      extractGeneratedImageArtifact(
        params({
          type: "imageGeneration",
          id: "image-2",
          status: "failed",
          result: "Generation failed",
          savedPath: "/tmp/failed.png",
        }),
      ),
    ).toBeNull();
    expect(
      extractGeneratedImageArtifact(
        params({
          type: "imageGeneration",
          id: "image-3",
          status: "completed",
          result: "Image generated without a saved file",
        }),
      ),
    ).toBeNull();
  });
});
