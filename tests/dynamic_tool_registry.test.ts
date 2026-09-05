import { describe, expect, test } from "bun:test";

import {
  DynamicToolRegistry,
  UnknownDynamicToolError,
} from "../server/core/dynamic_tool_registry.js";

describe("DynamicToolRegistry", () => {
  test("groups namespaced registrations and unregisters by identity", async () => {
    const registry = new DynamicToolRegistry();
    const unregister = registry.register({
      namespace: "shepherd",
      namespaceDescription: "Shepherd services.",
      name: "callback",
      description: "Create a callback.",
      inputSchema: { type: "object", additionalProperties: false },
      async execute(params) {
        return { success: true, contentItems: [{ type: "inputText", text: params.callId }] };
      },
    });

    expect(registry.specifications()).toEqual([{
      type: "namespace",
      name: "shepherd",
      description: "Shepherd services.",
      tools: [{
        type: "function",
        name: "callback",
        description: "Create a callback.",
        inputSchema: { type: "object", additionalProperties: false },
      }],
    }]);
    await expect(registry.execute({
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "call-1",
      namespace: "shepherd",
      tool: "callback",
      arguments: {},
    })).resolves.toEqual({
      success: true,
      contentItems: [{ type: "inputText", text: "call-1" }],
    });

    unregister();
    expect(registry.hasTools()).toBe(false);
  });

  test("rejects duplicates, invalid names, and unknown calls", () => {
    const registry = new DynamicToolRegistry();
    const registration = {
      namespace: null,
      name: "callback",
      description: "Create a callback.",
      inputSchema: { type: "object" } as const,
      async execute() { return { success: true as const, contentItems: [] }; },
    };
    registry.register(registration);
    expect(() => registry.register(registration)).toThrow("already registered");
    expect(() => registry.register({ ...registration, name: "bad.name" })).toThrow("only letters");
    expect(() => registry.register({
      ...registration,
      namespace: "tools",
      namespaceDescription: "First description.",
      name: "one",
    })).not.toThrow();
    expect(() => registry.register({
      ...registration,
      namespace: "tools",
      namespaceDescription: "Conflicting description.",
      name: "two",
    })).toThrow("conflicting descriptions");
    expect(() => registry.register({
      ...registration,
      namespace: null,
      name: "tools",
    })).toThrow("collide with namespace");
    expect(() => registry.execute({
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "call-1",
      namespace: null,
      tool: "missing",
      arguments: {},
    })).toThrow(UnknownDynamicToolError);
  });
});
