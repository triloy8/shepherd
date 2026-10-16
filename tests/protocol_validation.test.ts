import { describe, expect, test } from "bun:test";

import {
  validateCreateThreadRequest,
  validateForkThreadRequest,
  validateResumeThreadRequest,
  validateListStoredThreadsRequest,
  validateSubmitTurnRequest,
  validateSkillsListRequest,
} from "../shared/protocol/validation.js";

describe("application protocol validation", () => {
  test("skill discovery accepts refresh but cannot redirect the conversation workspace", () => {
    expect(validateSkillsListRequest({ refresh: true })).toEqual({ refresh: true });
    for (const request of [{ cwds: ["/other"] }, { workspacePath: "/other" }, { forceReload: true }]) expect(() => validateSkillsListRequest(request)).toThrow("Invalid skills list payload");
  });
  test("thread requests take one execution policy and reject the removed approval and sandbox modes", () => {
    const policy = { writes: "workspace", network: "none", review: "risky" };
    for (const validate of [validateCreateThreadRequest, validateResumeThreadRequest, validateForkThreadRequest]) {
      expect(validate({ policy }).policy).toEqual(policy);
      expect(validate({}).policy).toBeUndefined();
      for (const removed of [{ approvalPolicy: "bypass" }, { sandbox: "read_only" }]) expect(() => validate(removed)).toThrow("Unsupported request field");
    }
    for (const invalid of [{ ...policy, writes: "danger-full-access" }, { ...policy, review: "untrusted" }, { writes: "any" }, { ...policy, extra: "x" }, "bypass"]) {
      expect(() => validateCreateThreadRequest({ policy: invalid })).toThrow("Invalid execution policy");
    }
    expect(() => validateSubmitTurnRequest({ input: "hi", approvalPolicy: "bypass" })).toThrow("Unsupported request field: approvalPolicy");
  });

  test("accepts shared sorting and multiple workspace filters; rejects native listing knobs", () => {
    expect(validateListStoredThreadsRequest({ cwd: ["/one", "/two"], sortKey: "updated_at", sortDirection: "asc" })).toMatchObject({ cwd: ["/one", "/two"], sortKey: "updated_at", sortDirection: "asc" });
    for (const key of ["sourceKinds", "useStateDbOnly", "modelProviders"]) expect(() => validateListStoredThreadsRequest({ [key]: true })).toThrow(`Unsupported request field: ${key}`);
    expect(() => validateListStoredThreadsRequest({ sortKey: "recency_at" })).toThrow("Invalid sort key");
  });

  test("accepts current audio, file, and image-detail input variants", () => {
    expect(
      validateSubmitTurnRequest({
        input: [
          { type: "image", url: "https://example.com/image.png", detail: "high" },
          { type: "image_file", path: "/tmp/image.png" },
          { type: "audio", url: "https://example.com/audio.mp3" },
          { type: "audio_file", path: "/tmp/audio.wav" },
        ],
      }).input,
    ).toEqual([
      { type: "image", url: "https://example.com/image.png", detail: "high" },
      { type: "image_file", path: "/tmp/image.png" },
      { type: "audio", url: "https://example.com/audio.mp3" },
      { type: "audio_file", path: "/tmp/audio.wav" },
    ]);
  });

  test("rejects native input kinds and text fields rather than silently dropping them", () => {
    expect(() => validateSubmitTurnRequest({ input: [{ type: "text", text: "hello", text_elements: [] }] })).toThrow("Unsupported request field: text_elements");
    expect(() => validateSubmitTurnRequest({ input: [{ type: "text", text: "hello", annotations: [] }] })).toThrow("Unsupported request field: annotations");
    for (const type of ["localImage", "localAudio", "mention"]) expect(() => validateSubmitTurnRequest({ input: [{ type, path: "/tmp/x", name: "x" }] })).toThrow("Invalid input.");
    // Image detail uses application values; Codex's "auto" and "original" are encoded in its adapter.
    for (const detail of ["auto", "original"]) expect(() => validateSubmitTurnRequest({ input: [{ type: "image", url: "https://example.com/a.png", detail }] })).toThrow("Invalid input.");
    expect(validateSubmitTurnRequest({ input: [{ type: "image_file", path: "/tmp/a.png", detail: "full" }] }).input).toEqual([{ type: "image_file", path: "/tmp/a.png", detail: "full" }]);
  });
});
