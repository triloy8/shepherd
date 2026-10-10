import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileThreadProviderDirectory } from "../server/storage/thread_provider_directory.js";
import { memoryProviderDirectory } from "../server/core/provider_directory.js";
import { listProviderThreads } from "../server/core/provider_thread_catalog.js";
import type { AgentProvider, ThreadRecord } from "../shared/protocol/requests.js";

const directories: string[] = [];
afterEach(() => { directories.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })); });
function directory() { const path = mkdtempSync(join(tmpdir(), "shepherd-provider-bindings-")); directories.push(path); return path; }

test("provider bindings survive restart and override legacy-looking IDs", () => {
  const path = directory();
  const first = new FileThreadProviderDirectory(path, () => "claude");
  first.bind("claude-looking-but-codex", "codex");
  const second = new FileThreadProviderDirectory(path, () => "claude");
  expect(second.resolve("claude-looking-but-codex")).toBe("codex");
  expect(second.resolve("legacy-id")).toBe("claude");
  expect(() => second.bind("claude-looking-but-codex", "claude")).toThrow("Cannot change");
  second.bind("claude-looking-but-codex", "codex");
  expect(readdirSync(path)).toHaveLength(1);
});

test("opaque IDs cannot escape binding storage and corrupt bindings do not silently change providers", () => {
  const path = directory(); const storage = new FileThreadProviderDirectory(path, () => "codex");
  storage.bind("../../some/native/id", "claude");
  expect(storage.resolve("../../some/native/id")).toBe("claude");
  const file = join(path, readdirSync(path)[0]!); writeFileSync(file, JSON.stringify({ threadId: "wrong", provider: "codex" }));
  expect(() => storage.resolve("../../some/native/id")).toThrow("Invalid thread provider");
});

test("provider merge refills pages before selecting rows when page size increases", async () => {
  const rows = { codex: [10, 9, 8, 7, 4], claude: [100, 6, 5, 3] };
  const directory = memoryProviderDirectory();
  const sources = {
    providers: ["codex", "claude"] as const, directory, hasStoredThreads: () => true,
    listPage: async (provider: AgentProvider, request: { cursor?: string; limit?: number }) => {
      const offset = Number(request.cursor ?? 0); const size = request.limit!;
      return { data: rows[provider].slice(offset, offset + size).map(value => ({ id: `${provider}-${value}`, updatedAt: value })), nextCursor: offset + size < rows[provider].length ? String(offset + size) : null };
    },
  };
  const first = await listProviderThreads(sources, { limit: 2 });
  const next = await listProviderThreads(sources, { cursor: first.nextCursor!, limit: 5 });
  expect([...first.threads, ...next.threads].map(thread => thread.updatedAt)).toEqual([100, 10, 9, 8, 7, 6, 5]);
  expect(directory.resolve("claude-100")).toBe("claude");
});

test("provider merge handles empty intermediate pages and rejects cursor loops", async () => {
  const sources = { providers: ["codex", "claude"] as const, directory: memoryProviderDirectory(), hasStoredThreads: () => true,
    listPage: async (provider: AgentProvider, request: { cursor?: string }) => provider === "codex" ? { data: [] as ThreadRecord[], nextCursor: null } : request.cursor ? { data: [{ id: "opaque", updatedAt: 2 }], nextCursor: null } : { data: [] as ThreadRecord[], nextCursor: "next" },
  };
  expect((await listProviderThreads(sources, {})).threads.map(thread => thread.threadId)).toEqual(["opaque"]);
  await expect(listProviderThreads({ ...sources, listPage: async () => ({ data: [], nextCursor: "loop" }) }, {})).rejects.toThrow("repeated thread cursor");
});
