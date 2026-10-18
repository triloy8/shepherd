import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";

/** Shepherd's layers, lowest first. A layer may import itself and the layers it lists, nothing
 * else: every dependency points down. Composition is the one layer that wires concretes from all. */
const layers: Array<{ name: string; paths: string[]; may: string[] }> = [
  { name: "protocol", paths: ["shared/protocol"], may: [] },
  { name: "ports", paths: ["server/ports"], may: ["protocol"] },
  { name: "provider-support", paths: ["server/providers/approval_choices.ts", "server/providers/event_bus.ts"], may: ["ports", "protocol"] },
  { name: "provider:claude", paths: ["server/providers/claude"], may: ["provider-support", "ports", "protocol"] },
  { name: "provider:codex", paths: ["server/providers/codex"], may: ["provider-support", "ports", "protocol"] },
  { name: "config", paths: ["server/config"], may: ["protocol"] },
  { name: "storage", paths: ["server/storage"], may: ["ports", "protocol"] },
  { name: "core", paths: ["server/core"], may: ["ports", "protocol"] },
  { name: "signals", paths: ["server/signals"], may: ["core", "protocol"] },
  { name: "surface-support", paths: ["server/adapters/http"], may: ["ports", "protocol"] },
  { name: "surface:discord", paths: ["server/adapters/discord"], may: ["surface-support", "ports", "config", "protocol"] },
  { name: "surface:web", paths: ["server/adapters/web/"], may: ["surface-support", "ports", "config", "protocol"] },
  { name: "surface:webhook", paths: ["server/adapters/webhook"], may: ["surface-support", "ports", "config", "protocol"] },
  { name: "ui", paths: ["ui/src"], may: ["protocol"] },
  { name: "composition", paths: ["server/runtime", "server/main.ts", "server/surface_definitions.ts"], may: ["*"] },
];

/** Imports that break the rules today, each to be removed by moving code to its layer. The list
 * may only shrink: a fixed import must leave it, and a new violation fails. */
const knownViolations: string[] = [
  "server/adapters/discord/action_error.ts -> server/core/action_error (surface:discord -> core)",
  "server/adapters/discord/bot.ts -> server/runtime/surface_adapter (surface:discord -> composition)",
  "server/adapters/discord/commands.ts -> server/core/control_actions_service (surface:discord -> core)",
  "server/adapters/discord/commands.ts -> server/core/deployment_service (surface:discord -> core)",
  "server/adapters/discord/commands.ts -> server/core/runtime_lifecycle_orchestrator (surface:discord -> core)",
  "server/adapters/discord/commands.ts -> server/core/session_manager (surface:discord -> core)",
  "server/adapters/discord/commands.ts -> server/core/skills_page_service (surface:discord -> core)",
  "server/adapters/discord/commands.ts -> server/core/surface_actions_service (surface:discord -> core)",
  "server/adapters/discord/commands.ts -> server/core/surface_application_context (surface:discord -> core)",
  "server/adapters/discord/commands.ts -> server/core/surface_snapshot_service (surface:discord -> core)",
  "server/adapters/discord/commands.ts -> server/core/surface_state_service (surface:discord -> core)",
  "server/adapters/discord/generated_image_delivery.ts -> server/core/generated_image (surface:discord -> core)",
  "server/adapters/discord/history_pagination.ts -> server/core/history_page_service (surface:discord -> core)",
  "server/adapters/discord/image_input.ts -> server/core/image_media (surface:discord -> core)",
  "server/adapters/discord/interactions.ts -> server/core/conversation_ports (surface:discord -> core)",
  "server/adapters/discord/interactions.ts -> server/core/skills_page_service (surface:discord -> core)",
  "server/adapters/discord/list_pagination.ts -> server/core/skills_page_service (surface:discord -> core)",
  "server/adapters/discord/message_ingress.ts -> server/core/turn_routing_policy (surface:discord -> core)",
  "server/adapters/discord/message_ingress.ts -> server/core/turn_routing_service (surface:discord -> core)",
  "server/adapters/discord/message_ingress.ts -> server/core/turn_routing_service (surface:discord -> core)",
  "server/adapters/discord/signal_notice.ts -> server/core/signal_registry (surface:discord -> core)",
  "server/adapters/discord/thread_event_handler.ts -> server/core/response_stream_reducer (surface:discord -> core)",
  "server/adapters/web/api.ts -> server/core/action_error (surface:web -> core)",
  "server/adapters/web/api.ts -> server/core/approvals (surface:web -> core)",
  "server/adapters/web/api.ts -> server/core/conversation_routing_service (surface:web -> core)",
  "server/adapters/web/api.ts -> server/core/signal_registry (surface:web -> core)",
  "server/adapters/web/api.ts -> server/core/surface_application_context (surface:web -> core)",
  "server/adapters/web/api.ts -> server/core/turn_routing_service (surface:web -> core)",
  "server/adapters/web/api.ts -> server/runtime/surface_adapter (surface:web -> composition)",
  "server/adapters/web/controls.ts -> server/core/control_actions_service (surface:web -> core)",
  "server/adapters/web/host_controls.ts -> server/core/runtime_lifecycle_orchestrator (surface:web -> core)",
  "server/adapters/web/host_controls.ts -> server/core/runtime_lifecycle_orchestrator (surface:web -> core)",
  "server/adapters/web/host_controls.ts -> server/core/session_manager (surface:web -> core)",
  "server/adapters/web/host_controls.ts -> server/core/surface_application_context (surface:web -> core)",
  "server/adapters/web/image_input.ts -> server/core/image_media (surface:web -> core)",
  "server/adapters/web/images.ts -> server/core/generated_image (surface:web -> core)",
  "server/adapters/web/server.ts -> server/runtime/surface_adapter (surface:web -> composition)",
  "server/adapters/webhook/server.ts -> server/core/signal_dispatcher (surface:webhook -> core)",
  "server/adapters/webhook/server.ts -> server/core/signal_registry (surface:webhook -> core)",
  "server/adapters/webhook/server.ts -> server/core/signal_route_registry (surface:webhook -> core)",
];

function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? files(path) : /\.(ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}

function layerOf(path: string) {
  const file = path.replace(/\.js$/, ".ts");
  // Longest match wins, so a file listed by name beats its folder.
  return layers.flatMap(layer => layer.paths.filter(prefix => file.startsWith(prefix) || `${file}/`.startsWith(prefix)).map(prefix => ({ layer, prefix })))
    .sort((a, b) => b.prefix.length - a.prefix.length)[0]?.layer;
}

function violations(): string[] {
  const found: string[] = [];
  for (const root of ["shared", "server", "ui/src"]) for (const file of files(root)) {
    const from = layerOf(file);
    if (!from) { found.push(`${file}: belongs to no layer`); continue; }
    for (const match of readFileSync(file, "utf8").matchAll(/(?:from|import)\s*\(?\s*["'](\.[^"']+)["']/g)) {
      const target = normalize(join(dirname(file), match[1]!));
      const to = layerOf(target);
      if (!to || to === from || from.may.includes("*") || from.may.includes(to.name)) continue;
      found.push(`${file} -> ${target.replace(/\.js$/, "")} (${from.name} -> ${to.name})`);
    }
  }
  return found.sort();
}

test("every import points down the layers, apart from the listed violations being removed", () => {
  expect(violations()).toEqual([...knownViolations].sort());
});
