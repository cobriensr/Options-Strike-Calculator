// @vitest-environment node

/**
 * Slot persistence for flow_regime_slot_daily (api/_lib/flow-regime-slot-daily.ts).
 *
 * Two layers:
 *   - pure helpers (slot windows across DST, settle margin, previous weekday,
 *     the retention guard) as input/output tables;
 *   - REAL SQL against pglite (in-process Postgres): `finalizeSlot` runs the
 *     production per-window aggregation + the ON CONFLICT (date, slot) upsert,
 *     and `loadFlowRegimeBaseline` (the live consumer) reads those rows back.
 *     That proves the write is idempotent, a failed write persists nothing,
 *     and the loader's percentile query works on a populated table — the
 *     table has never held a row in production, so the mock-based loader
 *     tests alone cannot show that.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

import type { getDb } from '../_lib/db.js';
import {
  FLOW_REGIME_BASELINE,
  computeFlowMetrics,
  type FlowTradeRow,
} from '../_lib/flow-regime.js';
import {
  __resetFlowRegimeBaselineCache,
  loadFlowRegimeBaseline,
  MIN_DAY_SLOT_TRADES,
} from '../_lib/flow-regime-baseline-live.js';
import {
  SLOT_SETTLE_MS,
  finalizeSlot,
  isSlotSettled,
  isRegularSessionSlot,
  isWithinTradeRetention,
  previousWeekdayEt,
  readPersistedSlots,
  slotWindow,
} from '../_lib/flow-regime-slot-daily.js';
import { getETToday } from '../../src/utils/timezone.js';

type Sql = ReturnType<typeof getDb>;

describe('slotWindow', () => {
  it.each([
    // EDT (UTC−4): 09:30 ET = 13:30 UTC.
    ['2026-06-05', 0, '2026-06-05T13:30:00.000Z', '2026-06-05T14:00:00.000Z'],
    ['2026-06-05', 12, '2026-06-05T19:30:00.000Z', '2026-06-05T20:00:00.000Z'],
    // EST (UTC−5): the final slot closes at 21:00 UTC.
    ['2026-01-15', 12, '2026-01-15T20:30:00.000Z', '2026-01-15T21:00:00.000Z'],
  ])('%s slot %i → [%s, %s)', (date, slot, startIso, endIso) => {
    expect(slotWindow(date, slot)).toEqual({
      slot,
      startIso,
      endIso,
      endMs: Date.parse(endIso),
    });
  });

  it.each([-1, FLOW_REGIME_BASELINE.slot_count, 1.5])(
    'rejects slot %s outside the RTH grid',
    (slot) => {
      expect(slotWindow('2026-06-05', slot)).toBeNull();
    },
  );

  it('rejects a malformed date', () => {
    expect(slotWindow('2026-02-30', 0)).toBeNull();
  });
});

describe('isSlotSettled', () => {
  const w = slotWindow('2026-06-05', 0)!;
  it.each([
    [w.endMs, false], // closing instant: trades may still be in flight
    [w.endMs + SLOT_SETTLE_MS - 1, false],
    [w.endMs + SLOT_SETTLE_MS, true],
    // Vercel fires the 5-min crons ~45 s after the minute. The first tick of
    // the next slot is too early to rule out a stalled uw-stream flush; the
    // second tick clears the 5-min margin.
    [w.endMs + 45_000, false],
    [w.endMs + 345_000, true],
  ])('now = end + %d ms → %s', (nowMs, settled) => {
    expect(isSlotSettled(w, nowMs)).toBe(settled);
  });
});

describe('previousWeekdayEt', () => {
  it.each([
    ['2026-06-08', '2026-06-05'], // Monday → Friday (not Sunday)
    ['2026-06-09', '2026-06-08'], // Tuesday → Monday
    ['2026-06-05', '2026-06-04'], // Friday → Thursday
    ['2026-06-07', '2026-06-05'], // Sunday → Friday
    ['2026-06-06', '2026-06-05'], // Saturday → Friday
    ['2026-03-02', '2026-02-27'], // Monday across a month boundary
    ['2027-01-04', '2027-01-01'], // Monday → Friday (New Year's Day)
    ['2027-01-01', '2026-12-31'], // Friday across a year boundary
  ])('%s → %s', (date, expected) => {
    expect(previousWeekdayEt(date)).toBe(expected);
  });

  it('returns null for a malformed date', () => {
    expect(previousWeekdayEt('not-a-date')).toBeNull();
  });
});

describe('isRegularSessionSlot', () => {
  it.each([
    ['2026-06-05', 0, true], // regular day, first slot
    ['2026-06-05', 12, true], // regular day, final slot ends at 16:00
    ['2026-11-27', 6, true], // Black Friday: 12:30–13:00 ends at the close
    ['2026-11-27', 7, false], // Black Friday: 13:00–13:30 is post-close
    ['2026-11-27', 12, false],
    ['2026-11-26', 0, false], // Thanksgiving (market closed)
    ['2026-06-06', 3, false], // Saturday
  ])('%s slot %i → %s', (date, slot, expected) => {
    expect(isRegularSessionSlot(date, slot)).toBe(expected);
  });
});

describe('isWithinTradeRetention', () => {
  // WS_OPTION_TRADES_RETENTION_DAYS = 2: the cleanup keeps rows on or after
  // (today − 2 days) 00:00 ET.
  it.each([
    ['2026-06-09', '2026-06-09', true], // today
    ['2026-06-08', '2026-06-09', true], // Tuesday's lookback (Monday)
    ['2026-06-07', '2026-06-09', true], // oldest intact date
    ['2026-06-06', '2026-06-09', false],
    ['2026-06-05', '2026-06-08', false], // Monday's lookback (Friday): pruned
    ['2026-06-05', '2026-06-06', true], // Saturday still holds Friday
  ])('date %s on %s → %s', (date, today, expected) => {
    expect(isWithinTradeRetention(date, today)).toBe(expected);
  });
});

// ─── Real SQL (pglite) ───────────────────────────────────────────────────

const DATE = '2026-06-05'; // a regular EDT weekday

let pg: PGlite;

/**
 * The `getDb()` surface the module uses, backed by pglite: the tagged
 * template (readPersistedSlots, the upsert, the loader) and `.query(text,
 * params)` (the aggregation). Both return the row array, like neon.
 */
function pgSql(db: PGlite): Sql {
  const tag = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.reduce((acc, s, i) => `${acc}$${i}${s}`);
    return (await db.query(text, values)).rows;
  };
  return Object.assign(tag, {
    query: async (text: string, params: unknown[] = []) =>
      (await db.query(text, params)).rows,
  }) as unknown as Sql;
}

let sql: Sql;

beforeAll(async () => {
  pg = await PGlite.create();
  await pg.query(`
    CREATE TABLE ws_option_trades (
      id            BIGSERIAL PRIMARY KEY,
      ticker        TEXT NOT NULL,
      option_type   CHAR(1) NOT NULL,
      expiry        DATE NOT NULL,
      executed_at   TIMESTAMPTZ NOT NULL,
      price         NUMERIC(12, 4) NOT NULL,
      size          INTEGER NOT NULL,
      side          TEXT NOT NULL,
      delta         NUMERIC(10, 6),
      canceled      BOOLEAN NOT NULL DEFAULT FALSE
    )
  `);
  // Production DDL (migration 187).
  await pg.query(`
    CREATE TABLE flow_regime_slot_daily (
      id               BIGSERIAL PRIMARY KEY,
      date             DATE NOT NULL,
      slot             INT NOT NULL,
      nd_num           NUMERIC,
      nd_den           NUMERIC,
      idx_put_premium  NUMERIC,
      total_premium    NUMERIC,
      n_trades         INT,
      computed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (date, slot)
    )
  `);
  sql = pgSql(pg);
});

afterAll(async () => {
  await pg.close();
});

/** `n` deterministic trades spread across `slot`'s window on `date`. */
function slotTrades(
  slot: number,
  n: number,
  date = DATE,
): (FlowTradeRow & { at: string })[] {
  const w = slotWindow(date, slot)!;
  const startMs = Date.parse(w.startIso);
  const tickers = ['SPY', 'QQQ', 'NVDA', 'SPXW'];
  return Array.from({ length: n }, (_, i) => ({
    ticker: tickers[i % tickers.length]!,
    optionType: i % 3 === 0 ? 'C' : 'P',
    expiry: date,
    tradeDateEt: date,
    side: i % 2 === 0 ? 'ask' : 'bid',
    delta: i % 3 === 0 ? 0.4 : -0.45,
    size: (i % 7) + 1,
    price: 1 + (i % 5) * 0.25,
    // Strictly inside [start, end): the last trade is before the close.
    at: new Date(startMs + Math.floor((i * 1_799_000) / n)).toISOString(),
  }));
}

async function loadTrades(rows: ReturnType<typeof slotTrades>): Promise<void> {
  await pg.query(
    `INSERT INTO ws_option_trades
       (ticker, option_type, expiry, executed_at, price, size, side, delta)
     SELECT * FROM unnest(
       $1::text[], $2::text[], $3::date[], $4::timestamptz[],
       $5::numeric[], $6::int[], $7::text[], $8::numeric[])`,
    [
      rows.map((r) => r.ticker),
      rows.map((r) => r.optionType),
      rows.map((r) => r.expiry),
      rows.map((r) => r.at),
      rows.map((r) => r.price),
      rows.map((r) => r.size),
      rows.map((r) => r.side),
      rows.map((r) => r.delta),
    ],
  );
}

async function slotRows(): Promise<Record<string, unknown>[]> {
  return (
    await pg.query<Record<string, unknown>>(
      'SELECT slot, nd_num, nd_den, idx_put_premium, total_premium, n_trades FROM flow_regime_slot_daily ORDER BY date, slot',
    )
  ).rows;
}

describe('finalizeSlot (pglite, real SQL)', () => {
  beforeEach(async () => {
    await pg.query('TRUNCATE ws_option_trades, flow_regime_slot_daily');
  });

  it('persists a closed slot with sums equal to computeFlowMetrics over its window', async () => {
    const trades = slotTrades(0, 600);
    await loadTrades(trades);
    // A slot-1 trade must not leak into slot 0's window.
    await loadTrades(slotTrades(1, 5));

    const result = await finalizeSlot(sql, DATE, slotWindow(DATE, 0)!);

    expect(result).toEqual({ outcome: 'written', slot: 0, nTrades: 600 });
    const rows = await slotRows();
    expect(rows).toHaveLength(1);
    const expected = computeFlowMetrics(trades);
    expect(Number(rows[0]!.slot)).toBe(0);
    expect(Number(rows[0]!.n_trades)).toBe(600);
    expect(Number(rows[0]!.nd_num)).toBeCloseTo(expected.ndNum, 6);
    expect(Number(rows[0]!.nd_den)).toBeCloseTo(expected.ndDen, 6);
    expect(Number(rows[0]!.idx_put_premium)).toBeCloseTo(
      expected.idxPutPremium,
      6,
    );
    expect(Number(rows[0]!.total_premium)).toBeCloseTo(
      expected.totalPremium,
      6,
    );
    expect(await readPersistedSlots(sql, DATE)).toEqual(new Set([0]));
  });

  it('is idempotent: a re-run converges on the same single (date, slot) row', async () => {
    await loadTrades(slotTrades(0, 600));
    const w = slotWindow(DATE, 0)!;

    await finalizeSlot(sql, DATE, w);
    const first = await slotRows();
    await finalizeSlot(sql, DATE, w);
    const second = await slotRows();

    expect(second).toHaveLength(1);
    expect(second).toEqual(first);
  });

  it('never aggregates or writes a post-close half-day slot, even one above the quorum', async () => {
    // Black Friday 2026-11-27 closes at 13:00 ET. Post-close prints are
    // plentiful (56k in 15 min after a normal close), so slot 7 [13:00,
    // 13:30) clears the quorum on volume alone. The calendar must stop it.
    await loadTrades(slotTrades(7, MIN_DAY_SLOT_TRADES + 300, '2026-11-27'));
    let queried = false;
    const watching = Object.assign(
      (strings: TemplateStringsArray, ...values: unknown[]) =>
        (
          sql as unknown as (
            s: TemplateStringsArray,
            ...v: unknown[]
          ) => unknown
        )(strings, ...values),
      {
        query: async (text: string, params: unknown[]) => {
          queried = true;
          return sql.query(text, params);
        },
      },
    ) as unknown as Sql;

    const result = await finalizeSlot(
      watching,
      '2026-11-27',
      slotWindow('2026-11-27', 7)!,
    );

    expect(result).toEqual({ outcome: 'outside-session', slot: 7 });
    expect(queried).toBe(false);
    expect(await slotRows()).toEqual([]);
  });

  it('does not persist a slot below the per-day quorum', async () => {
    await loadTrades(slotTrades(1, MIN_DAY_SLOT_TRADES - 1));

    const result = await finalizeSlot(sql, DATE, slotWindow(DATE, 1)!);

    expect(result).toEqual({
      outcome: 'thin',
      slot: 1,
      nTrades: MIN_DAY_SLOT_TRADES - 1,
    });
    expect(await slotRows()).toEqual([]);
    expect(await readPersistedSlots(sql, DATE)).toEqual(new Set());
  });

  it('a rejected upsert propagates and leaves the slot unpersisted', async () => {
    await loadTrades(slotTrades(0, 600));
    const insertFails = Object.assign(
      async () => {
        throw new Error('insert rejected');
      },
      { query: sql.query },
    ) as unknown as Sql;

    await expect(
      finalizeSlot(insertFails, DATE, slotWindow(DATE, 0)!),
    ).rejects.toThrow('insert rejected');
    expect(await slotRows()).toEqual([]);
  });

  it('a rejected aggregation propagates and never attempts the write', async () => {
    let wrote = false;
    const aggFails = Object.assign(
      async () => {
        wrote = true;
        return [];
      },
      {
        query: async () => {
          throw new Error('aggregation rejected');
        },
      },
    ) as unknown as Sql;

    await expect(
      finalizeSlot(aggFails, DATE, slotWindow(DATE, 0)!),
    ).rejects.toThrow('aggregation rejected');
    expect(wrote).toBe(false);
  });

  it('treats an empty aggregation result as an empty (thin) window and writes nothing', async () => {
    // runAggWindow coalesces a row-less result to all-zero sums; that must
    // land as 'thin' (not persisted), never as a written zero row.
    let wrote = false;
    const emptyAgg = Object.assign(
      async () => {
        wrote = true;
        return [];
      },
      { query: async () => [] },
    ) as unknown as Sql;

    const result = await finalizeSlot(emptyAgg, DATE, slotWindow(DATE, 0)!);

    expect(result).toEqual({ outcome: 'thin', slot: 0, nTrades: 0 });
    expect(wrote).toBe(false);
  });
});

describe('loadFlowRegimeBaseline over persisted slots (pglite, real SQL)', () => {
  const N_DAYS = FLOW_REGIME_BASELINE.min_days_per_slot + 1; // 16
  const FRACTIONS = FLOW_REGIME_BASELINE.percentiles.map((p) => p / 100);

  /** Postgres percentile_cont (linear interpolation) over sorted values. */
  function percentileCont(sorted: number[], f: number): number {
    const h = f * (sorted.length - 1);
    const lo = Math.floor(h);
    const hi = Math.min(lo + 1, sorted.length - 1);
    return sorted[lo]! + (h - lo) * (sorted[hi]! - sorted[lo]!);
  }

  /** YYYY-MM-DD `n` calendar days before `date`. */
  function daysBefore(date: string, n: number): string {
    const [y, m, d] = date.split('-').map(Number);
    return new Date(Date.UTC(y!, m! - 1, d! - n)).toISOString().slice(0, 10);
  }

  async function insertSlotDay(
    date: string,
    slot: number,
    ndNum: number,
    idxPut: number,
  ): Promise<void> {
    await pg.query(
      `INSERT INTO flow_regime_slot_daily
         (date, slot, nd_num, nd_den, idx_put_premium, total_premium, n_trades)
       VALUES ($1::date, $2, $3, 10, $4, 100, 1000)`,
      [date, slot, ndNum, idxPut],
    );
  }

  beforeEach(async () => {
    __resetFlowRegimeBaselineCache();
    await pg.query('TRUNCATE flow_regime_slot_daily');
  });

  it('falls back to the committed JSON for every slot when the table is empty', async () => {
    const { baseline, liveSlots } = await loadFlowRegimeBaseline(sql);
    expect(liveSlots.size).toBe(0);
    expect(baseline.slots).toEqual(FLOW_REGIME_BASELINE.slots);
  });

  it('computes live breakpoints from prior days, excludes today, and keeps the JSON seed for thin slots', async () => {
    const today = getETToday();
    // Slot 0: 16 prior days with nd ratio (i − 8)/10 and idx share i/100.
    for (let i = 0; i < N_DAYS; i++) {
      await insertSlotDay(daysBefore(today, i + 1), 0, i - 8, i);
    }
    // Today's intraday-finalized slot 0 is an extreme outlier; it must not
    // enter the distribution today's live slots are scored against.
    await insertSlotDay(today, 0, 1_000, 99);
    // Slot 1: only 3 prior days → stays on the committed seed.
    for (let i = 0; i < 3; i++) {
      await insertSlotDay(daysBefore(today, i + 1), 1, 1, 1);
    }

    const { baseline, liveSlots } = await loadFlowRegimeBaseline(sql);

    expect([...liveSlots]).toEqual([0]);
    const slot0 = baseline.slots.find((s) => s.slot === 0)!;
    const ndSorted = Array.from({ length: N_DAYS }, (_, i) => (i - 8) / 10);
    const idxSorted = Array.from({ length: N_DAYS }, (_, i) => i / 100);
    slot0.nd_tilt_breakpoints.forEach((v, k) =>
      expect(v).toBeCloseTo(percentileCont(ndSorted, FRACTIONS[k]!), 9),
    );
    slot0.idx0dte_put_share_breakpoints.forEach((v, k) =>
      expect(v).toBeCloseTo(percentileCont(idxSorted, FRACTIONS[k]!), 9),
    );
    // Had today's 100.0 ratio been included, p99 would sit far above 1.
    expect(slot0.nd_tilt_breakpoints.at(-1)!).toBeLessThan(1);

    const slot1 = baseline.slots.find((s) => s.slot === 1)!;
    const seed1 = FLOW_REGIME_BASELINE.slots.find((s) => s.slot === 1)!;
    expect(slot1.nd_tilt_breakpoints).toEqual(seed1.nd_tilt_breakpoints);
  });
});
