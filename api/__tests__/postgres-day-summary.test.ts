// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockSql = vi.fn();
vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
  withDbRetry: <T>(fn: () => Promise<T>): Promise<T> => fn(),
}));
vi.mock('../_lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import logger from '../_lib/logger.js';
import {
  fetchDayOhlcFromPostgres,
  fetchDaySummaryFromPostgres,
  fetchVixCloseFromPostgres,
  readDayOhlcFromPostgres,
} from '../_lib/postgres-day-summary.js';

describe('fetchDaySummaryFromPostgres', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns null when no bars exist for the date', async () => {
    mockSql.mockResolvedValueOnce([
      {
        day_open: null,
        day_high: null,
        day_low: null,
        day_close: null,
        day_volume: null,
        close_60: null,
        close_120: null,
        close_180: null,
        bar_count: 0,
      },
    ]);

    const out = await fetchDaySummaryFromPostgres('2026-04-21');
    expect(out).toBeNull();
  });

  it('formats a complete day in the sidecar-compatible format', async () => {
    // Simulate a clean trading day: open 5700, close 5720 (+20), 1h delta
    // -2.5, 2h delta -5.0, 3h delta +10.25, range 30 (high-low),
    // total volume 1.65M.
    mockSql.mockResolvedValueOnce([
      {
        day_open: 5700,
        day_high: 5725,
        day_low: 5695,
        day_close: 5720,
        day_volume: 1_650_000,
        close_60: 5697.5,
        close_120: 5695,
        close_180: 5710.25,
        bar_count: 390,
      },
    ]);

    const out = await fetchDaySummaryFromPostgres('2026-04-21');
    expect(out).toEqual({
      summary:
        '2026-04-21 SPX | open 5700.00 | 1h delta -2.50 | 2h delta -5.00 | ' +
        '3h delta +10.25 | range 30.00 | vol 1.65M | close 5720.00 (+20.00)',
      barCount: 390,
    });
  });

  it('reports the bar count of a partial day so the caller can refuse it', async () => {
    // 2026-09-21: the SPX feed died at 16:18 UTC after 169 of 390 bars.
    mockSql.mockResolvedValueOnce([
      {
        day_open: 7693.61,
        day_high: 7751.38,
        day_low: 7693.61,
        day_close: 7745.68,
        day_volume: 15_730_000,
        close_60: 7720.93,
        close_120: 7729.9,
        close_180: 7745.68,
        bar_count: '169',
      },
    ]);

    const out = await fetchDaySummaryFromPostgres('2026-09-21');
    expect(out?.barCount).toBe(169);
  });

  it('renders n/a when intra-session checkpoints are missing (short day)', async () => {
    // Half-day: only 90 minutes of bars, so close_120/close_180 are null.
    mockSql.mockResolvedValueOnce([
      {
        day_open: 5800,
        day_high: 5810,
        day_low: 5798,
        day_close: 5805,
        day_volume: 421,
        close_60: 5802,
        close_120: null,
        close_180: null,
        bar_count: 90,
      },
    ]);

    const out = await fetchDaySummaryFromPostgres('2026-11-28');
    expect(out?.summary).toBe(
      '2026-11-28 SPX | open 5800.00 | 1h delta +2.00 | 2h delta n/a | ' +
        '3h delta n/a | range 12.00 | vol 421 | close 5805.00 (+5.00)',
    );
  });

  it('formats negative close-vs-open with a minus sign', async () => {
    mockSql.mockResolvedValueOnce([
      {
        day_open: 5700,
        day_high: 5705,
        day_low: 5680,
        day_close: 5685,
        day_volume: 2_100_500,
        close_60: 5695,
        close_120: 5690,
        close_180: 5687,
        bar_count: 390,
      },
    ]);

    const out = await fetchDaySummaryFromPostgres('2026-04-21');
    expect(out?.summary).toContain('close 5685.00 (-15.00)');
    expect(out?.summary).toContain('vol 2.10M');
  });

  it('propagates a database error instead of reporting "no data"', async () => {
    mockSql.mockRejectedValueOnce(new Error('connection refused'));

    await expect(fetchDaySummaryFromPostgres('2026-04-21')).rejects.toThrow(
      'connection refused',
    );
  });
});

describe('readDayOhlcFromPostgres', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('returns null when no bars exist', async () => {
    mockSql.mockResolvedValueOnce([
      {
        day_open: null,
        day_high: null,
        day_low: null,
        day_close: null,
        bar_count: 0,
      },
    ]);

    expect(await readDayOhlcFromPostgres('2026-04-21')).toBeNull();
  });

  it('aggregates OHLC, simple excursions and the bar count', async () => {
    mockSql.mockResolvedValueOnce([
      {
        day_open: 5700,
        day_high: 5725,
        day_low: 5695,
        day_close: 5720,
        bar_count: 390,
      },
    ]);

    expect(await readDayOhlcFromPostgres('2026-04-21')).toEqual({
      ohlc: {
        open: 5700,
        high: 5725,
        low: 5695,
        close: 5720,
        range: 30,
        up_excursion: 25,
        down_excursion: 5,
      },
      barCount: 390,
    });
  });

  it('propagates a database error', async () => {
    mockSql.mockRejectedValueOnce(new Error('boom'));

    await expect(readDayOhlcFromPostgres('2026-04-21')).rejects.toThrow('boom');
  });
});

describe('fetchDayOhlcFromPostgres (fail-soft wrapper)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('returns the OHLC without the bar count', async () => {
    mockSql.mockResolvedValueOnce([
      {
        day_open: 5700,
        day_high: 5725,
        day_low: 5695,
        day_close: 5720,
        bar_count: 390,
      },
    ]);

    expect(await fetchDayOhlcFromPostgres('2026-04-21')).toEqual({
      open: 5700,
      high: 5725,
      low: 5695,
      close: 5720,
      range: 30,
      up_excursion: 25,
      down_excursion: 5,
    });
  });

  it('returns null when no bars exist', async () => {
    mockSql.mockResolvedValueOnce([
      { day_open: null, day_high: null, day_low: null, day_close: null },
    ]);

    expect(await fetchDayOhlcFromPostgres('2026-04-21')).toBeNull();
  });

  it('returns null on database error (regime-0DTE scorecard contract) and logs it', async () => {
    mockSql.mockRejectedValueOnce(new Error('boom'));

    expect(await fetchDayOhlcFromPostgres('2026-04-21')).toBeNull();
    // Fail-soft must not mean silent: the swallowed error is logged with
    // the error object and the date.
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error), date: '2026-04-21' }),
      'fetchDayOhlcFromPostgres failed',
    );
  });
});

describe('fetchVixCloseFromPostgres', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('returns the numeric VIX close (Neon NUMERIC arrives as a string)', async () => {
    mockSql.mockResolvedValueOnce([{ vix_close: '16.39' }]);
    expect(await fetchVixCloseFromPostgres('2026-10-01')).toBe(16.39);
  });

  it('returns null when the outcomes row or value is missing', async () => {
    mockSql.mockResolvedValueOnce([]);
    expect(await fetchVixCloseFromPostgres('2026-09-22')).toBeNull();
    mockSql.mockResolvedValueOnce([{ vix_close: null }]);
    expect(await fetchVixCloseFromPostgres('2026-09-23')).toBeNull();
  });

  it('propagates a database error', async () => {
    mockSql.mockRejectedValueOnce(new Error('pg down'));
    await expect(fetchVixCloseFromPostgres('2026-10-01')).rejects.toThrow(
      'pg down',
    );
  });
});
