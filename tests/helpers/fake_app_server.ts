import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import readline from "node:readline";
import { PassThrough } from "node:stream";
import { CodexAppServer } from "../../server/providers/codex/app_server.js";

type Request = { id: number | string; method: string; params: unknown };
type Line = Record<string, unknown>;

/** A fake `codex app-server` behind a real CodexAppServer: requests are answered by `handle`
 * (a thrown error becomes a JSON-RPC error), and tests can send notifications and requests. */
export function fakeAppServer(handle: (request: Request) => unknown = () => ({})) {
  const processes: Array<{ child: EventEmitter & { stdout: PassThrough; stderr: PassThrough }; received: Line[] }> = [];
  const spawn = () => {
    const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough();
    const child = Object.assign(new EventEmitter(), { stdin, stdout, stderr, killed: false, kill() {
      child.killed = true; queueMicrotask(() => child.emit("exit", null, "SIGTERM")); return true;
    } });
    const record = { child, received: [] as Line[] };
    processes.push(record);
    readline.createInterface({ input: stdin }).on("line", line => {
      const message = JSON.parse(line) as Line;
      record.received.push(message);
      if (typeof message.method !== "string" || message.id === undefined) return;
      void Promise.resolve().then(() => handle(message as Request)).then(
        result => stdout.write(`${JSON.stringify({ id: message.id, result })}\n`),
        (error: Error) => stdout.write(`${JSON.stringify({ id: message.id, error: { code: -32600, message: error.message } })}\n`));
    });
    return child as unknown as ChildProcessWithoutNullStreams;
  };
  const latest = () => processes.at(-1)!;
  const write = (line: Line) => new Promise<void>(resolve => latest().child.stdout.write(`${JSON.stringify(line)}\n`, () => setTimeout(resolve, 0)));
  return {
    server: new CodexAppServer(spawn),
    processes,
    /** Everything Shepherd wrote to the latest process. */
    received: () => latest().received,
    notify: (method: string, params: unknown) => write({ method, params }),
    request: (id: number | string, method: string, params: unknown) => write({ id, method, params }),
    stderr: (text: string) => new Promise<void>(resolve => latest().child.stderr.write(text, () => setTimeout(resolve, 0))),
    exit: () => { latest().child.emit("exit", 1, null); },
  };
}
