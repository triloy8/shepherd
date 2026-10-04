import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { brotliCompressSync, gzipSync } from "node:zlib";

export type UiAsset = { body: Uint8Array; contentType: string; gzip?: Uint8Array; brotli?: Uint8Array };
export type UiAssets = Map<string, UiAsset>;
type Bundle = Record<string, { base64: string; contentType: string }>;
// Replaced by the binary build. Source startup reads the same Vite output.
declare const SHEPHERD_UI_BUNDLE: Bundle;

export async function loadUiAssets(): Promise<UiAssets> {
  const compressed = (body: Uint8Array, contentType: string): UiAsset => {
    if (!contentType.startsWith("text/") && !contentType.includes("javascript")) return { body, contentType };
    const gzip = gzipSync(body); const brotli = brotliCompressSync(body);
    return { body, contentType, ...(gzip.byteLength < body.byteLength ? { gzip } : {}), ...(brotli.byteLength < body.byteLength ? { brotli } : {}) };
  };
  if (typeof SHEPHERD_UI_BUNDLE !== "undefined") {
    return new Map(Object.entries(SHEPHERD_UI_BUNDLE).map(([name, asset]) => [name,
      compressed(Buffer.from(asset.base64, "base64"), asset.contentType),
    ]));
  }
  const root = fileURLToPath(new URL("../../../ui/dist/", import.meta.url));
  const assets: UiAssets = new Map();
  const mime: Record<string, string> = {
    ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml",
    ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf", ".otf": "font/otf",
  };
  async function walk(directory: string) {
    for (const entry of await readdir(path.join(root, directory), { withFileTypes: true })) {
      const name = path.posix.join(directory, entry.name);
      if (entry.isDirectory()) await walk(name);
      else if (entry.isFile() && mime[path.extname(name)]) {
        const contentType = mime[path.extname(name)]!;
        assets.set(`/${name}`, compressed(await readFile(path.join(root, name)), contentType));
      }
    }
  }
  try { await walk(""); }
  catch (cause) { throw new Error("Web UI build is missing. Run bun run build before starting web.", { cause }); }
  if (!assets.has("/index.html")) throw new Error("Web UI index is missing. Run bun run build.");
  return assets;
}

export function serveUiAsset(request: Request, assets: UiAssets): Response {
  const pathname = new URL(request.url).pathname;
  const asset = assets.get(pathname === "/" ? "/index.html" : pathname);
  const headers = new Headers({
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; font-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    "cache-control": "no-store",
  });
  if (!["GET", "HEAD"].includes(request.method)) {
    headers.set("allow", "GET, HEAD");
    return new Response(null, { status: 405, headers });
  }
  if (!asset) return new Response(null, { status: 404, headers });
  headers.set("content-type", asset.contentType);
  if (pathname.startsWith("/assets/")) headers.set("cache-control", "public, max-age=31536000, immutable");
  headers.set("vary", "Accept-Encoding");
  const accepted = request.headers.get("accept-encoding") ?? "";
  const accepts = (name: string) => accepted.split(",").some((entry) => {
    const [encoding, ...parameters] = entry.trim().toLowerCase().split(";");
    return encoding === name && !parameters.some((parameter) => /^q=0(?:\.0*)?$/.test(parameter.trim()));
  });
  const encoded = accepts("br") && asset.brotli ? { body: asset.brotli, encoding: "br" }
    : accepts("gzip") && asset.gzip ? { body: asset.gzip, encoding: "gzip" }
    : { body: asset.body, encoding: null };
  if (encoded.encoding) headers.set("content-encoding", encoded.encoding);
  return new Response(request.method === "HEAD" ? null : encoded.body as BodyInit, { headers });
}
