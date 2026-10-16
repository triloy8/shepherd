import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { DynamicToolRegistry } from "../server/core/dynamic_tool_registry.js";
import { shepherdMcpServers } from "../server/providers/claude/mcp_bridge.js";
import { codexToolResponse } from "../server/providers/codex/tools.js";
import type { DynamicToolCallResponse } from "../shared/protocol/dynamic_tools.js";

const call = { threadId: "thread", turnId: "turn", callId: "call", namespace: null, tool: "media", arguments: {} };
function registryFor(result: DynamicToolCallResponse) {
  const registry = new DynamicToolRegistry();
  registry.register({ namespace: null, name: "media", description: "Return media", inputSchema: { type: "object" }, execute: async () => result });
  return registry;
}

test("the same application media result reaches Codex and Claude without URLs in the contract", async () => {
  const result: DynamicToolCallResponse = { success: true, contentItems: [
    { type: "text", text: "Media" },
    { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
    { type: "audio", data: "d29ybGQ=", mimeType: "audio/wav" },
  ] };
  const registry = registryFor(result);
  expect(codexToolResponse(await registry.execute(call))).toEqual({ success: true, contentItems: [
    { type: "inputText", text: "Media" },
    { type: "inputImage", imageUrl: "data:image/png;base64,aGVsbG8=" },
    { type: "inputAudio", audioUrl: "data:audio/wav;base64,d29ybGQ=" },
  ] });
  const sdkServer = shepherdMcpServers(registry, () => call).shepherd!;
  if (sdkServer.type !== "sdk") throw new Error("Expected SDK MCP server");
  const client = new Client({ name: "test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await sdkServer.instance.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const response = await client.callTool({ name: "media", arguments: {} });
    expect(response).toEqual({ isError: false, content: [
      { type: "text", text: "Media" },
      { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
      { type: "audio", data: "d29ybGQ=", mimeType: "audio/wav" },
    ] });
  } finally { await client.close(); await sdkServer.instance.close(); }
});

test("shared execution rejects remote URLs, malformed bytes and mismatched MIME types", async () => {
  for (const item of [
    { type: "image", url: "https://example.com/image.png" },
    { type: "image", data: "AA==", mimeType: "audio/wav" },
    { type: "audio", data: "AA==", mimeType: "audio/wav;evil" },
    { type: "image", data: "", mimeType: "image/png" },
    { type: "image", data: "AA", mimeType: "image/png" },
    { type: "image", data: "!!!!", mimeType: "image/png" },
  ]) {
    const registry = registryFor({ success: true, contentItems: [item] } as unknown as DynamicToolCallResponse);
    await expect(registry.execute(call)).rejects.toThrow();
  }
});
