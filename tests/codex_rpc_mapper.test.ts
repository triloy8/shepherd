import { describe, expect, test } from "bun:test";

import {
  extractCompletedAgentMessage,
  mapTurnActivity,
} from "../server/core/codex_rpc_mapper.js";

function params(item: Record<string, unknown>) {
  return {
    threadId: "thread-1",
    turnId: "turn-1",
    item,
  };
}

describe("Codex RPC activity mapping", () => {
  test("normalizes command, file, MCP, dynamic, and web activity", () => {
    expect(
      mapTurnActivity(
        params({ type: "commandExecution", id: "command-1", command: "bun test", status: "inProgress" }),
        "started",
      ),
    ).toMatchObject({
      itemId: "command-1",
      turnId: "turn-1",
      kind: "command",
      label: "Running command",
      detail: "bun test",
      status: "started",
    });
    expect(
      mapTurnActivity(
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
      )?.detail,
    ).toBe("one.ts, two.ts, three.ts +1 more");
    expect(
      mapTurnActivity(
        params({ type: "mcpToolCall", id: "mcp-1", server: "github", tool: "get_pr", status: "inProgress" }),
        "started",
      ),
    ).toMatchObject({ kind: "mcp_tool", detail: "github.get_pr" });
    expect(
      mapTurnActivity(
        params({ type: "dynamicToolCall", id: "tool-1", namespace: "browser", tool: "open", status: "inProgress" }),
        "started",
      ),
    ).toMatchObject({ kind: "dynamic_tool", detail: "browser.open" });
    expect(
      mapTurnActivity(
        params({ type: "webSearch", id: "search-1", query: "Discord limits" }),
        "started",
      ),
    ).toMatchObject({ kind: "web_search", detail: "Discord limits" });
  });

  test("normalizes collaboration, image, wait, and lifecycle activity", () => {
    expect(
      mapTurnActivity(
        params({ type: "collabAgentToolCall", id: "collab-1", tool: "spawnAgent", status: "inProgress" }),
        "started",
      ),
    ).toMatchObject({ kind: "collaboration", detail: "spawnAgent" });
    expect(
      mapTurnActivity(
        params({ type: "subAgentActivity", id: "sub-1", kind: "message", agentThreadId: "agent-1" }),
        "started",
      ),
    ).toMatchObject({ kind: "collaboration", label: "Agent activity" });
    expect(
      mapTurnActivity(params({ type: "imageView", id: "image-1", path: "/tmp/example.png" }), "started"),
    ).toMatchObject({ kind: "image", detail: "/tmp/example.png" });
    expect(
      mapTurnActivity(params({ type: "sleep", id: "sleep-1", durationMs: 1_500 }), "started"),
    ).toMatchObject({ kind: "wait", detail: "1500 ms" });
    expect(
      mapTurnActivity(params({ type: "contextCompaction", id: "compact-1" }), "started"),
    ).toMatchObject({ kind: "other", label: "Compacting context" });
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

  test("extracts canonical completed agent messages", () => {
    expect(
      extractCompletedAgentMessage(
        params({
          type: "agentMessage",
          id: "message-1",
          phase: "final_answer",
          text: "Canonical final answer",
        }),
      ),
    ).toEqual({
      itemId: "message-1",
      phase: "final_answer",
      text: "Canonical final answer",
      turnId: "turn-1",
    });
    expect(extractCompletedAgentMessage(params({ type: "reasoning", id: "reason-1" }))).toBeNull();
  });
});
