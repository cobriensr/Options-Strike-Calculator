/**
 * Fixtures and routers shared by futures-bar-backfill.test.ts and
 * futures-bar-repair.test.ts: the mock functions behind both files' module
 * mocks, the UW and DB routers, and the run set-up. It holds no `vi.mock`
 * call (those are hoisted per test file; each file keeps its own block) and
 * imports nothing at runtime but vitest, so a mock factory can load it.
 */

import { vi } from 'vitest';

import type { BarBackfillOptions } from './futures-bar-backfill.js';

export const mockSql = vi.fn();
export const mockUwFetch = vi.fn();
export const mockIsMarketHours = vi.fn(() => false);
export const mockStored = vi.fn();
export const mockSchedule = vi.fn();
export const mockRefresh = vi.fn();

// ── Fixtures ──────────────────────────────────────────────

const NOW = '2026-11-06T23:00:00Z'; // a Friday evening, after the close
export const DAY = '2026-09-15'; // ES roll week; the sessions open at 22:00Z (CDT)
export const DAY_START = '2026-09-14T23:59:00.000000Z'; // before 00:00 UTC of DAY
export const PX = '6700.250000000';

export function opts(
  over: Partial<BarBackfillOptions> = {},
): BarBackfillOptions {
  return {
    dates: [DAY],
    from: null,
    to: null,
    roots: ['ES'],
    dryRun: false,
    maxPages: 20_000,
    compare: false,
    repair: false,
    noCache: false,
    workDir: 'docs/tmp/uw-futures-run',
    ...over,
  };
}

/** A regular REST /trades print (probe 0a shape). */
export function print(
  id: number,
  at: string,
  size: number,
  side: string | null,
  price: string | null = PX,
) {
  return {
    executed_at: at,
    is_block: false,
    is_spread: false,
    price,
    side,
    size,
    trade_id: id,
  };
}

/** The print that ends a contract's paging: it is before 00:00 UTC. */
export const ENDER = print(1, DAY_START, 1, 'buy');

export function nextDay(date: string): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000)
    .toISOString()
    .slice(0, 10);
}

/**
 * Routes the front-month table. Every date is decided, on `${root}U6`
 * unless `contracts` names the date; `undecided` dates have no stored row.
 * The schedule answers only the dates it is asked about, like the real one.
 */
export function routeFrontMonth(
  contracts: Record<string, string> = {},
  undecided: readonly string[] = [],
) {
  const contractOn = (root: string, date: string) =>
    contracts[date] ?? `${root}U6`;
  mockStored.mockImplementation(
    async (root: string, from: string, to: string) => {
      const stored = new Map<string, string>();
      for (let d = from; d <= to; d = nextDay(d)) {
        if (!undecided.includes(d)) stored.set(d, contractOn(root, d));
      }
      return stored;
    },
  );
  mockSchedule.mockImplementation(
    async (root: string, dates: readonly string[]) => ({
      contractFor: (d: string) =>
        dates.includes(d) ? contractOn(root, d) : undefined,
      contracts: [...new Set(dates.map((d) => contractOn(root, d)))],
    }),
  );
}

/** UW /trades pages per contract, served in order; unknown contracts 404. */
export function routeTrades(pages: Record<string, unknown[][]>) {
  const served: Record<string, number> = {};
  mockUwFetch.mockImplementation(async (_key: string, path: string) => {
    const contract = /^\/futures\/([^/]+)\/trades\?/.exec(path)?.[1];
    if (!contract) throw new Error(`unexpected UW path ${path}`);
    const i = served[contract] ?? 0;
    served[contract] = i + 1;
    const page = pages[contract]?.[i];
    if (page === undefined) {
      throw new Error(`UW API 404: ${contract} page ${i}`);
    }
    return page;
  });
}

/** A stored bar as the SELECT returns it (driver types). */
export function storedRow(ts: string, over: Record<string, unknown> = {}) {
  return {
    ts: new Date(ts),
    open: '6700.2500',
    high: '6700.2500',
    low: '6700.2500',
    close: '6700.2500',
    volume: 5,
    buy_volume: 5,
    sell_volume: 0,
    buy_prints: 1,
    sell_prints: 0,
    ...over,
  };
}

/**
 * Routes the DB by SQL text. `stored` is keyed by root; an INSERT answers
 * with one RETURNING row per timestamp unless `conflicts` takes some.
 */
export function routeSql(
  stored: Record<string, unknown[]> = {},
  conflicts = 0,
): void {
  mockSql.mockImplementation(
    async (strings: readonly string[], ...values: unknown[]) => {
      const text = strings.join('?');
      if (text.includes('INSERT INTO futures_bars')) {
        return (values[1] as string[]).slice(conflicts).map((ts) => ({ ts }));
      }
      if (text.includes('FROM futures_bars')) {
        return stored[values[0] as string] ?? [];
      }
      return [];
    },
  );
}

export function tradesContracts(): string[] {
  return mockUwFetch.mock.calls.map(
    (c) => /^\/futures\/([^/]+)\/trades/.exec(c[1] as string)![1]!,
  );
}

/** Everything the run printed, console.log and console.error alike. */
export const logs: string[] = [];
export const out = () => logs.join('\n');

/** The line a run prints when it stops before a date, if it did. */
export const stopLine = () =>
  logs.find((l) => /Page budget spent|Market hours began/.test(l));

// ── Set-up ────────────────────────────────────────────────

/** Each test file's `beforeEach`. */
export function setUpBarRun(): void {
  vi.resetAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  mockIsMarketHours.mockReturnValue(false);
  routeSql();
  routeFrontMonth();
  mockRefresh.mockResolvedValue({ contracts: [], offered: 0, inserted: 0 });
  logs.length = 0;
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
    logs.push(a.join(' '));
  });
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
    logs.push(a.join(' '));
  });
}

/** Each test file's `afterEach`. */
export function tearDownBarRun(): void {
  vi.useRealTimers();
  vi.restoreAllMocks();
}
