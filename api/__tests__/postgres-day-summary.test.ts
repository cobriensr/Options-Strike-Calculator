// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockSql = vi.fn();
vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
}));
vi.mock('../_lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  fetchDayOhlcFromPostgres,
  fetchDaySummaryFromPostgres,
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
      },
    ]);

    const out = await fetchDaySummaryFromPostgres('2026-04-21');
    expect(out).toBe(
      '2026-04-21 SPX | open 5700.00 | 1h delta -2.50 | 2h delta -5.00 | ' +
        '3h delta +10.25 | range 30.00 | vol 1.65M | close 5720.00 (+20.00)',
    );
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
      },
    ]);

    const out = await fetchDaySummaryFromPostgres('2026-11-28');
    expect(out).toBe(
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
      },
    ]);

    const out = await fetchDaySummaryFromPostgres('2026-04-21');
    expect(out).toContain('close 5685.00 (-15.00)');
    expect(out).toContain('vol 2.10M');
  });

  it('returns null on database error rather than throwing', async () => {
    mockSql.mockRejectedValueOnce(new Error('connection refused'));

    const out = await fetchDaySummaryFromPostgres('2026-04-21');
    expect(out).toBeNull();
  });
});

describe('fetchDayOhlcFromPostgres', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('returns null when no bars exist', async () => {
    mockSql.mockResolvedValueOnce([
      { day_open: null, day_high: null, day_low: null, day_close: null },
    ]);

    const out = await fetchDayOhlcFromPostgres('2026-04-21');
    expect(out).toBeNull();
  });

  it('aggregates OHLC and computes simple excursion metrics', async () => {
    mockSql.mockResolvedValueOnce([
      {
        day_open: 5700,
        day_high: 5725,
        day_low: 5695,
        day_close: 5720,
      },
    ]);

    const out = await fetchDayOhlcFromPostgres('2026-04-21');
    expect(out).toEqual({
      open: 5700,
      high: 5725,
      low: 5695,
      close: 5720,
      range: 30,
      up_excursion: 25,
      down_excursion: 5,
    });
  });

  it('returns null on database error', async () => {
    mockSql.mockRejectedValueOnce(new Error('boom'));

    const out = await fetchDayOhlcFromPostgres('2026-04-21');
    expect(out).toBeNull();
  });
});
