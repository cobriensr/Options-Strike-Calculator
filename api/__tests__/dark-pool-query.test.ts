// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';

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

// ──────────────────────────────────────────────────────────────────
// getDarkPoolLevels
// ──────────────────────────────────────────────────────────────────

describe('getDarkPoolLevels', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Result shape ──────────────────────────────────────────

  it('returns levels sorted by total premium DESC', async () => {
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

  it('returns empty result when prints query is empty', async () => {
    mockSql([[]]);

    const result = await getDarkPoolLevels({
      date: '2026-04-22',
      symbol: 'SPX',
    });

    expect(result.levels).toEqual([]);
    expect(result.lastUpdated).toBeNull();
  });

  // ── Selector dispatch ─────────────────────────────────────

  it('SPX selector queries dark_pool_prints with SPY+SPX candle JOIN', async () => {
    const sql = mockSql([[makePrintsRow()]]);

    await getDarkPoolLevels({ date: '2026-04-22', symbol: 'SPX' });

    const queryText = sql.mock.calls[0]![0].join('').toLowerCase();
    expect(queryText).toContain('dark_pool_prints');
    expect(queryText).toContain('etf_candles_1m');
    expect(queryText).toContain('index_candles_1m');
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
    expect(queryText.toLowerCase()).not.toContain('america/chicago');
  });

  // ── Date validation ──────────────────────────────────────

  it('throws on invalid date format', async () => {
    await expect(
      getDarkPoolLevels({ date: 'garbage', symbol: 'SPX' }),
    ).rejects.toThrow(/Invalid date/);
  });
});

// ──────────────────────────────────────────────────────────────────
// getDarkPoolLastUpdated
// ──────────────────────────────────────────────────────────────────

describe('getDarkPoolLastUpdated', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('queries dark_pool_prints MAX(ingested_at)', async () => {
    const sql = mockSql([[{ ts: new Date('2026-04-22T19:35:00Z') }]]);

    const ts = await getDarkPoolLastUpdated();

    expect(ts).toBe('2026-04-22T19:35:00.000Z');
    const queryText = sql.mock.calls[0]![0].join('').toLowerCase();
    expect(queryText).toContain('dark_pool_prints');
    expect(queryText).toContain('ingested_at');
  });

  it('returns null when no rows', async () => {
    mockSql([[{ ts: null }]]);

    const ts = await getDarkPoolLastUpdated();

    expect(ts).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────
// getRecentDarkPoolPrints
// ──────────────────────────────────────────────────────────────────

describe('getRecentDarkPoolPrints', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('SPX queries dark_pool_prints with candle JOIN', async () => {
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

  it('NDX queries dark_pool_prints with QQQ+NDX', async () => {
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
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('SPX queries dark_pool_prints with index ratio', async () => {
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

  it('NDX queries dark_pool_prints with QQQ+NDX', async () => {
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
