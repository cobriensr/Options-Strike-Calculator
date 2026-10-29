// @vitest-environment node

/**
 * REAL-SQL test for the fetch-futures-session-stats upsert.
 *
 * fetch-futures-session-stats.test.ts mocks the DB and only sees SQL
 * text. This file runs the handler end to end against pglite (real
 * Postgres in WASM): futures_session_stats comes from the REAL migration
 * #197, and the handler's own unnest upsert writes to it. It checks what
 * the mocks can't: decimal strings land at NUMERIC(18,8) without a float
 * round trip, NULLs inside the unnest arrays store as NULL, and a second
 * run for the same settlement date updates the row in place.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { mockRequest, mockResponse } from './helpers';

const { pg, mockUwFetch, mockCronGuard } = vi.hoisted(() => ({
  pg: { db: null as PGlite | null },
  mockUwFetch: vi.fn(),
  mockCronGuard: vi.fn(),
}));

// getDb() → a neon-shaped tagged template over the test's pglite handle.
vi.mock('../_lib/db.js', () => ({
  getDb:
    () =>
    (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.reduce((acc, s, i) => `${acc}$${i}${s}`);
      return pg.db!.query(text, values).then((r) => r.rows);
    },
  withDbRetry: <T>(fn: () => Promise<T>): Promise<T> => fn(),
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: {
    captureException: vi.fn(),
    captureMessage: vi.fn(),
    setTag: vi.fn(),
  },
  metrics: { increment: vi.fn() },
}));

vi.mock('../_lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../_lib/axiom.js', () => ({ reportCronRun: vi.fn() }));

vi.mock('../_lib/api-helpers.js', async () => {
  const { mapWithConcurrency } = await vi.importActual<
    typeof import('../_lib/uw-fetch.js')
  >('../_lib/uw-fetch.js');
  return {
    uwFetch: mockUwFetch,
    cronGuard: mockCronGuard,
    withRetry: (fn: () => unknown) => fn(),
    mapWithConcurrency,
  };
});

import handler from '../cron/fetch-futures-session-stats.js';
import { applyMigration } from './pglite-migrations.js';

const CONTRACTS = [
  { name: 'ESZ6', product: 'ES', is_spread: false, volume: 3_000_000 },
  { name: 'ESH7', product: 'ES', is_spread: false, volume: 1_500 },
  { name: 'NQZ6', product: 'NQ', is_spread: false, volume: 1_200_000 },
  { name: 'NQH7', product: 'NQ', is_spread: false, volume: 1_700 },
  { name: 'RTYZ6', product: 'RTY', is_spread: false, volume: 200_000 },
  { name: 'RTYH7', product: 'RTY', is_spread: false, volume: 900 },
  { name: 'CLZ6', product: 'CL', is_spread: false, volume: 800_000 },
  { name: 'CLF7', product: 'CL', is_spread: false, volume: 300_000 },
  { name: 'GCZ6', product: 'GC', is_spread: false, volume: 400_000 },
  { name: 'GCG7', product: 'GC', is_spread: false, volume: 90_000 },
  { name: 'ZNZ6', product: 'ZN', is_spread: false, volume: 1_500_000 },
  { name: 'ZNH7', product: 'ZN', is_spread: false, volume: 40_000 },
];

type Stats = Record<string, unknown>;

function stats(overrides: Stats = {}): Stats {
  return {
    open_interest: 1_928_340,
    session_high: '7769.000000000',
    session_low: '7740.000000000',
    session_volume: 1_576_563,
    settlement: '7783.250000000',
    settlement_date: '2026-10-28',
    ...overrides,
  };
}

/** Every contract gets `base`; `perContract` overrides individual ones. */
function routeUw(base: Stats, perContract: Record<string, Stats> = {}) {
  mockUwFetch.mockImplementation(
    async (
      _key: string,
      path: string,
      extract?: (body: Record<string, unknown>) => unknown[],
    ) => {
      if (path === '/futures/contracts?days=5') return CONTRACTS;
      const m = /^\/futures\/([^/]+)\/stats$/.exec(path);
      if (!m?.[1] || !extract) throw new Error(`unexpected UW path ${path}`);
      return extract({ data: { ...base, ...perContract[m[1]] } });
    },
  );
}

async function run() {
  const res = mockResponse();
  await handler(
    mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    }),
    res,
  );
  return res;
}

interface StoredRow {
  contract: string;
  product: string;
  settlement_date: string;
  settlement: string | null;
  open_interest: string | null;
  session_volume: string | null;
  fetched_at: string;
}

async function stored(contract: string): Promise<StoredRow[]> {
  const r = await pg.db!.query<StoredRow>(
    `SELECT contract, product, settlement_date::text AS settlement_date,
            settlement::text AS settlement,
            open_interest::text AS open_interest,
            session_volume::text AS session_volume,
            fetched_at::text AS fetched_at
     FROM futures_session_stats WHERE contract = $1`,
    [contract],
  );
  return r.rows;
}

async function count(): Promise<number> {
  const r = await pg.db!.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM futures_session_stats',
  );
  return r.rows[0]!.n;
}

describe('fetch-futures-session-stats upsert (pglite)', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mockCronGuard.mockReturnValue({ apiKey: 'k', today: '2026-10-29' });
    pg.db = new PGlite();
    await applyMigration(pg.db, 197);
  });

  afterEach(async () => {
    await pg.db!.close();
    pg.db = null;
  });

  it('writes one row per contract with the settlement at scale 8, never touching session high/low', async () => {
    routeUw(stats());

    const res = await run();

    expect(res._json).toMatchObject({ status: 'success', rows: 12 });
    expect(await count()).toBe(12);
    expect(await stored('ESZ6')).toEqual([
      expect.objectContaining({
        contract: 'ESZ6',
        product: 'ES',
        settlement_date: '2026-10-28',
        settlement: '7783.25000000',
        open_interest: '1928340',
        session_volume: '1576563',
      }),
    ]);
  });

  it('keeps every digit of a long or negative decimal (no float round trip)', async () => {
    routeUw(stats(), {
      ZNZ6: { settlement: '112.67187500' },
      CLF7: { settlement: '-37.630000000' },
      GCZ6: { settlement: '9999999999.12345678' },
    });

    await run();

    expect((await stored('ZNZ6'))[0]?.settlement).toBe('112.67187500');
    expect((await stored('CLF7'))[0]?.settlement).toBe('-37.63000000');
    expect((await stored('GCZ6'))[0]?.settlement).toBe('9999999999.12345678');
  });

  it('stores NULL for null values inside the unnest arrays', async () => {
    routeUw(stats(), {
      ESH7: { settlement: null, open_interest: null, session_volume: null },
    });

    await run();

    expect(await stored('ESH7')).toEqual([
      expect.objectContaining({
        settlement_date: '2026-10-28',
        settlement: null,
        open_interest: null,
        session_volume: null,
      }),
    ]);
  });

  it('a second run for the same settlement date updates the row in place and moves fetched_at', async () => {
    routeUw(stats({ open_interest: 1_900_000 }));
    await run();
    // Age the first write so the second run's now() is unambiguously later.
    await pg.db!.query(
      `UPDATE futures_session_stats SET fetched_at = '2026-10-28T21:30:00Z'`,
    );

    routeUw(stats({ open_interest: 1_928_340, session_volume: 1_600_000 }));
    const res = await run();

    expect(res._json).toMatchObject({ status: 'success', rows: 12 });
    expect(await count()).toBe(12);
    const [row] = await stored('ESZ6');
    expect(row).toMatchObject({
      open_interest: '1928340',
      session_volume: '1600000',
    });
    expect(Date.parse(row!.fetched_at)).toBeGreaterThan(
      Date.parse('2026-10-28T21:30:00Z'),
    );
  });

  it('a new settlement date adds a row instead of overwriting the previous session', async () => {
    routeUw(stats());
    await run();

    routeUw(stats({ settlement_date: '2026-10-29', settlement: '7801.5' }));
    await run();

    expect(await count()).toBe(24);
    const rows = await stored('ESZ6');
    expect(rows.map((r) => [r.settlement_date, r.settlement]).sort()).toEqual([
      ['2026-10-28', '7783.25000000'],
      ['2026-10-29', '7801.50000000'],
    ]);
  });
});
