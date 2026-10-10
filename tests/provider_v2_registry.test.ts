import { expect, test } from "bun:test";
import { ProviderRegistry, validateThreadSettings, validateTurnInput } from "../server/core/provider_registry.js";
import { readProviderDefaults } from "../server/runtime/provider_defaults.js";
import { capabilities, registration } from "./helpers/provider_v2.js";

test("a third provider registers without native identity branches and descriptor copies are isolated", async () => {
  const fixture = registration();
  const registry = new ProviderRegistry([fixture]);
  expect(registry.enumerate().map(({ id }) => id)).toEqual(["fixture-agent"]);
  expect((await registry.createSession("fixture-agent")).provider).toBe("fixture-agent");
  fixture.capabilities.inputKinds.push("asset");
  registry.descriptor("fixture-agent").capabilities.inputKinds.push("mention");
  expect(registry.descriptor("fixture-agent").capabilities.inputKinds).toEqual(["text"]);
  expect(() => registry.services("unknown")).toThrow("Unknown provider");
  expect(() => registry.services("__proto__")).toThrow("Unknown provider");
  expect(() => new ProviderRegistry([registration(), registration()])).toThrow("Duplicate provider");
  expect(() => new ProviderRegistry([registration("../native")])).toThrow("Invalid provider ID");
  const invalidDefault = registration();
  invalidDefault.defaults.sandboxMode = "workspace_write";
  expect(() => new ProviderRegistry([invalidDefault])).toThrow("workspace_write");
});

test("skill and reset capabilities come from optional services", () => {
  const fixture = registration();
  fixture.services.skills = { list: async () => [] };
  const resets = { supported: true, availableCount: 1, credits: null };
  fixture.services.account = { read: async () => { throw new Error("unused"); }, resets: {
    list: async () => resets, consume: async () => ({ outcome: "reset" }),
  } };
  const registry = new ProviderRegistry([fixture]);
  expect(registry.descriptor(fixture.id).capabilities.skills).toEqual({ list: true, configure: false });
  expect(registry.descriptor(fixture.id).capabilities.resets).toBe(true);
  expect(new ProviderRegistry([registration()]).descriptor("fixture-agent").capabilities.resets).toBe(false);
});

test("a lying descriptor or incorrectly bound session fails before initialization and is stopped", async () => {
  const fixture = registration();
  let stopped = 0, initialized = 0;
  const session = fixture.services.createSession();
  session.stop = async () => { stopped++; };
  session.initialize = async () => { initialized++; };
  fixture.capabilities.fork = true;
  await expect(new ProviderRegistry([fixture]).createSession(fixture.id)).rejects.toThrow("session ports");
  expect(stopped).toBe(1);
  expect(initialized).toBe(0);
  const wrong = registration();
  wrong.services.createSession = () => session;
  wrong.id = "different-agent";
  await expect(new ProviderRegistry([wrong]).createSession(wrong.id)).rejects.toThrow("session ports");
});

test("unsupported settings and any unsupported part reject before submitting a mixed request", () => {
  const support = capabilities();
  expect(() => validateThreadSettings(support, { cwd: "/fixture", model: null, effort: null, approvalMode: "bypass", sandboxMode: "unrestricted" })).toThrow("bypass");
  expect(() => validateThreadSettings(support, { cwd: "/fixture", model: null, effort: null, approvalMode: "provider_default", sandboxMode: "workspace_write" })).toThrow("workspace_write");
  expect(() => validateTurnInput(support, { input: [{ type: "text", text: "prompt" }, { type: "asset", assetId: "asset", media: "image" }] })).toThrow("asset");
  support.inputKinds.push("asset");
  expect(() => validateTurnInput(support, { input: [{ type: "asset", assetId: "asset", media: "image" }] })).toThrow("image");
  support.inputMedia.push("image");
  expect(() => validateTurnInput(support, { input: [{ type: "asset", assetId: "asset", media: "image" }] })).not.toThrow();
});

test("neutral defaults override native aliases and malformed defaults never silently fall back", () => {
  expect(readProviderDefaults({})).toEqual({});
  expect(readProviderDefaults({ CODEX_APPROVAL_POLICY: "on-request", CODEX_SANDBOX: "workspace-write" })).toEqual({ approvalMode: "review_sensitive", sandboxMode: "workspace_write" });
  expect(readProviderDefaults({ SHEPHERD_APPROVAL_MODE: "bypass", SHEPHERD_SANDBOX_MODE: "unrestricted", CODEX_APPROVAL_POLICY: "invalid", CODEX_SANDBOX: "invalid" })).toEqual({ approvalMode: "bypass", sandboxMode: "unrestricted" });
  expect(() => readProviderDefaults({ SHEPHERD_APPROVAL_MODE: "never" })).toThrow("SHEPHERD_APPROVAL_MODE");
  expect(() => readProviderDefaults({ CODEX_APPROVAL_POLICY: "__proto__" })).toThrow("alias");
});
