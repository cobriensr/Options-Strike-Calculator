// @vitest-environment node

/**
 * Property test: the sliced tick scan reads exactly the rows the old
 * three-way hash scan read.
 *
 * Both run on real Postgres (pglite) over a ws_option_trades table built from
 * migration #109, with random rows and seeded PRNGs. The rows include the
 * edge cases that slicing can get wrong: rows exactly on every slice bound
 * and one microsecond either side of it, rows exactly at the window start and
 * at scanEnd, rows after scanEnd, rows before the window, canceled rows,
 * price-0 rows, same-instant ties on one chain, and fully duplicated rows.
 *
 * Three answers must agree, as multisets of ticks (counted, not de-duplicated,
 * so a row read twice or dropped fails):
 *   1. the old query (ORACLE below), with NOW() replaced by the anchor;
 *   2. scanLotteryTicks;
 *   3. a plain JavaScript filter of the generated rows, so a bug the SQL
 *      oracle and the new scan could not share still fails, and an oracle
 *      that returned nothing could not pass.
 *
 * The session runs in America/Chicago, not Neon's UTC: nothing may depend on
 * the session time zone.
 */

import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  groupTickRows,
  scanLotteryTicks,
  SCAN_WINDOW_MIN,
  type LotteryTickScan,
  type TickRow,
} from '../_lib/lottery-tick-scan.js';
import { applyMigration, neonOverPglite } from './pglite-migrations';

let pg: PGlite;
type Db = ReturnType<typeof neonOverPglite>;
let db: Db;

beforeAll(async () => {
  pg = await PGlite.create();
  await applyMigration(pg, 109);
  await pg.query(`SET TIME ZONE 'America/Chicago'`);
  db = neonOverPglite(pg);
});

afterAll(async () => {
  await pg.close();
});

beforeEach(async () => {
  await pg.query('TRUNCATE ws_option_trades RESTART IDENTITY');
});

// ---------------------------------------------------------------------------
// Oracle: the scan detect-lottery-fires ran before phase B1.
//
// Copied verbatim from api/cron/detect-lottery-fires.ts at a02fef66 (the
// merge of feat/lottery-b0-timings-router; the query came in with d67ac753,
// "batch detect-lottery-fires ticks query under Neon 64MB cap"). The only
// change: `NOW()` is the bound anchor, as B1 captures it once for the run.
// ---------------------------------------------------------------------------
const SCAN_WINDOW_MIN_OLD = 7;
const TICK_QUERY_BATCHES = 3;

async function oldThreeWayScan(
  sql: Db,
  scanEnd: Date,
): Promise<{ rows: TickRow[]; partitions: TickRow[][] }> {
  const anchor = scanEnd.toISOString();
  const tickBatches = await Promise.all(
    Array.from({ length: TICK_QUERY_BATCHES }, (_, batchIdx) =>
      sql`
            SELECT
              ticker, option_chain, option_type, strike, expiry::text AS expiry,
              executed_at, price, size, underlying_price, side,
              implied_volatility, delta,
              NULLIF(raw_payload->>'gamma', '')::numeric AS gamma,
              open_interest
            FROM ws_option_trades
            WHERE executed_at >= ${anchor}::timestamptz - (${SCAN_WINDOW_MIN_OLD}::int * INTERVAL '1 minute')
              AND canceled = FALSE
              AND price > 0
              AND mod(abs(hashtextextended(ticker, 0)), ${TICK_QUERY_BATCHES}::int) = ${batchIdx}::int
            ORDER BY option_chain, executed_at ASC
          `.then((r) => r as unknown as TickRow[]),
    ),
  );
  return { rows: tickBatches.flat(), partitions: tickBatches };
}

// ---------------------------------------------------------------------------
// Seeded generator.
// ---------------------------------------------------------------------------

/** mulberry32: a small seeded PRNG, so a failing seed replays exactly. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SIDES = ['ask', 'bid', 'mid', 'no_side'] as const;
const TICKERS = ['SNDK', 'TSLA', 'SPY', 'QQQ', 'NVDA', 'SPXW', 'AAPL', 'USO'];
const MINUTE_US = 60_000_000n;

interface GenRow {
  /** Unique label (in `size`), except for deliberate duplicates. */
  label: number;
  ticker: string;
  chain: string;
  type: 'C' | 'P';
  strike: number;
  expiry: string;
  atUs: bigint;
  price: string;
  canceled: boolean;
  side: (typeof SIDES)[number];
  underlying: string | null;
  iv: string | null;
  delta: string | null;
  oi: number | null;
  payload: string;
}

function occ(
  ticker: string,
  expiry: string,
  type: 'C' | 'P',
  strike: number,
): string {
  const yymmdd = expiry.slice(2).replaceAll('-', '');
  return `${ticker}${yymmdd}${type}${String(Math.round(strike * 1000)).padStart(8, '0')}`;
}

/** An ISO-8601 instant with microsecond precision, from epoch microseconds. */
function isoUs(us: bigint): string {
  const ms = us / 1000n;
  const micro = us % 1000n;
  return new Date(Number(ms))
    .toISOString()
    .replace('Z', `${String(micro).padStart(3, '0')}Z`);
}

interface Dataset {
  scanEnd: Date;
  scanStartUs: bigint;
  scanEndUs: bigint;
  rows: GenRow[];
}

function generate(seed: number): Dataset {
  const rand = prng(seed);
  const int = (lo: number, hi: number): number =>
    lo + Math.floor(rand() * (hi - lo + 1));
  const pick = <T>(xs: readonly T[]): T => xs[int(0, xs.length - 1)]!;

  // The anchor: any time of day, with a millisecond part (the run's clock).
  const scanEndMs =
    Date.parse('2026-11-05T00:00:00.000Z') +
    int(13 * 3600, 21 * 3600) * 1000 +
    int(0, 999);
  const scanEnd = new Date(scanEndMs);
  const scanEndUs = BigInt(scanEndMs) * 1000n;
  const scanStartUs = scanEndUs - BigInt(SCAN_WINDOW_MIN) * MINUTE_US;

  // Chains: each fixes its ticker, side of the book, strike and expiry.
  const chains = TICKERS.flatMap((ticker) =>
    Array.from({ length: 3 }, () => {
      const type = pick(['C', 'P'] as const);
      const strike = int(20, 600) + pick([0, 0.5, 0.25]);
      const expiry = pick(['2026-11-05', '2026-11-06', '2026-11-20']);
      return {
        ticker,
        type,
        strike,
        expiry,
        chain: occ(ticker, expiry, type, strike),
      };
    }),
  );

  let label = 0;
  const rows: GenRow[] = [];
  const add = (
    atUs: bigint,
    force: { canceled?: boolean; zeroPrice?: boolean } = {},
  ): void => {
    label += 1;
    const c = pick(chains);
    const canceled = force.canceled ?? rand() < 0.08;
    const zeroPrice = force.zeroPrice ?? (!canceled && rand() < 0.08);
    const gammaShapes = [
      `{"gamma": ${(rand() * 0.05).toFixed(6)}}`,
      `{"gamma": "${(rand() * 0.05).toFixed(6)}"}`,
      '{"gamma": ""}',
      '{"gamma": null}',
      '{}',
    ];
    rows.push({
      label,
      ticker: c.ticker,
      chain: c.chain,
      type: c.type,
      strike: c.strike,
      expiry: c.expiry,
      atUs,
      price: zeroPrice ? '0.0000' : (0.0001 + rand() * 50).toFixed(4),
      canceled,
      side: pick(SIDES),
      underlying: rand() < 0.1 ? null : (100 + rand() * 500).toFixed(4),
      iv: rand() < 0.15 ? null : rand().toFixed(6),
      delta: rand() < 0.15 ? null : (rand() * 2 - 1).toFixed(6),
      oi: rand() < 0.2 ? null : int(0, 5000),
      payload: pick(gammaShapes),
    });
  };

  // Uniform rows from 2 minutes before the window to 2 minutes after scanEnd.
  const spanUs = BigInt(SCAN_WINDOW_MIN + 4) * MINUTE_US;
  for (let i = 0; i < 600; i += 1) {
    const offset = BigInt(Math.floor(rand() * Number(spanUs / 1000n))) * 1000n;
    add(scanStartUs - 2n * MINUTE_US + offset + BigInt(int(0, 999)));
  }

  // Edge rows: every slice bound (the window start, the 6 inner bounds,
  // scanEnd), at the bound and 1 µs / 1 ms either side. Two rows per spot,
  // so ties at one instant exist on every edge.
  for (let k = 0; k <= SCAN_WINDOW_MIN; k += 1) {
    const bound = scanStartUs + BigInt(k) * MINUTE_US;
    for (const delta of [-1000n, -1n, 0n, 1n, 1000n]) {
      add(bound + delta);
      add(bound + delta);
    }
  }
  // The window start in every filter combination: kept, canceled, price 0.
  add(scanStartUs, { canceled: false, zeroPrice: false });
  add(scanStartUs, { canceled: true });
  add(scanStartUs, { canceled: false, zeroPrice: true });
  // Open end: long after scanEnd, still read.
  add(scanEndUs + 3_600n * 1_000_000n, { canceled: false, zeroPrice: false });
  // Far before the window: never read.
  add(scanStartUs - 3_600n * 1_000_000n, { canceled: false, zeroPrice: false });
  // A tiny positive price is kept; zero is not.
  add(scanStartUs + 1n, { canceled: false, zeroPrice: false });

  // Fully duplicated rows: same content, a different ws_trade_id and id.
  const dupes = Array.from({ length: 12 }, () => pick(rows));
  rows.push(...dupes.map((r) => ({ ...r })));

  return { scanEnd, scanStartUs, scanEndUs, rows };
}

/** Insert the rows in a shuffled order, so id order is unrelated to time. */
async function insertRows(rows: GenRow[], seed: number): Promise<void> {
  const rand = prng(seed ^ 0x9e3779b9);
  const order = rows
    .map((row) => ({ row, k: rand() }))
    .sort((a, b) => a.k - b.k)
    .map(({ row }) => row);
  await pg.query(
    `INSERT INTO ws_option_trades (
       ws_trade_id, ticker, option_chain, option_type, strike, expiry,
       executed_at, price, size, underlying_price, side,
       implied_volatility, delta, open_interest, canceled, raw_payload)
     SELECT ('00000000-0000-4000-8000-' || lpad(t.ord::text, 12, '0'))::uuid,
            t.ticker, t.chain, t.type, t.strike, t.expiry::date,
            t.at, t.price, t.size, t.underlying, t.side,
            t.iv, t.delta, t.oi, t.canceled, t.payload::jsonb
       FROM unnest($1::text[], $2::text[], $3::char[], $4::numeric[],
                   $5::text[], $6::timestamptz[], $7::numeric[], $8::int[],
                   $9::numeric[], $10::text[], $11::numeric[], $12::numeric[],
                   $13::int[], $14::bool[], $15::text[], $16::int[])
         AS t(ticker, chain, type, strike, expiry, at, price, size,
              underlying, side, iv, delta, oi, canceled, payload, ord)
      ORDER BY t.ord`,
    [
      order.map((r) => r.ticker),
      order.map((r) => r.chain),
      order.map((r) => r.type),
      order.map((r) => r.strike),
      order.map((r) => r.expiry),
      order.map((r) => isoUs(r.atUs)),
      order.map((r) => r.price),
      order.map((r) => r.label),
      order.map((r) => r.underlying),
      order.map((r) => r.side),
      order.map((r) => r.iv),
      order.map((r) => r.delta),
      order.map((r) => r.oi),
      order.map((r) => r.canceled),
      order.map((r) => r.payload),
      order.map((_, i) => i + 1),
    ],
  );
}

// ---------------------------------------------------------------------------
// Comparison: counted multisets of ticks, per chain.
// ---------------------------------------------------------------------------

/** Each tick as one string; the size is the row's label. */
function tickKeys(scan: LotteryTickScan): Map<string, string[]> {
  const byChain = new Map<string, string[]>();
  for (const [chain, g] of scan.groups) {
    byChain.set(
      chain,
      g.ticks
        .map((t) =>
          JSON.stringify([
            t.executedAt.toISOString(),
            t.size,
            t.price,
            t.side,
            t.underlyingPrice,
            t.impliedVolatility,
            t.delta,
            t.gamma,
            t.openInterest,
            t.strike,
            t.optionType,
            t.expiry.toISOString(),
          ]),
        )
        .sort(),
    );
  }
  return byChain;
}

/** What the scan must return, from the generated rows alone. */
function modelLabels(ds: Dataset): number[] {
  return ds.rows
    .filter(
      (r) => r.atUs >= ds.scanStartUs && !r.canceled && r.price !== '0.0000',
    )
    .map((r) => r.label)
    .sort((a, b) => a - b);
}

const labelsOf = (scan: LotteryTickScan): number[] =>
  [...scan.groups.values()]
    .flatMap((g) => g.ticks.map((t) => t.size))
    .sort((a, b) => a - b);

/** Fail unless the scan's ticks are time-ordered within every chain. */
function expectTimeOrdered(scan: LotteryTickScan): void {
  for (const g of scan.groups.values()) {
    const ms = g.ticks.map((t) => t.executedAt.getTime());
    expect(ms).toEqual([...ms].sort((a, b) => a - b));
  }
}

function expectSameScan(actual: LotteryTickScan, oracle: LotteryTickScan) {
  expect(actual.scanned).toBe(oracle.scanned);
  expect([...actual.groups.keys()].sort()).toEqual(
    [...oracle.groups.keys()].sort(),
  );
  for (const [chain, g] of actual.groups) {
    const o = oracle.groups.get(chain)!;
    // The chain's own fields and its max open interest.
    expect({ ...g, ticks: undefined }).toEqual({ ...o, ticks: undefined });
  }
  expect(tickKeys(actual)).toEqual(tickKeys(oracle));
}

// A deterministic ladder of seeds; a failure names its seed.
const SEEDS = [0x5eed01, 0x5eed02, 0x5eed03, 0x5eed04, 0x5eed05];

describe('scanLotteryTicks against the old three-way scan (pglite)', () => {
  it.each(SEEDS)(
    'reads the same tick multiset per chain, seed %i',
    async (seed) => {
      const ds = generate(seed);
      await insertRows(ds.rows, seed);

      const oracle = await oldThreeWayScan(db, ds.scanEnd);
      const oracleScan = groupTickRows(oracle.rows);
      const scan = await scanLotteryTicks(db as never, ds.scanEnd);

      // Not vacuous: the model, the oracle and the scan agree on a
      // non-trivial set, and the generator really made the awkward rows.
      const expected = modelLabels(ds);
      expect(expected.length).toBeGreaterThan(300);
      expect(labelsOf(oracleScan)).toEqual(expected);
      expect(labelsOf(scan)).toEqual(expected);
      expect(ds.rows.some((r) => r.canceled && r.atUs >= ds.scanStartUs)).toBe(
        true,
      );
      expect(
        ds.rows.some((r) => r.price === '0.0000' && r.atUs >= ds.scanStartUs),
      ).toBe(true);
      expect(ds.rows.some((r) => r.atUs < ds.scanStartUs)).toBe(true);
      expect(ds.rows.some((r) => r.atUs > ds.scanEndUs)).toBe(true);

      expectSameScan(scan, oracleScan);
      expectTimeOrdered(scan);
      // The old scan was three queries over the same window: every row
      // appeared in exactly one partition (the read-once-not-three-times
      // claim is about work; this pins that the oracle itself is a clean
      // partition of the answer).
      expect(oracle.partitions.flat()).toHaveLength(oracle.rows.length);
    },
  );

  it('reads a row exactly on a slice bound once, not twice and not never', async () => {
    const ds = generate(SEEDS[0]!);
    await insertRows(ds.rows, SEEDS[0]!);
    const scan = await scanLotteryTicks(db as never, ds.scanEnd);
    const read = labelsOf(scan);
    const counts = new Map<number, number>();
    for (const label of read) counts.set(label, (counts.get(label) ?? 0) + 1);

    // Every generated edge row is a distinct label unless it was duplicated
    // on purpose; compare with how many rows carry that label.
    const made = new Map<number, number>();
    for (const r of ds.rows) made.set(r.label, (made.get(r.label) ?? 0) + 1);
    let checked = 0;
    for (const r of ds.rows) {
      const onBound =
        (r.atUs - ds.scanStartUs) % MINUTE_US === 0n &&
        r.atUs >= ds.scanStartUs;
      if (!onBound || r.canceled || r.price === '0.0000') continue;
      expect(counts.get(r.label)).toBe(made.get(r.label));
      checked += 1;
    }
    expect(checked).toBeGreaterThan(10);
  });

  it('gives the same answer for any session time zone', async () => {
    const ds = generate(SEEDS[1]!);
    await insertRows(ds.rows, SEEDS[1]!);
    const answers: string[] = [];
    try {
      for (const zone of ['UTC', 'Asia/Kolkata', 'Pacific/Auckland']) {
        await pg.query(`SET TIME ZONE '${zone}'`);
        const scan = await scanLotteryTicks(db as never, ds.scanEnd);
        answers.push(JSON.stringify([...tickKeys(scan)].sort()));
      }
    } finally {
      await pg.query(`SET TIME ZONE 'America/Chicago'`);
    }
    expect(answers[1]).toBe(answers[0]);
    expect(answers[2]).toBe(answers[0]);
  });

  it('orders prints in the same millisecond by id', async () => {
    const at = '2026-11-05T15:00:00.123Z';
    const scanEnd = new Date('2026-11-05T15:02:00.000Z');
    const chain = 'SNDK261105C01175000';
    // Explicit ids, inserted out of order; the label is the size.
    await pg.query(
      `INSERT INTO ws_option_trades (
         id, ws_trade_id, ticker, option_chain, option_type, strike, expiry,
         executed_at, price, size, side, raw_payload)
       SELECT t.id, ('00000000-0000-4000-8000-' || lpad(t.id::text, 12, '0'))::uuid,
              'SNDK', $1, 'C', 1175, '2026-11-05', $2::timestamptz, 0.5,
              t.size, 'ask', '{}'::jsonb
         FROM unnest($3::bigint[], $4::int[]) AS t(id, size)`,
      [chain, at, [30, 10, 20], [3, 1, 2]],
    );
    const scan = await scanLotteryTicks(db as never, scanEnd);
    expect(scan.groups.get(chain)!.ticks.map((t) => t.size)).toEqual([1, 2, 3]);
  });

  it('returns nothing, and does not fail, on an empty table or a window with no rows', async () => {
    const scanEnd = new Date('2026-11-05T15:00:00.000Z');
    const empty = await scanLotteryTicks(db as never, scanEnd);
    expect(empty).toEqual({ scanned: 0, groups: new Map() });

    // Rows exist, but all before the window.
    const ds = generate(SEEDS[2]!);
    await insertRows(
      ds.rows.filter((r) => r.atUs < ds.scanStartUs),
      SEEDS[2]!,
    );
    const none = await scanLotteryTicks(db as never, ds.scanEnd);
    expect(none.scanned).toBe(0);
  });
});

describe('scanLotteryTicks splitting on a size error, on real rows (pglite)', () => {
  const tooLarge = () =>
    new Error('Server error (HTTP status 507): response too large');

  /**
   * A db that refuses a slice query wider than `maxWidthMs(rand)`. The open
   * slice counts as wide as the minute it would cover if it were closed, so
   * its upper halves can fit too.
   */
  function limitedDb(
    scanEnd: Date,
    maxWidthMs: (rand: () => number) => number,
    seed: number,
  ) {
    const rand = prng(seed);
    const issued: number[] = [];
    const wrapped = (
      strings: TemplateStringsArray,
      ...values: unknown[]
    ): PromiseLike<unknown[]> => {
      const [from, to] = values as [string, string];
      const toMs = to === 'infinity' ? scanEnd.getTime() : Date.parse(to);
      const width = toMs - Date.parse(from);
      issued.push(width);
      if (width > maxWidthMs(rand)) return Promise.reject(tooLarge()) as never;
      return db(strings, ...values);
    };
    return { sql: wrapped as never, issued };
  }

  it.each(SEEDS)(
    'still reads exactly the old scan when slices over 15 s, or a random half of those over 7.5 s, are refused, seed %i',
    async (seed) => {
      const ds = generate(seed);
      await insertRows(ds.rows, seed);
      const oracleScan = groupTickRows(
        (await oldThreeWayScan(db, ds.scanEnd)).rows,
      );

      // Every query wider than 15 s is refused: each slice splits twice.
      const strict = limitedDb(ds.scanEnd, () => 15_000, seed);
      const strictScan = await scanLotteryTicks(strict.sql, ds.scanEnd);
      expectSameScan(strictScan, oracleScan);
      expectTimeOrdered(strictScan);
      // 7 slices, 2 pieces each at 30 s, 4 each at 15 s: it did split.
      expect(strict.issued.length).toBeGreaterThan(SCAN_WINDOW_MIN * 4);

      // A seeded random refusal of anything wider than 7.5 s.
      const random = limitedDb(
        ds.scanEnd,
        (rand) => (rand() < 0.5 ? 7_500 : 1e12),
        seed,
      );
      const randomScan = await scanLotteryTicks(random.sql, ds.scanEnd);
      expectSameScan(randomScan, oracleScan);
      expectTimeOrdered(randomScan);
    },
  );

  it('fails, rather than dropping rows, when every slice stays too large', async () => {
    const ds = generate(SEEDS[3]!);
    await insertRows(ds.rows, SEEDS[3]!);
    const refusing = limitedDb(ds.scanEnd, () => 7_000, SEEDS[3]!);
    await expect(scanLotteryTicks(refusing.sql, ds.scanEnd)).rejects.toThrow(
      /still too large after 3 splits/,
    );
  });
});
