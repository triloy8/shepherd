import type { DynamicToolCallResponse, DynamicToolSpec, JsonValue } from "../../../shared/protocol/dynamic_tools.js";

type NativeFunctionSpec = { type: "function"; name: string; description: string; inputSchema: JsonValue };
export type NativeToolSpec = NativeFunctionSpec | { type: "namespace"; name: string; description: string; tools: NativeFunctionSpec[] };
type NativeContentItem = { type: "inputText"; text: string } | { type: "inputImage"; imageUrl: string } | { type: "inputAudio"; audioUrl: string };
export type NativeToolResponse = { contentItems: NativeContentItem[]; success: boolean };

const functionSpec = (spec: Extract<DynamicToolSpec, { type: "function" }>): NativeFunctionSpec =>
  ({ type: "function", name: spec.name, description: spec.description, inputSchema: spec.inputSchema });

/** Application tools are declared to Codex as dynamic tools. */
export function codexToolSpecs(specs: readonly DynamicToolSpec[]): NativeToolSpec[] {
  return specs.map(spec => spec.type === "namespace"
    ? { type: "namespace", name: spec.name, description: spec.description, tools: spec.tools.map(functionSpec) }
    : functionSpec(spec));
}

export function codexToolResponse(response: DynamicToolCallResponse): NativeToolResponse {
  return {
    success: response.success,
    contentItems: response.contentItems.map((item): NativeContentItem => {
      switch (item.type) {
        case "text": return { type: "inputText", text: item.text };
        case "image": return { type: "inputImage", imageUrl: item.url };
        case "audio": return { type: "inputAudio", audioUrl: item.url };
      }
    }),
  };
}
