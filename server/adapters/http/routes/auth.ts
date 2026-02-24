import type { IncomingMessage } from "node:http";

export function isAuthorized(_request: IncomingMessage): boolean {
  return true;
}
