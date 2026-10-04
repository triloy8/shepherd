import { expect, test } from "bun:test";
import { brotliCompressSync, brotliDecompressSync, gunzipSync } from "node:zlib";
import { serveUiAsset, type UiAssets } from "../server/adapters/web/ui_assets";

const text = "console.log('compressed');".repeat(500);
const body = new TextEncoder().encode(text);
const assets: UiAssets = new Map([["/assets/app.js", {
  body,
  contentType: "text/javascript; charset=utf-8",
  gzip: Bun.gzipSync(body),
  brotli: brotliCompressSync(body),
}]]);

test("UI assets negotiate precompressed immutable responses", async () => {
  const brotli = serveUiAsset(new Request("http://localhost/assets/app.js", { headers: { "accept-encoding": "gzip, br" } }), assets);
  expect(brotli.headers.get("content-encoding")).toBe("br");
  expect(brotli.headers.get("vary")).toBe("Accept-Encoding");
  expect(brotli.headers.get("cache-control")).toContain("immutable");
  expect(brotliDecompressSync(Buffer.from(await brotli.arrayBuffer())).toString()).toBe(text);

  const gzip = serveUiAsset(new Request("http://localhost/assets/app.js", { headers: { "accept-encoding": "gzip" } }), assets);
  expect(gzip.headers.get("content-encoding")).toBe("gzip");
  expect(gunzipSync(Buffer.from(await gzip.arrayBuffer())).toString()).toBe(text);

  const identity = serveUiAsset(new Request("http://localhost/assets/app.js", { headers: { "accept-encoding": "xbr" } }), assets);
  expect(identity.headers.get("content-encoding")).toBeNull();
  expect(await identity.text()).toBe(text);

  const refused = serveUiAsset(new Request("http://localhost/assets/app.js", { headers: { "accept-encoding": "br;q=0, gzip;q=0" } }), assets);
  expect(refused.headers.get("content-encoding")).toBeNull();
});
