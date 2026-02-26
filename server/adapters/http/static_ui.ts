import fs from "node:fs/promises";
import path from "node:path";

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

export async function serveStaticUi(request: Request): Promise<Response | null> {
  const url = new URL(request.url);
  const distDir = path.resolve(process.cwd(), "dist");

  let pathname = url.pathname;
  if (pathname === "/") pathname = "/index.html";

  const target = sanitizePath(distDir, pathname);
  if (!target) return null;

  try {
    const stats = await fs.stat(target);
    if (!stats.isFile()) return null;

    const extension = path.extname(target).toLowerCase();
    const contents = await fs.readFile(target);
    return new Response(contents, {
      status: 200,
      headers: {
        "Content-Type": MIME[extension] ?? "application/octet-stream",
        "Cache-Control": "no-store",
      },
    });
  } catch {
    return null;
  }
}
