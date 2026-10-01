// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { formatFuturesForClaude } from '../_lib/futures-context.js';
import logger from '../_lib/logger.js';
import { metrics, Sentry } from '../_lib/sentry.js';

// ── Mock logger so debug calls don't pollute output ──────────
vi.mock('../_lib/logger.js', () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../_lib/sentry.js', () => ({
  metrics: { increment: vi.fn() },
  Sentry: { captureException: vi.fn() },
}));

// ── Types matching the query's row shape ─────────────────────

interface SnapshotRow {
  symbol: string;
  /** futures_snapshots.ts — the cron's write time. */
  ts: string | Date;
  /** Latest futures_bars.ts at-or-before the snapshot (null = no bar). */
  bar_ts: string | Date | null;
  price: string | null;
  change_1h_pct: string | null;
  change_day_pct: string | null;
  volume_ratio: string | null;
}

// ── Clock ────────────────────────────────────────────────────
//
// Freshness is judged against the analysis reference time. Pin the
// wall clock mid-session (11:00 ET) so the "fresh by default" fixtures
// below stay fresh.

const NOW = new Date('2026-04-06T15:00:00.000Z');
const MINUTE_MS = 60_000;
const STALE_NOTE = 'Omitted (stale >15m):';
const STALE_LOG_MSG =
  'futures price stale — omitting symbols from analyze context';

function minutesBefore(ref: Date, minutes: number): string {
  return new Date(ref.getTime() - minutes * MINUTE_MS).toISOString();
}

// ── Helpers ──────────────────────────────────────────────────

function makeSnapshot(
  symbol: string,
  overrides: Partial<SnapshotRow> = {},
): SnapshotRow {
  return {
    symbol,
    ts: minutesBefore(NOW, 2),
    bar_ts: minutesBefore(NOW, 3),
    price: '5700.00',
    change_1h_pct: '0.15',
    change_day_pct: '-0.30',
    volume_ratio: '1.1',
    ...overrides,
  };
}

const analysisDate = '2026-04-06';

// ── Mock sql (tagged template literal) ───────────────────────

let mockSql: ReturnType<typeof vi.fn>;

function mockSnapshots(rows: SnapshotRow[]): void {
  mockSql.mockResolvedValueOnce(rows);
}

/** Tagged-template params of the Nth sql call (strings array stripped). */
function queryParams(callIndex = 0): unknown[] {
  return mockSql.mock.calls[callIndex]!.slice(1);
}

function queryText(callIndex = 0): string {
  const strings = mockSql.mock.calls[callIndex]![0] as readonly string[];
  return strings.join('$?');
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  mockSql = vi.fn();
});

afterEach(() => {
  vi.useRealTimers();
});

// ============================================================
// TESTS
// ============================================================

describe('formatFuturesForClaude', () => {
  // ── Error handling ───────────────────────────────────────

  it('returns null, warns, and reports to Sentry when the query rejects', async () => {
    const err = new Error('relation "futures_snapshots" does not exist');
    mockSql.mockRejectedValueOnce(err);

    const result = await formatFuturesForClaude(mockSql as never, analysisDate);

    expect(result).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      { err },
      'futures context query failed — omitting Futures Context',
    );
    expect(Sentry.captureException).toHaveBeenCalledWith(err);
    expect(metrics.increment).toHaveBeenCalledWith(
      'futures_context.fetch_error',
    );
  });

  it('returns null when no snapshot rows exist', async () => {
    mockSnapshots([]);

    const result = await formatFuturesForClaude(mockSql as never, analysisDate);

    expect(result).toBeNull();
  });

  it('drops a malformed row with a schema warning and keeps valid rows', async () => {
    mockSnapshots([
      makeSnapshot('ES'),
      makeSnapshot('NQ', { price: null }),
      makeSnapshot('ZN', { bar_ts: 'not-a-timestamp' }),
    ]);

    const result = await formatFuturesForClaude(mockSql as never, analysisDate);

    expect(result).toContain('ES Futures (/ES)');
    expect(result).not.toContain('NQ Futures');
    expect(result).not.toContain('10Y Treasury');
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        row: expect.objectContaining({ symbol: 'NQ' }),
      }),
      'futures_snapshots row failed schema validation — dropping',
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        row: expect.objectContaining({ symbol: 'ZN' }),
      }),
      'futures_snapshots row failed schema validation — dropping',
    );
  });

  it('accepts ts and bar_ts as Date objects (Neon TIMESTAMPTZ parsing)', async () => {
    mockSnapshots([
      makeSnapshot('ES', {
        ts: new Date(NOW.getTime() - 2 * MINUTE_MS),
        bar_ts: new Date(NOW.getTime() - 3 * MINUTE_MS),
      }),
    ]);

    const result = await formatFuturesForClaude(mockSql as never, analysisDate);

    expect(result).toContain('ES Futures (/ES)');
  });

  // ── Query shape ─────────────────────────────────────────

  it('reads every rendered symbol in one lateral query that seeks by (symbol, ts)', async () => {
    mockSnapshots([makeSnapshot('ES')]);

    const result = await formatFuturesForClaude(mockSql as never, analysisDate);

    expect(mockSql).toHaveBeenCalledTimes(1);
    const text = queryText();
    expect(text).toContain('unnest(');
    expect(text).toContain('WITH ORDINALITY');
    expect(text).toContain('CROSS JOIN LATERAL');
    expect(text).toContain('futures_snapshots');
    expect(text).toContain('futures_bars');
    expect(text).toMatch(/ts <= \$\?/);
    // trade_date is unindexed — the seek is on (symbol, ts).
    expect(text).not.toContain('trade_date');
    expect(text).not.toContain('futures_options_daily');
    // DX (Databento-only, no UW substitute) is never requested.
    expect(queryParams()).toContainEqual([
      'ES',
      'NQ',
      'VX1',
      'VX2',
      'ZN',
      'RTY',
      'CL',
      'GC',
    ]);
    expect(result).not.toContain('ES Options');
  });

  // ── Price-age guard (age of the underlying bar) ─────────

  it('renders a symbol whose underlying bar is within the 15-minute max age', async () => {
    mockSnapshots([makeSnapshot('ES', { bar_ts: minutesBefore(NOW, 14) })]);

    const result = await formatFuturesForClaude(mockSql as never, analysisDate);

    expect(result).toContain('ES Futures (/ES)');
    expect(result).not.toContain(STALE_NOTE);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(metrics.increment).not.toHaveBeenCalled();
  });

  it('omits a symbol whose snapshot row is fresh but whose underlying bar is frozen', async () => {
    mockSnapshots([
      makeSnapshot('ES', { price: '5700.00', change_day_pct: '0.50' }),
      makeSnapshot('NQ', {
        price: '20500.00',
        change_day_pct: '0.80',
        ts: minutesBefore(NOW, 1), // cron still writing…
        bar_ts: minutesBefore(NOW, 60 * 24 * 26), // …a 26-day-old price
      }),
    ]);

    const result = await formatFuturesForClaude(mockSql as never, analysisDate);

    expect(result).toContain('ES Futures (/ES)');
    expect(result).not.toContain('NQ Futures');
    // Cross-symbol derivations must not read the stale NQ row either.
    expect(result).not.toContain('NQ/ES Ratio');
    expect(result).toContain(`${STALE_NOTE} NQ`);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        stale: [expect.objectContaining({ symbol: 'NQ', ageMin: 37440 })],
      }),
      STALE_LOG_MSG,
    );
    expect(metrics.increment).toHaveBeenCalledWith(
      'futures_context.stale_snapshot',
    );
  });

  it('treats a null bar ts (no bar behind the snapshot) as stale', async () => {
    mockSnapshots([makeSnapshot('ES'), makeSnapshot('ZN', { bar_ts: null })]);

    const result = await formatFuturesForClaude(mockSql as never, analysisDate);

    expect(result).toContain('ES Futures (/ES)');
    expect(result).not.toContain('10Y Treasury');
    expect(result).toContain(`${STALE_NOTE} ZN`);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        stale: [{ symbol: 'ZN', barTs: null, ageMin: null }],
      }),
      STALE_LOG_MSG,
    );
  });

  it('names every omitted stale symbol in one note line at the end of the block', async () => {
    mockSnapshots([
      makeSnapshot('ES'),
      makeSnapshot('ZN', { bar_ts: minutesBefore(NOW, 16) }),
      makeSnapshot('GC', { bar_ts: minutesBefore(NOW, 45) }),
    ]);

    const result = await formatFuturesForClaude(mockSql as never, analysisDate);

    expect(result).toMatch(/^## Futures Context\n\nES Futures \(\/ES\):/);
    expect(result).toMatch(/\n\nOmitted \(stale >15m\): ZN, GC$/);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        stale: [
          expect.objectContaining({ symbol: 'ZN', ageMin: 16 }),
          expect.objectContaining({ symbol: 'GC', ageMin: 45 }),
        ],
      }),
      STALE_LOG_MSG,
    );
  });

  it('drops the frozen VX section (VX1/VX2 bars last printed in April)', async () => {
    const later = new Date('2026-09-29T15:00:00.000Z');
    vi.setSystemTime(later);
    const fresh = {
      ts: minutesBefore(later, 2),
      bar_ts: minutesBefore(later, 3),
    };
    mockSnapshots([
      makeSnapshot('ES', fresh),
      makeSnapshot('VX1', {
        price: '18.00',
        ts: fresh.ts, // cron still writing…
        bar_ts: '2026-04-10T20:00:00.000Z', // …an April price
      }),
      makeSnapshot('VX2', {
        price: '19.50',
        ts: fresh.ts,
        bar_ts: '2026-04-10T20:00:00.000Z',
      }),
    ]);

    const result = await formatFuturesForClaude(mockSql as never, '2026-09-29');

    expect(result).not.toContain('VIX Futures');
    expect(result).toContain(`${STALE_NOTE} VX1, VX2`);
  });

  it('returns null when every symbol is stale so the caller marks Futures Context unavailable', async () => {
    mockSnapshots([
      makeSnapshot('ES', { bar_ts: minutesBefore(NOW, 60 * 24 * 26) }),
      makeSnapshot('NQ', { bar_ts: null }),
    ]);

    const result = await formatFuturesForClaude(
      mockSql as never,
      analysisDate,
      5700,
    );

    expect(result).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        stale: [
          expect.objectContaining({ symbol: 'ES' }),
          expect.objectContaining({ symbol: 'NQ' }),
        ],
      }),
      STALE_LOG_MSG,
    );
    expect(metrics.increment).toHaveBeenCalledWith(
      'futures_context.stale_snapshot',
    );
  });

  // ── Reference time ──────────────────────────────────────

  it('bounds the query at wall clock during the session when no asOf is given', async () => {
    mockSnapshots([makeSnapshot('ES')]);

    await formatFuturesForClaude(mockSql as never, analysisDate);

    expect(queryParams()).toContain(NOW.toISOString());
  });

  it('judges freshness against asOf in backtest mode, not wall clock', async () => {
    const asOf = '2026-03-10T15:30:59.000Z';
    mockSnapshots([
      makeSnapshot('ES', { bar_ts: minutesBefore(new Date(asOf), 4) }),
      makeSnapshot('NQ', { bar_ts: minutesBefore(new Date(asOf), 20) }),
    ]);

    const result = await formatFuturesForClaude(
      mockSql as never,
      '2026-03-10',
      undefined,
      asOf,
    );

    // ES bar is 4 min before the entry time → fresh; NQ 20 min → stale.
    expect(result).toContain('ES Futures (/ES)');
    expect(result).not.toContain('NQ Futures');
    expect(result).toContain(`${STALE_NOTE} NQ`);
    // Query bounded at the entry time, so rows after it can't leak in.
    expect(queryParams()).toContain(asOf);
  });

  it('caps a historical run with no asOf at that date’s 4 PM ET session close', async () => {
    // 2026-03-10 is EDT → 16:00 ET = 20:00 UTC.
    const close = '2026-03-10T20:00:00.000Z';
    mockSnapshots([
      makeSnapshot('ES', { bar_ts: minutesBefore(new Date(close), 4) }),
    ]);

    const result = await formatFuturesForClaude(mockSql as never, '2026-03-10');

    expect(result).toContain('ES Futures (/ES)');
    expect(queryParams()).toContain(close);
  });

  it('caps today’s run at the session close once the session is over', async () => {
    vi.setSystemTime(new Date('2026-04-06T22:00:00.000Z')); // 6 PM ET
    mockSnapshots([
      makeSnapshot('ES', {
        bar_ts: minutesBefore(new Date('2026-04-06T20:00:00.000Z'), 1),
      }),
    ]);

    const result = await formatFuturesForClaude(mockSql as never, analysisDate);

    expect(result).toContain('ES Futures (/ES)');
    expect(queryParams()).toContain('2026-04-06T20:00:00.000Z');
  });

  it('clamps a future asOf (pre-market default entry time) to wall clock', async () => {
    const futureAsOf = new Date(NOW.getTime() + 2 * 60 * MINUTE_MS);
    mockSnapshots([makeSnapshot('ES')]);

    const result = await formatFuturesForClaude(
      mockSql as never,
      analysisDate,
      undefined,
      futureAsOf.toISOString(),
    );

    expect(result).toContain('ES Futures (/ES)');
    expect(queryParams()).toContain(NOW.toISOString());
    expect(queryParams()).not.toContain(futureAsOf.toISOString());
  });

  it('falls back to the session-close default when asOf is unparseable', async () => {
    mockSnapshots([makeSnapshot('ES')]);

    const result = await formatFuturesForClaude(
      mockSql as never,
      analysisDate,
      undefined,
      'garbage',
    );

    // Mid-session, min(session close, now) = now.
    expect(result).toContain('ES Futures (/ES)');
    expect(queryParams()).toContain(NOW.toISOString());
  });

  // ── ES section ───────────────────────────────────────────

  it('formats ES section with momentum and basis', async () => {
    mockSnapshots([
      makeSnapshot('ES', {
        price: '5720.50',
        change_1h_pct: '0.25',
        change_day_pct: '-0.40',
        volume_ratio: '1.5',
      }),
    ]);

    const result = await formatFuturesForClaude(
      mockSql as never,
      analysisDate,
      5719,
    );

    expect(result).not.toBeNull();
    expect(result).toContain('ES Futures (/ES)');
    expect(result).toContain('+0.25%'); // 1H
    expect(result).toContain('-0.40%'); // Day
    expect(result).toContain('Volume Ratio');
    expect(result).toContain('ES-SPX Basis');
    expect(result).toContain('normal'); // 5720.50 - 5719 = 1.50 pts ≤ 2 → normal
  });

  it('omits ES-SPX basis when spxPrice is not provided', async () => {
    mockSnapshots([makeSnapshot('ES', { price: '5720.50' })]);

    const result = await formatFuturesForClaude(mockSql as never, analysisDate);

    expect(result).not.toBeNull();
    expect(result).not.toContain('ES-SPX Basis');
  });

  // ── NQ section with NQ/ES ratio ─────────────────────────

  it('formats NQ section with NQ/ES ratio and direction', async () => {
    mockSnapshots([
      makeSnapshot('ES', { price: '5700.00', change_day_pct: '0.50' }),
      makeSnapshot('NQ', {
        price: '20500.00',
        change_1h_pct: '0.30',
        change_day_pct: '0.80',
      }),
    ]);

    const result = await formatFuturesForClaude(mockSql as never, analysisDate);

    expect(result).not.toBeNull();
    expect(result).toContain('NQ Futures (/NQ)');
    expect(result).toContain('NQ/ES Ratio');
    // 20500 / 5700 = 3.596
    expect(result).toContain('3.596');
    // Both day changes positive → ALIGNED
    expect(result).toContain('ALIGNED');
  });

  it('shows NQ-ES DIVERGING when day directions differ', async () => {
    mockSnapshots([
      makeSnapshot('ES', { price: '5700.00', change_day_pct: '-0.30' }),
      makeSnapshot('NQ', { price: '20500.00', change_day_pct: '0.50' }),
    ]);

    const result = await formatFuturesForClaude(mockSql as never, analysisDate);

    expect(result).toContain('DIVERGING');
  });

  // ── VX section with term structure ──────────────────────

  it('formats VX section with CONTANGO signal', async () => {
    mockSnapshots([
      makeSnapshot('VX1', { price: '18.00' }),
      makeSnapshot('VX2', { price: '19.50' }),
    ]);

    const result = await formatFuturesForClaude(mockSql as never, analysisDate);

    expect(result).toContain('VIX Futures (/VX)');
    expect(result).toContain('CONTANGO');
    // 18.00 - 19.50 = -1.50 → < -0.25 → CONTANGO
    expect(result).toContain('premium selling');
  });

  it('formats VX section with BACKWARDATION signal', async () => {
    mockSnapshots([
      makeSnapshot('VX1', { price: '22.00' }),
      makeSnapshot('VX2', { price: '20.00' }),
    ]);

    const result = await formatFuturesForClaude(mockSql as never, analysisDate);

    expect(result).toContain('BACKWARDATION');
    // 22 - 20 = +2.00 → > 0.25 → BACKWARDATION
    expect(result).toContain('Near-term stress');
  });

  it('formats VX section with FLAT term structure', async () => {
    mockSnapshots([
      makeSnapshot('VX1', { price: '19.10' }),
      makeSnapshot('VX2', { price: '19.00' }),
    ]);

    const result = await formatFuturesForClaude(mockSql as never, analysisDate);

    expect(result).toContain('FLAT');
    // 19.10 - 19.00 = 0.10 → abs ≤ 0.25 → FLAT
    expect(result).not.toContain('premium selling');
    expect(result).not.toContain('Near-term stress');
  });

  it('formats VX section with only front month when VX2 is missing', async () => {
    mockSnapshots([makeSnapshot('VX1', { price: '20.00' })]);

    const result = await formatFuturesForClaude(mockSql as never, analysisDate);

    expect(result).toContain('VIX Futures (/VX)');
    expect(result).toContain('Front Month: 20.00');
    // No term structure info because VX2 is absent
    expect(result).not.toContain('Term Structure:');
  });

  // ── ZN section with flight-to-safety ────────────────────

  it('formats ZN section with flight-to-safety signal', async () => {
    mockSnapshots([
      makeSnapshot('ES', { price: '5700.00', change_day_pct: '-0.50' }),
      makeSnapshot('ZN', {
        price: '110.50',
        change_1h_pct: '0.10',
        change_day_pct: '0.30',
      }),
    ]);

    const result = await formatFuturesForClaude(mockSql as never, analysisDate);

    expect(result).toContain('10Y Treasury (/ZN)');
    // ZN day +0.30 > 0.1 && ES day -0.50 < -0.2 → flight to safety
    expect(result).toContain('FLIGHT TO SAFETY');
  });

  it('detects broad liquidation when bonds and equities both sell', async () => {
    mockSnapshots([
      makeSnapshot('ES', { price: '5700.00', change_day_pct: '-0.50' }),
      makeSnapshot('ZN', { price: '109.00', change_day_pct: '-0.30' }),
    ]);

    const result = await formatFuturesForClaude(mockSql as never, analysisDate);

    expect(result).toContain('Broad liquidation');
  });

  it('shows ZN flat signal when ZN change is negligible', async () => {
    mockSnapshots([
      makeSnapshot('ES', { price: '5700.00', change_day_pct: '-0.50' }),
      makeSnapshot('ZN', { price: '110.00', change_day_pct: '0.05' }),
    ]);

    const result = await formatFuturesForClaude(mockSql as never, analysisDate);

    expect(result).toContain('ZN flat');
    expect(result).toContain('not macro-driven');
  });

  // ── CL section with vol signals ─────────────────────────

  it('formats CL section with vol compression signal', async () => {
    mockSnapshots([
      makeSnapshot('CL', {
        price: '72.50',
        change_1h_pct: '-0.10',
        change_day_pct: '-2.50',
      }),
    ]);

    const result = await formatFuturesForClaude(mockSql as never, analysisDate);

    expect(result).toContain('Crude Oil (/CL)');
    // day change -2.50 < -2 → vol compression signal
    expect(result).toContain('vol compression favorable');
  });

  it('formats CL section with vol expansion signal', async () => {
    mockSnapshots([
      makeSnapshot('CL', { price: '80.00', change_day_pct: '3.00' }),
    ]);

    const result = await formatFuturesForClaude(mockSql as never, analysisDate);

    // day change +3.00 > 2 → vol expansion signal
    expect(result).toContain('vol expansion likely');
  });

  // ── Partial data ────────────────────────────────────────

  it('handles partial data with only some symbols present', async () => {
    mockSnapshots([
      makeSnapshot('ES', { price: '5700.00' }),
      makeSnapshot('CL', { price: '75.00' }),
    ]);

    const result = await formatFuturesForClaude(mockSql as never, analysisDate);

    expect(result).not.toBeNull();
    expect(result).toContain('ES Futures (/ES)');
    expect(result).toContain('Crude Oil (/CL)');
    expect(result).not.toContain('NQ Futures');
    expect(result).not.toContain('VIX Futures');
    expect(result).not.toContain('10Y Treasury');
    expect(result).not.toContain('Russell 2000');
  });

  // ── RTY section ─────────────────────────────────────────────

  it('formats RTY section with aligned breadth signal', async () => {
    mockSnapshots([
      makeSnapshot('ES', { price: '5700.00', change_day_pct: '0.40' }),
      makeSnapshot('RTY', {
        price: '2100.00',
        change_1h_pct: '0.20',
        change_day_pct: '0.60',
      }),
    ]);

    const result = await formatFuturesForClaude(mockSql as never, analysisDate);

    expect(result).toContain('Russell 2000 (/RTY)');
    // Both day changes positive → ALIGNED (broad move)
    expect(result).toContain('ALIGNED (broad move)');
  });

  it('formats RTY section with diverging breadth signal', async () => {
    mockSnapshots([
      makeSnapshot('ES', { price: '5700.00', change_day_pct: '0.40' }),
      makeSnapshot('RTY', { price: '2100.00', change_day_pct: '-0.30' }),
    ]);

    const result = await formatFuturesForClaude(mockSql as never, analysisDate);

    // ES positive, RTY negative → DIVERGING (narrow/fragile)
    expect(result).toContain('DIVERGING (narrow/fragile)');
  });

  // ── GC section ───────────────────────────────────────────────

  it('formats GC section with safe-haven bid signal', async () => {
    mockSnapshots([
      makeSnapshot('ES', { price: '5700.00', change_day_pct: '-0.50' }),
      makeSnapshot('GC', {
        price: '2900.00',
        change_1h_pct: '0.30',
        change_day_pct: '1.20',
      }),
    ]);

    const result = await formatFuturesForClaude(mockSql as never, analysisDate);

    expect(result).toContain('Gold (/GC)');
    // gcDay > 0.5 && esDay < -0.2 → safe haven bid
    expect(result).toContain('SAFE HAVEN BID');
    expect(result).toContain('Fear-driven positioning');
  });

  it('formats GC with HIGH-CONVICTION flight to safety when ZN also bid', async () => {
    mockSnapshots([
      makeSnapshot('ES', { price: '5700.00', change_day_pct: '-0.50' }),
      makeSnapshot('ZN', { price: '110.00', change_day_pct: '0.30' }),
      makeSnapshot('GC', { price: '2900.00', change_day_pct: '1.20' }),
    ]);

    const result = await formatFuturesForClaude(mockSql as never, analysisDate);

    // Gold + ZN both up while ES down → HIGH-CONVICTION flight to safety
    expect(result).toContain('HIGH-CONVICTION flight to safety');
  });

  it('formats GC section with risk-on rotation signal', async () => {
    mockSnapshots([
      makeSnapshot('ES', { price: '5700.00', change_day_pct: '0.50' }),
      makeSnapshot('GC', { price: '2800.00', change_day_pct: '-1.00' }),
    ]);

    const result = await formatFuturesForClaude(mockSql as never, analysisDate);

    // gcDay < -0.5 && esDay > 0.2 → risk-on rotation
    expect(result).toContain('Risk-on rotation');
    expect(result).toContain('premium selling');
  });

  it('shows no signal on GC when moves are below threshold', async () => {
    mockSnapshots([
      makeSnapshot('GC', { price: '2850.00', change_day_pct: '0.10' }),
    ]);

    const result = await formatFuturesForClaude(mockSql as never, analysisDate);

    expect(result).toContain('Gold (/GC)');
    // change < 0.5 → no signal
    expect(result).not.toContain('SAFE HAVEN BID');
    expect(result).not.toContain('Risk-on rotation');
  });

  // ── ES-SPX basis stress label ─────────────────────────────────

  it('labels ES-SPX basis as "slightly wide" when between 2 and 5 pts', async () => {
    mockSnapshots([makeSnapshot('ES', { price: '5710.00' })]);

    // SPX at 5707 → basis = 3.00 pts → slightly wide (>2, ≤5)
    const result = await formatFuturesForClaude(
      mockSql as never,
      analysisDate,
      5707,
    );

    expect(result).toContain('slightly wide');
  });

  it('labels ES-SPX basis as "STRESS" when above 5 pts', async () => {
    mockSnapshots([makeSnapshot('ES', { price: '5714.00' })]);

    // SPX at 5700 → basis = 14 pts → STRESS (>5)
    const result = await formatFuturesForClaude(
      mockSql as never,
      analysisDate,
      5700,
    );

    expect(result).toContain('STRESS');
  });

  // ── fmtVolRatio labels ────────────────────────────────────────

  it('shows VERY ELEVATED volume ratio label when ratio >= 2.0', async () => {
    mockSnapshots([
      makeSnapshot('ES', { price: '5700.00', volume_ratio: '2.5' }),
    ]);

    const result = await formatFuturesForClaude(mockSql as never, analysisDate);

    expect(result).toContain('VERY ELEVATED');
  });

  it('shows LOW volume ratio label when ratio < 0.7', async () => {
    mockSnapshots([
      makeSnapshot('ES', { price: '5700.00', volume_ratio: '0.50' }),
    ]);

    const result = await formatFuturesForClaude(mockSql as never, analysisDate);

    expect(result).toContain('LOW');
  });

  // ── NQ without ES present ─────────────────────────────────────

  it('omits NQ/ES ratio when ES is absent', async () => {
    mockSnapshots([
      makeSnapshot('NQ', { price: '20500.00', change_day_pct: '0.5' }),
    ]);

    const result = await formatFuturesForClaude(mockSql as never, analysisDate);

    expect(result).toContain('NQ Futures (/NQ)');
    // No NQ/ES ratio without ES
    expect(result).not.toContain('NQ/ES Ratio');
    // No direction check without ES day pct
    expect(result).not.toContain('NQ-ES Direction');
  });

  // ── Output structure ────────────────────────────────────

  it('wraps output in Futures Context header', async () => {
    mockSnapshots([makeSnapshot('ES', { price: '5700.00' })]);

    const result = await formatFuturesForClaude(mockSql as never, analysisDate);

    expect(result).toMatch(/^## Futures Context\n\n/);
  });
});
