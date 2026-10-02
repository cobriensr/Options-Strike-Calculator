// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSql } = vi.hoisted(() => ({ mockSql: vi.fn() }));

vi.mock('../_lib/db.js', () => ({
  withDbRetry: <T>(fn: () => Promise<T>): Promise<T> => fn(),
}));

import {
  INVERSION_WIN_THRESHOLD,
  SAMPLE_SIZE_FLOOR,
  buildShadowReport,
  computeTickerInversionStats,
  inversionBlend,
  quintileCuts,
  readLiveTickerStats,
  readTickerWindowCounts,
  wilsonLcb,
  writeLiveTickerStats,
  type TickerInversionStats,
} from '../_lib/lottery-ticker-refit.js';

type Sql = Parameters<typeof readTickerWindowCounts>[0];
const sql = mockSql as unknown as Sql;
const text = (i = 0): string =>
  (mockSql.mock.calls[i]![0] as string[]).join(' ');

beforeEach(() => {
  mockSql.mockReset();
});

/**
 * Reference values from the Python refit this module ports
 * (scripts/enrich_lottery_outcomes.py wilson_lcb / inversion_blend /
 * quintile_cuts), computed 2026-10-02 with ml/.venv.
 */
describe('parity with scripts/enrich_lottery_outcomes.py', () => {
  it.each([
    [7, 10, 0.3967732199795652],
    [0, 10, 0],
    [10, 10, 0.7224598312333834],
    [33, 120, 0.20302779841476157],
    [1, 47, 0.003765671010464998],
  ])('wilsonLcb(%i, %i) = %f', (w, n, expected) => {
    expect(wilsonLcb(w, n)).toBeCloseTo(expected, 12);
  });

  it('returns NULL below the sample floor', () => {
    expect(SAMPLE_SIZE_FLOOR).toBe(10);
    expect(wilsonLcb(9, 9)).toBeNull();
    expect(wilsonLcb(0, 0)).toBeNull();
  });

  it('blends 0.6 x 21d + 0.4 x 90d, else whichever window exists', () => {
    expect(inversionBlend(0.4, 0.3)).toBeCloseTo(0.36, 12);
    expect(inversionBlend(null, 0.3)).toBe(0.3);
    expect(inversionBlend(0.4, null)).toBe(0.4);
    expect(inversionBlend(null, null)).toBeNull();
  });

  it('cuts rank quintiles with (blend, ticker) tie order and skips NULL blends', () => {
    const q = quintileCuts(
      new Map<string, number | null>([
        ['AAPL', 0.3],
        ['AMD', 0.1],
        ['COIN', 0.3],
        ['META', 0.05],
        ['NVDA', 0.5],
        ['TSLA', 0.2],
        ['QQQ', 0.4],
        ['SPY', null],
      ]),
    );
    expect(Object.fromEntries(q)).toEqual({
      META: 1,
      AMD: 1,
      TSLA: 2,
      AAPL: 3,
      COIN: 4,
      QQQ: 5,
      NVDA: 5,
    });
    expect(
      Object.fromEntries(
        quintileCuts(
          new Map([
            ['A', 0.2],
            ['B', 0.1],
          ]),
        ),
      ),
    ).toEqual({ B: 1, A: 5 });
    expect(
      Object.fromEntries(
        quintileCuts(
          new Map<string, number | null>([
            ['A', 0.2],
            ['B', null],
          ]),
        ),
      ),
    ).toEqual({ A: 1 });
    expect(quintileCuts(new Map()).size).toBe(0);
  });
});

describe('computeTickerInversionStats', () => {
  it('computes bounds, blend and quintile per ticker, sorted by ticker', () => {
    const stats = computeTickerInversionStats([
      { ticker: 'TSLA', n21d: 10, w21d: 7, n90d: 120, w90d: 33 },
      { ticker: 'AMD', n21d: 3, w21d: 1, n90d: 47, w90d: 1 },
      { ticker: 'IBIT', n21d: 2, w21d: 2, n90d: 9, w90d: 9 },
    ]);

    expect(stats.map((s) => s.ticker)).toEqual(['AMD', 'IBIT', 'TSLA']);
    const [amd, ibit, tsla] = stats;
    expect(tsla!.blend).toBeCloseTo(
      0.6 * 0.3967732199795652 + 0.4 * 0.20302779841476157,
      12,
    );
    expect(amd).toMatchObject({ lcb21d: null, n21d: 3, n90d: 47 });
    expect(amd!.blend).toBeCloseTo(0.003765671010464998, 12);
    expect(amd!.quintile).toBe(1);
    expect(tsla!.quintile).toBe(5);
    // Insufficient sample in both windows: no bound, no blend, no quintile.
    expect(ibit).toEqual({
      ticker: 'IBIT',
      lcb21d: null,
      lcb90d: null,
      blend: null,
      quintile: null,
      n21d: 2,
      n90d: 9,
    });
  });

  it('assigns no quintile at all when every ticker is below the floor', () => {
    const stats = computeTickerInversionStats([
      { ticker: 'A', n21d: 0, w21d: 0, n90d: 0, w90d: 0 },
      { ticker: 'B', n21d: 4, w21d: 2, n90d: 9, w90d: 5 },
    ]);
    expect(stats.every((s) => s.quintile === null && s.blend === null)).toBe(
      true,
    );
  });
});

describe('buildShadowReport', () => {
  const s = (
    ticker: string,
    quintile: number | null,
    blend: number | null = quintile === null ? null : quintile / 10,
  ): TickerInversionStats => ({
    ticker,
    lcb21d: null,
    lcb90d: blend,
    blend,
    quintile,
    n21d: quintile === null ? 3 : 12,
    n90d: quintile === null ? 8 : 40,
  });

  it('reports coverage and every quintile change against the live table', () => {
    const report = buildShadowReport(
      [s('AAPL', 3), s('AMD', 2), s('COIN', null), s('NEW', 4), s('TSLA', 5)],
      [
        {
          ticker: 'AAPL',
          quintile: 3,
          blend: 0.3,
          updatedAt: '2026-06-17T03:30:00.000Z',
        },
        {
          ticker: 'AMD',
          quintile: 4,
          blend: 0.4,
          updatedAt: '2026-06-17T03:30:00.000Z',
        },
        {
          ticker: 'COIN',
          quintile: 1,
          blend: 0.05,
          updatedAt: '2026-06-17T03:30:00.000Z',
        },
        {
          ticker: 'TSLA',
          quintile: null,
          blend: null,
          updatedAt: '2026-06-16T03:30:00.000Z',
        },
        { ticker: 'OLD', quintile: 2, blend: 0.2, updatedAt: null },
      ],
    );

    expect(report).toMatchObject({
      tickersSeen: 5,
      tickersWithBlend: 4,
      tickersAtFloor21d: 4,
      tickersAtFloor90d: 4,
      resolvedFires21d: 51,
      resolvedFires90d: 168,
      shadowQuintiles: { '2': 1, '3': 1, '4': 1, '5': 1 },
      live: {
        rows: 5,
        withQuintile: 4,
        lastUpdatedAt: '2026-06-17T03:30:00.000Z',
      },
      diff: {
        unchanged: 1, // AAPL
        changed: 1, // AMD 4 → 2
        wouldClear: 1, // COIN 1 → NULL
        wouldSet: 1, // TSLA NULL → 5
        notInLiveTable: 1, // NEW (UPDATE-only write skips it)
        liveNotRefit: 1, // OLD (no fire in 90 d: left as is)
      },
    });
    expect(report.changes.map((c) => [c.ticker, c.live, c.shadow])).toEqual([
      ['AMD', 4, 2],
      ['COIN', 1, null],
      ['TSLA', null, 5],
    ]);
  });

  it('shows the empty-input case: no coverage, every live quintile would clear', () => {
    const report = buildShadowReport(
      [s('AAPL', null), s('AMD', null)],
      [
        { ticker: 'AAPL', quintile: 3, blend: 0.3, updatedAt: null },
        { ticker: 'AMD', quintile: 1, blend: 0.1, updatedAt: null },
      ],
    );
    expect(report.tickersWithBlend).toBe(0);
    expect(report.diff.wouldClear).toBe(2);
    expect(report.shadowQuintiles).toEqual({});
  });
});

describe('readTickerWindowCounts', () => {
  it('counts the 21d/90d windows over the last 90 days with the win threshold bound', async () => {
    mockSql.mockResolvedValueOnce([
      { ticker: 'TSLA', n21d: 10, w21d: 7, n90d: 120, w90d: 33 },
    ]);

    await expect(readTickerWindowCounts(sql)).resolves.toEqual([
      { ticker: 'TSLA', n21d: 10, w21d: 7, n90d: 120, w90d: 33 },
    ]);
    const t = text().replaceAll(/\s+/g, ' ');
    expect(t).toContain("trigger_time_ct >= NOW() - INTERVAL '90 days'");
    expect(t).toContain("trigger_time_ct >= NOW() - INTERVAL '21 days'");
    expect(t).toContain('GROUP BY underlying_symbol');
    expect(mockSql.mock.calls[0]!.slice(1)).toEqual([
      INVERSION_WIN_THRESHOLD,
      INVERSION_WIN_THRESHOLD,
    ]);
  });

  it.each([
    ['a string count', { ticker: 'A', n21d: '10', w21d: 1, n90d: 10, w90d: 1 }],
    ['a negative count', { ticker: 'A', n21d: -1, w21d: 0, n90d: 10, w90d: 1 }],
    [
      'wins above resolved',
      { ticker: 'A', n21d: 5, w21d: 6, n90d: 10, w90d: 6 },
    ],
    ['21d above 90d', { ticker: 'A', n21d: 12, w21d: 1, n90d: 10, w90d: 1 }],
    ['a NULL ticker', { ticker: null, n21d: 1, w21d: 0, n90d: 1, w90d: 0 }],
  ])('throws on %s (never fits stats on garbage)', async (_l, row) => {
    mockSql.mockResolvedValueOnce([row]);
    await expect(readTickerWindowCounts(sql)).rejects.toThrow(
      /malformed window counts/,
    );
  });

  it('propagates a DB reject', async () => {
    mockSql.mockRejectedValueOnce(new Error('neon: connection reset'));
    await expect(readTickerWindowCounts(sql)).rejects.toThrow(
      'connection reset',
    );
  });
});

describe('readLiveTickerStats', () => {
  it('normalizes driver strings and dates', async () => {
    mockSql.mockResolvedValueOnce([
      {
        ticker: 'AAPL',
        quintile: 3,
        blend: '0.31',
        updatedAt: new Date('2026-06-17T03:30:00Z'),
      },
      { ticker: 'IBIT', quintile: null, blend: null, updatedAt: null },
    ]);
    await expect(readLiveTickerStats(sql)).resolves.toEqual([
      {
        ticker: 'AAPL',
        quintile: 3,
        blend: 0.31,
        updatedAt: '2026-06-17T03:30:00.000Z',
      },
      { ticker: 'IBIT', quintile: null, blend: null, updatedAt: null },
    ]);
  });
});

describe('writeLiveTickerStats (the promotion path)', () => {
  const stat = (ticker: string, quintile: number | null) => ({
    ticker,
    lcb21d: null,
    lcb90d: 0.2,
    blend: quintile === null ? null : 0.2,
    quintile,
    n21d: 4,
    n90d: 30,
  });
  const live = (ticker: string, quintile: number | null) => ({
    ticker,
    quintile,
    blend: quintile === null ? null : quintile / 10,
    updatedAt: '2026-06-17T03:30:00.000Z',
  });
  /** Write with the report the cron would build for the same inputs. */
  const write = (
    stats: ReturnType<typeof stat>[],
    liveRows: ReturnType<typeof live>[],
  ) => writeLiveTickerStats(sql, stats, buildShadowReport(stats, liveRows));

  it('UPDATEs only existing rows, one batched statement, and returns the count', async () => {
    mockSql.mockResolvedValueOnce([{ ticker: 'AAPL' }]);

    await expect(
      write([stat('AAPL', 4), stat('NEW', null)], [live('AAPL', 2)]),
    ).resolves.toBe(1);
    const t = text();
    expect(t).toContain('UPDATE lottery_ticker_stats');
    expect(t).not.toContain('INSERT');
    expect(t).toContain('RETURNING t.ticker');
    expect(mockSql.mock.calls[0]!.slice(1)).toEqual([
      ['AAPL', 'NEW'],
      [null, null],
      [0.2, 0.2],
      [0.2, null],
      [4, null],
      [4, 4],
      [30, 30],
    ]);
  });

  it('refuses a write that would clear every quintile', async () => {
    await expect(
      write(
        [stat('AAPL', null), stat('AMD', null)],
        [live('AAPL', 3), live('AMD', 1)],
      ),
    ).rejects.toThrow(/refusing a live write that would clear 2 live/);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('refuses a write where one ticker has a blend but most live quintiles would clear', async () => {
    // A thin refit: TSLA re-fits, nine others fall below the sample floor.
    const others = [
      'AAPL',
      'AMD',
      'COIN',
      'GOOG',
      'HOOD',
      'META',
      'MSTR',
      'NVDA',
      'QQQ',
    ];
    const stats = [stat('TSLA', 1), ...others.map((t) => stat(t, null))];
    const liveRows = [live('TSLA', 4), ...others.map((t) => live(t, 3))];

    await expect(write(stats, liveRows)).rejects.toThrow(
      /would clear 9 live quintile\(s\) while keeping or re-fitting only 1/,
    );
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('allows a write that clears fewer quintiles than it keeps or re-fits', async () => {
    mockSql.mockResolvedValueOnce([{ ticker: 'AAPL' }, { ticker: 'AMD' }]);

    await expect(
      write(
        [stat('AAPL', 4), stat('AMD', 3), stat('COIN', null)],
        [live('AAPL', 4), live('AMD', 1), live('COIN', 2)],
      ),
    ).resolves.toBe(2); // unchanged 1 + changed 1 >= wouldClear 1
  });

  it('propagates a DB reject', async () => {
    mockSql.mockRejectedValueOnce(new Error('neon: write timeout'));
    await expect(write([stat('AAPL', 4)], [live('AAPL', 4)])).rejects.toThrow(
      'write timeout',
    );
  });
});
