import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { WebHostBattery } from "../../../shared/protocol/host.js";

/** Read the host's Linux/Android battery; unsupported or unreadable hosts return null. */
export async function readHostBattery(root = "/sys/class/power_supply"): Promise<WebHostBattery | null> {
  try {
    const names = (await readdir(root)).sort((a, b) => a === "battery" ? -1 : b === "battery" ? 1 : a.localeCompare(b));
    for (const name of names) {
      try {
        const path = join(root, name);
        const type = (await readFile(join(path, "type"), "utf8")).trim();
        if (type !== "Battery") continue;
        // Exclude peripheral batteries on desktop Linux. Android often omits scope.
        const scope = await readFile(join(path, "scope"), "utf8").catch(() => "");
        if (scope.trim() === "Device") continue;
        const [capacity, state] = await Promise.all([
          readFile(join(path, "capacity"), "utf8"),
          readFile(join(path, "status"), "utf8").catch(() => "Unknown"),
        ]);
        if (!/^\d{1,3}$/.test(capacity.trim())) continue;
        const percentage = Number(capacity.trim());
        if (percentage > 100) continue;
        const status = { Charging: "charging", Discharging: "discharging", Full: "full", "Not charging": "not-charging" }[state.trim()] as WebHostBattery["status"] | undefined;
        return { percentage, status: status ?? "unknown" };
      } catch { /* Try another supply if this one is unavailable. */ }
    }
  } catch { /* Sysfs is optional. */ }
  return null;
}
