import { useEffect, useState } from "react";
import type { WebHostBattery } from "../../../shared/protocol/host";
import { api } from "../api";

export function BatteryIndicator({ battery }: { battery: WebHostBattery | null }) {
  if (!battery) return null;
  const charging = battery.status === "charging";
  const description = { charging: "charging", discharging: "on battery", full: "fully charged", "not-charging": "not charging", unknown: "charging state unavailable" }[battery.status];
  const label = `Host battery: ${battery.percentage}%, ${description}`;
  return <span role="img" aria-label={label} title={label} className={`inline-flex shrink-0 items-center gap-1.5 text-xs tabular-nums ${battery.percentage <= 20 && battery.status === "discharging" ? "text-amber-400" : "text-muted"}`}>
    <svg aria-hidden="true" className="h-4 w-6" viewBox="0 0 26 16" fill="none" stroke="currentColor" strokeWidth="1.3">
      <rect x="1" y="3" width="21" height="10" rx="2" />
      <path d="M24 6v4" strokeLinecap="round" />
      <rect x="3" y="5" width={17 * battery.percentage / 100} height="6" rx="0.7" fill="currentColor" stroke="none" opacity={charging ? "0.3" : "0.8"} />
      {charging && <path d="m13 2-5 7h4l-1 5 6-8h-4l1-4Z" fill="currentColor" stroke="none" />}
    </svg>
    <span>{battery.percentage}%</span>
  </span>;
}

export function HostBattery() {
  const [battery, setBattery] = useState<WebHostBattery | null>(null);
  useEffect(() => {
    const abort = new AbortController();
    let reading = false;
    async function refresh() {
      if (document.visibilityState !== "visible" || reading || abort.signal.aborted) return;
      reading = true;
      try {
        const result = await api.hostBattery(AbortSignal.any([abort.signal, AbortSignal.timeout(10_000)]));
        if (!abort.signal.aborted) setBattery(result.battery);
      } catch { if (!abort.signal.aborted) setBattery(null); }
      finally { reading = false; }
    }
    void refresh();
    const timer = setInterval(() => void refresh(), 30_000);
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("focus", refresh);
    return () => {
      abort.abort(); clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("focus", refresh);
    };
  }, []);
  return <BatteryIndicator battery={battery} />;
}
