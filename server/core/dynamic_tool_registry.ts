import type {
  DynamicToolCallParams,
  DynamicToolCallResponse,
  DynamicToolSpec,
  JsonValue,
} from "../../shared/protocol/dynamic_tools.js";

const TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;

export type DynamicToolRegistration = {
  namespace: string | null;
  namespaceDescription?: string;
  name: string;
  description: string;
  inputSchema: JsonValue;
  deferLoading?: boolean;
  execute: (params: DynamicToolCallParams) => Promise<DynamicToolCallResponse>;
};

export class InvalidDynamicToolCallError extends Error {}
export class UnknownDynamicToolError extends Error {}

function toolKey(namespace: string | null, name: string): string {
  return `${namespace ?? ""}\u0000${name}`;
}

function assertName(value: string, label: string): void {
  if (!value || !TOOL_NAME_PATTERN.test(value)) {
    throw new Error(`${label} must contain only letters, numbers, underscores, or hyphens.`);
  }
}

export class DynamicToolRegistry {
  private readonly registrations = new Map<string, DynamicToolRegistration>();

  register(registration: DynamicToolRegistration): () => void {
    assertName(registration.name, "Dynamic tool name");
    if (registration.namespace !== null) {
      assertName(registration.namespace, "Dynamic tool namespace");
      if (!registration.namespaceDescription?.trim()) {
        throw new Error("Namespaced dynamic tools require a namespace description.");
      }
    }
    if (!registration.description.trim()) {
      throw new Error("Dynamic tool description is required.");
    }
    for (const existing of this.registrations.values()) {
      if (
        registration.namespace !== null &&
        existing.namespace === registration.namespace &&
        existing.namespaceDescription !== registration.namespaceDescription
      ) {
        throw new Error(
          `Dynamic tool namespace ${registration.namespace} has conflicting descriptions.`,
        );
      }
      if (
        (registration.namespace === null && existing.namespace === registration.name) ||
        (existing.namespace === null && registration.namespace === existing.name)
      ) {
        throw new Error("Dynamic tool names cannot collide with namespace names.");
      }
    }

    const key = toolKey(registration.namespace, registration.name);
    if (this.registrations.has(key)) {
      throw new Error(
        `Dynamic tool already registered: ${registration.namespace ? `${registration.namespace}.` : ""}${registration.name}.`,
      );
    }
    this.registrations.set(key, registration);
    return () => {
      if (this.registrations.get(key) === registration) {
        this.registrations.delete(key);
      }
    };
  }

  hasTools(): boolean {
    return this.registrations.size > 0;
  }

  specifications(): DynamicToolSpec[] {
    const standalone: DynamicToolSpec[] = [];
    const namespaces = new Map<
      string,
      { description: string; tools: Extract<DynamicToolSpec, { type: "function" }>[] }
    >();

    for (const registration of this.registrations.values()) {
      const functionSpec: Extract<DynamicToolSpec, { type: "function" }> = {
        type: "function",
        name: registration.name,
        description: registration.description,
        inputSchema: registration.inputSchema,
        ...(registration.deferLoading === undefined
          ? {}
          : { deferLoading: registration.deferLoading }),
      };
      if (registration.namespace === null) {
        standalone.push(functionSpec);
        continue;
      }

      const namespace = namespaces.get(registration.namespace) ?? {
        description: registration.namespaceDescription as string,
        tools: [],
      };
      namespace.tools.push(functionSpec);
      namespaces.set(registration.namespace, namespace);
    }

    for (const [name, namespace] of namespaces) {
      standalone.push({
        type: "namespace",
        name,
        description: namespace.description,
        tools: namespace.tools,
      });
    }
    return standalone;
  }

  execute(params: DynamicToolCallParams): Promise<DynamicToolCallResponse> {
    const registration = this.registrations.get(toolKey(params.namespace, params.tool));
    if (!registration) {
      throw new UnknownDynamicToolError(
        `Unknown dynamic tool: ${params.namespace ? `${params.namespace}.` : ""}${params.tool}.`,
      );
    }
    return registration.execute(params);
  }
}
