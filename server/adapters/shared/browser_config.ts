export type WebConfig = {
  hostname: "127.0.0.1";
  port: number;
  origins: string[];
};

export function readWebConfig(environment: Record<string, string | undefined>): WebConfig {
  const port = Number(environment.SHEPHERD_WEB_PORT ?? "8788");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("SHEPHERD_WEB_PORT must be an integer from 1 to 65535.");
  const origins = (environment.SHEPHERD_WEB_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  for (const origin of origins) {
    let url: URL;
    try { url = new URL(origin); } catch { throw new Error("SHEPHERD_WEB_ORIGINS must contain exact HTTP(S) origins."); }
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.hostname.includes("*") || url.origin !== origin || url.username || url.password || (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))) {
      throw new Error("SHEPHERD_WEB_ORIGINS requires HTTPS origins (HTTP allowed only for loopback).");
    }
  }
  return { hostname: "127.0.0.1", port, origins: [...new Set(origins)] };
}
