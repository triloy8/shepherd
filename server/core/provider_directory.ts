import type { AgentProvider } from "../../shared/protocol/requests.js";
import type { ThreadProviderDirectory, ProviderSessionFactory } from "../ports/provider_services.js";
/** Pure defaults for isolated application tests. Production supplies persistent services. */
export function memoryProviderDirectory(defaultProvider = "default"): ThreadProviderDirectory {
  const bindings = new Map<string, AgentProvider>();
  return {
    resolve: (id) => bindings.get(id) ?? defaultProvider,
    bind(id, provider) {
      const existing = bindings.get(id);
      if (existing && existing !== provider) throw new Error("Cannot change the provider of an existing thread.");
      bindings.set(id, provider);
    },
  };
}

export const missingSessionFactory: ProviderSessionFactory = () => {
  throw new Error("Provider services were not supplied at the runtime composition boundary.");
};
