export type PendingAccountReset = { idempotencyKey: string; creditId?: string };
const key = (provider: string) => `shepherd.account-reset:${provider}`;
function decode(raw: string | null): PendingAccountReset | null {
  try {
    const value = JSON.parse(raw ?? "null");
    if (typeof value?.idempotencyKey !== "string" || !value.idempotencyKey.trim() || value.idempotencyKey.length > 100) return null;
    if (value.creditId !== undefined && (typeof value.creditId !== "string" || !value.creditId.trim() || value.creditId.length > 256)) return null;
    return { idempotencyKey: value.idempotencyKey, ...(value.creditId ? { creditId: value.creditId } : {}) };
  } catch { return null; }
}
/** One-time local storage upgrade; the old API supported one account's resets. */
export function migrateAccountResetStorage(storage: Storage): void {
  const old = decode(storage.getItem("shepherd.usage-reset"));
  if (old && !storage.getItem(key("codex"))) {
    storage.setItem(key("codex"), JSON.stringify(old));
    storage.removeItem("shepherd.usage-reset");
  }
}
export function readAccountReset(provider: string): PendingAccountReset | null {
  try { migrateAccountResetStorage(sessionStorage); return decode(sessionStorage.getItem(key(provider))); } catch { return null; }
}
export function writeAccountReset(provider: string, value: PendingAccountReset | null): void {
  try { if (value) sessionStorage.setItem(key(provider), JSON.stringify(value)); else sessionStorage.removeItem(key(provider)); } catch { /* Optional storage; the mounted component retains the request. */ }
}
