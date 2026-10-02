import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readHostBattery } from "../server/adapters/web/host_battery";
import { BatteryIndicator } from "../ui/src/components/HostBattery";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { webHarness } from "./helpers/web_harness";

test("host battery discovery handles Android, desktop, peripheral and invalid supplies", async () => {
  const root = await mkdtemp(join(tmpdir(), "host-battery-"));
  async function supply(name: string, files: Record<string, string>) {
    await mkdir(join(root, name), { recursive: true });
    await Promise.all(Object.entries(files).map(([key, value]) => writeFile(join(root, name, key), value)));
  }
  try {
    expect(await readHostBattery(root)).toBeNull();
    await supply("usb", { type: "USB", capacity: "100", status: "Charging" });
    await supply("mouse", { type: "Battery", scope: "Device", capacity: "50" });
    await supply("battery", { type: "Battery\n", capacity: "85\n", status: "Charging\n" });
    expect(await readHostBattery(root)).toEqual({ percentage: 85, status: "charging" });
    for (const [state, expected] of [["Discharging", "discharging"], ["Full", "full"], ["Not charging", "not-charging"], ["Unexpected", "unknown"]]) {
      await supply("battery", { status: state });
      expect((await readHostBattery(root))?.status).toBe(expected);
    }
    for (const capacity of ["", "NaN", "101", "-1", "45.5"]) {
      await supply("battery", { capacity });
      expect(await readHostBattery(root)).toBeNull();
    }
    await supply("BAT0", { type: "Battery", scope: "System", capacity: "0" });
    expect(await readHostBattery(root)).toEqual({ percentage: 0, status: "unknown" });
    await supply("BAT0", { capacity: "100", status: "Full" });
    expect(await readHostBattery(root)).toEqual({ percentage: 100, status: "full" });
  } finally { await rm(root, { recursive: true, force: true }); }
  expect(await readHostBattery(root)).toBeNull();
});

test("battery endpoint is conversation independent and obeys origin checks", async () => {
  const h = webHarness();
  try {
    const response = await h.request("/host/battery");
    expect(response.status).toBe(200);
    const { battery } = await response.json();
    if (battery !== null) {
      expect(battery.percentage).toBeGreaterThanOrEqual(0);
      expect(battery.percentage).toBeLessThanOrEqual(100);
      expect(["charging", "discharging", "full", "not-charging", "unknown"]).toContain(battery.status);
    }
    expect((await h.request("/host/battery", "GET", undefined, { origin: "https://evil.test" })).status).toBe(403);
  } finally { h.api.dispose(); }
});

test("battery indicator labels the host and charging state and hides unavailable readings", () => {
  const render = (battery: Parameters<typeof BatteryIndicator>[0]["battery"]) => renderToStaticMarkup(createElement(BatteryIndicator, { battery }));
  expect(render(null)).toBe("");
  expect(render({ percentage: 85, status: "charging" })).toContain('aria-label="Host battery: 85%, charging"');
  expect(render({ percentage: 12, status: "discharging" })).toContain("text-amber-400");
  expect(render({ percentage: 12, status: "charging" })).not.toContain("text-amber-400");
  expect(render({ percentage: 100, status: "full" })).toContain("fully charged");
});
