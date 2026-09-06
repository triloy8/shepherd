import type { UserInput } from "../../shared/protocol/user_input.js";
import type { SignalEnvelope, SignalSubject } from "../../shared/protocol/signals.js";

const SIGNAL_KIND_PATTERN = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/;
const ENVELOPE_KEYS = new Set(["kind", "version", "subject", "payload"]);
const SUBJECT_KEYS = new Set(["type", "id"]);

export type SignalTarget = {
  type: "conversation";
  threadId: string;
  cwd: string;
  delivery: {
    adapter: string;
    surfaceId: string;
  };
};

export type SignalDefinition<TPayload> = {
  kind: string;
  version: number;
  validatePayload: (value: unknown) => TPayload;
  buildInput: (signal: SignalEnvelope<TPayload>) => UserInput[];
  coalesceKey?: (signal: SignalEnvelope<TPayload>) => string;
  isTerminal?: (signal: SignalEnvelope<TPayload>) => boolean;
};

export type RegisteredSignal = {
  envelope: SignalEnvelope;
  target: SignalTarget;
  input: UserInput[];
  coalesceKey: string | null;
  terminal: boolean;
};

export class InvalidSignalError extends Error {}
export class UnknownSignalKindError extends Error {}
export class UnsupportedSignalVersionError extends Error {}

export function assertSignalTarget(target: SignalTarget): void {
  if (
    target.type !== "conversation" ||
    !target.threadId.trim() ||
    target.threadId !== target.threadId.trim() ||
    !target.cwd.trim() ||
    target.cwd !== target.cwd.trim() ||
    !target.delivery.adapter.trim() ||
    target.delivery.adapter !== target.delivery.adapter.trim() ||
    !target.delivery.surfaceId.trim() ||
    target.delivery.surfaceId !== target.delivery.surfaceId.trim()
  ) {
    throw new InvalidSignalError("Signal has an invalid trusted target.");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readNonEmptyString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new InvalidSignalError(`Signal ${name} must be a non-empty string.`);
  }
  return value.trim();
}

function rejectUnknownKeys(value: Record<string, unknown>, allowed: Set<string>, name: string): void {
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) throw new InvalidSignalError(`Unknown ${name} field: ${unknown}.`);
}

function parseSubject(value: unknown): SignalSubject | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new InvalidSignalError("Signal subject must be an object.");
  rejectUnknownKeys(value, SUBJECT_KEYS, "signal subject");
  return {
    type: readNonEmptyString(value.type, "subject.type"),
    id: readNonEmptyString(value.id, "subject.id"),
  };
}

export function parseSignalEnvelope(value: unknown): SignalEnvelope {
  if (!isRecord(value)) throw new InvalidSignalError("Signal body must be an object.");
  rejectUnknownKeys(value, ENVELOPE_KEYS, "signal");

  const kind = readNonEmptyString(value.kind, "kind");
  if (!SIGNAL_KIND_PATTERN.test(kind)) {
    throw new InvalidSignalError("Signal kind must be a lowercase dotted name.");
  }
  if (!Number.isInteger(value.version) || Number(value.version) < 1) {
    throw new InvalidSignalError("Signal version must be a positive integer.");
  }
  if (!Object.hasOwn(value, "payload")) {
    throw new InvalidSignalError("Signal payload is required.");
  }

  return {
    kind,
    version: Number(value.version),
    ...(value.subject === undefined ? {} : { subject: parseSubject(value.subject) }),
    payload: value.payload,
  };
}

export class SignalRegistry {
  private readonly definitions = new Map<string, SignalDefinition<unknown>>();
  private readonly versionsByKind = new Map<string, Set<number>>();

  register<TPayload>(definition: SignalDefinition<TPayload>): void {
    const envelope = parseSignalEnvelope({
      kind: definition.kind,
      version: definition.version,
      payload: null,
    });
    const key = this.key(envelope.kind, envelope.version);
    if (this.definitions.has(key)) {
      throw new Error(`Signal definition already registered: ${key}.`);
    }
    this.definitions.set(key, definition as SignalDefinition<unknown>);
    const versions = this.versionsByKind.get(envelope.kind) ?? new Set<number>();
    versions.add(envelope.version);
    this.versionsByKind.set(envelope.kind, versions);
  }

  has(kind: string, version: number): boolean {
    return this.definitions.has(this.key(kind, version));
  }

  resolve(
    value: unknown,
    target: SignalTarget,
    coalesceScope?: string,
  ): RegisteredSignal {
    return this.resolveEnvelope(parseSignalEnvelope(value), target, coalesceScope);
  }

  resolveEnvelope(
    envelope: SignalEnvelope,
    target: SignalTarget,
    coalesceScope?: string,
  ): RegisteredSignal {
    const versions = this.versionsByKind.get(envelope.kind);
    if (!versions) throw new UnknownSignalKindError(`Unknown signal kind: ${envelope.kind}.`);

    const definition = this.definitions.get(this.key(envelope.kind, envelope.version));
    if (!definition) {
      throw new UnsupportedSignalVersionError(
        `Unsupported ${envelope.kind} signal version: ${envelope.version}.`,
      );
    }

    let payload: unknown;
    try {
      payload = definition.validatePayload(envelope.payload);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid signal payload.";
      throw new InvalidSignalError(message);
    }

    const typedEnvelope: SignalEnvelope = { ...envelope, payload };
    const input = definition.buildInput(typedEnvelope);
    if (input.length === 0) throw new InvalidSignalError("Signal definition produced no input.");
    const rawCoalesceKey = definition.coalesceKey?.(typedEnvelope)?.trim() ?? null;
    const terminal = definition.isTerminal?.(typedEnvelope) ?? false;
    assertSignalTarget(target);

    return {
      envelope: typedEnvelope,
      target,
      input,
      coalesceKey: rawCoalesceKey
        ? `${coalesceScope ? `${coalesceScope}:` : ""}${typedEnvelope.kind}@${typedEnvelope.version}:${rawCoalesceKey}`
        : null,
      terminal,
    };
  }

  private key(kind: string, version: number): string {
    return `${kind}@${version}`;
  }
}
