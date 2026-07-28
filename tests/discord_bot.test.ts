import { describe, expect, test } from "bun:test";

import { readBoolean } from "../server/config/environment.js";

describe("Discord delivery configuration", () => {
  test("keeps Discord final-answer streaming off by default", () => {
    expect(readBoolean(undefined, "SHEPHERD_DISCORD_STREAMING", false)).toBe(false);
  });

  test("accepts common explicit boolean values", () => {
    expect(readBoolean("true", "SHEPHERD_DISCORD_STREAMING", false)).toBe(true);
    expect(readBoolean("off", "SHEPHERD_DISCORD_STREAMING", true)).toBe(false);
  });

  test("rejects ambiguous streaming values", () => {
    expect(() => readBoolean("sometimes", "SHEPHERD_DISCORD_STREAMING", false)).toThrow(
      "SHEPHERD_DISCORD_STREAMING must be true or false.",
    );
  });
});
