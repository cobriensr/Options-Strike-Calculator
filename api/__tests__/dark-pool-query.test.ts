// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(),
}));

import { getDb } from '../_lib/db.js';
import {
  getDarkPoolLevels,
  getDarkPoolLastUpdated,
  getRecentDarkPoolPrints,
  getDarkPoolStrikeCountBuckets,
} from '../_lib/dark-pool-query.js';

type SqlMock = ReturnType<typeof vi.fn>;

function mockSql(rowSets: unknown[][]): SqlMock {
  const sql = vi.fn();
  for (const rows of rowSets) {
    sql.mockResolvedValueOnce(rows);
  }
  vi.mocked(getDb).mockReturnValue(sql as unknown as ReturnType<typeof getDb>);
  return sql;
}

function makePrintsRow(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    level: 5850,
    total_premium: '125000.50',
    trade_count: 12,
    total_shares: 4500,
    latest_time: new Date('2026-04-22T19:30:00Z'),
    updated_at: new Date('2026-04-22T19:30:05Z'),
    max_updated_at: new Date('2026-04-22T19:35:00Z'),
    ...overrides,
  };
}

function makeLegacyRow(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    spx_approx: 5840,
    total_premium: '95000.25',
    trade_count: 8,
    total_shares: 2400,
    latest_time: new Date('2026-04-22T19:30:00Z'),
    updated_at: new Date('2026-04-22T19:30:05Z'),
    max_updated_at: new Date('2026-04-22T19:35:00Z'),
    ...overrides,
  };
}

describe('getDarkPoolLevels', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    // The soak-window default has SPX preferring legacy. The existing
    // test cases below all exercise the daemon-preferred path (i.e.
    // post-cutover state), so flip the flag for them. The
    // SoakWindowDefault describe block at the bottom of the file
    // covers the unset (legacy-preferred) path explicitly.
    process.env.USE_DAEMON_DARK_POOL = 'true';
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  // ── Result shape ──────────────────────────────────────────

  it('returns levels sorted by total premium DESC (from prints)', async () => {
    mockSql([
      [
        makePrintsRow({ level: 5850, total_premium: '125000.50' }),
        makePrintsRow({ level: 5845, total_premium: '98000.00' }),
        makePrintsRow({ level: 5860, total_premium: '67000.75' }),
      ],
    ]);

    const result = await getDarkPoolLevels({
      date: '2026-04-22',
      symbol: 'SPX',
    });

    expect(result.levels).toHaveLength(3);
    expect(result.levels[0]!.level).toBe(5850);
    expect(result.levels[0]!.totalPremium).toBe(125000.5);
    expect(result.legacyFallback).toBe(false);
    expect(result.lastUpdated).toBe('2026-04-22T19:35:00.000Z');
  });

  it('coerces string-encoded NUMERIC fields to numbers', async () => {
    mockSql([
      [
        makePrintsRow({
          level: '5850',
          total_premium: '125000.50',
          total_shares: '4500',
        }),
      ],
    ]);

    const result = await getDarkPoolLevels({
      date: '2026-04-22',
      symbol: 'SPX',
    });

    expect(result.levels[0]!.level).toBe(5850);
    expect(typeof result.levels[0]!.level).toBe('number');
    expect(result.levels[0]!.totalPremium).toBe(125000.5);
    expect(result.levels[0]!.totalShares).toBe(4500);
  });

  it('renders Date latest_time / updated_at as ISO strings', async () => {
    mockSql([[makePrintsRow()]]);

    const result = await getDarkPoolLevels({
      date: '2026-04-22',
      symbol: 'SPX',
    });

    expect(result.levels[0]!.latestTime).toBe('2026-04-22T19:30:00.000Z');
    expect(result.levels[0]!.updatedAt).toBe('2026-04-22T19:30:05.000Z');
  });

  it('returns empty result when prints AND legacy both empty (SPX)', async () => {
    mockSql([[], []]); // prints empty → fallback to legacy → also empty

    const result = await getDarkPoolLevels({
      date: '2026-04-22',
      symbol: 'SPX',
    });

    expect(result.levels).toEqual([]);
    expect(result.lastUpdated).toBeNull();
    expect(result.legacyFallback).toBe(false);
  });

  // ── Selector dispatch ─────────────────────────────────────

  it('SPX selector queries dark_pool_prints with SPY+SPX candle JOIN', async () => {
    const sql = mockSql([[makePrintsRow()]]);

    await getDarkPoolLevels({ date: '2026-04-22', symbol: 'SPX' });

    const queryText = sql.mock.calls[0]![0].join('').toLowerCase();
    expect(queryText).toContain('dark_pool_prints');
    expect(queryText).toContain('etf_candles_1m');
    expect(queryText).toContain('index_candles_1m');
    // Bound parameters: etfTicker, indexSymbol, etfTicker, date
    const params = sql.mock.calls[0]!.slice(1);
    expect(params).toContain('SPY');
    expect(params).toContain('SPX');
  });

  it('NDX selector queries dark_pool_prints with QQQ+NDX candle JOIN', async () => {
    const sql = mockSql([[makePrintsRow({ level: 24500 })]]);

    await getDarkPoolLevels({ date: '2026-04-22', symbol: 'NDX' });

    const queryText = sql.mock.calls[0]![0].join('').toLowerCase();
    expect(queryText).toContain('dark_pool_prints');
    expect(queryText).toContain('etf_candles_1m');
    expect(queryText).toContain('index_candles_1m');
    const params = sql.mock.calls[0]!.slice(1);
    expect(params).toContain('QQQ');
    expect(params).toContain('NDX');
  });

  it('SPY selector uses native price bucketing (no candle JOIN)', async () => {
    const sql = mockSql([[makePrintsRow({ level: 585 })]]);

    await getDarkPoolLevels({ date: '2026-04-22', symbol: 'SPY' });

    const queryText = sql.mock.calls[0]![0].join('').toLowerCase();
    expect(queryText).toContain('dark_pool_prints');
    expect(queryText).not.toContain('etf_candles_1m');
    expect(queryText).not.toContain('index_candles_1m');
    expect(queryText).toContain('round(p.price)');
  });

  it('QQQ selector uses native price bucketing (no candle JOIN)', async () => {
    const sql = mockSql([[makePrintsRow({ level: 510 })]]);

    await getDarkPoolLevels({ date: '2026-04-22', symbol: 'QQQ' });

    const queryText = sql.mock.calls[0]![0].join('').toLowerCase();
    expect(queryText).toContain('dark_pool_prints');
    expect(queryText).not.toContain('etf_candles_1m');
    const params = sql.mock.calls[0]!.slice(1);
    expect(params).toContain('QQQ');
  });

  // ── Legacy fallback (SPX only) ────────────────────────────

  it('SPX falls back to dark_pool_levels when prints query is empty', async () => {
    const sql = mockSql([
      [], // prints empty
      [makeLegacyRow({ spx_approx: 5840 })], // legacy returns rows
    ]);

    const result = await getDarkPoolLevels({
      date: '2026-04-22',
      symbol: 'SPX',
    });

    expect(sql).toHaveBeenCalledTimes(2);
    expect(result.legacyFallback).toBe(true);
    expect(result.levels).toHaveLength(1);
    expect(result.levels[0]!.level).toBe(5840);
    // Confirm second query targeted dark_pool_levels
    const legacyText = sql.mock.calls[1]![0].join('').toLowerCase();
    expect(legacyText).toContain('dark_pool_levels');
  });

  it('SPX returns prints data when present (no fallback triggered)', async () => {
    const sql = mockSql([[makePrintsRow()]]);

    const result = await getDarkPoolLevels({
      date: '2026-04-22',
      symbol: 'SPX',
    });

    expect(sql).toHaveBeenCalledTimes(1);
    expect(result.legacyFallback).toBe(false);
  });

  it('NDX does NOT fall back to dark_pool_levels (legacy is SPY-only)', async () => {
    const sql = mockSql([[]]); // prints empty

    const result = await getDarkPoolLevels({
      date: '2026-04-22',
      symbol: 'NDX',
    });

    expect(sql).toHaveBeenCalledTimes(1); // no fallback query
    expect(result.levels).toEqual([]);
    expect(result.legacyFallback).toBe(false);
  });

  it('SPY does NOT fall back to dark_pool_levels (new ETF view)', async () => {
    const sql = mockSql([[]]);

    const result = await getDarkPoolLevels({
      date: '2026-04-22',
      symbol: 'SPY',
    });

    expect(sql).toHaveBeenCalledTimes(1);
    expect(result.levels).toEqual([]);
    expect(result.legacyFallback).toBe(false);
  });

  // ── Time filter ───────────────────────────────────────────

  it('passes asOfTimeCT into prints query when valid', async () => {
    const sql = mockSql([[makePrintsRow()]]);

    await getDarkPoolLevels({
      date: '2026-04-22',
      symbol: 'SPX',
      asOfTimeCT: '13:00',
    });

    const queryText = sql.mock.calls[0]![0].join('');
    expect(queryText.toLowerCase()).toContain('america/chicago');
    const params = sql.mock.calls[0]!.slice(1);
    expect(params).toContain('2026-04-22 13:00:00');
  });

  it('ignores malformed asOfTimeCT (uses no-time variant)', async () => {
    const sql = mockSql([[makePrintsRow()]]);

    await getDarkPoolLevels({
      date: '2026-04-22',
      symbol: 'SPX',
      asOfTimeCT: 'garbage',
    });

    const queryText = sql.mock.calls[0]![0].join('');
    // No time-bound query path → no AT TIME ZONE clause
    expect(queryText.toLowerCase()).not.toContain('america/chicago');
  });

  it('passes asOfTimeCT into legacy fallback when triggered', async () => {
    const sql = mockSql([[], [makeLegacyRow()]]);

    await getDarkPoolLevels({
      date: '2026-04-22',
      symbol: 'SPX',
      asOfTimeCT: '13:00',
    });

    const legacyQueryText = sql.mock.calls[1]![0].join('');
    expect(legacyQueryText.toLowerCase()).toContain('america/chicago');
  });

  // ── Date validation ──────────────────────────────────────

  it('throws on invalid date format', async () => {
    await expect(
      getDarkPoolLevels({ date: 'garbage', symbol: 'SPX' }),
    ).rejects.toThrow(/Invalid date/);
  });
});

// ── Soak-window default (USE_DAEMON_DARK_POOL unset) ─────────
//
// The migration's default while the daemon warms up: SPX always reads
// from the legacy dark_pool_levels table even when dark_pool_prints
// has rows. This prevents the "one early-morning daemon print bypasses
// the entire cron-fed dataset" footgun. NDX/SPY/QQQ are unaffected
// because they have no legacy source.

describe('getDarkPoolLevels — soak-window default (env flag unset)', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    // Explicitly remove the flag so the soak-window default applies
    delete process.env.USE_DAEMON_DARK_POOL;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('SPX bypasses prints query and reads legacy dark_pool_levels', async () => {
    const sql = mockSql([[makeLegacyRow()]]);

    const result = await getDarkPoolLevels({
      date: '2026-04-22',
      symbol: 'SPX',
    });

    expect(sql).toHaveBeenCalledTimes(1);
    expect(result.legacyFallback).toBe(true);
    const queryText = sql.mock.calls[0]![0].join('').toLowerCase();
    expect(queryText).toContain('dark_pool_levels');
    expect(queryText).not.toContain('dark_pool_prints');
  });

  it('NDX still reads from prints (no legacy source)', async () => {
    const sql = mockSql([[makePrintsRow({ level: 24500 })]]);

    const result = await getDarkPoolLevels({
      date: '2026-04-22',
      symbol: 'NDX',
    });

    expect(sql).toHaveBeenCalledTimes(1);
    expect(result.legacyFallback).toBe(false);
    const queryText = sql.mock.calls[0]![0].join('').toLowerCase();
    expect(queryText).toContain('dark_pool_prints');
  });

  it('SPY still reads from prints (no legacy source)', async () => {
    const sql = mockSql([[makePrintsRow({ level: 585 })]]);

    const result = await getDarkPoolLevels({
      date: '2026-04-22',
      symbol: 'SPY',
    });

    expect(sql).toHaveBeenCalledTimes(1);
    expect(result.legacyFallback).toBe(false);
  });

  it('SPX returns empty legacy result without falling through to prints', async () => {
    const sql = mockSql([[]]);

    const result = await getDarkPoolLevels({
      date: '2026-04-22',
      symbol: 'SPX',
    });

    expect(sql).toHaveBeenCalledTimes(1);
    expect(result.levels).toEqual([]);
    expect(result.legacyFallback).toBe(true);
    expect(result.lastUpdated).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────
// getDarkPoolLastUpdated
// ──────────────────────────────────────────────────────────────────

describe('getDarkPoolLastUpdated', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('queries dark_pool_levels when env flag unset (soak default)', async () => {
    delete process.env.USE_DAEMON_DARK_POOL;
    const sql = mockSql([[{ ts: new Date('2026-04-22T19:35:00Z') }]]);

    const ts = await getDarkPoolLastUpdated();

    expect(ts).toBe('2026-04-22T19:35:00.000Z');
    const queryText = sql.mock.calls[0]![0].join('').toLowerCase();
    expect(queryText).toContain('dark_pool_levels');
    expect(queryText).not.toContain('dark_pool_prints');
  });

  it('queries dark_pool_prints when env flag set', async () => {
    process.env.USE_DAEMON_DARK_POOL = 'true';
    const sql = mockSql([[{ ts: new Date('2026-04-22T19:35:00Z') }]]);

    const ts = await getDarkPoolLastUpdated();

    expect(ts).toBe('2026-04-22T19:35:00.000Z');
    const queryText = sql.mock.calls[0]![0].join('').toLowerCase();
    expect(queryText).toContain('dark_pool_prints');
    expect(queryText).toContain('ingested_at');
  });

  it('returns null when source has no rows', async () => {
    delete process.env.USE_DAEMON_DARK_POOL;
    mockSql([[{ ts: null }]]);

    const ts = await getDarkPoolLastUpdated();

    expect(ts).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────
// getRecentDarkPoolPrints
// ──────────────────────────────────────────────────────────────────

describe('getRecentDarkPoolPrints', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('SPX queries legacy table by default (soak window)', async () => {
    delete process.env.USE_DAEMON_DARK_POOL;
    const sql = mockSql([
      [
        {
          latest_time: new Date('2026-04-22T19:30:00Z'),
          spx_approx: 5840,
          total_premium: '95000',
        },
      ],
    ]);

    const rows = await getRecentDarkPoolPrints({
      date: '2026-04-22',
      symbol: 'SPX',
      fromIso: '2026-04-22T19:15:00Z',
      toIso: '2026-04-22T19:30:00Z',
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      ts: '2026-04-22T19:30:00.000Z',
      price: 5840,
      premium: 95000,
    });
    const queryText = sql.mock.calls[0]![0].join('').toLowerCase();
    expect(queryText).toContain('dark_pool_levels');
  });

  it('SPX with env flag set queries dark_pool_prints with candle JOIN', async () => {
    process.env.USE_DAEMON_DARK_POOL = 'true';
    const sql = mockSql([
      [
        {
          executed_at: new Date('2026-04-22T19:30:00Z'),
          price: 5850,
          premium: '125000.50',
        },
      ],
    ]);

    const rows = await getRecentDarkPoolPrints({
      date: '2026-04-22',
      symbol: 'SPX',
      fromIso: '2026-04-22T19:15:00Z',
      toIso: '2026-04-22T19:30:00Z',
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]!.price).toBe(5850);
    expect(rows[0]!.premium).toBe(125000.5);
    const queryText = sql.mock.calls[0]![0].join('').toLowerCase();
    expect(queryText).toContain('dark_pool_prints');
    expect(queryText).toContain('etf_candles_1m');
    expect(queryText).toContain('index_candles_1m');
  });

  it('NDX always queries dark_pool_prints (no legacy)', async () => {
    delete process.env.USE_DAEMON_DARK_POOL;
    const sql = mockSql([[]]);

    await getRecentDarkPoolPrints({
      date: '2026-04-22',
      symbol: 'NDX',
      fromIso: '2026-04-22T19:15:00Z',
      toIso: '2026-04-22T19:30:00Z',
    });

    const queryText = sql.mock.calls[0]![0].join('').toLowerCase();
    expect(queryText).toContain('dark_pool_prints');
    const params = sql.mock.calls[0]!.slice(1);
    expect(params).toContain('QQQ');
    expect(params).toContain('NDX');
  });

  it('SPY uses native price (no candle JOIN)', async () => {
    delete process.env.USE_DAEMON_DARK_POOL;
    const sql = mockSql([[]]);

    await getRecentDarkPoolPrints({
      date: '2026-04-22',
      symbol: 'SPY',
      fromIso: '2026-04-22T19:15:00Z',
      toIso: '2026-04-22T19:30:00Z',
    });

    const queryText = sql.mock.calls[0]![0].join('').toLowerCase();
    expect(queryText).toContain('dark_pool_prints');
    expect(queryText).not.toContain('etf_candles_1m');
  });

  it('respects custom limit', async () => {
    delete process.env.USE_DAEMON_DARK_POOL;
    const sql = mockSql([[]]);

    await getRecentDarkPoolPrints({
      date: '2026-04-22',
      symbol: 'SPX',
      fromIso: '2026-04-22T19:15:00Z',
      toIso: '2026-04-22T19:30:00Z',
      limit: 5,
    });

    const params = sql.mock.calls[0]!.slice(1);
    expect(params).toContain(5);
  });

  it('throws on invalid date', async () => {
    await expect(
      getRecentDarkPoolPrints({
        date: 'garbage',
        symbol: 'SPX',
        fromIso: '2026-04-22T19:15:00Z',
        toIso: '2026-04-22T19:30:00Z',
      }),
    ).rejects.toThrow(/Invalid date/);
  });
});

// ──────────────────────────────────────────────────────────────────
// getDarkPoolStrikeCountBuckets
// ──────────────────────────────────────────────────────────────────

describe('getDarkPoolStrikeCountBuckets', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('SPX queries legacy table by default (soak window)', async () => {
    delete process.env.USE_DAEMON_DARK_POOL;
    const sql = mockSql([
      [
        { bucket_index: 0, strike_count: 12 },
        { bucket_index: 1, strike_count: 8 },
      ],
    ]);

    const buckets = await getDarkPoolStrikeCountBuckets({
      symbol: 'SPX',
      fromIso: '2026-04-22T18:30:00Z',
      nowIso: '2026-04-22T19:30:00Z',
      bucketMs: 5 * 60 * 1000,
    });

    expect(buckets).toEqual([
      { bucketIndex: 0, strikeCount: 12 },
      { bucketIndex: 1, strikeCount: 8 },
    ]);
    const queryText = sql.mock.calls[0]![0].join('').toLowerCase();
    expect(queryText).toContain('dark_pool_levels');
    expect(queryText).toContain('count(distinct spx_approx)');
  });

  it('SPX with env flag queries dark_pool_prints with index ratio', async () => {
    process.env.USE_DAEMON_DARK_POOL = 'true';
    const sql = mockSql([[{ bucket_index: 0, strike_count: 12 }]]);

    await getDarkPoolStrikeCountBuckets({
      symbol: 'SPX',
      fromIso: '2026-04-22T18:30:00Z',
      nowIso: '2026-04-22T19:30:00Z',
      bucketMs: 5 * 60 * 1000,
    });

    const queryText = sql.mock.calls[0]![0].join('').toLowerCase();
    expect(queryText).toContain('dark_pool_prints');
    expect(queryText).toContain('index_candles_1m');
    expect(queryText).toContain('count(distinct level)');
  });

  it('NDX always queries dark_pool_prints', async () => {
    delete process.env.USE_DAEMON_DARK_POOL;
    const sql = mockSql([[]]);

    await getDarkPoolStrikeCountBuckets({
      symbol: 'NDX',
      fromIso: '2026-04-22T18:30:00Z',
      nowIso: '2026-04-22T19:30:00Z',
      bucketMs: 5 * 60 * 1000,
    });

    const queryText = sql.mock.calls[0]![0].join('').toLowerCase();
    expect(queryText).toContain('dark_pool_prints');
    expect(queryText).toContain('index_candles_1m');
  });

  it('QQQ uses native price bucketing (no index JOIN)', async () => {
    delete process.env.USE_DAEMON_DARK_POOL;
    const sql = mockSql([[]]);

    await getDarkPoolStrikeCountBuckets({
      symbol: 'QQQ',
      fromIso: '2026-04-22T18:30:00Z',
      nowIso: '2026-04-22T19:30:00Z',
      bucketMs: 5 * 60 * 1000,
    });

    const queryText = sql.mock.calls[0]![0].join('').toLowerCase();
    expect(queryText).toContain('dark_pool_prints');
    expect(queryText).not.toContain('index_candles_1m');
    expect(queryText).toContain('round(p.price)');
  });

  it('coerces string-encoded counts to numbers', async () => {
    delete process.env.USE_DAEMON_DARK_POOL;
    mockSql([[{ bucket_index: '3', strike_count: '15' }]]);

    const buckets = await getDarkPoolStrikeCountBuckets({
      symbol: 'SPX',
      fromIso: '2026-04-22T18:30:00Z',
      nowIso: '2026-04-22T19:30:00Z',
      bucketMs: 5 * 60 * 1000,
    });

    expect(buckets[0]).toEqual({ bucketIndex: 3, strikeCount: 15 });
    expect(typeof buckets[0]!.bucketIndex).toBe('number');
  });
});
