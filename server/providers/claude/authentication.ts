import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Keep credential policy inside the Claude adapter. Never change the host's
// environment: Codex and other host services can use different credentials.
const apiEnvironmentKeys = [
  "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL",
  "ANTHROPIC_PROFILE", "ANTHROPIC_FEDERATION_RULE_ID", "ANTHROPIC_ORGANIZATION_ID",
  "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_ANTHROPIC_AWS", "CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD",
] as const;

export function claudeAuthenticationOptions(
  environment: Record<string, string | undefined> = process.env,
) {
  const mode = environment.CLAUDE_AUTH_MODE ?? "subscription";
  if (mode === "api") return { env: { ...environment } };
  if (mode !== "subscription") {
    throw new Error("CLAUDE_AUTH_MODE must be subscription or api.");
  }

  // Empty flag settings also override credentials injected by user/project
  // settings. A missing or expired subscription must not fall back to an API key.
  const cleared = Object.fromEntries(apiEnvironmentKeys.map(key => [key, ""]));
  return {
    env: { ...environment, ...cleared },
    settings: { forceLoginMethod: "claudeai" as const, apiKeyHelper: "", env: cleared },
  };
}

/**
 * Fingerprint of the credentials Claude would use. Values derived from one login
 * (limits, model lists) must not be reused after it changes. The fingerprint is private.
 */
export function claudeCredentialScope(): string {
  const env = claudeAuthenticationOptions().env;
  let savedLogin: [number, number, number] | null = null;
  try {
    const stat = statSync(join(env.CLAUDE_CONFIG_DIR ?? join(env.HOME ?? homedir(), ".claude"), ".credentials.json"));
    savedLogin = [stat.ino, stat.mtimeMs, stat.size];
  } catch { /* Keychain-backed installations need not have a credential file. */ }
  return createHash("sha256").update(JSON.stringify([
    env.HOME, env.CLAUDE_CONFIG_DIR, env.CLAUDE_AUTH_MODE ?? "subscription",
    env.CLAUDE_CODE_OAUTH_TOKEN, env.ANTHROPIC_API_KEY, env.ANTHROPIC_AUTH_TOKEN,
    env.ANTHROPIC_PROFILE, env.CLAUDE_CODE_USE_BEDROCK, env.CLAUDE_CODE_USE_VERTEX,
    env.CLAUDE_CODE_USE_FOUNDRY,
    savedLogin,
  ])).digest("hex");
}
