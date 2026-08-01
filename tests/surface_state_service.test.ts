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

  test("tracks listening modes and resumes the mode active before a pause", () => {
    const service = new SurfaceStateService();

    expect(service.getListeningMode("discord", "chan-1")).toBe("mention");
    expect(service.setListeningMode("discord", "chan-1", "open")).toBe("open");
    expect(service.pauseListening("discord", "chan-1")).toBe("paused");
    expect(service.getListeningMode("discord", "chan-1")).toBe("paused");
    expect(service.resumeListening("discord", "chan-1")).toBe("open");

    service.resetListeningMode("discord", "chan-1");
    expect(service.getListeningMode("discord", "chan-1")).toBe("mention");
  });
});
