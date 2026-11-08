/**
 * Fixtures for SPX 0DTE greek flow tests (fetch-greek-flow and
 * reconcile-zero-dte-greek-flow): UW's per-minute grid, the bucket rows it
 * should produce, and the stubs around them. 2026-03-24 is on EDT (UTC-4):
 * 09:30 ET is 13:30Z, 16:00 ET is 20:00Z.
 */

import { vi } from 'vitest';

export const SOURCE = 'zero_dte_greek_flow';

export const MINUTE = 60_000;
export const at = (hhmmZ: string, day = '2026-03-24'): Date =>
  new Date(`${day}T${hhmmZ}:00Z`);

/**
 * One minute tick. The default is the last minute (14:04Z = 10:04 ET) of the
 * 10:00-10:05 bucket, which has closed and settled at MARKET_TIME.
 */
export function makeGreekFlowTick(overrides = {}) {
  return {
    timestamp: '2026-03-24T14:04:00Z',
    ticker: 'SPX',
    expiry: '2026-03-24',
    total_delta_flow: '5000000',
    dir_delta_flow: '-3000000',
    total_vega_flow: '200000',
    dir_vega_flow: '-100000',
    otm_total_delta_flow: '3000000',
    otm_dir_delta_flow: '-1500000',
    otm_total_vega_flow: '150000',
    otm_dir_vega_flow: '-75000',
    transactions: 4500,
    volume: 120000,
    ...overrides,
  };
}

/**
 * UW's session grid for `day`: one tick per minute from `openZ` (`minutes` of
 * them: 405 is 09:30-16:14 ET, as SPX options print until 16:15). Minutes at
 * or after `filledUntil` have not happened yet: UW sends them with null values
 * (the prefilled form) or leaves them out (`prefilled: false`). The values are
 * built from the minute-of-session `i`, so a bucket's value names its last
 * minute.
 */
export function tickGrid(
  day: string,
  filledUntil: Date,
  { openZ = '13:30', minutes = 405, prefilled = true } = {},
) {
  const open = at(openZ, day).getTime();
  const ticks: Array<Record<string, unknown>> = [];
  for (let i = 0; i < minutes; i++) {
    const start = new Date(open + i * MINUTE);
    if (start < filledUntil) {
      ticks.push(
        makeGreekFlowTick({
          timestamp: start.toISOString(),
          total_delta_flow: String(2000 + i),
          dir_delta_flow: String(-700 - i),
          otm_total_delta_flow: String(300 + i),
          otm_dir_delta_flow: String(-100 - i),
          volume: 50 + i,
        }),
      );
    } else if (prefilled) {
      ticks.push({
        timestamp: start.toISOString(),
        ticker: 'SPX',
        total_delta_flow: null,
        dir_delta_flow: null,
        otm_total_delta_flow: null,
        otm_dir_delta_flow: null,
        volume: null,
      });
    }
  }
  return ticks;
}

/** What `tickGrid` stores for the k-th 5-minute bucket of a session (k = 0 is 09:30-09:35). */
export function bucketValues(k: number, day = '2026-03-24', openZ = '13:30') {
  const i = 5 * k + 4; // the bucket's last minute
  const label = new Date(
    at(openZ, day).getTime() + 5 * (k + 1) * MINUTE,
  ).toISOString();
  return [day, label, SOURCE, 2000 + i, -700 - i, 50 + i, 300 + i, -100 - i];
}

/** The grid with one minute's fields replaced. */
export const withMinute = (
  ticks: Array<Record<string, unknown>>,
  hhmmZ: string,
  overrides: Record<string, unknown>,
) =>
  ticks.map((tick) =>
    tick.timestamp === `2026-03-24T${hhmmZ}:00.000Z`
      ? { ...tick, ...overrides }
      : tick,
  );

/** Stub fetch with the flat UW greek-flow response structure */
export function stubFetch(ticks: unknown = []) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: ticks }),
    }),
  );
}

/**
 * The calls to the stubbed `fetch` that went to Unusual Whales. Other calls
 * (a Sentry cron check-in when SENTRY_DSN is set in the shell) are not the
 * cron's UW reads and must not move a test's count.
 */
export function uwFetchCalls() {
  return vi
    .mocked(fetch)
    .mock.calls.filter(([url]) => String(url).includes('unusualwhales'));
}

export type Outcome = 'inserted' | 'updated' | 'unchanged';
export const OUTCOME_ROWS: Record<Outcome, unknown[]> = {
  inserted: [{ inserted: true }],
  updated: [{ inserted: false }],
  unchanged: [],
};
