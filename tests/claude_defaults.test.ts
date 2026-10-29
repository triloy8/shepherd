import { expect, test } from "bun:test";
import { claudeDefaults, claudeSubagentsEnabled } from "../server/providers/claude/defaults.js";
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

test("Claude subagents stay enabled unless CLAUDE_SUBAGENTS disables them", () => {
  expect(claudeSubagentsEnabled({})).toBe(true);
  expect(claudeSubagentsEnabled({ CLAUDE_SUBAGENTS: " disabled " })).toBe(false);
  expect(() => claudeSubagentsEnabled({ CLAUDE_SUBAGENTS: "off" })).toThrow("CLAUDE_SUBAGENTS");
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

test("Claude's own default does not hide the model it resolves to", () => {
  const rows = claudeModelCatalog([{ value: "default", resolvedModel: "claude-opus-5-5", displayName: "Default (recommended)", description: "Opus 5.5" }, ...models], claudeDefaults({}));
  expect(rows.filter(row => !row.hidden).map(row => row.displayName)).toEqual(["Opus 5.5", "Sonnet 5.5"]);
  expect(rows.find(row => row.isDefault)!.displayName).toBe("Opus 5.5");
  expect(rows.find(row => row.id === "default")).toMatchObject({ hidden: true });
});

test("catalog avoids duplicate IDs and does not advertise an unsupported default effort", () => {
  const rows = claudeModelCatalog([...models, { ...models[0]!, value: "claude-opus-5-5" }], claudeDefaults({}));
  expect(rows.filter(row => row.id === "claude-opus-5-5")).toHaveLength(1);
  const limited = claudeModelCatalog([{ ...models[0]!, supportedEffortLevels: ["high"] }], claudeDefaults({}));
  expect(limited[0]!.defaultEffort).toBeNull();
});

test("Claude tool calls are classified by what they do, from a bounded subset of their arguments", async () => {
  const { claudeActivity, claudeActivityFields } = await import("../server/providers/claude/activity");
  const classify = (tool: string, input: Record<string, unknown>) => claudeActivity(tool, claudeActivityFields(input));
  expect(classify("Bash", { command: "bun test", description: "Run tests", timeout: 1 })).toEqual({ kind: "command", command: "bun test", cwd: null });
  expect(classify("Edit", { file_path: "/a.ts", old_string: "x", new_string: "y" })).toEqual({ kind: "file_change", paths: ["/a.ts"] });
  expect(classify("NotebookEdit", { notebook_path: "/n.ipynb" })).toEqual({ kind: "file_change", paths: ["/n.ipynb"] });
  expect(classify("WebSearch", { query: "bun docs" })).toEqual({ kind: "web", query: "bun docs", url: null });
  expect(classify("WebFetch", { url: "https://example.com", prompt: "summarize" })).toEqual({ kind: "web", query: null, url: "https://example.com" });
  expect(classify("Agent", { description: "Explore", prompt: "long brief" })).toEqual({ kind: "delegation", description: "Explore" });
  expect(classify("mcp__shepherd__signals__callback", {})).toEqual({ kind: "tool", source: "application", server: "signals", name: "callback", target: null });
  expect(classify("mcp__shepherd__ping", {})).toEqual({ kind: "tool", source: "application", server: null, name: "ping", target: null });
  expect(classify("mcp__github__search_code", { q: "x" })).toEqual({ kind: "tool", source: "mcp", server: "github", name: "search_code", target: null });
  expect(classify("Read", { file_path: "/readme.md" })).toEqual({ kind: "tool", source: "builtin", server: null, name: "Read", target: "/readme.md" });
  expect(classify("Grep", { pattern: "TODO", path: "/src" })).toEqual({ kind: "tool", source: "builtin", server: null, name: "Grep", target: "/src" });
  expect(classify("TodoWrite", { todos: [] })).toEqual({ kind: "tool", source: "builtin", server: null, name: "TodoWrite", target: null });
});
