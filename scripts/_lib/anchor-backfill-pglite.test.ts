// @vitest-environment node

/**
 * REAL-SQL test for the anchor backfill's two UPDATE statements.
 *
 * anchor-backfill.test.ts mocks getDb and only sees the SQL text and the
 * bound values, so a swapped SET column or a typo in one of the two
 * hand-duplicated statements would pass there. This file runs the real
 * `applyDate` against pglite (Postgres in WASM) with lottery_finder_fires,
 * silent_boom_alerts and the anchor columns built from the REAL migrations
 * (#110, #134, #197), and reads the rows back.
 *
 * The session runs in America/Chicago, not Neon's UTC: nothing here may
 * depend on the session time zone.
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { PGlite } from '@electric-sql/pglite';

const { pgRef } = vi.hoisted(() => ({
  pgRef: { current: null as PGlite | null },
}));

// Real withDbRetry; getDb() is a Neon-shaped tagged template over pglite.
vi.mock('../../api/_lib/db.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/_lib/db.js')>()),
  getDb:
    () =>
    (strings: TemplateStringsArray, ...values: unknown[]) => {
      const pg = pgRef.current;
      if (!pg) throw new Error('pglite not started');
      const text = strings.reduce((acc, part, i) => `${acc}$${i}${part}`);
      return pg.query(text, values).then((r) => r.rows);
    },
}));

import { applyMigration } from '../../api/__tests__/pglite-migrations';
import { describeAnchor, type TapePrint } from '../../api/_lib/anchor-legs.js';
import {
  applyDate,
  markerPath,
  type BackfillTable,
  type ExtractLine,
} from './anchor-backfill.js';

const DATE = '2026-10-27';
const OTHER_DATE = '2026-10-26';

const WS = (n: number): string =>
  `01a17d88-0000-7000-8000-${String(n).padStart(12, '0')}`;

function print(n: number, over: Partial<TapePrint> = {}): TapePrint {
  return {
    wsTradeId: WS(n),
    optionChain: 'SPY261028C00785000',
    optionType: 'C',
    strike: 785,
    expiry: '2026-10-28',
    executedAt: '2026-10-27T15:00:01.123Z',
    price: 1.5,
    size: 10,
    tradeCode: 'auto',
    ...over,
  };
}

function line(
  table: BackfillTable,
  id: number,
  anchor: TapePrint | null,
  siblings: TapePrint[] = [],
): ExtractLine {
  return { table, id, anchor, siblings };
}

// A multi-leg order: anchor and wing coded 'MLET' (upper case on purpose), a
// second leg coded 'mlet', and a zero-priced cabinet wing that must still
// count as a leg.
const FLY_ANCHOR = print(20, {
  optionChain: 'SPY261028C00785000',
  strike: 785,
  tradeCode: 'MLET',
  size: 20,
  price: 0.91,
});
const FLY_BODY = print(21, {
  optionChain: 'SPY261028C00790000',
  strike: 790,
  tradeCode: 'mlet',
  size: 40,
  price: 0.4,
});
const FLY_WING = print(22, {
  optionChain: 'SPY261028C00795000',
  strike: 795,
  tradeCode: 'MLET',
  size: 20,
  price: 0,
});
const FLY_SIBLINGS = [FLY_ANCHOR, FLY_BODY, FLY_WING];

let pg: PGlite;
let dir: string;

/** Seed one lottery_finder_fires row (only the NOT NULL columns). */
async function seedLottery(
  id: number,
  date: string,
  anchor: {
    ws?: string;
    code?: string;
    kind?: string;
  } = {},
): Promise<void> {
  await pg.query(
    `INSERT INTO lottery_finder_fires (
       id, date, trigger_time_ct, entry_time_ct, option_chain_id,
       underlying_symbol, option_type, strike, expiry, dte,
       trigger_vol_to_oi_window, trigger_vol_to_oi_cum, trigger_iv,
       trigger_delta, trigger_ask_pct, trigger_window_size,
       trigger_window_prints, entry_price, open_interest, spot_at_first,
       alert_seq, flow_quad, tod, mode, reload_tagged, cheap_call_pm_tagged,
       anchor_ws_trade_id, anchor_trade_code, anchor_leg_kind)
     VALUES ($1, $2::date, $2::timestamptz, $2::timestamptz, $3, 'SPY', 'C',
             785, '2026-10-28', 1, 1, 1, 0.2, 0.3, 0.9, 10, 3, 1.5, 100, 780,
             1, 'call_ask', 'MID', 'A_intraday_0DTE', false, false,
             $4::uuid, $5, $6)`,
    [
      id,
      date,
      `LF${id}`,
      anchor.ws ?? null,
      anchor.code ?? null,
      anchor.kind ?? null,
    ],
  );
}

/** Seed one silent_boom_alerts row (only the NOT NULL columns). */
async function seedSilentBoom(
  id: number,
  date: string,
  anchor: {
    ws?: string;
    code?: string;
    kind?: string;
  } = {},
): Promise<void> {
  await pg.query(
    `INSERT INTO silent_boom_alerts (
       id, date, bucket_ct, option_chain_id, underlying_symbol, option_type,
       strike, expiry, dte, spike_volume, baseline_volume, spike_ratio,
       ask_pct, vol_oi, entry_price, open_interest,
       anchor_ws_trade_id, anchor_trade_code, anchor_leg_kind)
     VALUES ($1, $2::date, $2::timestamptz, $3, 'SPY', 'C', 785,
             '2026-10-28', 1, 500, 5, 100, 0.9, 2, 1.5, 100,
             $4::uuid, $5, $6)`,
    [
      id,
      date,
      `SB${id}`,
      anchor.ws ?? null,
      anchor.code ?? null,
      anchor.kind ?? null,
    ],
  );
}

interface AnchorRow {
  id: number;
  date: string;
  anchor_ws_trade_id: string | null;
  anchor_trade_code: string | null;
  anchor_leg_kind: string | null;
  spread_shape: string | null;
  spread_legs: unknown;
}

async function rows(table: BackfillTable): Promise<Map<number, AnchorRow>> {
  const result = await pg.query<AnchorRow>(
    `SELECT id::int AS id, date::text AS date,
            anchor_ws_trade_id::text AS anchor_ws_trade_id,
            anchor_trade_code, anchor_leg_kind, spread_shape, spread_legs
       FROM ${table} ORDER BY id`,
  );
  return new Map(result.rows.map((r) => [r.id, r]));
}

/**
 * Postgres' own verdict on whether the stored spread_legs is the jsonb of
 * `JSON.stringify(legs)`: key order and whitespace don't count, values do.
 */
async function storesLegs(
  table: BackfillTable,
  id: number,
  legs: unknown,
): Promise<boolean> {
  const result = await pg.query<{ same: boolean | null }>(
    `SELECT spread_legs = $1::jsonb AS same FROM ${table} WHERE id = $2`,
    [JSON.stringify(legs), id],
  );
  return result.rows[0]?.same === true;
}

const untouched = (id: number, date = DATE): AnchorRow => ({
  id,
  date,
  anchor_ws_trade_id: null,
  anchor_trade_code: null,
  anchor_leg_kind: null,
  spread_shape: null,
  spread_legs: null,
});

const LIVE_WS = WS(900);

/** The NDJSON the extract would have written for DATE. */
const LINES: ExtractLine[] = [
  // lottery
  line('lottery_finder_fires', 1, print(1)), // plain single, NULL row
  line('lottery_finder_fires', 2, FLY_ANCHOR, FLY_SIBLINGS), // multi-leg
  line('lottery_finder_fires', 3, print(3)), // row already written live
  line('lottery_finder_fires', 4, print(4)), // kind-only row
  line('lottery_finder_fires', 5, print(5, { tradeCode: null })), // no code
  line('lottery_finder_fires', 6, print(6)), // row dated OTHER_DATE
  line('lottery_finder_fires', 7, null), // no anchor in the tape
  line('lottery_finder_fires', 8, print(8)), // live null-code anchor: ws id only
  // silent_boom: ids 1 and 2 collide with lottery ids 1 and 2
  line('silent_boom_alerts', 1, print(101, { tradeCode: 'exht' })),
  line('silent_boom_alerts', 2, FLY_ANCHOR, FLY_SIBLINGS),
  line('silent_boom_alerts', 8, print(108)), // row dated OTHER_DATE
  line('silent_boom_alerts', 9, print(109)), // row already written live
  line('silent_boom_alerts', 10, print(110)), // kind-only row
  line('silent_boom_alerts', 11, print(111)), // live null-code anchor: ws id only
];

beforeAll(async () => {
  pg = await PGlite.create();
  pgRef.current = pg;
  await applyMigration(pg, 110); // lottery_finder_fires
  await applyMigration(pg, 134); // silent_boom_alerts
  await applyMigration(pg, 197); // the five anchor columns on both
  await pg.query(`SET TIME ZONE 'America/Chicago'`);
});

afterAll(async () => {
  await pg.close();
});

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'anchor-backfill-pglite-'));
  writeFileSync(
    join(dir, `${DATE}.ndjson`),
    LINES.map((l) => JSON.stringify(l)).join('\n') + '\n',
  );
  await pg.query('TRUNCATE lottery_finder_fires, silent_boom_alerts');
  await seedLottery(1, DATE);
  await seedLottery(2, DATE);
  await seedLottery(3, DATE, { ws: LIVE_WS, code: 'exht', kind: 'single' });
  await seedLottery(4, DATE, { kind: 'multi_leg' });
  await seedLottery(5, DATE);
  await seedLottery(6, OTHER_DATE);
  await seedLottery(7, DATE);
  // A null-code anchor written live leaves the ws id set, code and kind NULL.
  await seedLottery(8, DATE, { ws: WS(908) });
  // Silent boom ids 1 and 2 collide with the lottery ids; 3..7 have no line
  // and must stay NULL even though lottery lines carry those ids.
  for (const id of [1, 2, 3, 4, 5, 6, 7]) await seedSilentBoom(id, DATE);
  await seedSilentBoom(8, OTHER_DATE);
  await seedSilentBoom(9, DATE, { ws: LIVE_WS, code: 'exht', kind: 'single' });
  await seedSilentBoom(10, DATE, { kind: 'multi_leg' });
  await seedSilentBoom(11, DATE, { ws: WS(911) });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('applyDate on real SQL (pglite)', () => {
  it('writes all five columns per row and leaves every other row alone', async () => {
    const result = await applyDate(DATE, { outDir: dir });

    expect(result?.counts).toEqual({
      lottery_finder_fires: { updated: 3, skipped: 4, noAnchor: 1 },
      silent_boom_alerts: { updated: 2, skipped: 4, noAnchor: 0 },
    });
    const flyLegs = describeAnchor(FLY_ANCHOR, FLY_SIBLINGS);
    const lf = await rows('lottery_finder_fires');

    // 1: plain single anchor.
    expect(lf.get(1)).toEqual({
      ...untouched(1),
      anchor_ws_trade_id: WS(1),
      anchor_trade_code: 'auto',
      anchor_leg_kind: 'single',
    });

    // 2: multi-leg, upper-case code kept as the print carried it, the
    // zero-priced wing still a leg.
    expect(lf.get(2)).toEqual({
      ...untouched(2),
      anchor_ws_trade_id: WS(20),
      anchor_trade_code: 'MLET',
      anchor_leg_kind: 'multi_leg',
      spread_shape: 'butterfly',
      spread_legs: flyLegs.spreadLegs,
    });
    expect(flyLegs.spreadLegs).toHaveLength(3);
    expect(flyLegs.spreadLegs?.some((leg) => leg.price === 0)).toBe(true);
    expect(
      await storesLegs('lottery_finder_fires', 2, flyLegs.spreadLegs),
    ).toBe(true);
    // The helper discriminates: other legs, or none, don't match.
    expect(
      await storesLegs('lottery_finder_fires', 2, flyLegs.spreadLegs?.slice(1)),
    ).toBe(false);
    expect(await storesLegs('lottery_finder_fires', 1, null)).toBe(false);

    // 3: written live (ws id set): skipped, byte for byte.
    expect(lf.get(3)).toEqual({
      ...untouched(3),
      anchor_ws_trade_id: LIVE_WS,
      anchor_trade_code: 'exht',
      anchor_leg_kind: 'single',
    });

    // 4: kind-only row (only anchor_leg_kind set): skipped.
    expect(lf.get(4)).toEqual({
      ...untouched(4),
      anchor_leg_kind: 'multi_leg',
    });

    // 5: null-code anchor: the ws id lands, code and kind stay NULL.
    expect(lf.get(5)).toEqual({ ...untouched(5), anchor_ws_trade_id: WS(5) });

    // 6: the line is in DATE's file but the row is on another date: skipped.
    expect(lf.get(6)).toEqual(untouched(6, OTHER_DATE));

    // 7: no anchor in the tape: stays NULL.
    expect(lf.get(7)).toEqual(untouched(7));

    // 8: a null-code anchor written live (ws id set, code and kind NULL) is
    // skipped on the ws id alone, though its kind is NULL.
    expect(lf.get(8)).toEqual({ ...untouched(8), anchor_ws_trade_id: WS(908) });
  });

  it('keeps the two tables apart when their ids collide', async () => {
    await applyDate(DATE, { outDir: dir });
    const lf = await rows('lottery_finder_fires');
    const sb = await rows('silent_boom_alerts');

    // Same ids, different anchors: each table holds its own.
    expect(lf.get(1)?.anchor_ws_trade_id).toBe(WS(1));
    expect(sb.get(1)).toEqual({
      ...untouched(1),
      anchor_ws_trade_id: WS(101),
      anchor_trade_code: 'exht',
      anchor_leg_kind: 'single',
    });
    expect(sb.get(2)).toEqual({
      ...untouched(2),
      anchor_ws_trade_id: WS(20),
      anchor_trade_code: 'MLET',
      anchor_leg_kind: 'multi_leg',
      spread_shape: 'butterfly',
      spread_legs: describeAnchor(FLY_ANCHOR, FLY_SIBLINGS).spreadLegs,
    });
    expect(
      await storesLegs(
        'silent_boom_alerts',
        2,
        describeAnchor(FLY_ANCHOR, FLY_SIBLINGS).spreadLegs,
      ),
    ).toBe(true);
    // The silent_boom statement has the same three guards as the lottery one:
    // another date, a live-written row and a kind-only row are all skipped.
    expect(sb.get(8)).toEqual(untouched(8, OTHER_DATE));
    expect(sb.get(9)).toEqual({
      ...untouched(9),
      anchor_ws_trade_id: LIVE_WS,
      anchor_trade_code: 'exht',
      anchor_leg_kind: 'single',
    });
    expect(sb.get(10)).toEqual({
      ...untouched(10),
      anchor_leg_kind: 'multi_leg',
    });
    expect(sb.get(11)).toEqual({
      ...untouched(11),
      anchor_ws_trade_id: WS(911),
    });
    // No silent_boom row was touched by a lottery id (lines for lottery ids
    // 3..7 exist; silent_boom 3..7 have none).
    for (const id of [3, 4, 5, 6, 7]) {
      expect(sb.get(id)).toEqual(untouched(id));
    }
  });

  it('a forced rerun updates 0 rows and changes nothing', async () => {
    await applyDate(DATE, { outDir: dir });
    const before = {
      lf: await rows('lottery_finder_fires'),
      sb: await rows('silent_boom_alerts'),
    };

    // The done marker makes a plain rerun a no-op.
    expect(await applyDate(DATE, { outDir: dir })).toBeNull();

    const rerun = await applyDate(DATE, { outDir: dir, force: true });
    expect(rerun?.counts).toEqual({
      lottery_finder_fires: { updated: 0, skipped: 7, noAnchor: 1 },
      silent_boom_alerts: { updated: 0, skipped: 6, noAnchor: 0 },
    });
    expect(await rows('lottery_finder_fires')).toEqual(before.lf);
    expect(await rows('silent_boom_alerts')).toEqual(before.sb);
  });

  it('writes no marker when a statement fails', async () => {
    await pg.query('ALTER TABLE silent_boom_alerts RENAME TO sb_renamed');
    try {
      await expect(applyDate(DATE, { outDir: dir })).rejects.toThrow(
        /apply failed: date 2026-10-27, table silent_boom_alerts, batch 0/,
      );
    } finally {
      await pg.query('ALTER TABLE sb_renamed RENAME TO silent_boom_alerts');
    }
    expect(existsSync(markerPath(dir, DATE))).toBe(false);
  });
});
