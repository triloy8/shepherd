import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

function sanitizePath(baseDir: string, pathname: string): string | null {
  const safe = path.normalize(decodeURIComponent(pathname)).replace(/^([.]{2}[/\\])+/, "");
  const absolute = path.resolve(baseDir, `.${safe}`);
  return absolute.startsWith(baseDir) ? absolute : null;
}

export async function serveStaticUi(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
  const host = request.headers.host ?? "127.0.0.1";
  const url = new URL(request.url ?? "/", `http://${host}`);
  const distDir = path.resolve(process.cwd(), "dist");

  let pathname = url.pathname;
  if (pathname === "/") pathname = "/index.html";

  const target = sanitizePath(distDir, pathname);
  if (!target) return false;

  try {
    const stats = await fs.stat(target);
    if (!stats.isFile()) return false;

    const extension = path.extname(target).toLowerCase();
    response.writeHead(200, {
      "Content-Type": MIME[extension] ?? "application/octet-stream",
      "Cache-Control": "no-store",
    });
    createReadStream(target).pipe(response);
    return true;
  } catch {
    return false;
  }
}
