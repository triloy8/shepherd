/** Process signals belong to the host, never to individual adapters. */
export function installShutdownHandlers(
  stop: () => Promise<void>,
  target: Pick<NodeJS.Process, "on" | "off"> = process,
  exit: (code: number) => void = (code) => process.exit(code),
): () => void {
  let requested = false;
  const handler = () => {
    if (requested) return;
    requested = true;
    void Promise.resolve().then(stop).then(
      () => exit(0),
      (error) => { console.error("Shepherd shutdown failed:", error); exit(1); },
    );
  };
  target.on("SIGINT", handler);
  target.on("SIGTERM", handler);
  return () => {
    target.off("SIGINT", handler);
    target.off("SIGTERM", handler);
  };
}
