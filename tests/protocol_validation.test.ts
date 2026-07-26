import { describe, expect, test } from "bun:test";

import {
  validateCreateThreadRequest,
  validateListStoredThreadsRequest,
  validateSubmitTurnRequest,
} from "../shared/protocol/validation.js";

describe("generated protocol validation parity", () => {
  test("rejects the removed on-failure approval policy", () => {
    expect(() => validateCreateThreadRequest({ approvalPolicy: "on-failure" })).toThrow(
      "Invalid approval policy.",
    );
  });

  test("accepts the generated granular approval policy", () => {
    const granular = {
      granular: {
        sandbox_approval: true,
        rules: false,
        skill_approval: true,
        request_permissions: false,
        mcp_elicitations: true,
      },
    };
    expect(validateCreateThreadRequest({ approvalPolicy: granular }).approvalPolicy).toEqual(granular);
  });

  test("accepts recency sorting, direction, state-db reads, and multiple cwd filters", () => {
    expect(
      validateListStoredThreadsRequest({
        cwd: ["/one", "/two"],
        sortKey: "recency_at",
        sortDirection: "asc",
        useStateDbOnly: true,
      }),
    ).toEqual({
      archived: undefined,
      cursor: undefined,
      cwd: ["/one", "/two"],
      limit: undefined,
      modelProviders: undefined,
      searchTerm: undefined,
      sortDirection: "asc",
      sortKey: "recency_at",
      sourceKinds: undefined,
      useStateDbOnly: true,
    });
  });

  test("accepts current audio and image-detail input variants", () => {
    expect(
      validateSubmitTurnRequest({
        input: [
          { type: "image", url: "https://example.com/image.png", detail: "high" },
          { type: "audio", url: "https://example.com/audio.mp3" },
          { type: "localAudio", path: "/tmp/audio.wav" },
        ],
      }).input,
    ).toEqual([
      { type: "image", url: "https://example.com/image.png", detail: "high" },
      { type: "audio", url: "https://example.com/audio.mp3" },
      { type: "localAudio", path: "/tmp/audio.wav" },
    ]);
  });

  test("validates structured text elements", () => {
    expect(() =>
      validateSubmitTurnRequest({
        input: [
          {
            type: "text",
            text: "hello",
            text_elements: [{ byteRange: { start: 4, end: 2 }, placeholder: null }],
          },
        ],
      }),
    ).toThrow("Invalid input.");
  });
});
