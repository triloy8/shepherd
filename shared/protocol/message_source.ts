/** Application provenance for a user-role message. It carries no permission or authority. */
const messageSources = ["human", "webhook", "thread_watch", "swarm_assignment"] as const;
export type MessageSource = typeof messageSources[number];

export function isMessageSource(value: unknown): value is MessageSource {
  return messageSources.some(source => source === value);
}
