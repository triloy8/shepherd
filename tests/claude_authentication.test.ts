import { expect, test } from "bun:test";
import { claudeAuthenticationOptions } from "../server/providers/claude/authentication.js";

test("Claude defaults to subscription credentials without changing host credentials", () => {
  const host = {
    PATH: "/bin", HOME: "/home/test", CLAUDE_CONFIG_DIR: "/claude",
    CLAUDE_CODE_OAUTH_TOKEN: "test-subscription-token",
    ANTHROPIC_API_KEY: "test-api-key", ANTHROPIC_AUTH_TOKEN: "test-bearer",
    ANTHROPIC_BASE_URL: "https://example.invalid", ANTHROPIC_PROFILE: "console",
    CLAUDE_CODE_USE_BEDROCK: "1", CLAUDE_CODE_USE_VERTEX: "1",
    CLAUDE_CODE_USE_FOUNDRY: "1", CLAUDE_CODE_USE_ANTHROPIC_AWS: "1",
  };
  const options = claudeAuthenticationOptions(host);
  expect(options.env.CLAUDE_CODE_OAUTH_TOKEN).toBe(host.CLAUDE_CODE_OAUTH_TOKEN);
  expect(options.env.CLAUDE_CONFIG_DIR).toBe(host.CLAUDE_CONFIG_DIR);
  expect(options.env.PATH).toBe(host.PATH);
  expect(options.env.HOME).toBe(host.HOME);
  for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "ANTHROPIC_PROFILE", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY", "CLAUDE_CODE_USE_ANTHROPIC_AWS"]) {
    expect(options.env[key]).toBe("");
    expect(options.settings?.env[key]).toBe("");
  }
  expect(options.settings?.apiKeyHelper).toBe("");
  expect(options.settings?.forceLoginMethod).toBe("claudeai");
  expect(host.ANTHROPIC_API_KEY).toBe("test-api-key");
  expect(host.CLAUDE_CODE_USE_BEDROCK).toBe("1");
});

test("API authentication requires an explicit mode and retains configured backends", () => {
  const host = { CLAUDE_AUTH_MODE: "api", ANTHROPIC_API_KEY: "test-api-key", CLAUDE_CODE_USE_BEDROCK: "1" };
  const options = claudeAuthenticationOptions(host);
  expect(options.env).toEqual(host);
  expect(options.env).not.toBe(host);
  expect(options.settings).toBeUndefined();
});

test("missing subscription credentials cannot select an inherited API key", () => {
  const options = claudeAuthenticationOptions({ ANTHROPIC_API_KEY: "test-api-key" });
  expect(options.env.ANTHROPIC_API_KEY).toBe("");
  expect(options.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
});

test("invalid authentication modes fail without printing credentials", () => {
  expect(() => claudeAuthenticationOptions({ CLAUDE_AUTH_MODE: "test-secret" }))
    .toThrow("CLAUDE_AUTH_MODE must be subscription or api.");
});
