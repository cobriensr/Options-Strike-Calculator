// @vitest-environment node

/**
 * Unit tests for computeSnapshot's bar-freshness rules.
 *
 * Background: when the futures_bars feed stopped (Databento cancelled
 * 2026-09-03) computeSnapshot kept returning the last bar it could find,
 * so the cron wrote the same frozen ES price into futures_snapshots for
 * ~4 weeks. Every bar that stands in for a price at some moment must now
 * be within 15 minutes of that moment.
 *
 * computeSnapshot issues its queries sequentially for one symbol, so the
 * mocks use mockResolvedValueOnce in query order:
 *   1. latest bar (ts <= at)
 *   2. 1H-ago reference bar (ts <= at - 60m)
 *   3. day-open reference bar (ts >= 9:30 ET)
 *   4. 20-day average daily volume
 *   5. today's volume
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSql = vi.fn();

vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
}));

vi.mock('../_lib/logger.js', () => ({
  default: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import {
  FUTURES_SYMBOLS,
  computeSnapshot,
  type SnapshotResult,
  type SnapshotRow,
} from '../_lib/futures-derive.js';
import logger from '../_lib/logger.js';

// 2026-04-03 is EDT, so the 9:30 ET cash open is 13:30 UTC.
const TRADE_DATE = '2026-04-03';
const AT = new Date('2026-04-03T16:00:00.000Z');
const DAY_OPEN_TS = '2026-04-03T13:30:00.000Z';

function minutesBefore(base: Date, minutes: number): string {
  return new Date(base.getTime() - minutes * 60_000).toISOString();
}

const HOUR_AGO = new Date(AT.getTime() - 60 * 60_000);

interface Rows {
  latest?: Record<string, unknown>[];
  hourAgo?: Record<string, unknown>[];
  dayOpen?: Record<string, unknown>[];
  avgVol?: Record<string, unknown>[];
  todayVol?: Record<string, unknown>[];
}

/** Queue the five query results in the order computeSnapshot issues them. */
function queueRows(rows: Rows = {}) {
  mockSql
    .mockResolvedValueOnce(
      rows.latest ?? [{ close: '5700', ts: minutesBefore(AT, 1) }],
    )
    .mockResolvedValueOnce(
      rows.hourAgo ?? [{ close: '5650', ts: minutesBefore(HOUR_AGO, 1) }],
    )
    .mockResolvedValueOnce(rows.dayOpen ?? [{ close: '5600', ts: DAY_OPEN_TS }])
    .mockResolvedValueOnce(rows.avgVol ?? [{ avg_vol: '100000' }])
    .mockResolvedValueOnce(rows.todayVol ?? [{ today_vol: '120000' }]);
}

/** Assert the result is fresh and return its snapshot. */
function expectFresh(result: SnapshotResult): SnapshotRow {
  expect(result.kind).toBe('fresh');
  if (result.kind !== 'fresh') throw new Error('unreachable');
  return result.snapshot;
}

describe('FUTURES_SYMBOLS', () => {
  it('does not include DX (ICE product, no UW feed, dead since 2026-03-05)', () => {
    expect(FUTURES_SYMBOLS).not.toContain('DX');
    expect([...FUTURES_SYMBOLS]).toEqual([
      'ES',
      'NQ',
      'VX1',
      'VX2',
      'ZN',
      'RTY',
      'CL',
      'GC',
    ]);
  });
});

describe('computeSnapshot', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  // ── Latest bar freshness ────────────────────────────────────

  it('returns a fresh snapshot when the latest bar is fresh', async () => {
    queueRows();

    const snap = expectFresh(await computeSnapshot('ES', TRADE_DATE, AT));

    expect(snap.symbol).toBe('ES');
    expect(snap.price).toBe(5700);
    expect(snap.latestTs).toBe(minutesBefore(AT, 1));
    // (5700 - 5650) / 5650 * 100
    expect(snap.change1hPct).toBeCloseTo(0.885, 3);
    // (5700 - 5600) / 5600 * 100
    expect(snap.changeDayPct).toBeCloseTo(1.786, 3);
    expect(snap.volumeRatio).toBeCloseTo(1.2, 6);
  });

  it('accepts a bar exactly 15 minutes old (boundary is inclusive)', async () => {
    queueRows({ latest: [{ close: '5700', ts: minutesBefore(AT, 15) }] });

    const snap = expectFresh(await computeSnapshot('ES', TRADE_DATE, AT));

    expect(snap.price).toBe(5700);
  });

  it('accepts a Date-typed ts (Neon may return TIMESTAMPTZ as a Date)', async () => {
    queueRows({
      latest: [{ close: '5700', ts: new Date(minutesBefore(AT, 2)) }],
    });

    const snap = expectFresh(await computeSnapshot('ES', TRADE_DATE, AT));

    expect(snap.latestTs).toBe(minutesBefore(AT, 2));
  });

  it('reports stale with ts and age when the latest bar is >15 min old', async () => {
    queueRows({ latest: [{ close: '5700', ts: minutesBefore(AT, 16) }] });

    const result = await computeSnapshot('ES', TRADE_DATE, AT);

    expect(result).toEqual({
      kind: 'stale',
      latestTs: minutesBefore(AT, 16),
      ageMinutes: 16,
    });
    // Short-circuits: no reference-bar or volume queries for a stale symbol.
    expect(mockSql).toHaveBeenCalledTimes(1);
  });

  it('reports stale for the frozen-feed case (latest bar weeks old)', async () => {
    // The production incident: ES stuck at the 2026-09-03 close.
    const at = new Date('2026-09-29T15:00:00.000Z');
    mockSql.mockResolvedValueOnce([
      { close: '7752.75', ts: '2026-09-03T23:59:00.000Z' },
    ]);

    const result = await computeSnapshot('ES', '2026-09-29', at);

    expect(result).toEqual({
      kind: 'stale',
      latestTs: '2026-09-03T23:59:00.000Z',
      ageMinutes: 36_901, // ~25.6 days
    });
  });

  it('logs the symbol and bar age when it drops a stale bar', async () => {
    queueRows({ latest: [{ close: '5700', ts: minutesBefore(AT, 90) }] });

    await computeSnapshot('CL', TRADE_DATE, AT);

    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        symbol: 'CL',
        ageMinutes: 90,
        latestTs: minutesBefore(AT, 90),
      }),
      expect.stringContaining('stale'),
    );
  });

  it('reports stale (not fresh) when the latest bar has no parseable ts', async () => {
    queueRows({ latest: [{ close: '5700', ts: null }] });

    const result = await computeSnapshot('ES', TRADE_DATE, AT);

    expect(result).toEqual({ kind: 'stale', latestTs: null, ageMinutes: null });
  });

  it('reports missing when no bar exists at or before `at`', async () => {
    queueRows({ latest: [] });

    const result = await computeSnapshot('VX1', TRADE_DATE, AT);

    expect(result).toEqual({ kind: 'missing' });
  });

  // ── 1H-change reference bar ─────────────────────────────────

  it('computes the 1H change from a reference bar exactly 15 min before at-60m', async () => {
    queueRows({
      hourAgo: [{ close: '5650', ts: minutesBefore(HOUR_AGO, 15) }],
    });

    const snap = expectFresh(await computeSnapshot('ES', TRADE_DATE, AT));

    expect(snap.change1hPct).toBeCloseTo(0.885, 3);
  });

  it('nulls the 1H change when the reference bar is 16 min before at-60m', async () => {
    queueRows({
      hourAgo: [{ close: '5650', ts: minutesBefore(HOUR_AGO, 16) }],
    });

    const snap = expectFresh(await computeSnapshot('ES', TRADE_DATE, AT));

    expect(snap.change1hPct).toBeNull();
  });

  it('nulls the 1H change when the reference bar predates a feed gap', async () => {
    // Feed resumed recently: the newest bar at-or-before (at - 60m) is
    // from before the outage, so "1H change" would really be a
    // multi-week change.
    queueRows({
      hourAgo: [{ close: '5000', ts: '2026-03-20T20:59:00.000Z' }],
    });

    const snap = expectFresh(await computeSnapshot('ES', TRADE_DATE, AT));

    expect(snap.change1hPct).toBeNull();
    // Other metrics are unaffected.
    expect(snap.changeDayPct).toBeCloseTo(1.786, 3);
  });

  it('nulls the 1H change when the reference bar has no ts', async () => {
    queueRows({ hourAgo: [{ close: '5650' }] });

    const snap = expectFresh(await computeSnapshot('ES', TRADE_DATE, AT));

    expect(snap.change1hPct).toBeNull();
  });

  // ── Day-change reference bar ────────────────────────────────

  it('accepts a first bar exactly 15 min after the 9:30 ET open', async () => {
    queueRows({
      dayOpen: [{ close: '5600', ts: '2026-04-03T13:45:00.000Z' }],
    });

    const snap = expectFresh(await computeSnapshot('ES', TRADE_DATE, AT));

    expect(snap.changeDayPct).toBeCloseTo(1.786, 3);
  });

  it('nulls the day change when the first bar is 16 min after the open', async () => {
    queueRows({
      dayOpen: [{ close: '5600', ts: '2026-04-03T13:46:00.000Z' }],
    });

    const snap = expectFresh(await computeSnapshot('ES', TRADE_DATE, AT));

    expect(snap.changeDayPct).toBeNull();
    expect(snap.change1hPct).toBeCloseTo(0.885, 3);
  });

  it('nulls the day change when the feed resumed mid-session', async () => {
    // Feed was down at 9:30 ET and resumed at 11:00 ET — comparing to
    // the resume bar would mislabel a partial-session move as "day".
    queueRows({
      dayOpen: [{ close: '5600', ts: '2026-04-03T15:00:00.000Z' }],
    });

    const snap = expectFresh(await computeSnapshot('ES', TRADE_DATE, AT));

    expect(snap.changeDayPct).toBeNull();
  });

  it('nulls the day change when `at` is inside the open window but before the open bar', async () => {
    // at = 9:40 ET; the first bar >= 9:30 ET printed at 9:42 ET, which
    // is within 15 min of the open but after `at` (a future bar).
    const at = new Date('2026-04-03T13:40:00.000Z');
    mockSql
      .mockResolvedValueOnce([{ close: '5700', ts: minutesBefore(at, 1) }])
      .mockResolvedValueOnce([{ close: '5650', ts: minutesBefore(at, 61) }])
      .mockResolvedValueOnce([
        { close: '5600', ts: '2026-04-03T13:42:00.000Z' },
      ])
      .mockResolvedValueOnce([{ avg_vol: '100000' }])
      .mockResolvedValueOnce([{ today_vol: '5000' }]);

    const snap = expectFresh(await computeSnapshot('ES', TRADE_DATE, at));

    expect(snap.changeDayPct).toBeNull();
  });

  it('nulls the day change when `at` is before the cash open (no future leak)', async () => {
    // `at` = 9:00 ET. The earliest bar >= 9:30 ET is in the future
    // relative to `at` and must not be used.
    const preOpen = new Date('2026-04-03T13:00:00.000Z');
    mockSql
      .mockResolvedValueOnce([{ close: '5700', ts: minutesBefore(preOpen, 1) }])
      .mockResolvedValueOnce([
        { close: '5650', ts: minutesBefore(preOpen, 61) },
      ])
      .mockResolvedValueOnce([{ close: '5600', ts: DAY_OPEN_TS }])
      .mockResolvedValueOnce([{ avg_vol: '100000' }])
      .mockResolvedValueOnce([{ today_vol: null }]);

    const snap = expectFresh(await computeSnapshot('ES', TRADE_DATE, preOpen));

    expect(snap.changeDayPct).toBeNull();
  });

  // ── Failure modes (R4) ──────────────────────────────────────

  it('propagates a DB rejection on the latest-bar query', async () => {
    mockSql.mockRejectedValueOnce(new Error('connection reset'));

    await expect(computeSnapshot('ES', TRADE_DATE, AT)).rejects.toThrow(
      'connection reset',
    );
  });

  it('propagates a DB rejection on a reference-bar query', async () => {
    mockSql
      .mockResolvedValueOnce([{ close: '5700', ts: minutesBefore(AT, 1) }])
      .mockRejectedValueOnce(new Error('statement timeout'));

    await expect(computeSnapshot('ES', TRADE_DATE, AT)).rejects.toThrow(
      'statement timeout',
    );
  });
});
