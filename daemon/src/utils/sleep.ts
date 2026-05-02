/**
 * Trivial Promise-based sleep helper. Shared between the daemon's
 * api-client retry/backoff path and the backfill rate-limit gap
 * (both previously defined the same one-line function locally).
 */

export const sleep = (ms: number): Promise<void> =>
  new Promise<void>((r) => setTimeout(r, ms));
