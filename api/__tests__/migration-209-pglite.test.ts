// @vitest-environment node

/**
 * REAL-SQL test for migration #209, which retires the Lottery Finder fire-count
 * score adjustment (spec 2026-11-15-retire-lottery-fire-count-adjustment.md).
 * Postgres in WASM (pglite) builds lottery_finder_fires from the REAL
 * migrations up to #168, seeds fires while the #167 trigger is live, applies
 * #209, and reads the rows back. A mocked db.test.ts can count statements but
 * cannot see that a generated column recomputes, or that a trigger is gone.
 *
 * The session runs in America/Chicago, not Neon's UTC: nothing here may depend
 * on the session time zone.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

import { MIGRATIONS } from '../_lib/db-migrations.js';
import { applyMigration, neonOverPglite } from './pglite-migrations';

// lottery_finder_fires and what #209 touches, in order: the table, its later
// columns, the round-trip deduct (#154), the fire-count adjustment, trigger and
// first combined_score (#167), then gamma and the second combined_score (#168).
const BEFORE_209 = [110, 126, 134, 154, 158, 167, 168, 178];

interface Seed {
  id: number;
  ticker?: string;
  score?: number | null;
  /** round_trip_score_deduct is NOT NULL (default 0) in the table. */
  rt?: number;
  gamma?: number | null;
  /** Fires of one chain-day share a chain id; each needs its own minute. */
  chain?: string;
  minute?: number;
}

let pg: PGlite;

/** One fire with every NOT NULL column filled; only the score inputs vary. */
async function seed(s: Seed): Promise<void> {
  await pg.query(
    `INSERT INTO lottery_finder_fires (
       id, date, trigger_time_ct, entry_time_ct, option_chain_id,
       underlying_symbol, option_type, strike, expiry, dte,
       trigger_vol_to_oi_window, trigger_vol_to_oi_cum, trigger_iv,
       trigger_delta, trigger_ask_pct, trigger_window_size,
       trigger_window_prints, entry_price, open_interest, spot_at_first,
       alert_seq, flow_quad, tod, mode, reload_tagged, cheap_call_pm_tagged,
       score, round_trip_score_deduct, gamma_at_trigger)
     VALUES ($1, '2026-11-13'::date,
             ('2026-11-13'::date + TIME '14:30' + ($2 * INTERVAL '1 minute'))
               AT TIME ZONE 'UTC',
             ('2026-11-13'::date + TIME '14:31' + ($2 * INTERVAL '1 minute'))
               AT TIME ZONE 'UTC',
             $3, $4, 'C', 100, '2026-12-31', 0,
             0.4, 1, 0.3, 0.3, 0.8, 10, 3, 1.5, 100, 99,
             1, 'call_ask', 'MID', 'A_intraday_0DTE', false, false,
             $5, $6, $7)`,
    [
      s.id,
      s.minute ?? 0,
      s.chain ?? `CHAIN${s.id}`,
      s.ticker ?? 'SNDK',
      s.score === undefined ? 10 : s.score,
      s.rt === undefined ? 0 : s.rt,
      s.gamma === undefined ? 0.03 : s.gamma,
    ],
  );
}

/** The gamma bonus, written independently of the migration's SQL. */
function gammaBonus(ticker: string, gamma: number | null): number {
  if (ticker === 'SPY' || ticker === 'USO') return 0;
  return gamma != null && gamma >= 0.025 ? 1 : 0;
}

/** What combined_score must be once the fire-count term is gone. */
function expectedCombined(s: Required<Omit<Seed, 'chain' | 'minute'>>): number {
  return Math.max(
    0,
    (s.score ?? 0) + (s.rt ?? 0) + gammaBonus(s.ticker, s.gamma),
  );
}

// Single-fire chains, one per case the gamma CASE and the zero floor can hit.
const CASES: Required<Omit<Seed, 'chain' | 'minute'>>[] = [
  { id: 1, ticker: 'SNDK', score: 12, rt: 0, gamma: 0.03 },
  { id: 2, ticker: 'SPY', score: 10, rt: 0, gamma: 0.05 }, // excluded ticker
  { id: 3, ticker: 'USO', score: 10, rt: 0, gamma: 0.05 }, // excluded ticker
  { id: 4, ticker: 'SNDK', score: 10, rt: 0, gamma: null }, // NULL gamma
  { id: 5, ticker: 'SNDK', score: 10, rt: 0, gamma: 0.025 }, // boundary, in
  { id: 6, ticker: 'SNDK', score: 10, rt: 0, gamma: 0.0249 }, // just below
  { id: 7, ticker: 'SNDK', score: 2, rt: -3, gamma: 0.03 }, // 2 - 3 + 1 -> 0
  { id: 8, ticker: 'SNDK', score: 1, rt: -3, gamma: null }, // 1 - 3 -> 0
  { id: 9, ticker: 'SNDK', score: null, rt: 0, gamma: 0.03 }, // NULL score
];

// One chain-day that fires 16 times: the #167 trigger gave every one of its
// rows the +2 bucket. After #209 they must score like a one-fire chain.
const BURST_IDS = Array.from({ length: 16 }, (_, i) => 100 + i);

interface Row {
  id: number;
  combined_score: number | null;
  fire_count_score_adjustment?: number;
}

const rowsOf = async (ids: number[]): Promise<Row[]> =>
  (
    await pg.query<Row>(
      `SELECT id, combined_score FROM lottery_finder_fires
        WHERE id = ANY($1::int[]) ORDER BY id`,
      [ids],
    )
  ).rows;

let before: { single: Row[]; burst: Row[]; adjustments: Map<number, number> };

beforeAll(async () => {
  pg = new PGlite();
  await pg.query("SET TIME ZONE 'America/Chicago'");
  for (const id of BEFORE_209) await applyMigration(pg, id);

  for (const c of CASES) await seed(c);
  for (const [i, id] of BURST_IDS.entries()) {
    await seed({
      id,
      chain: 'BURSTCHAIN',
      minute: i,
      score: 12,
      rt: 0,
      gamma: 0.03,
    });
  }

  // What the #167 trigger left behind, read before #209 removes it.
  const adj = await pg.query<{ id: number; a: number }>(
    `SELECT id, fire_count_score_adjustment AS a FROM lottery_finder_fires`,
  );
  before = {
    single: await rowsOf(CASES.map((c) => c.id)),
    burst: await rowsOf(BURST_IDS),
    adjustments: new Map(adj.rows.map((r) => [r.id, r.a])),
  };

  await applyMigration(pg, 209);
}, 120_000);

afterAll(async () => {
  await pg.close();
});

describe('migration #209 (retire the fire-count score adjustment)', () => {
  it('starts from the live #167 state: the trigger scored the chain-days', () => {
    // Without this the after-state tests would pass on a table that never had
    // the adjustment. A one-fire chain carries -3; all 16 fires of the burst
    // carry +2 (the trigger rewrote the whole chain-day at the 16th).
    expect(before.adjustments.get(1)).toBe(-3);
    for (const id of BURST_IDS) expect(before.adjustments.get(id)).toBe(2);
    // ...and it fed the old combined_score: 12 - 3 + 1 gamma = 10, 12 + 2 + 1.
    expect(before.single.find((r) => r.id === 1)?.combined_score).toBe(10);
    expect(before.burst.every((r) => r.combined_score === 15)).toBe(true);
  });

  it('drops the trigger and its function', async () => {
    const triggers = await pg.query(
      `SELECT 1 FROM pg_trigger
        WHERE tgname = 'lottery_finder_fires_fc_adj_trg' AND NOT tgisinternal`,
    );
    expect(triggers.rows).toHaveLength(0);
    const functions = await pg.query(
      `SELECT 1 FROM pg_proc WHERE proname = 'update_lottery_fire_count_score_adj'`,
    );
    expect(functions.rows).toHaveLength(0);
  });

  it('drops the fire_count_score_adjustment column', async () => {
    const columns = await pg.query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_name = 'lottery_finder_fires'
          AND column_name = 'fire_count_score_adjustment'`,
    );
    expect(columns.rows).toHaveLength(0);
    await expect(
      pg.query('SELECT fire_count_score_adjustment FROM lottery_finder_fires'),
    ).rejects.toThrow(/fire_count_score_adjustment/);
  });

  it('recreates combined_score as an integer STORED generated column', async () => {
    const { rows } = await pg.query<{
      data_type: string;
      is_generated: string;
    }>(
      `SELECT data_type, is_generated FROM information_schema.columns
        WHERE table_name = 'lottery_finder_fires'
          AND column_name = 'combined_score'`,
    );
    expect(rows).toEqual([{ data_type: 'integer', is_generated: 'ALWAYS' }]);
  });

  it.each(CASES)(
    'combined_score of $ticker score $score deduct $rt gamma $gamma is GREATEST(0, score + deduct + gamma bonus)',
    async (c) => {
      const [row] = await rowsOf([c.id]);
      expect(row?.combined_score).toBe(expectedCombined(c));
    },
  );

  it('scores a chain-day the same at one fire and at sixteen', async () => {
    // The point of the migration: the +2 the trigger stored on all 16 burst
    // fires is gone, so they match the one-fire chain with the same inputs
    // (score 12, gamma 0.03 on SNDK: 12 + 1 = 13), which lost its -3.
    const burst = await rowsOf(BURST_IDS);
    expect(burst.every((r) => r.combined_score === 13)).toBe(true);
    const [single] = await rowsOf([1]);
    expect(single?.combined_score).toBe(13);
  });

  it('keeps scoring new fires without the trigger', async () => {
    for (let i = 0; i < 4; i++) {
      await seed({
        id: 200 + i,
        chain: 'AFTERCHAIN',
        minute: i,
        score: 9,
        rt: -1,
        gamma: 0.03,
      });
    }
    // 9 - 1 + 1 = 9 on every fire of the chain, whatever its fire number.
    const rows = await rowsOf([200, 201, 202, 203]);
    expect(rows.map((r) => r.combined_score)).toEqual([9, 9, 9, 9]);
  });

  it('recreates the (date DESC, combined_score DESC NULLS LAST) index', async () => {
    const { rows } = await pg.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
        WHERE tablename = 'lottery_finder_fires'
          AND indexname = 'lottery_finder_fires_combined_score_idx'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.indexdef).toMatch(
      /\(date DESC, combined_score DESC NULLS LAST\)/,
    );
  });

  it('can run twice: every statement tolerates the state it leaves', async () => {
    await expect(applyMigration(pg, 209)).resolves.toBeUndefined();
    const [row] = await rowsOf([1]);
    expect(row?.combined_score).toBe(13);
  });

  it("starts with SET LOCAL lock_timeout so a busy table fails fast, as #194-#208's ALTERs do", () => {
    // DROP COLUMN / ADD COLUMN take ACCESS EXCLUSIVE on a table the detect
    // cron inserts into every minute. Without a lock timeout the transaction
    // would queue behind a running insert, and every reader behind it.
    const migration = MIGRATIONS.find((m) => m.id === 209);
    const statements = migration?.statements?.(
      neonOverPglite(pg) as unknown as Parameters<
        NonNullable<typeof migration.statements>
      >[0],
    ) as unknown as { text: string }[];
    expect(statements[0]?.text).toBe("SET LOCAL lock_timeout = '5s'");
  });

  it("copies #168's gamma CASE verbatim", () => {
    // The generated expression is the one #168 defined, minus the fire-count
    // term. Compare the CASE text itself so a retuned threshold or a changed
    // excluded ticker in #209 cannot pass on the sample rows alone.
    const caseOf = (id: number): string => {
      const migration = MIGRATIONS.find((m) => m.id === id);
      const statements = migration?.statements?.(
        neonOverPglite(pg) as unknown as Parameters<
          NonNullable<typeof migration.statements>
        >[0],
      ) as unknown as { text: string }[];
      const text = statements.find((s) =>
        /ADD COLUMN combined_score/.test(s.text),
      )?.text;
      const found = /CASE[\s\S]*?END/.exec(text ?? '');
      expect(found, `no gamma CASE in #${id}`).not.toBeNull();
      return found![0].replace(/\s+/g, ' ');
    };
    expect(caseOf(209)).toBe(caseOf(168));
  });
});
