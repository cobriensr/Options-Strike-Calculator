// @vitest-environment node

/**
 * Tests for the post-close flow-regime slot gap filler.
 *
 * The live capture-flow-regime cron persists each slot as it closes; this
 * cron fills only the slots still MISSING from flow_regime_slot_daily, for
 * today and the previous weekday, one bounded [slotStart, slotEnd) window at
 * a time. Assertions focus on:
 *   - only missing slots are aggregated, each over its own 30-min window
 *     (never the old full-day GROUP BY);
 *   - the Monday lookback names Friday (not Sunday) and skips it as outside
 *     ws_option_trades retention; Tuesday back-fills Monday;
 *   - an idempotent re-run with everything persisted does nothing;
 *   - R4: a failed aggregation or upsert writes nothing for that slot, never
 *     reports success, and reaches Sentry.
 *
 * The real flow-regime-slot-daily helpers run; only the DB is mocked. The
 * SQL itself is exercised against pglite in flow-regime-slot-daily.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Persisted slots per date, as the `SELECT slot …` read returns them. */
let persistedByDate: Record<string, number[]> = {};
/** Per-window aggregation results keyed by the window's start ISO. */
let aggByStart: Record<string, Record<string, unknown> | Error> = {};
let insertError: Error | null = null;
let selectError: Error | null = null;
/** Wall-clock ms each aggregation "takes" (advances the fake clock). */
let aggMs = 0;

const mockQuery = vi.fn(async (_stmt: string, params: unknown[]) => {
  if (aggMs) vi.setSystemTime(new Date(Date.now() + aggMs));
  const r = aggByStart[String(params[2])];
  if (r instanceof Error) throw r;
  return [r ?? aggRow(0)];
});
const mockSql = Object.assign(
  vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?');
    if (/SELECT slot FROM flow_regime_slot_daily/.test(text)) {
      if (selectError) throw selectError;
      return (persistedByDate[String(values[0])] ?? []).map((slot) => ({
        slot,
      }));
    }
    if (/INSERT INTO flow_regime_slot_daily/.test(text)) {
      if (insertError) throw insertError;
      return [];
    }
    throw new Error(`unexpected SQL: ${text}`);
  }),
  { query: mockQuery },
);

vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
  withDbRetry: <T>(fn: () => Promise<T>): Promise<T> => fn(),
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: {
    captureException: vi.fn(),
    captureMessage: vi.fn(),
    setTag: vi.fn(),
    flush: vi.fn(() => Promise.resolve(true)),
  },
}));

vi.mock('../_lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../_lib/axiom.js', () => ({
  reportCronRun: vi.fn(),
}));

const mockCronGuard = vi.hoisted(() => vi.fn());
vi.mock('../_lib/api-helpers.js', () => ({
  cronGuard: mockCronGuard,
}));

import handler from '../cron/capture-flow-regime-daily.js';
import { MIN_DAY_SLOT_TRADES } from '../_lib/flow-regime-baseline-live.js';
import { Sentry } from '../_lib/sentry.js';
import { mockRequest, mockResponse } from './helpers';

const ALL_SLOTS = Array.from({ length: 13 }, (_, i) => i);
const QUORUM = MIN_DAY_SLOT_TRADES;

/** One per-window aggregation row as neon returns it (NUMERIC as strings). */
function aggRow(nTrades: number, ndNum = 12.5) {
  return {
    n_trades: nTrades,
    nd_num: String(ndNum),
    nd_den: '40',
    total_premium: '90000',
    idx_put_premium: '15000',
  };
}

/** Start ISO of `slot` on an EDT date (09:30 ET = 13:30 UTC). */
function slotStartIso(date: string, slot: number): string {
  return new Date(
    Date.parse(`${date}T13:30:00.000Z`) + slot * 30 * 60_000,
  ).toISOString();
}

function aggCalls() {
  return mockQuery.mock.calls.map(([stmt, params]) => ({ stmt, params }));
}

/** Values of each INSERT: [date, slot, nd_num, nd_den, idx_put, total, n_trades]. */
function inserts(): unknown[][] {
  return mockSql.mock.calls
    .filter(([strings]) =>
      /INSERT INTO flow_regime_slot_daily/.test(
        (strings as TemplateStringsArray).join('?'),
      ),
    )
    .map(([, ...values]) => values);
}

function selectDates(): unknown[] {
  return mockSql.mock.calls
    .filter(([strings]) =>
      /SELECT slot FROM/.test((strings as TemplateStringsArray).join('?')),
    )
    .map(([, date]) => date);
}

async function run(at: string) {
  vi.setSystemTime(new Date(at));
  const res = mockResponse();
  await handler(mockRequest({ method: 'GET' }), res);
  return res;
}

// Tue 2026-06-09 21:55 UTC = 17:55 ET (EDT): today 06-09, lookback Mon 06-08.
const TUESDAY_RUN = '2026-06-09T21:55:00.000Z';
// Mon 2026-06-08 21:55 UTC: today 06-08, lookback Fri 06-05.
const MONDAY_RUN = '2026-06-08T21:55:00.000Z';

beforeEach(() => {
  persistedByDate = {};
  aggByStart = {};
  insertError = null;
  selectError = null;
  aggMs = 0;
  mockQuery.mockClear();
  mockSql.mockClear();
  vi.mocked(Sentry.captureException).mockClear();
  vi.mocked(Sentry.captureMessage).mockClear();
  mockCronGuard.mockReset();
  mockCronGuard.mockReturnValue({ apiKey: '', today: '2026-06-09' });
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('capture-flow-regime-daily cron', () => {
  it('does not touch the DB when cronGuard rejects the request', async () => {
    mockCronGuard.mockReturnValue(null);
    await run(TUESDAY_RUN);
    expect(mockSql).not.toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('fills only the missing final slot, over its own [15:30, 16:00) ET window', async () => {
    // The live cron finalized slots 0–11 today; the lookback day is complete.
    persistedByDate = {
      '2026-06-09': ALL_SLOTS.slice(0, 12),
      '2026-06-08': ALL_SLOTS,
    };
    aggByStart = { [slotStartIso('2026-06-09', 12)]: aggRow(QUORUM + 100) };

    const res = await run(TUESDAY_RUN);

    expect(aggCalls()).toHaveLength(1);
    const { stmt, params } = aggCalls()[0]!;
    expect(stmt).toContain('FROM ws_option_trades');
    expect(stmt).not.toMatch(/GROUP BY/i);
    expect(params.slice(2)).toEqual([
      '2026-06-09T19:30:00.000Z',
      '2026-06-09T20:00:00.000Z',
      '2026-06-09',
    ]);
    expect(inserts()).toEqual([
      ['2026-06-09', 12, 12.5, 40, 15000, 90000, QUORUM + 100],
    ]);
    expect(res._json).toMatchObject({ status: 'success', rows: 1 });
  });

  it('fills every missing slot one bounded 30-min window at a time', async () => {
    persistedByDate = { '2026-06-08': ALL_SLOTS };
    for (const s of ALL_SLOTS) {
      aggByStart[slotStartIso('2026-06-09', s)] = aggRow(QUORUM);
    }

    const res = await run(TUESDAY_RUN);

    const calls = aggCalls();
    expect(calls).toHaveLength(13);
    for (const [i, { stmt, params }] of calls.entries()) {
      expect(stmt).not.toMatch(/GROUP BY/i);
      expect(params[2]).toBe(slotStartIso('2026-06-09', i));
      expect(
        Date.parse(String(params[3])) - Date.parse(String(params[2])),
      ).toBe(30 * 60_000);
    }
    expect(inserts().map((v) => v[1])).toEqual(ALL_SLOTS);
    expect(res._json).toMatchObject({ status: 'success', rows: 13 });
  });

  it('on Monday looks back to Friday, not Sunday, and skips it as outside retention', async () => {
    persistedByDate = { '2026-06-08': ALL_SLOTS };

    const res = await run(MONDAY_RUN);

    expect(res._json).toMatchObject({
      status: 'success',
      rows: 0,
      dates: ['2026-06-08', '2026-06-05'],
    });
    const perDate = (res._json as { perDate: Record<string, unknown>[] })
      .perDate;
    expect(perDate[1]).toMatchObject({
      date: '2026-06-05',
      skipped: 'outside-retention',
    });
    // Friday's tape is purged at Monday 00:00 ET: it is neither read nor
    // aggregated, so a partially pruned window can't be persisted.
    expect(selectDates()).toEqual(['2026-06-08']);
    expect(mockQuery).not.toHaveBeenCalled();
    expect(JSON.stringify(mockSql.mock.calls)).not.toContain('2026-06-07');
  });

  it('on Tuesday back-fills a slot Monday left missing (inside retention)', async () => {
    persistedByDate = {
      '2026-06-09': ALL_SLOTS,
      '2026-06-08': ALL_SLOTS.slice(0, 12),
    };
    aggByStart = { [slotStartIso('2026-06-08', 12)]: aggRow(QUORUM) };

    const res = await run(TUESDAY_RUN);

    expect(aggCalls()).toHaveLength(1);
    expect(aggCalls()[0]!.params.slice(2)).toEqual([
      '2026-06-08T19:30:00.000Z',
      '2026-06-08T20:00:00.000Z',
      '2026-06-08',
    ]);
    expect(inserts()).toHaveLength(1);
    expect(inserts()[0]!.slice(0, 2)).toEqual(['2026-06-08', 12]);
    expect(res._json).toMatchObject({ status: 'success', rows: 1 });
  });

  it('is idempotent: a re-run with every slot persisted aggregates and writes nothing', async () => {
    persistedByDate = { '2026-06-09': ALL_SLOTS, '2026-06-08': ALL_SLOTS };

    const res = await run(TUESDAY_RUN);

    expect(mockQuery).not.toHaveBeenCalled();
    expect(inserts()).toEqual([]);
    expect(res._json).toMatchObject({ status: 'success', rows: 0 });
  });

  it('does not persist a below-quorum regular-session slot and raises one ingest-gap warning', async () => {
    persistedByDate = {
      '2026-06-09': ALL_SLOTS.slice(0, 12),
      '2026-06-08': ALL_SLOTS,
    };
    aggByStart = { [slotStartIso('2026-06-09', 12)]: aggRow(QUORUM - 1) };

    const res = await run(TUESDAY_RUN);

    expect(aggCalls()).toHaveLength(1);
    expect(inserts()).toEqual([]);
    expect(res._json).toMatchObject({
      status: 'skipped',
      rows: 0,
      thinGaps: [{ date: '2026-06-09', slot: 12, nTrades: QUORUM - 1 }],
    });
    // A regular-session slot under quorum means uw-stream missed its trades.
    expect(Sentry.captureMessage).toHaveBeenCalledOnce();
    const [message, context] = vi.mocked(Sentry.captureMessage).mock.calls[0]!;
    expect(message).toContain('1 regular-session slot(s) below');
    expect(context).toMatchObject({
      level: 'warning',
      fingerprint: ['capture-flow-regime-daily', 'thin-slot'],
      tags: { 'cron.anomaly': 'flow-regime-thin-slot' },
      extra: {
        thinGaps: [{ date: '2026-06-09', slot: 12, nTrades: QUORUM - 1 }],
      },
    });
  });

  it('never aggregates or writes post-close half-day slots or holiday slots, even with quorum-sized volume', async () => {
    // Black Friday 2026-11-27 closes at 13:00 ET (EST, so 13:00 ET = 18:00
    // UTC). Post-close prints are plentiful, so give slots 7–12 a
    // quorum-clearing count: only the market calendar can keep them out.
    for (let s = 7; s < 13; s++) {
      const start = new Date(
        Date.parse('2026-11-27T14:30:00.000Z') + s * 30 * 60_000,
      ).toISOString();
      aggByStart[start] = aggRow(QUORUM + 5_000);
    }
    // Lookback = Thanksgiving 2026-11-26 (market closed), nothing persisted.
    persistedByDate = { '2026-11-27': ALL_SLOTS.slice(0, 7) };

    const res = await run('2026-11-27T21:55:00.000Z'); // 16:55 ET

    expect(mockQuery).not.toHaveBeenCalled();
    expect(inserts()).toEqual([]);
    const body = res._json as {
      status: string;
      thinGaps: unknown[];
      perDate: { date: string; outsideSession: number[] }[];
    };
    expect(body.perDate[0]).toMatchObject({
      date: '2026-11-27',
      outsideSession: [7, 8, 9, 10, 11, 12],
    });
    expect(body.perDate[1]).toMatchObject({
      date: '2026-11-26',
      outsideSession: ALL_SLOTS,
    });
    expect(body.thinGaps).toEqual([]);
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it('leaves a slot that has not yet settled for a later run, without counting it as a failure', async () => {
    // 20:03 UTC = 16:03 ET: slot 12 closed 3 min ago, inside the 5-min settle.
    persistedByDate = {
      '2026-06-09': ALL_SLOTS.slice(0, 12),
      '2026-06-08': ALL_SLOTS,
    };

    const res = await run('2026-06-09T20:03:00.000Z');

    expect(mockQuery).not.toHaveBeenCalled();
    expect(inserts()).toEqual([]);
    const body = res._json as {
      status: string;
      failures: unknown[];
      perDate: { unsettled: number[] }[];
    };
    expect(body.status).toBe('success');
    expect(body.perDate[0]!.unsettled).toEqual([12]);
    expect(body.failures).toEqual([]);
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it('R4: a failed slot aggregation writes nothing for that slot, still fills the rest, and reports partial to Sentry', async () => {
    persistedByDate = {
      '2026-06-09': ALL_SLOTS.slice(0, 11),
      '2026-06-08': ALL_SLOTS,
    };
    aggByStart = {
      [slotStartIso('2026-06-09', 11)]: new Error('canceling statement'),
      [slotStartIso('2026-06-09', 12)]: aggRow(QUORUM),
    };

    const res = await run(TUESDAY_RUN);

    expect(inserts().map((v) => v[1])).toEqual([12]);
    expect(res._json).toMatchObject({
      status: 'partial',
      rows: 1,
      failures: [
        { date: '2026-06-09', slot: 11, error: 'canceling statement' },
      ],
    });
    expect(Sentry.captureException).toHaveBeenCalledOnce();
    const [err, context] = vi.mocked(Sentry.captureException).mock.calls[0]!;
    expect((err as Error).message).toBe('canceling statement');
    expect(context).toMatchObject({
      tags: { 'flow_regime.step': 'slot-fill' },
      extra: {
        failures: [
          { date: '2026-06-09', slot: 11, error: 'canceling statement' },
        ],
      },
    });
  });

  it('R4: a rejected upsert is not counted as written and the run reports error', async () => {
    persistedByDate = {
      '2026-06-09': ALL_SLOTS.slice(0, 12),
      '2026-06-08': ALL_SLOTS,
    };
    aggByStart = { [slotStartIso('2026-06-09', 12)]: aggRow(QUORUM) };
    insertError = new Error('could not extend file: disk full');

    const res = await run(TUESDAY_RUN);

    expect(res._json).toMatchObject({ status: 'error', rows: 0 });
    expect(res._json).not.toMatchObject({ status: 'success' });
    expect(Sentry.captureException).toHaveBeenCalledOnce();
  });

  it('fails the run instead of refilling blindly when the persisted-slot read rejects', async () => {
    selectError = new Error('connection refused');

    const res = await run(TUESDAY_RUN);

    expect(res._status).toBe(500);
    expect(mockQuery).not.toHaveBeenCalled();
    expect(inserts()).toEqual([]);
    expect(Sentry.captureException).toHaveBeenCalled();
  });

  it('stops starting new fills past the wall budget and reports the deferred slots', async () => {
    // Each aggregation "takes" 61 s: fills start at 0 s and 61 s, and at
    // 122 s the 120 s budget is spent, so the remaining 11 slots are
    // deferred, not attempted. (A 180 s budget would allow a third fill.)
    persistedByDate = { '2026-06-08': ALL_SLOTS };
    for (const s of ALL_SLOTS) {
      aggByStart[slotStartIso('2026-06-09', s)] = aggRow(QUORUM);
    }
    aggMs = 61_000;

    const res = await run(TUESDAY_RUN);

    expect(aggCalls()).toHaveLength(2);
    expect(inserts().map((v) => v[1])).toEqual([0, 1]);
    const body = res._json as {
      status: string;
      failures: { slot: number; error: string }[];
    };
    expect(body.status).toBe('partial');
    expect(body.failures.map((f) => f.slot)).toEqual(ALL_SLOTS.slice(2));
    expect(
      body.failures.every((f) => f.error === 'fill budget exhausted'),
    ).toBe(true);
    expect(Sentry.captureException).toHaveBeenCalledOnce();
    expect(
      (vi.mocked(Sentry.captureException).mock.calls[0]![0] as Error).message,
    ).toContain('11 slot(s) not filled');
  });
});
