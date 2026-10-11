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

/** Tool media contains standard padded base64 bytes and a matching MIME type.
 * Provider adapters choose the native encoding; remote URLs are not tool media. */
export type DynamicToolCallOutputContentItem =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "audio"; data: string; mimeType: string };

export type DynamicToolCallResponse = {
  contentItems: DynamicToolCallOutputContentItem[];
  success: boolean;
};

/** Validate application output before it crosses either provider boundary. */
export function assertDynamicToolResponse(response: DynamicToolCallResponse): void {
  if (!response || typeof response.success !== "boolean" || !Array.isArray(response.contentItems)) {
    throw new Error("Invalid dynamic tool response.");
  }
  for (const item of response.contentItems) {
    if (item?.type === "text" && typeof item.text === "string") continue;
    if (item?.type !== "image" && item?.type !== "audio") throw new Error("Invalid dynamic tool content item.");
    if (typeof item.mimeType !== "string" || !new RegExp(`^${item.type}/[A-Za-z0-9!#$&^_.+-]+$`).test(item.mimeType)) {
      throw new Error("Tool media MIME type must match its image or audio type.");
    }
    if (typeof item.data !== "string" || !item.data || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(item.data)) {
      throw new Error("Tool media must contain standard padded base64 data.");
    }
  }
}
