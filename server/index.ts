import { SessionManager } from "./core/session_manager.js";
import { startHttpServer } from "./adapters/http/server.js";
import { loadEnvironment } from "./config/environment.js";

loadEnvironment("http");

const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? "8787");

const manager = new SessionManager();
const server = startHttpServer(manager, host, port);

process.on("SIGINT", () => {
  manager.stopAll();
  server.stop();
  process.exit(0);
});

process.on("SIGTERM", () => {
  manager.stopAll();
  server.stop();
  process.exit(0);
});

console.log(`shepherd listening at http://${server.hostname}:${server.port}`);
