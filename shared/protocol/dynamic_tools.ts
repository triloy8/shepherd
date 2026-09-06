export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type DynamicToolFunctionSpec = {
  type: "function";
  name: string;
  description: string;
  inputSchema: JsonValue;
  deferLoading?: boolean;
};

export type DynamicToolNamespaceSpec = {
  type: "namespace";
  name: string;
  description: string;
  tools: DynamicToolFunctionSpec[];
};

export type DynamicToolSpec = DynamicToolFunctionSpec | DynamicToolNamespaceSpec;

export type DynamicToolCallParams = {
  threadId: string;
  turnId: string;
  callId: string;
  namespace: string | null;
  tool: string;
  arguments: JsonValue;
};

export type DynamicToolCallOutputContentItem =
  | { type: "inputText"; text: string }
  | { type: "inputImage"; imageUrl: string }
  | { type: "inputAudio"; audioUrl: string };

export type DynamicToolCallResponse = {
  contentItems: DynamicToolCallOutputContentItem[];
  success: boolean;
};
