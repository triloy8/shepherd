import { ConversationService } from "./core/conversation_service.js";
import { startHttpServer } from "./adapters/http/server.js";
import { loadEnvironment } from "./config/environment.js";

loadEnvironment("http");

const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? "8787");

const conversation = new ConversationService();
const server = startHttpServer(conversation, host, port);

process.on("SIGINT", () => {
  conversation.stopAll();
  server.stop();
  process.exit(0);
});

process.on("SIGTERM", () => {
  conversation.stopAll();
  server.stop();
  process.exit(0);
});

console.log(`shepherd listening at http://${server.hostname}:${server.port}`);
