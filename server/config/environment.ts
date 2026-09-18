import fs from "node:fs";
import path from "node:path";

import type { ApprovalPolicy } from "../../shared/protocol/requests.js";

function parseEnvFile(contents: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const separator = line.indexOf("=");
    if (separator <= 0) continue;

    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (key) result[key] = value;
  }
  return result;
}

function loadEnvFile(filePath: string): void {
  if (!fs.existsSync(filePath)) return;
  const parsed = parseEnvFile(fs.readFileSync(filePath, "utf8"));
  for (const [key, value] of Object.entries(parsed)) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

export function loadCommonEnvironment(): void {
  loadEnvFile(path.resolve(process.cwd(), "envs/common.env"));
}

/** Isolated scope: one adapter's file must not supply another's credentials. */
export function readSurfaceEnvironment(
  scope: string,
  environment: Record<string, string | undefined> = process.env,
  projectDir = process.cwd(),
): Record<string, string | undefined> {
  if (!/^[a-z][a-z0-9-]*$/.test(scope)) throw new Error("Invalid surface environment scope.");
  const file = path.resolve(projectDir, "envs", `${scope}.env`);
  const values = fs.existsSync(file) ? parseEnvFile(fs.readFileSync(file, "utf8")) : {};
  for (const [key, value] of Object.entries(environment)) {
    if (value !== undefined) values[key] = value;
  }
  return values;
}

export function readApprovalPolicy(value: string | undefined): ApprovalPolicy {
  const policy = value ?? "on-request";
  if (policy === "untrusted" || policy === "on-request" || policy === "never") {
    return policy;
  }
  throw new Error(`Invalid CODEX_APPROVAL_POLICY: ${policy}`);
}

export function readBoolean(value: string | undefined, name: string, defaultValue: boolean): boolean {
  if (value === undefined || value.trim() === "") return defaultValue;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new Error(`${name} must be true or false.`);
}
