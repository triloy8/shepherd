export async function parseJsonBody(request: Request): Promise<unknown> {
  const raw = await request.text();
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

export function respondJson(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

export function respondError(status: number, message: string): Response {
  return respondJson(status, { error: message });
}

export function notFound(): Response {
  return respondError(404, "Not found");
}
