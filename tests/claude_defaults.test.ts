import { expect, test } from "bun:test";
import { claudeDefaults } from "../server/providers/claude/defaults.js";
import { claudeModelCatalog } from "../server/providers/claude/model_catalog.js";
import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";

const models: ModelInfo[] = [
  { value: "opus", resolvedModel: "claude-opus-5-5", displayName: "Opus 5.5", description: "Opus", supportsEffort: true, supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"] },
  { value: "sonnet", resolvedModel: "claude-sonnet-5-5", displayName: "Sonnet 5.5", description: "Sonnet", supportsEffort: true, supportedEffortLevels: ["low", "medium", "high"] },
];

test("Claude defaults pin Opus 5.5 and medium independently of Codex configuration", () => {
  expect(claudeDefaults({ CODEX_MODEL: "unrelated", CODEX_REASONING_EFFORT: "high" })).toEqual({ model: "claude-opus-5-5", effort: "medium" });
  expect(claudeDefaults({ CLAUDE_MODEL: " sonnet ", CLAUDE_EFFORT: " high " })).toEqual({ model: "sonnet", effort: "high" });
  expect(claudeDefaults({ CLAUDE_MODEL: " ", CLAUDE_EFFORT: "" })).toEqual({ model: "claude-opus-5-5", effort: "medium" });
  expect(() => claudeDefaults({ CLAUDE_EFFORT: "invalid" })).toThrow("CLAUDE_EFFORT");
});

test("catalog resolves explicit IDs while retaining aliases for saved conversations", () => {
  const rows = claudeModelCatalog(models, claudeDefaults({}));
  expect(rows.filter(row => !row.hidden).map(row => row.id)).toEqual(["claude-opus-5-5", "claude-sonnet-5-5"]);
  expect(rows.filter(row => row.isDefault).map(row => row.id)).toEqual(["claude-opus-5-5"]);
  expect(rows.find(row => row.id === "claude-opus-5-5")).toMatchObject({ defaultEffort: "medium", displayName: "Opus 5.5" });
  expect(rows.find(row => row.id === "opus")).toMatchObject({ hidden: true, isDefault: false });
  expect(rows.find(row => row.id === "sonnet")).toMatchObject({ hidden: true, defaultEffort: "medium" });
  expect(claudeModelCatalog(models, claudeDefaults({ CLAUDE_MODEL: "sonnet" })).find(row => row.isDefault)!.id).toBe("claude-sonnet-5-5");
});

test("catalog avoids duplicate IDs and does not advertise an unsupported default effort", () => {
  const rows = claudeModelCatalog([...models, { ...models[0]!, value: "claude-opus-5-5" }], claudeDefaults({}));
  expect(rows.filter(row => row.id === "claude-opus-5-5")).toHaveLength(1);
  const limited = claudeModelCatalog([{ ...models[0]!, supportedEffortLevels: ["high"] }], claudeDefaults({}));
  expect(limited[0]!.defaultEffort).toBeNull();
});

test("Claude tool calls map to shared activity kinds rather than defaulting to MCP", async () => {
  const { claudeActivityKind } = await import("../server/providers/claude/activity");
  expect(["Bash", "Edit", "NotebookEdit", "WebFetch", "Agent", "mcp__shepherd__signals__callback", "mcp__github__search", "Read", "TodoWrite"].map(claudeActivityKind))
    .toEqual(["command", "file_change", "file_change", "web_search", "collaboration", "dynamic_tool", "mcp_tool", "other", "other"]);
});
