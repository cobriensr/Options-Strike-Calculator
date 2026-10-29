// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

// ── Mocks (module boundary — R3) ──────────────────────────

const mockSql = vi.fn();

vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
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

vi.mock('../_lib/axiom.js', () => ({
  reportCronRun: vi.fn(),
}));

const { mockUwFetch, mockCronGuard, mockWithRetry, mockMapWithConcurrency } =
  vi.hoisted(() => ({
    mockUwFetch: vi.fn(),
    mockCronGuard: vi.fn(),
    mockWithRetry: vi.fn((fn: () => unknown) => fn()),
    mockMapWithConcurrency: vi.fn(),
  }));

vi.mock('../_lib/api-helpers.js', () => ({
  uwFetch: mockUwFetch,
  cronGuard: mockCronGuard,
  withRetry: mockWithRetry,
  mapWithConcurrency: mockMapWithConcurrency,
}));

import handler from '../cron/fetch-futures-session-stats.js';
import { Sentry, metrics } from '../_lib/sentry.js';
import { reportCronRun } from '../_lib/axiom.js';

// The real fan-out, behind a spy so the concurrency limit is assertable.
const { mapWithConcurrency: realMapWithConcurrency } = await vi.importActual<
  typeof import('../_lib/uw-fetch.js')
>('../_lib/uw-fetch.js');

// ── Fixtures ──────────────────────────────────────────────

const GUARD = { apiKey: 'test-uw-key', today: '2026-10-29' };
const CONTRACTS_PATH = '/futures/contracts?days=5';
const statsPath = (contract: string) => `/futures/${contract}/stats`;

/** Two outrights per root, plus a spread and a micro that must never win. */
const CONTRACTS = [
  { name: 'ESZ6', product: 'ES', is_spread: false, volume: 3_267_170 },
  { name: 'ESH7', product: 'ES', is_spread: false, volume: 1_562 },
  { name: 'ESZ7', product: 'ES', is_spread: false, volume: 5 },
  { name: 'ESZ6-ESH7', product: 'ES', is_spread: true, volume: 9_999_999 },
  { name: 'MESZ6', product: 'MES', is_spread: false, volume: 2_363_415 },
  { name: 'NQZ6', product: 'NQ', is_spread: false, volume: 1_270_100 },
  { name: 'NQH7', product: 'NQ', is_spread: false, volume: 1_789 },
  { name: 'RTYZ6', product: 'RTY', is_spread: false, volume: 210_000 },
  { name: 'RTYH7', product: 'RTY', is_spread: false, volume: 900 },
  { name: 'CLZ6', product: 'CL', is_spread: false, volume: 800_000 },
  { name: 'CLF7', product: 'CL', is_spread: false, volume: 300_000 },
  { name: 'GCZ6', product: 'GC', is_spread: false, volume: 400_000 },
  { name: 'GCG7', product: 'GC', is_spread: false, volume: 90_000 },
  { name: 'ZNZ6', product: 'ZN', is_spread: false, volume: 1_500_000 },
  { name: 'ZNH7', product: 'ZN', is_spread: false, volume: 40_000 },
];

const TARGETS = [
  ['ESZ6', 'ES'],
  ['ESH7', 'ES'],
  ['NQZ6', 'NQ'],
  ['NQH7', 'NQ'],
  ['RTYZ6', 'RTY'],
  ['RTYH7', 'RTY'],
  ['CLZ6', 'CL'],
  ['CLF7', 'CL'],
  ['GCZ6', 'GC'],
  ['GCG7', 'GC'],
  ['ZNZ6', 'ZN'],
  ['ZNH7', 'ZN'],
] as const;

/** Live `/futures/{c}/stats` body shape (probed 2026-10-29 03:34 UTC). */
function statsBody(overrides: Record<string, unknown> = {}) {
  return {
    data: {
      open_interest: 1_928_340,
      session_high: '7769.000000000',
      session_low: '7740.000000000',
      session_volume: 1_576_563,
      settlement: '7783.250000000',
      settlement_date: '2026-10-28',
      ...overrides,
    },
  };
}

type Route = Record<string, unknown> | Error;

/**
 * Route uwFetch by path. Each route is the raw UW response body, and the
 * mock applies the caller's extractor (or the default `body.data`), so the
 * handler's own extractor is exercised.
 */
function routeUw(routes: Record<string, Route>) {
  mockUwFetch.mockImplementation(
    async (
      _key: string,
      path: string,
      extract?: (body: Record<string, unknown>) => unknown[],
    ) => {
      const r = routes[path];
      if (r === undefined) throw new Error(`unexpected UW path ${path}`);
      if (r instanceof Error) throw r;
      return extract ? extract(r) : r.data;
    },
  );
}

function allRoutes(overrides: Record<string, Route> = {}) {
  const routes: Record<string, Route> = {
    [CONTRACTS_PATH]: { data: CONTRACTS },
  };
  for (const [contract] of TARGETS) routes[statsPath(contract)] = statsBody();
  return { ...routes, ...overrides };
}

function sqlText(callIdx: number): string {
  const strings = mockSql.mock.calls[callIdx]?.[0] as readonly string[];
  return strings.join('?');
}

function sqlValues(callIdx: number): unknown[] {
  return mockSql.mock.calls[callIdx]!.slice(1);
}

/** The upsert's unnest arrays, in column order. */
function upsertColumns() {
  const [contract, product, date, settlement, oi, volume] = sqlValues(0) as [
    string[],
    string[],
    string[],
    Array<string | null>,
    Array<number | null>,
    Array<number | null>,
  ];
  return { contract, product, date, settlement, oi, volume };
}

/** RETURNING rows for an upsert of n contracts. */
function returning(n: number) {
  return Array.from({ length: n }, (_, i) => ({ contract: `C${i}` }));
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

describe('fetch-futures-session-stats handler', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockCronGuard.mockReturnValue(GUARD);
    mockWithRetry.mockImplementation((fn: () => unknown) => fn());
    mockMapWithConcurrency.mockImplementation(realMapWithConcurrency);
  });

  // ── Guard + wiring ────────────────────────────────────

  it('exits without touching the DB or UW when cronGuard rejects', async () => {
    mockCronGuard.mockReturnValue(null);

    await run();

    expect(mockSql).not.toHaveBeenCalled();
    expect(mockUwFetch).not.toHaveBeenCalled();
  });

  it('runs outside market hours (12:30 and 21:30 UTC schedule)', async () => {
    routeUw(allRoutes());
    mockSql.mockResolvedValueOnce(returning(12));

    await run();

    expect(mockCronGuard).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ marketHours: false }),
    );
  });

  // ── Happy path ────────────────────────────────────────

  it('fetches the contract list once, then stats for the top 2 non-spread contracts of each of the six roots, 3 at a time', async () => {
    routeUw(allRoutes());
    mockSql.mockResolvedValueOnce(returning(12));

    await run();

    const paths = mockUwFetch.mock.calls.map((c) => c[1]);
    expect(paths[0]).toBe(CONTRACTS_PATH);
    expect(paths.slice(1).sort()).toEqual(
      TARGETS.map(([c]) => statsPath(c)).sort(),
    );
    expect(paths).not.toContain(statsPath('ESZ6-ESH7'));
    expect(paths).not.toContain(statsPath('MESZ6'));
    expect(paths).not.toContain(statsPath('ESZ7'));
    expect(mockUwFetch.mock.calls.every((c) => c[0] === 'test-uw-key')).toBe(
      true,
    );
    // Every UW call goes through withRetry.
    expect(mockWithRetry).toHaveBeenCalledTimes(13);
    expect(mockMapWithConcurrency).toHaveBeenCalledWith(
      expect.any(Array),
      3,
      expect.any(Function),
    );
  });

  it('writes all 12 contracts in ONE batched unnest upsert keyed (contract, settlement_date) and reports success', async () => {
    routeUw(allRoutes());
    mockSql.mockResolvedValueOnce(returning(12));

    const res = await run();

    expect(mockSql).toHaveBeenCalledTimes(1);
    const text = sqlText(0);
    expect(text).toContain('INSERT INTO futures_session_stats');
    expect(text).toContain('unnest(');
    expect(text).toContain('ON CONFLICT (contract, settlement_date) DO UPDATE');
    // A later null never erases a known value.
    expect(text).toContain(
      'settlement = COALESCE(EXCLUDED.settlement, futures_session_stats.settlement)',
    );
    expect(text).toContain(
      'open_interest = COALESCE(EXCLUDED.open_interest, futures_session_stats.open_interest)',
    );
    expect(text).toContain(
      'session_volume = COALESCE(EXCLUDED.session_volume, futures_session_stats.session_volume)',
    );
    expect(text).toContain('fetched_at = now()');
    // fetched_at moves only when a stored value actually changes.
    expect(text).toMatch(/WHERE \([\s\S]*\) IS DISTINCT FROM \(/);

    const cols = upsertColumns();
    expect([...cols.contract].sort()).toEqual(TARGETS.map(([c]) => c).sort());
    // product is the root the contract was selected for.
    cols.contract.forEach((c, i) => {
      expect(cols.product[i]).toBe(TARGETS.find(([t]) => t === c)?.[1]);
    });
    expect(new Set(cols.date)).toEqual(new Set(['2026-10-28']));
    // The decimal string goes to Postgres as-is (no float round trip).
    expect(new Set(cols.settlement)).toEqual(new Set(['7783.250000000']));
    expect(new Set(cols.oi)).toEqual(new Set([1_928_340]));
    expect(new Set(cols.volume)).toEqual(new Set([1_576_563]));

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      status: 'success',
      rows: 12,
      unchanged: 0,
    });
    expect(reportCronRun).toHaveBeenCalledWith(
      'fetch-futures-session-stats',
      expect.objectContaining({ status: 'success', rows: 12, unchanged: 0 }),
    );
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it('counts rows the guarded upsert left alone as unchanged, not written', async () => {
    routeUw(allRoutes());
    // 12 sent; RETURNING lists only the 5 inserted or changed.
    mockSql.mockResolvedValueOnce(returning(5));

    const res = await run();

    expect(upsertColumns().contract).toHaveLength(12);
    expect(res._json).toMatchObject({
      status: 'success',
      rows: 5,
      unchanged: 7,
    });
  });

  it('never stores session_high/low (they belong to the in-progress session)', async () => {
    routeUw(allRoutes());
    mockSql.mockResolvedValueOnce(returning(12));

    await run();

    expect(sqlText(0)).not.toMatch(/session_high|session_low/);
    expect(JSON.stringify(sqlValues(0))).not.toContain('7769.000000000');
    expect(JSON.stringify(sqlValues(0))).not.toContain('7740.000000000');
  });

  it('does not validate the discarded session_high/low: a changed or missing one still writes the row', async () => {
    const withoutLow: Record<string, unknown> = { ...statsBody().data };
    delete withoutLow.session_low;
    routeUw(
      allRoutes({
        [statsPath('ESZ6')]: statsBody({ session_high: 7769 }),
        [statsPath('NQZ6')]: { data: withoutLow },
      }),
    );
    mockSql.mockResolvedValueOnce(returning(12));

    const res = await run();

    expect(upsertColumns().contract).toEqual(
      expect.arrayContaining(['ESZ6', 'NQZ6']),
    );
    expect(res._json).toMatchObject({ status: 'success', rows: 12 });
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
  });

  it('stores NULL for null settlement, open interest and session volume when the settlement date is known', async () => {
    routeUw(
      allRoutes({
        [statsPath('ESH7')]: statsBody({
          settlement: null,
          open_interest: null,
          session_volume: null,
          session_high: null,
          session_low: null,
        }),
      }),
    );
    mockSql.mockResolvedValueOnce(returning(12));

    const res = await run();

    const cols = upsertColumns();
    const i = cols.contract.indexOf('ESH7');
    expect(i).toBeGreaterThanOrEqual(0);
    expect(cols.date[i]).toBe('2026-10-28');
    expect(cols.settlement[i]).toBeNull();
    expect(cols.oi[i]).toBeNull();
    expect(cols.volume[i]).toBeNull();
    expect(res._json).toMatchObject({ status: 'success', rows: 12 });
  });

  it('a contract listed twice is fetched and written once (a repeated key would abort the whole upsert)', async () => {
    routeUw(
      allRoutes({
        [CONTRACTS_PATH]: { data: [...CONTRACTS, CONTRACTS[0]] },
      }),
    );
    mockSql.mockResolvedValueOnce(returning(12));

    await run();

    const esz6Calls = mockUwFetch.mock.calls.filter(
      (c) => c[1] === statsPath('ESZ6'),
    );
    expect(esz6Calls).toHaveLength(1);
    expect(upsertColumns().contract.filter((c) => c === 'ESZ6')).toHaveLength(
      1,
    );
  });

  // ── Skips (counted, not failures) ─────────────────────

  it('skips and counts a contract with a null settlement_date, and still writes the rest', async () => {
    routeUw(
      allRoutes({
        [statsPath('GCG7')]: statsBody({ settlement_date: null }),
      }),
    );
    mockSql.mockResolvedValueOnce(returning(11));

    const res = await run();

    const cols = upsertColumns();
    expect(cols.contract).toHaveLength(11);
    expect(cols.contract).not.toContain('GCG7');
    expect(res._json).toMatchObject({
      status: 'success',
      rows: 11,
      skippedNoSettlement: ['GCG7'],
    });
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      expect.stringContaining('no settlement date'),
      expect.objectContaining({
        level: 'warning',
        extra: expect.objectContaining({ contracts: ['GCG7'] }),
      }),
    );
  });

  it('no contract with a settlement date fails the run (error + metric + one warning), with no DB call', async () => {
    const routes = allRoutes();
    for (const [contract] of TARGETS) {
      routes[statsPath(contract)] = statsBody({ settlement_date: null });
    }
    routeUw(routes);

    const res = await run();

    expect(mockSql).not.toHaveBeenCalled();
    expect(res._json).toMatchObject({
      status: 'error',
      rows: 0,
      message: expect.stringContaining('settlement date'),
    });
    expect(
      (res._json as { skippedNoSettlement: string[] }).skippedNoSettlement,
    ).toHaveLength(12);
    expect(metrics.increment).toHaveBeenCalledWith(
      'fetch_futures_session_stats.no_settlement',
    );
    expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
    expect(reportCronRun).toHaveBeenCalledWith(
      'fetch-futures-session-stats',
      expect.objectContaining({ status: 'error' }),
    );
  });

  // ── Failure modes (R4) ────────────────────────────────

  it('an upstream 5xx on one contract → Sentry exception tagged with the contract, partial status, the other 11 written', async () => {
    routeUw(
      allRoutes({
        [statsPath('NQH7')]: new Error('UW API 502: bad gateway'),
      }),
    );
    mockSql.mockResolvedValueOnce(returning(11));

    const res = await run();

    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'UW API 502: bad gateway' }),
      expect.objectContaining({
        tags: expect.objectContaining({
          cron: 'fetch-futures-session-stats',
          contract: 'NQH7',
        }),
      }),
    );
    const cols = upsertColumns();
    expect(cols.contract).toHaveLength(11);
    expect(cols.contract).not.toContain('NQH7');
    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      status: 'partial',
      rows: 11,
      failures: [expect.stringContaining('NQH7')],
    });
    expect(reportCronRun).toHaveBeenCalledWith(
      'fetch-futures-session-stats',
      expect.objectContaining({ status: 'partial' }),
    );
  });

  it.each<[string, unknown]>([
    ['no data field', { error: 'shape changed' }],
    ['data is not an object', { data: [] }],
    ['a non-decimal settlement', statsBody({ settlement: 'abc' })],
    ['a numeric (not string) settlement', statsBody({ settlement: 7783.25 })],
    [
      'a settlement too large for NUMERIC(18,8)',
      statsBody({ settlement: '12345678901.5' }),
    ],
    [
      'an impossible settlement_date',
      statsBody({ settlement_date: '2026-02-30' }),
    ],
    ['a fractional open_interest', statsBody({ open_interest: 1.5 })],
    ['a negative session_volume', statsBody({ session_volume: -1 })],
    [
      'a missing open_interest key',
      { data: { ...statsBody().data, open_interest: undefined } },
    ],
  ])(
    'a malformed body (%s) is skipped, surfaced as a Sentry warning, and fails only that contract',
    async (_label, body) => {
      routeUw(
        allRoutes({ [statsPath('CLF7')]: body as Record<string, unknown> }),
      );
      mockSql.mockResolvedValueOnce(returning(11));

      const res = await run();

      expect(Sentry.captureMessage).toHaveBeenCalledWith(
        expect.stringContaining('malformed'),
        expect.objectContaining({
          level: 'warning',
          extra: expect.objectContaining({ contract: 'CLF7' }),
        }),
      );
      expect(upsertColumns().contract).not.toContain('CLF7');
      expect(upsertColumns().contract).toHaveLength(11);
      expect(res._json).toMatchObject({
        status: 'partial',
        rows: 11,
        failures: [expect.stringContaining('CLF7')],
      });
    },
  );

  it('a root with no listed contract fails that root (Sentry) while the others are written', async () => {
    routeUw(
      allRoutes({
        [CONTRACTS_PATH]: {
          data: CONTRACTS.filter((c) => c.product !== 'ZN'),
        },
      }),
    );
    mockSql.mockResolvedValueOnce(returning(10));

    const res = await run();

    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringMatching(/ZN/) }),
      expect.objectContaining({
        tags: expect.objectContaining({ symbol: 'ZN' }),
      }),
    );
    expect(upsertColumns().contract).toHaveLength(10);
    expect(res._json).toMatchObject({
      status: 'partial',
      rows: 10,
      failures: [expect.stringContaining('ZN')],
    });
  });

  it('every contract failing reports status error (red monitor), never success, and writes nothing', async () => {
    const routes = allRoutes();
    for (const [contract] of TARGETS) {
      routes[statsPath(contract)] = new Error('UW API 500: upstream down');
    }
    routeUw(routes);

    const res = await run();

    expect(mockSql).not.toHaveBeenCalled();
    expect(res._json).toMatchObject({ status: 'error', rows: 0 });
    expect(Sentry.captureException).toHaveBeenCalledTimes(12);
    expect(reportCronRun).toHaveBeenCalledWith(
      'fetch-futures-session-stats',
      expect.objectContaining({ status: 'error' }),
    );
  });

  it('a rejected DB upsert → 500 + Sentry exception + error reported, not success', async () => {
    routeUw(allRoutes());
    mockSql.mockRejectedValueOnce(new Error('numeric field overflow'));

    const res = await run();

    expect(res._status).toBe(500);
    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'numeric field overflow' }),
    );
    expect(reportCronRun).toHaveBeenCalledWith(
      'fetch-futures-session-stats',
      expect.objectContaining({ status: 'error' }),
    );
    expect(reportCronRun).not.toHaveBeenCalledWith(
      'fetch-futures-session-stats',
      expect.objectContaining({ status: 'success' }),
    );
  });

  it('a failed /futures/contracts call → 500 + Sentry, error reported, and no stats calls', async () => {
    routeUw({ [CONTRACTS_PATH]: new Error('UW API 500: upstream down') });

    const res = await run();

    expect(res._status).toBe(500);
    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'UW API 500: upstream down' }),
    );
    expect(reportCronRun).toHaveBeenCalledWith(
      'fetch-futures-session-stats',
      expect.objectContaining({ status: 'error' }),
    );
    expect(mockUwFetch).toHaveBeenCalledTimes(1);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('a non-array /futures/contracts payload → 500, error reported', async () => {
    routeUw({ [CONTRACTS_PATH]: { data: { unexpected: 'shape' } } });

    const res = await run();

    expect(res._status).toBe(500);
    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringMatching(/non-array/) }),
    );
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('an empty /futures/contracts list → error, one Sentry exception per root, no stats calls and no SQL', async () => {
    routeUw({ [CONTRACTS_PATH]: { data: [] } });

    const res = await run();

    expect(res._json).toMatchObject({ status: 'error', rows: 0 });
    expect(Sentry.captureException).toHaveBeenCalledTimes(6);
    for (const root of ['ES', 'NQ', 'RTY', 'CL', 'GC', 'ZN']) {
      expect(Sentry.captureException).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringContaining(root) }),
        expect.objectContaining({
          tags: expect.objectContaining({ symbol: root }),
        }),
      );
    }
    expect(mockUwFetch).toHaveBeenCalledTimes(1);
    expect(mockSql).not.toHaveBeenCalled();
    expect(reportCronRun).toHaveBeenCalledWith(
      'fetch-futures-session-stats',
      expect.objectContaining({ status: 'error' }),
    );
  });
});
