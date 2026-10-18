import { expect, test } from "bun:test";
import { sessionProviders } from "./helpers/session_providers.js";
import type { TurnSettings } from "../server/ports/provider_session.js";
import { unsupportedModelInput, UnsupportedModelInputError } from "../shared/protocol/model_capabilities.js";
import type { ModelSummary } from "../shared/protocol/requests.js";
import { SessionManager } from "../server/core/conversation/session_manager.js";
import { modelsResponse } from "../server/providers/codex/responses.js";
import { claudeModelCatalog } from "../server/providers/claude/model_catalog.js";
import { IndependentSession } from "./helpers/independent_provider.js";
import { webHarness } from "./helpers/web_harness.js";

const model = (id: string, inputModalities: ModelSummary["inputModalities"], effort = "focused"): ModelSummary => ({
  id, displayName: id, description: "", hidden: false, isDefault: id === "third-model",
  inputModalities, supportedEfforts: [{ value: effort, description: "" }], defaultEffort: effort,
});

test("Codex models preserve native modalities, including audio, without granting them to every model", () => {
  const result = modelsResponse({ data: [
    { model: "text-only", inputModalities: ["text"] },
    { model: "multimodal", inputModalities: ["text", "image", "audio"] },
    { model: "legacy" }, { model: "unknown", inputModalities: null }, { model: "empty", inputModalities: [] },
  ] });
  expect(result.data.map(row => row.inputModalities)).toEqual([
    ["text"], ["text", "image", "audio"], ["text", "image"], null, [],
  ]);
});

test("Codex models without an effort list report efforts as unknown, not unsupported", () => {
  const result = modelsResponse({ data: [
    { model: "unreported" }, { model: "none", supportedReasoningEfforts: [] },
    { model: "listed", supportedReasoningEfforts: [{ reasoningEffort: "low", description: "Fast" }], defaultReasoningEffort: "low" },
  ] });
  expect(result.data.map(row => row.supportedEfforts)).toEqual([null, [], [{ value: "low", description: "Fast" }]]);
});

test("unknown modalities remain unknown and Claude does not claim disabled effort", () => {
  const row = claudeModelCatalog([{ value: "model", displayName: "Model", description: "", supportsEffort: false, supportedEffortLevels: ["medium"] }], { model: "model", effort: "medium" })[0]!;
  expect(row).toMatchObject({ inputModalities: null, supportedEfforts: [], defaultEffort: null });
  expect(unsupportedModelInput(row, [{ type: "image", url: "data:image/png;base64,AA" }])).toBeNull();
  expect(unsupportedModelInput(model("empty", []), [{ type: "text", text: "hello" }])).toBe("text");
});

test("file and URL inputs share modality checks; skill references are not model media", () => {
  const row = model("text", ["text"]);
  for (const input of [{ type: "image", url: "image" }, { type: "image_file", path: "/image" }] as const) {
    expect(unsupportedModelInput(row, [input])).toBe("image");
  }
  for (const input of [{ type: "audio", url: "audio" }, { type: "audio_file", path: "/audio" }] as const) {
    expect(unsupportedModelInput(row, [input])).toBe("audio");
  }
  expect(unsupportedModelInput(row, [{ type: "skill", name: "skill", path: "/skill" }])).toBeNull();
});

test("submission uses the next or explicitly requested model; steering keeps the active model", async () => {
  const session = new IndependentSession();
  let starts = 0, steers = 0;
  session.onTurn = () => { starts++; };
  session.steerTurn = async () => { steers++; return "turn"; };
  session.listModels = async request => request?.cursor
    ? { data: [model("vision", ["text", "image"])], nextCursor: null }
    : { data: [model("third-model", ["text"])], nextCursor: "next" };
  const manager = new SessionManager(undefined, sessionProviders(() => session));
  try {
    const { threadId } = await manager.createThread({ cwd: "/tmp" });
    const input = [{ type: "image" as const, url: "data:image/png;base64,AA" }];
    await expect(manager.submitTurn(threadId, { input })).rejects.toThrow("image inputs");
    manager.setThreadModel(threadId, "vision");
    await expect(manager.steerTurn(threadId, { input })).rejects.toThrow("image inputs");
    await expect(manager.submitTurn(threadId, { input, model: "third-model" })).rejects.toThrow("image inputs");
    expect(starts).toBe(0); expect(steers).toBe(0);
    await manager.submitTurn(threadId, { input });
    expect(starts).toBe(1);
    expect((await manager.getThreadEffort(threadId)).inputModalities).toEqual(["text", "image"]);
    await manager.steerTurn(threadId, { input });
    expect(steers).toBe(1);
  } finally { manager.stopAll(); }
});

test("model support cannot bypass adapter input restrictions", async () => {
  const session = new IndependentSession();
  session.listModels = async () => ({ data: [model("third-model", ["text", "audio"])], nextCursor: null });
  session.onTurn = () => { throw new Error("must not execute"); };
  const manager = new SessionManager(undefined, sessionProviders(() => session));
  try {
    const { threadId } = await manager.createThread({ cwd: "/tmp" });
    await expect(manager.submitTurn(threadId, { input: [{ type: "audio", url: "data:audio/wav;base64,AA" }] })).rejects.toThrow("audio inputs");
  } finally { manager.stopAll(); }
});

test("a model switch replaces unsupported inherited effort with the new model default", async () => {
  const session = new IndependentSession();
  const starts: TurnSettings[] = [];
  session.onTurn = (_input, settings) => { starts.push(settings); };
  session.listModels = async () => ({ data: [model("third-model", ["text"]), model("quick-model", ["text"], "quick")], nextCursor: null });
  const manager = new SessionManager(undefined, sessionProviders(() => session));
  try {
    const { threadId } = await manager.createThread({ cwd: "/tmp" });
    manager.setThreadModel(threadId, "quick-model");
    await manager.submitTurn(threadId, { input: [{ type: "text", text: "hello" }] });
    expect(starts[0]?.effort).toBe("quick");
    expect((await manager.getThreadEffort(threadId)).currentEffort).toBe("quick");
  } finally { manager.stopAll(); }
});

test("web callers get a model-specific unsupported-input error", async () => {
  const h = webHarness();
  h.context.ingress.submitTurn = async () => { throw new UnsupportedModelInputError("text-only", "image"); };
  try {
    const conversation = await h.create();
    const response = await h.request(`/conversations/${conversation.id}/messages`, "POST", { text: "hello" });
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: { code: "unsupported_model_input", message: 'Model "text-only" does not support image inputs.' } });
  } finally { h.api.dispose(); }
});

test("Claude effort discovery distinguishes unknown, empty, disabled and reported metadata", () => {
  const rows = claudeModelCatalog([
    { value: "unknown", displayName: "Unknown", description: "" },
    { value: "supported-unreported", displayName: "Supported", description: "", supportsEffort: true },
    { value: "empty", displayName: "Empty", description: "", supportedEffortLevels: [] },
    { value: "disabled", displayName: "Disabled", description: "", supportsEffort: false, supportedEffortLevels: ["high"] },
    { value: "reported", displayName: "Reported", description: "", supportedEffortLevels: ["high"] },
  ], { model: "unknown", effort: "high" });
  expect(rows.map(row => row.supportedEfforts)).toEqual([null, null, [], [], [{ value: "high", description: "" }]]);
  expect(rows.map(row => row.defaultEffort)).toEqual([null, null, null, null, "high"]);
});
