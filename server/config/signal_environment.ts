import { readBoolean } from "./environment.js";

export type SignalRuntimeConfig = {
  enabled: boolean;
  hostname: string;
  port: number;
  maxBodyBytes: number;
  queueCapacity: number;
  researchDiscordSurfaceId?: string;
};

function readInteger(
  value: string | undefined,
  name: string,
  defaultValue: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined || value.trim() === "") return defaultValue;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}.`);
  }
  return parsed;
}

function optionalTrimmed(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function readSignalRuntimeConfig(
  environment: Record<string, string | undefined> = process.env,
): SignalRuntimeConfig {
  return {
    enabled: readBoolean(
      environment.SHEPHERD_SIGNAL_WEBHOOK_ENABLED,
      "SHEPHERD_SIGNAL_WEBHOOK_ENABLED",
      false,
    ),
    hostname: optionalTrimmed(environment.SHEPHERD_SIGNAL_WEBHOOK_HOST) ?? "127.0.0.1",
    port: readInteger(
      environment.SHEPHERD_SIGNAL_WEBHOOK_PORT,
      "SHEPHERD_SIGNAL_WEBHOOK_PORT",
      8787,
      1,
      65_535,
    ),
    maxBodyBytes: readInteger(
      environment.SHEPHERD_SIGNAL_WEBHOOK_MAX_BODY_BYTES,
      "SHEPHERD_SIGNAL_WEBHOOK_MAX_BODY_BYTES",
      64 * 1024,
      1,
      10 * 1024 * 1024,
    ),
    queueCapacity: readInteger(
      environment.SHEPHERD_SIGNAL_QUEUE_CAPACITY,
      "SHEPHERD_SIGNAL_QUEUE_CAPACITY",
      100,
      1,
      10_000,
    ),
    ...(optionalTrimmed(environment.SHEPHERD_RESEARCH_SIGNAL_DISCORD_CHANNEL_ID)
      ? {
          researchDiscordSurfaceId: optionalTrimmed(
            environment.SHEPHERD_RESEARCH_SIGNAL_DISCORD_CHANNEL_ID,
          ),
        }
      : {}),
  };
}
