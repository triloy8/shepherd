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

/** Tool output returned to the model. Media URLs are data URLs or remote URLs. */
export type DynamicToolCallOutputContentItem =
  | { type: "text"; text: string }
  | { type: "image"; url: string }
  | { type: "audio"; url: string };

export type DynamicToolCallResponse = {
  contentItems: DynamicToolCallOutputContentItem[];
  success: boolean;
};
