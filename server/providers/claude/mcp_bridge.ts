import { randomUUID } from "node:crypto";
import { createSdkMcpServer, type Options } from "@anthropic-ai/claude-agent-sdk";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { DynamicToolRegistry } from "../../core/dynamic_tool_registry.js";
import type { DynamicToolSpec, JsonValue } from "../../../shared/protocol/dynamic_tools.js";

/** Native MCP translation depends on a tool port, never on a session implementation. */
export function shepherdMcpServers(tools: Pick<DynamicToolRegistry, "hasTools" | "specifications" | "execute">, currentTurn: () => { threadId: string; turnId: string } | null): NonNullable<Options["mcpServers"]> {
  if (!tools.hasTools()) return {};
  const server = createSdkMcpServer({ name: "shepherd", version: "1.0.0" });
  server.instance.server.registerCapabilities({ tools: {} });
  const specs = tools.specifications().flatMap<Extract<DynamicToolSpec, { type: "function" }> & { namespace: string | null; wireName: string }>((spec) => spec.type === "namespace" ? spec.tools.map((tool) => ({ ...tool, namespace: spec.name, wireName: `${spec.name}__${tool.name}` })) : [{ ...spec, namespace: null, wireName: spec.name }]);
  if (new Set(specs.map(spec => spec.wireName)).size !== specs.length) throw new Error("Claude MCP tool names collide.");
  server.instance.server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: specs.map(spec => ({ name: spec.wireName, description: spec.description, inputSchema: spec.inputSchema as { type: "object" } })) }));
  server.instance.server.setRequestHandler(CallToolRequestSchema, async request => {
    const spec = specs.find(spec => spec.wireName === request.params.name);
    const identity = currentTurn();
    if (!spec || !identity) throw new Error("Unknown or inactive Shepherd tool call.");
    const result = await tools.execute({ ...identity, callId: randomUUID(), namespace: spec.namespace, tool: spec.name, arguments: (request.params.arguments ?? {}) as JsonValue });
    if (currentTurn()?.turnId !== identity.turnId) return { isError: true, content: [{ type: "text", text: "The originating turn has ended." }] };
    const content = result.contentItems.map(item => {
      if (item.type === "inputText") return { type: "text" as const, text: item.text };
      const url = item.type === "inputImage" ? item.imageUrl : item.audioUrl;
      const match = /^data:([^;,]+);base64,(.+)$/s.exec(url);
      if (!match) throw new Error("MCP media output must contain a base64 data URL.");
      return { type: item.type === "inputImage" ? "image" as const : "audio" as const, mimeType: match[1]!, data: match[2]! };
    });
    return { isError: !result.success, content };
  });
  return { shepherd: server };
}
