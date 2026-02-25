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

function loadEnvFile(filePath: string): void {
  if (!fs.existsSync(filePath)) return;
  const parsed = parseEnvFile(fs.readFileSync(filePath, "utf8"));
  for (const [key, value] of Object.entries(parsed)) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

export function loadEnvironment(scope: "http" | "discord" | "all"): void {
  const envsDir = path.resolve(process.cwd(), "envs");
  const legacyDir = path.resolve(process.cwd(), "environment");
  const envDir = fs.existsSync(envsDir) ? envsDir : legacyDir;
  loadEnvFile(path.join(envDir, "common.env"));
  loadEnvFile(path.join(envDir, `${scope}.env`));
}
