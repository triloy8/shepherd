/** `maxBytes` is the limit the request exceeded, so a route with its own limit can report it. */
export class BodyTooLargeError extends Error {
  constructor(message: string, readonly maxBytes: number) { super(message); }
}

export async function readBoundedJson(request: Request, maxBodyBytes: number): Promise<unknown> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (Number.isFinite(parsedLength) && parsedLength > maxBodyBytes) {
      throw new BodyTooLargeError("Request body is too large.", maxBodyBytes);
    }
  }

  if (!request.body) throw new SyntaxError("Request body is required.");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBodyBytes) {
      await reader.cancel();
      throw new BodyTooLargeError("Request body is too large.", maxBodyBytes);
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder().decode(bytes);
  if (!text.trim()) throw new SyntaxError("Request body is required.");
  return JSON.parse(text) as unknown;
}

