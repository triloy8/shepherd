import { describe, expect, test } from "bun:test";

import {
  validateCreateThreadRequest,
  validateListStoredThreadsRequest,
  validateSubmitTurnRequest,
} from "../shared/protocol/validation.js";

describe("application protocol validation", () => {
  test("rejects the removed on-failure approval policy", () => {
    expect(() => validateCreateThreadRequest({ approvalPolicy: "on-failure" })).toThrow(
      "Invalid approval policy.",
    );
  });

  test("rejects native granular policies and accepts only application modes", () => {
    expect(() => validateCreateThreadRequest({ approvalPolicy: { granular: { sandbox_approval: true } } })).toThrow("Invalid approval policy");
    for (const approvalPolicy of ["provider_default", "review_sensitive", "review_untrusted", "bypass"]) {
      expect(validateCreateThreadRequest({ approvalPolicy }).approvalPolicy).toBe(approvalPolicy);
    }
    for (const approvalPolicy of ["never", "on-request", "untrusted", "review_all"]) expect(() => validateCreateThreadRequest({ approvalPolicy })).toThrow("Invalid approval policy");
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
  });
});
