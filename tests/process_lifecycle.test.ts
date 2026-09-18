import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { installShutdownHandlers } from "../server/runtime/process_lifecycle.js";

test("both process signals request one shutdown and detach cleanly", async () => {
  const events = new EventEmitter(); const exits: number[] = []; let stops = 0;
  const detach = installShutdownHandlers(async () => { stops++; }, events as never, (code) => exits.push(code));
  events.emit("SIGTERM"); events.emit("SIGINT");
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(stops).toBe(1); expect(exits).toEqual([0]);
  detach();
  expect(events.listenerCount("SIGTERM")).toBe(0);
  expect(events.listenerCount("SIGINT")).toBe(0);
});

test("shutdown failure produces a failing exit code", async () => {
  const events = new EventEmitter(); const exits: number[] = [];
  const detach = installShutdownHandlers(async () => { throw new Error("cleanup failed"); }, events as never, (code) => exits.push(code));
  events.emit("SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(exits).toEqual([1]); detach();
});
