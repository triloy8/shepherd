import fs from "node:fs";
import path from "node:path";


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

function loadEnvFile(filePath: string, environment: Record<string, string | undefined>): string[] {
  if (!fs.existsSync(filePath)) return [];
  const parsed = parseEnvFile(fs.readFileSync(filePath, "utf8"));
  const loaded: string[] = [];
  for (const [key, value] of Object.entries(parsed)) {
    if (environment[key] !== undefined) continue;
    environment[key] = value;
    loaded.push(key);
  }
  return loaded;
}

/**
 * Load common settings into the host environment and return the environment
 * for child validation commands. Values inserted from the file are omitted
 * from that child environment so a later edit/removal is observed by the
 * fresh child process. Values that were already present remain explicit
 * launcher/process overrides and are retained.
 */
export function loadCommonEnvironment(
  environment: Record<string, string | undefined> = process.env,
  projectDir = process.cwd(),
): Record<string, string | undefined> {
  const childEnvironment = { ...environment };
  const loaded = loadEnvFile(path.resolve(projectDir, "envs/common.env"), environment);
  for (const key of loaded) delete childEnvironment[key];
  return childEnvironment;
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

export function readBoolean(value: string | undefined, name: string, defaultValue: boolean): boolean {
  if (value === undefined || value.trim() === "") return defaultValue;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new Error(`${name} must be true or false.`);
}
