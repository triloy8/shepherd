export type WebConfig = {
  hostname: "127.0.0.1";
  port: number;
  token: string;
  origins: string[];
};

export function readWebConfig(environment: Record<string, string | undefined>): WebConfig {
  const token = environment.SHEPHERD_WEB_TOKEN ?? "";
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(token)) {
    throw new Error("SHEPHERD_WEB_TOKEN must be a 32–256 character random base64url or hexadecimal secret.");
  }
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
  return { hostname: "127.0.0.1", port, token, origins: [...new Set(origins)] };
}
