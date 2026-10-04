import { expect, test } from "bun:test";
import { humanizeUsageId, usageTitle } from "../ui/src/usage-title";
import type { ModelSummary } from "../shared/protocol/requests";
const models = [{ id: "catalog-id", model: "future-model-v2", displayName: "Future Model V2" }] as ModelSummary[];
test("usage titles resolve model names by slug or catalog ID and retain the quota label", () => {
  for (const normalModelSlug of ["future-model-v2", "catalog-id"]) expect(usageTitle("internal_bucket", { normalModelSlug, limitName: "Reserve allowance" }, models)).toEqual({ title: "Future Model V2", subtitle: "Reserve allowance" });
  expect(usageTitle("internal", { normalModelSlug: "future-model-v2", limitName: "Future Model V2" }, models).subtitle).toBeNull();
});
test("unavailable model metadata falls back to provider labels, then humanized IDs", () => {
  expect(usageTitle("internal_bucket", { normalModelSlug: "unlisted", limitName: "  Provider Label-v2  " }, models)).toEqual({ title: "Provider Label-v2", subtitle: null });
  for (const value of [null, {}, { normalModelSlug: 42, limitName: " " }]) expect(usageTitle("new_feature-quota", value, models)).toEqual({ title: "New feature quota", subtitle: null });
  expect(humanizeUsageId(" ___ ")).toBe("Usage allowance");
  expect(usageTitle("internal", { normalModelSlug: "future-model-v2", limitName: "Quota" }, [{ ...models[0]!, displayName: " " }])).toEqual({ title: "Quota", subtitle: null });
});
