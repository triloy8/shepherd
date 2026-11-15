import type { SwarmGroup } from "../../shared/protocol/swarm.js";

export interface SwarmStore {
  list(): SwarmGroup[];
  read(id: string): SwarmGroup | null;
  /** Compare the persisted revision; null means the record must not exist. */
  save(group: SwarmGroup, expectedRevision: number | null): void;
}
