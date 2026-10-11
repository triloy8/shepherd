import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ContextUsage } from "../ui/src/components/Usage";

test("usage distinguishes missing telemetry and unreported counts from zero", () => {
  expect(renderToStaticMarkup(createElement(ContextUsage, { usage: null }))).toContain("No context telemetry yet");
  const breakdown = { inputTokens: 10, cacheReadInputTokens: 0, cacheWriteInputTokens: null, outputTokens: 5, reasoningOutputTokens: null, totalTokens: 15 };
  const html = renderToStaticMarkup(createElement(ContextUsage, { usage: { last: breakdown, total: breakdown, contextWindow: null } }));
  expect(html).toContain("10 / 0 / Not reported"); expect(html).toContain("5 / Not reported"); expect(html).toContain("Unknown");
});
