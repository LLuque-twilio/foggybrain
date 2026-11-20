export const DEFAULT_SYNC_TIMEOUT_MS = 10_000;

export function parseSyncTimeout(value: string | undefined): number {
  if (value === undefined) return DEFAULT_SYNC_TIMEOUT_MS;
  const timeout = Number(value);
  if (!/^\d+$/.test(value) || timeout < 1_000 || timeout > 600_000)
    throw new Error('FOGGY_SYNC_TIMEOUT_MS must be an integer between 1000 and 600000.');
  return timeout;
}
