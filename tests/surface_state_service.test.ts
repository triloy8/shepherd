import { describe, expect, test } from "bun:test";

import { SurfaceStateService } from "../server/core/surface_state_service.js";

describe("SurfaceStateService", () => {
  test("stores project targets per adapter/surface pair", () => {
    const service = new SurfaceStateService();
    service.setProjectTarget("discord", "chan-1", {
      kind: "github",
      slug: "owner/repo",
      display: "owner/repo",
    });

    expect(service.getProjectTarget("discord", "chan-1")).toEqual({
      kind: "github",
      slug: "owner/repo",
      display: "owner/repo",
    });
    expect(service.getProjectTarget("discord", "chan-2")).toBeNull();
  });
});
