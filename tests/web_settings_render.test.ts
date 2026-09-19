import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AccountLimits, ContextUsage } from "../ui/src/components/Usage";

test("usage distinguishes missing telemetry and unknown values from zero", () => {
  expect(renderToStaticMarkup(createElement(ContextUsage, { usage: null }))).toContain("No context telemetry yet");
  expect(renderToStaticMarkup(createElement(AccountLimits, { value: null }))).toContain("unavailable");
  const html = renderToStaticMarkup(createElement(AccountLimits, { value: { primary: { usedPercent: 0, resetsAt: null }, credits: { unlimited: true } } }));
  expect(html).toContain("0% used"); expect(html).toContain("Resets: Unknown"); expect(html).toContain("Unlimited");
});

test("account labels are escaped and invalid reset times are not rendered as dates", () => {
  const html = renderToStaticMarkup(createElement(AccountLimits, { value: { planType: "<script>alert(1)</script>", primary: { usedPercent: NaN, resetsAt: 1e100 } } }));
  expect(html).not.toContain("<script>"); expect(html).not.toContain("Invalid Date"); expect(html).not.toContain("NaN");
});
