// @vitest-environment node

/**
 * Tests for the periscope outcome backfill orchestration. Module-boundary
 * mocks only: the DB (getDb / withDbRetry), the UW fetch
 * (fetchContractDayBars), and the market-hours clock.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MinuteBar } from '../../api/_lib/periscope-lottery-outcome.js';

const mockSql = vi.hoisted(() => vi.fn());
const mockFetchBars = vi.hoisted(() => vi.fn());
const mockIsMarketHours = vi.hoisted(() => vi.fn(() => false));

vi.mock('../../api/_lib/db.js', () => ({
  getDb: () => mockSql,
  withDbRetry: <T>(fn: () => Promise<T>): Promise<T> => fn(),
}));
vi.mock('../../api/_lib/cron-helpers.js', () => ({
  isMarketHours: mockIsMarketHours,
}));
vi.mock('../../api/_lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../api/_lib/sentry.js', () => ({
  Sentry: { captureException: vi.fn(), captureMessage: vi.fn() },
  metrics: { uwRateLimit: vi.fn(), uwBudget: vi.fn() },
}));
vi.mock(
  '../../api/_lib/uw-option-contract-bars.js',
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import('../../api/_lib/uw-option-contract-bars.js')
    >()),
    fetchContractDayBars: mockFetchBars,
  }),
);

import {
  PARITY_MIN_COMPARED,
  WRITE_CHUNK,
  evaluateDay,
  parityPasses,
  runBackfill,
  toFire,
  writeOutcomes,
  type BackfillOptions,
  type FireRow,
  type LockedFireRow,
} from './periscope-outcome-backfill.js';

const DAY = '2026-09-30';
const AFTER_SETTLE = Date.parse('2026-10-02T05:00:00Z');
const FIRE = '2026-09-30T14:00:10.620Z';

function bar(
  hhmm: string,
  [open, high, low, close]: [number, number, number, number],
): MinuteBar {
  return { start: new Date(`${DAY}T${hhmm}:00.000Z`), open, high, low, close };
}

/** Entry 0.27 at 14:00:10 → peak 0.40 @ 14:30, EOD 0.04, live tail. */
const GOOD_BARS: MinuteBar[] = [
  bar('14:00', [0.28, 0.29, 0.26, 0.27]),
  bar('14:01', [0.25, 0.26, 0.24, 0.25]),
  bar('14:30', [0.35, 0.4, 0.35, 0.38]),
  bar('19:55', [0.05, 0.05, 0.05, 0.05]),
  bar('19:59', [0.05, 0.05, 0.03, 0.04]),
];

function fireRow(id: number, over: Partial<FireRow> = {}): FireRow {
  return {
    id: String(id),
    fire_type: 'call_lottery',
    fire_time: FIRE,
    expiry: DAY,
    trade_strike: 7505,
    entry_px: '0.2700',
    ...over,
  };
}

/** A cron-locked fire whose stored outcome matches GOOD_BARS. */
function lockedRow(id: number): LockedFireRow {
  return {
    ...fireRow(id),
    peak_px: '0.4000',
    peak_pct: '1.4815',
    peak_time: '2026-09-30T14:30:41.000Z',
    eod_close_px: '0.0400',
    realized_r_peak: '0.4815',
    realized_r_eod: '-0.8519',
  };
}

const ok = (data: MinuteBar[]) => ({ kind: 'ok' as const, data });

/** The SQL text of the i-th tagged-template call. */
const sqlText = (i: number): string =>
  (mockSql.mock.calls[i]![0] as readonly string[]).join('$');
const anyUpdate = (): boolean =>
  mockSql.mock.calls.some((c) =>
    (c[0] as readonly string[]).join('').includes('UPDATE'),
  );

const BASE_OPTS: BackfillOptions = {
  apply: false,
  startDate: null,
  endDate: null,
  parityLimit: 500,
  sampleSize: 3,
  apiKey: 'key',
};

beforeEach(() => {
  mockSql.mockReset();
  mockFetchBars.mockReset();
  mockIsMarketHours.mockReset().mockReturnValue(false);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('toFire', () => {
  it('builds the UW contract id and the cron window', () => {
    const f = toFire(
      fireRow(7, { fire_type: 'put_lottery', trade_strike: 7580 }),
    );
    expect(f.id).toBe(7);
    expect(f.symbol).toBe('SPXW260930P07580000');
    expect(f.entryPx).toBe(0.27);
    expect(f.entryPxRaw).toBe('0.2700');
    expect(f.window.horizonEnd.toISOString()).toBe('2026-09-30T17:00:10.620Z');
  });
});

describe('parityPasses', () => {
  it.each([
    [PARITY_MIN_COMPARED, 0, true],
    [PARITY_MIN_COMPARED - 1, 0, false],
    [300, 1, false],
    [0, 0, false],
  ])('compared %i, mismatched %i → %s', (compared, mismatched, pass) => {
    expect(parityPasses(compared, mismatched)).toBe(pass);
  });
});

describe('evaluateDay', () => {
  it('names every abstention and fetches each contract-day once', async () => {
    const fires = [
      toFire(fireRow(1)), // 7505 C: locks
      toFire(fireRow(2, { fire_time: '2026-09-30T19:59:34.053Z' })), // late
      toFire(fireRow(3, { trade_strike: 7510 })), // UW empty
      toFire(fireRow(4, { trade_strike: 7515 })), // UW error
      toFire(fireRow(5, { trade_strike: 7520, entry_px: '0' })), // bad entry
    ];
    mockFetchBars.mockImplementation((_k: string, symbol: string) =>
      Promise.resolve(
        symbol === 'SPXW260930C07505000'
          ? ok(GOOD_BARS)
          : symbol === 'SPXW260930C07510000'
            ? { kind: 'empty' }
            : { kind: 'error', reason: 'http_500' },
      ),
    );

    const ev = await evaluateDay('key', DAY, fires, AFTER_SETTLE);

    expect(ev.results.get(1)).toMatchObject({
      kind: 'locked',
      values: { peakPx: 0.4, eodClosePx: 0.04 },
    });
    // Its tail [19:59:34, 20:00] holds no whole bar.
    expect(ev.results.get(2)).toEqual({
      kind: 'abstain',
      reason: 'tape_tail_dead',
    });
    expect(ev.results.get(3)).toEqual({ kind: 'abstain', reason: 'no_bars' });
    expect(ev.results.get(4)).toEqual({ kind: 'abstain', reason: 'uw_error' });
    expect(ev.results.get(5)).toEqual({
      kind: 'abstain',
      reason: 'bad_entry_px',
    });
    expect(ev.uwCalls).toBe(3);
    expect(mockFetchBars.mock.calls.map((c) => c[1])).toEqual([
      'SPXW260930C07505000',
      'SPXW260930C07510000',
      'SPXW260930C07515000',
    ]);
    expect(ev.noBars).toEqual([
      { symbol: 'SPXW260930C07510000', day: DAY, fires: 1, detail: 'empty' },
    ]);
    expect(ev.uwErrors).toEqual([
      { symbol: 'SPXW260930C07515000', day: DAY, fires: 1, detail: 'http_500' },
    ]);
  });

  it('leaves an unsettled fire in flight', async () => {
    mockFetchBars.mockResolvedValue(ok(GOOD_BARS));
    const ev = await evaluateDay(
      'key',
      DAY,
      [toFire(fireRow(1))],
      Date.parse('2026-09-30T18:00:00Z'),
    );
    expect(ev.results.get(1)).toEqual({ kind: 'abstain', reason: 'in_flight' });
  });
});

describe('writeOutcomes', () => {
  const values = {
    peakPx: 0.4,
    peakPct: 0.4 / 0.27,
    peakTime: new Date('2026-09-30T14:30:00Z'),
    eodClosePx: 0.04,
    realizedRPeak: 0.13 / 0.27,
    realizedREod: -0.23 / 0.27,
  };
  const rows = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      fire: toFire(fireRow(i + 1)),
      values,
    }));

  it('writes ≤WRITE_CHUNK rows per guarded unnest UPDATE and returns the ids written', async () => {
    const total = WRITE_CHUNK + 1;
    mockSql
      .mockResolvedValueOnce(
        Array.from({ length: WRITE_CHUNK }, (_, i) => ({ id: String(i + 1) })),
      )
      .mockResolvedValueOnce([{ id: String(total) }]);

    const ids = await writeOutcomes(rows(total));

    expect(mockSql).toHaveBeenCalledTimes(2);
    expect((mockSql.mock.calls[0]![1] as number[]).length).toBe(WRITE_CHUNK);
    expect(mockSql.mock.calls[1]![1]).toEqual([total]);
    const text = sqlText(0);
    for (const guard of [
      'p.outcome_locked = FALSE',
      'p.entry_px = u.entry_px',
      'p.peak_px IS NULL',
      'p.peak_pct IS NULL',
      'p.peak_time IS NULL',
      'p.eod_close_px IS NULL',
      'p.realized_r_peak IS NULL',
      'p.realized_r_eod IS NULL',
      'RETURNING p.id',
    ]) {
      expect(text).toContain(guard);
    }
    expect(ids).toHaveLength(total);
    expect(ids.at(-1)).toBe(total);
  });

  it('omits rows the guard skipped (already written elsewhere)', async () => {
    mockSql.mockResolvedValueOnce([{ id: '1' }]);
    expect(await writeOutcomes(rows(2))).toEqual([1]);
  });

  it('rejects when the UPDATE fails', async () => {
    mockSql.mockRejectedValueOnce(new Error('pg down'));
    await expect(writeOutcomes(rows(1))).rejects.toThrow('pg down');
  });
});

describe('runBackfill', () => {
  /** SQL sequence: no-entry, partial, parity, days, per-day fires, UPDATE. */
  function seedPassingRun(dayFires: FireRow[] = [fireRow(900)]): void {
    mockSql
      .mockResolvedValueOnce([]) // no-entry
      .mockResolvedValueOnce([]) // partial outcomes
      .mockResolvedValueOnce(
        Array.from({ length: PARITY_MIN_COMPARED }, (_, i) => lockedRow(i + 1)),
      ) // parity sample
      .mockResolvedValueOnce([{ d: DAY }]) // candidate days
      .mockResolvedValueOnce(dayFires); // that day's fires
  }

  it('refuses to run during market hours, before any DB or UW call', async () => {
    mockIsMarketHours.mockReturnValue(true);
    expect(await runBackfill(BASE_OPTS)).toBe(1);
    expect(mockSql).not.toHaveBeenCalled();
    expect(mockFetchBars).not.toHaveBeenCalled();
  });

  it('refuses to write when parity has too few comparable fires', async () => {
    mockSql
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([lockedRow(1)]); // 1 < PARITY_MIN_COMPARED
    mockFetchBars.mockResolvedValue(ok(GOOD_BARS));

    expect(await runBackfill({ ...BASE_OPTS, apply: true })).toBe(1);
    expect(mockSql).toHaveBeenCalledTimes(3); // never reached the days query
    expect(anyUpdate()).toBe(false);
  });

  it('refuses to write when a parity fire disagrees with the cron', async () => {
    const rows = Array.from({ length: PARITY_MIN_COMPARED }, (_, i) =>
      lockedRow(i + 1),
    );
    rows[0] = { ...rows[0]!, peak_px: '0.4500' };
    mockSql
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(rows);
    mockFetchBars.mockResolvedValue(ok(GOOD_BARS));

    expect(await runBackfill({ ...BASE_OPTS, apply: true })).toBe(1);
    expect(anyUpdate()).toBe(false);
  });

  it('dry run: computes outcomes and never issues an UPDATE', async () => {
    seedPassingRun();
    mockFetchBars.mockResolvedValue(ok(GOOD_BARS));

    expect(await runBackfill(BASE_OPTS)).toBe(0);
    expect(mockSql).toHaveBeenCalledTimes(5);
    expect(anyUpdate()).toBe(false);
  });

  it('--apply: writes the locked fires through the guarded UPDATE', async () => {
    seedPassingRun([fireRow(900), fireRow(901, { trade_strike: 7510 })]);
    mockSql.mockResolvedValueOnce([{ id: '900' }]); // UPDATE … RETURNING
    mockFetchBars.mockImplementation((_k: string, symbol: string) =>
      Promise.resolve(
        symbol === 'SPXW260930C07510000' ? { kind: 'empty' } : ok(GOOD_BARS),
      ),
    );

    expect(await runBackfill({ ...BASE_OPTS, apply: true })).toBe(0);
    expect(mockSql).toHaveBeenCalledTimes(6);
    expect(sqlText(5)).toContain('UPDATE periscope_lottery_fires');
    expect(mockSql.mock.calls[5]![1]).toEqual([900]); // the no_bars fire is not written
  });

  it('exits non-zero when a contract-day fetch failed at UW', async () => {
    seedPassingRun([fireRow(900, { trade_strike: 7515 })]);
    mockFetchBars.mockImplementation((_k: string, symbol: string) =>
      Promise.resolve(
        symbol === 'SPXW260930C07515000'
          ? { kind: 'error', reason: 'network: boom' }
          : ok(GOOD_BARS),
      ),
    );

    expect(await runBackfill(BASE_OPTS)).toBe(1);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('failed at UW'),
    );
  });

  it('exits non-zero when a parity-phase fetch failed at UW, even though parity passed', async () => {
    mockSql
      .mockResolvedValueOnce([]) // no-entry
      .mockResolvedValueOnce([]) // partial outcomes
      .mockResolvedValueOnce([
        ...Array.from({ length: PARITY_MIN_COMPARED }, (_, i) =>
          lockedRow(i + 1),
        ),
        { ...lockedRow(99), trade_strike: 7515 }, // this contract-day fails
      ])
      .mockResolvedValueOnce([{ d: DAY }])
      .mockResolvedValueOnce([fireRow(900)]);
    mockFetchBars.mockImplementation((_k: string, symbol: string) =>
      Promise.resolve(
        symbol === 'SPXW260930C07515000'
          ? { kind: 'error', reason: 'http_500' }
          : ok(GOOD_BARS),
      ),
    );

    expect(await runBackfill(BASE_OPTS)).toBe(1);
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('PARITY PASS'),
    );
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('failed at UW'),
    );
  });
});
