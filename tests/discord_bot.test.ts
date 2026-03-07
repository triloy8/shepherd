import { describe, expect, test } from "bun:test";

import { phaseHeader } from "../server/adapters/discord/bot.js";

describe("Discord bot phaseHeader", () => {
  test("adds a blank line after the working title at the start of a message", () => {
    expect(phaseHeader("commentary", false)).toBe("**🧠 Working**\n\n");
  });

  test("adds spacing before and after the final answer title when appending", () => {
    expect(phaseHeader("final", true)).toBe("\n\n**📦 Final Answer**\n\n");
  });
});
