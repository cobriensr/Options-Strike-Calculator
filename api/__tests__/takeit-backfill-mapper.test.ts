// @vitest-environment node

import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';

import { LotteryWeightsSchema } from '../_lib/lottery-weights-schema.js';
import type { LotteryWeights } from '../_lib/lottery-weights-schema.js';
import { SEED_LOTTERY_WEIGHTS } from '../_lib/lottery-weights-seed.js';
import {
  dbRowToLotteryAlertRow,
  isoDateKey,
  selectPriorWinRateForDate,
  STRICT_CLEAN_WHERE,
  type LotteryFireDbRow,
  type PerDateWinRateMap,
} from '../_lib/takeit-backfill-mapper.js';

/**
 * The seed's score for `makeRow()` with no overrides, worked by hand from
 * seed-2026-06-17: QQQ 4 + PM -4 + dte 0 2 + vol/OI 30.5 (quintile 4) 2 +
 * gamma 0.03 (quintile 2) 4 + ask 0.544 (quintile 1) -1 + put 2 = 9, and no
 * composite bonus matches. A hard-coded number on purpose: the tests below
 * must not recompute it with the function under test.
 */
const SEED_SCORE_OF_DEFAULT_ROW = 9;

/** A copy of the seed that the test may change; the seed itself is frozen. */
function cloneSeed(): LotteryWeights {
  return structuredClone(SEED_LOTTERY_WEIGHTS);
}

/**
 * Representative strict-clean DB row, mirroring the shape neon returns from
 * `SELECT * FROM lottery_finder_fires WHERE <STRICT_CLEAN_WHERE>`:
 * - NUMERIC columns come back as strings
 * - INTEGER / SMALLINT come back as numbers
 * - TIMESTAMPTZ / DATE come back as JS Dates
 * - BOOLEAN comes back as boolean
 */
function makeRow(overrides: Partial<LotteryFireDbRow> = {}): LotteryFireDbRow {
  return {
    trigger_time_ct: new Date('2026-05-05T20:02:17.900Z'),
    date: new Date('2026-05-05T00:00:00.000Z'),
    option_chain_id: 'QQQ260505P00681000',
    underlying_symbol: 'QQQ',
    option_type: 'P',
    strike: '681.0000',
    dte: 0,

    trigger_vol_to_oi_window: '30.502958579881657',
    trigger_vol_to_oi_cum: '5.123',
    trigger_iv: '0.412',
    trigger_delta: '-0.5',
    trigger_ask_pct: '0.5440729483282675',
    trigger_window_size: 1500,
    trigger_window_prints: 42,
    gamma_at_trigger: '0.03',

    entry_price: '1.2300',
    open_interest: 2500,
    spot_at_first: '680.9900',
    spot_at_trigger: null,
    alert_seq: 1,
    minutes_since_prev_fire: '0',

    flow_quad: 'put_ask',
    tod: 'PM',
    mode: 'A_intraday_0DTE',
    reload_tagged: false,
    cheap_call_pm_tagged: false,
    burst_ratio_vs_prev: null,
    entry_drop_pct_vs_prev: null,

    mkt_tide_ncp: '224809430.5',
    mkt_tide_npp: '-1234567.89',
    mkt_tide_diff: '226044000.0',
    mkt_tide_otm_diff: '100000000.0',
    spx_flow_diff: '50000000.0',
    spy_etf_diff: '25000000.0',
    qqq_etf_diff: '12000000.0',
    zero_dte_diff: '8000000.0',
    spx_spot_gamma_oi: '72773655916.12',
    spx_spot_gamma_vol: '12000000.0',
    spx_spot_charm_oi: '500000.0',
    spx_spot_vanna_oi: '700000.0',
    gex_strike_call_minus_put: '159215347.41',
    gex_strike_call_ask_minus_bid: '10000.0',
    gex_strike_put_ask_minus_bid: '20000.0',

    // Net flow at fire time: puts lead calls, so a put is aligned.
    cum_ncp_at_fire: '1000000',
    cum_npp_at_fire: '2500000',

    direction_gated: false,

    ...overrides,
  };
}

describe('dbRowToLotteryAlertRow', () => {
  it('produces a LotteryAlertRow with coerced numerics + passthrough metadata', () => {
    const out = dbRowToLotteryAlertRow(makeRow(), SEED_LOTTERY_WEIGHTS);

    // Identity passthrough
    expect(out.option_chain_id).toBe('QQQ260505P00681000');
    expect(out.underlying_symbol).toBe('QQQ');
    expect(out.option_type).toBe('P');

    // Date passthrough (NOT converted to string)
    expect(out.fire_time).toBeInstanceOf(Date);
    expect(out.fire_time.toISOString()).toBe('2026-05-05T20:02:17.900Z');
    expect(out.date).toBeInstanceOf(Date);

    // NUMERIC string → number coercion
    expect(out.strike).toBe(681);
    expect(out.trigger_vol_to_oi_window).toBeCloseTo(30.502958579881657, 10);
    expect(out.mkt_tide_ncp).toBe(224809430.5);
    expect(out.spx_spot_gamma_oi).toBe(72773655916.12);
    expect(out.gex_strike_call_minus_put).toBe(159215347.41);

    // INTEGER passthrough
    expect(out.trigger_window_size).toBe(1500);
    expect(out.open_interest).toBe(2500);
    expect(out.alert_seq).toBe(1);

    // BOOLEAN passthrough
    expect(out.reload_tagged).toBe(false);
    expect(out.cheap_call_pm_tagged).toBe(false);
    expect(out.direction_gated).toBe(false);

    // Optional nullables stay null
    expect(out.spot_at_trigger).toBeNull();
    expect(out.burst_ratio_vs_prev).toBeNull();
    expect(out.score).toBe(SEED_SCORE_OF_DEFAULT_ROW);
    // Retired classifier columns are not carried through.
    expect(out).not.toHaveProperty('inferred_structure');
    expect(out).not.toHaveProperty('is_isolated_leg');
    expect(out).not.toHaveProperty('match_confidence');
  });

  it('coerces optional NUMERIC strings to numbers, keeps explicit nulls', () => {
    const out = dbRowToLotteryAlertRow(
      makeRow({
        mkt_tide_npp: '-99.5',
        spx_spot_charm_oi: null,
        gex_strike_call_ask_minus_bid: '1234.5678',
      }),
      SEED_LOTTERY_WEIGHTS,
    );

    expect(out.mkt_tide_npp).toBe(-99.5);
    expect(out.spx_spot_charm_oi).toBeNull();
    expect(out.gex_strike_call_ask_minus_bid).toBeCloseTo(1234.5678, 6);
  });

  it('throws when a strict-clean required macro field is missing', () => {
    // mkt_tide_ncp is part of STRICT_CLEAN_WHERE — must not be null.
    expect(() =>
      dbRowToLotteryAlertRow(
        // @ts-expect-error — test that the runtime guard fires on bad input
        makeRow({ mkt_tide_ncp: null }),
        SEED_LOTTERY_WEIGHTS,
      ),
    ).toThrow(/mkt_tide_ncp.*is null/);

    expect(() =>
      dbRowToLotteryAlertRow(
        // @ts-expect-error — test that the runtime guard fires on bad input
        makeRow({ spx_spot_gamma_oi: null }),
        SEED_LOTTERY_WEIGHTS,
      ),
    ).toThrow(/spx_spot_gamma_oi.*is null/);

    expect(() =>
      dbRowToLotteryAlertRow(
        // @ts-expect-error — test that the runtime guard fires on bad input
        makeRow({ gex_strike_call_minus_put: null }),
        SEED_LOTTERY_WEIGHTS,
      ),
    ).toThrow(/gex_strike_call_minus_put.*is null/);
  });

  it.each(['Infinity', '-Infinity', '', 'NaN', 'not-a-number'])(
    'throws on non-finite numeric string %j (Number.parseFloat contract)',
    (badValue) => {
      expect(() =>
        dbRowToLotteryAlertRow(
          makeRow({ trigger_iv: badValue }),
          SEED_LOTTERY_WEIGHTS,
        ),
      ).toThrow(/trigger_iv.*non-finite/);
    },
  );

  // The three columns the scorer reads that the Take-It features do not: a
  // malformed one must stop the row, not score it as if the value were absent.
  it.each(['gamma_at_trigger', 'cum_ncp_at_fire', 'cum_npp_at_fire'] as const)(
    'throws on a non-numeric %s',
    (field) => {
      expect(() =>
        dbRowToLotteryAlertRow(
          makeRow({ [field]: 'not-a-number' }),
          SEED_LOTTERY_WEIGHTS,
        ),
      ).toThrow(new RegExp(`${field}.*non-finite`));
    },
  );

  it('throws when trigger_time_ct or date is not a Date instance', () => {
    expect(() =>
      dbRowToLotteryAlertRow(
        // @ts-expect-error — exercise the Date guard
        makeRow({ trigger_time_ct: '2026-05-05T20:02:17Z' }),
        SEED_LOTTERY_WEIGHTS,
      ),
    ).toThrow(/trigger_time_ct must be a Date/);

    expect(() =>
      dbRowToLotteryAlertRow(
        // @ts-expect-error — exercise the Date guard
        makeRow({ date: '2026-05-05' }),
        SEED_LOTTERY_WEIGHTS,
      ),
    ).toThrow(/date must be a Date/);
  });

  // A tod the weights do not know would add `undefined` to the sum and hand
  // Take-It a NaN score, so the mapper stops the row instead.
  it('throws when tod is not a time-of-day bucket', () => {
    expect(() =>
      dbRowToLotteryAlertRow(makeRow({ tod: 'CLOSE' }), SEED_LOTTERY_WEIGHTS),
    ).toThrow(/tod must be one of AM_open, MID, LUNCH, PM, got "CLOSE"/);
  });

  it('exports STRICT_CLEAN_WHERE matching the three macro guards', () => {
    expect(STRICT_CLEAN_WHERE).toEqual([
      'takeit_prob IS NULL',
      'mkt_tide_ncp IS NOT NULL',
      'spx_spot_gamma_oi IS NOT NULL',
      'gex_strike_call_minus_put IS NOT NULL',
    ]);
  });
});

describe('dbRowToLotteryAlertRow: the Take-It input score', () => {
  // The stored `score` column holds the active version's score, and a
  // promotion rescores it. Take-It's input stays on the pinned `takeit`
  // version, so the mapper scores the row itself from the weights it is given.
  it.each([99, null])(
    'scores with the weights it is given, not the stored score (stored %j)',
    (stored) => {
      const row = Object.assign(makeRow(), { score: stored });

      expect(dbRowToLotteryAlertRow(row, SEED_LOTTERY_WEIGHTS).score).toBe(
        SEED_SCORE_OF_DEFAULT_ROW,
      );

      const bumped = cloneSeed();
      bumped.features.ticker_weights.QQQ =
        (bumped.features.ticker_weights.QQQ ?? 0) + 3;
      expect(dbRowToLotteryAlertRow(row, bumped).score).toBe(
        SEED_SCORE_OF_DEFAULT_ROW + 3,
      );
    },
  );

  it.each([
    [
      'a put while calls lead',
      { cum_ncp_at_fire: '2500000', cum_npp_at_fire: '1000000' },
    ],
    [
      'a tie in net flow',
      { cum_ncp_at_fire: '1000000', cum_npp_at_fire: '1000000' },
    ],
    ['no net call premium', { cum_ncp_at_fire: null }],
    ['no net put premium', { cum_npp_at_fire: null }],
    ['a call while puts lead', { option_type: 'C' as const }],
    ['DTE 4', { dte: 4 }],
  ])('a misaligned row and DTE 4 map to null: %s', (_name, overrides) => {
    const out = dbRowToLotteryAlertRow(
      makeRow(overrides),
      SEED_LOTTERY_WEIGHTS,
    );

    expect(out.score).toBeNull();
    // The row itself still maps; only its Take-It input score is absent.
    expect(out.underlying_symbol).toBe('QQQ');
  });

  it('still scores the last in-universe DTE', () => {
    // DTE 3 weighs -3 against DTE 0's 2: 9 - 5.
    expect(
      dbRowToLotteryAlertRow(makeRow({ dte: 3 }), SEED_LOTTERY_WEIGHTS).score,
    ).toBe(SEED_SCORE_OF_DEFAULT_ROW - 5);
  });

  it("reads the weekday off the row's session date", () => {
    // 2026-05-04 is a Monday, and the seed's Monday table weighs PM -1 where
    // the global table weighs it -4.
    const monday = makeRow({ date: new Date('2026-05-04T00:00:00.000Z') });

    expect(dbRowToLotteryAlertRow(monday, SEED_LOTTERY_WEIGHTS).score).toBe(
      SEED_SCORE_OF_DEFAULT_ROW + 3,
    );
  });

  // The cron builds the same scorer input from a LotteryFireRecord, so this
  // replays its parity fixture (written in column names) through the mapper:
  // a field the two read differently shows up as a different integer.
  it('scores every fixture fire the way the cron does', () => {
    interface ParityFire {
      underlying_symbol: string;
      option_type: 'C' | 'P';
      tod: string;
      dte: number;
      trigger_vol_to_oi_window: number | null;
      gamma_at_trigger: number | null;
      trigger_ask_pct: number | null;
      cum_ncp_at_fire: number | null;
      cum_npp_at_fire: number | null;
      date: string;
    }
    const fixture = JSON.parse(
      readFileSync(
        new URL('./fixtures/lottery-score-parity.json', import.meta.url),
        'utf8',
      ),
    ) as {
      weights: unknown;
      cases: Array<{ name: string; fire: ParityFire; expected: number | null }>;
    };
    const weights = LotteryWeightsSchema.parse(fixture.weights);
    const numeric = (n: number | null) => (n === null ? null : String(n));

    let replayed = 0;
    for (const { name, fire, expected } of fixture.cases) {
      // The table's vol/OI and ask-pct columns are NOT NULL, so the mapper
      // never sees a null there; those cases stay in the scorer's own suite.
      if (fire.trigger_vol_to_oi_window === null) continue;
      if (fire.trigger_ask_pct === null) continue;
      const out = dbRowToLotteryAlertRow(
        makeRow({
          underlying_symbol: fire.underlying_symbol,
          option_type: fire.option_type,
          tod: fire.tod,
          dte: fire.dte,
          date: new Date(`${fire.date}T00:00:00.000Z`),
          trigger_vol_to_oi_window: String(fire.trigger_vol_to_oi_window),
          trigger_ask_pct: String(fire.trigger_ask_pct),
          gamma_at_trigger: numeric(fire.gamma_at_trigger),
          cum_ncp_at_fire: numeric(fire.cum_ncp_at_fire),
          cum_npp_at_fire: numeric(fire.cum_npp_at_fire),
        }),
        weights,
      );
      expect(out.score, name).toBe(expected);
      replayed += 1;
    }
    expect(replayed).toBeGreaterThanOrEqual(40);
  });
});

describe('isoDateKey', () => {
  it('returns YYYY-MM-DD slice of toISOString', () => {
    expect(isoDateKey(new Date('2026-05-05T00:00:00.000Z'))).toBe('2026-05-05');
    expect(isoDateKey(new Date('2026-05-26T23:59:59.999Z'))).toBe('2026-05-26');
  });

  it('throws on non-Date input', () => {
    expect(() =>
      // @ts-expect-error — exercising runtime guard
      isoDateKey('2026-05-05'),
    ).toThrow(/expects a Date/);
  });
});

describe('selectPriorWinRateForDate', () => {
  /**
   * Fixture that captures the PIT-correctness contract: the May-5 map sees
   * NO prior sessions, the May-12 map sees only sessions strictly earlier
   * (so it has a different size and different values from May-26). A
   * global map (the prior buggy shape) would have produced one map keyed
   * "global" that every row pulled from, leaking late-session data into
   * early rows.
   */
  function makePerDateMap(): PerDateWinRateMap {
    return new Map<string, ReadonlyMap<string, number | null>>([
      // First session of the backfill window has no prior history.
      ['2026-05-05', new Map<string, number | null>()],
      // Mid-window: a handful of tickers with rates computed only from
      // pre-May-12 sessions.
      [
        '2026-05-12',
        new Map<string, number | null>([
          ['SPY', 0.4],
          ['QQQ', 0.5],
        ]),
      ],
      // Late window: rates have evolved as more sessions enrich. A row
      // dated May-26 looking up here must see THESE rates, not the May-12
      // ones.
      [
        '2026-05-26',
        new Map<string, number | null>([
          ['SPY', 0.55],
          ['QQQ', 0.6],
          ['NVDA', 0.7],
        ]),
      ],
    ]);
  }

  it('selects the per-row session map (NOT a global one)', () => {
    const perDateMap = makePerDateMap();

    // The May-5 row sees an empty map — no prior sessions exist yet.
    const may5 = selectPriorWinRateForDate(
      perDateMap,
      new Date('2026-05-05T00:00:00.000Z'),
    );
    expect(may5.size).toBe(0);
    expect(may5.get('SPY')).toBeUndefined();

    // The May-12 row sees the mid-window map.
    const may12 = selectPriorWinRateForDate(
      perDateMap,
      new Date('2026-05-12T00:00:00.000Z'),
    );
    expect(may12.size).toBe(2);
    expect(may12.get('SPY')).toBe(0.4);
    expect(may12.get('NVDA')).toBeUndefined(); // NVDA wasn't yet in the universe

    // The May-26 row sees the late-window map — bigger AND with different
    // SPY rate than May-12 saw (this asymmetry is the PIT contract).
    const may26 = selectPriorWinRateForDate(
      perDateMap,
      new Date('2026-05-26T00:00:00.000Z'),
    );
    expect(may26.size).toBe(3);
    expect(may26.get('SPY')).toBe(0.55);
    expect(may26.get('SPY')).not.toBe(may12.get('SPY'));
    expect(may26.get('NVDA')).toBe(0.7);
  });

  it('returns an empty map for dates with no entry (defensive)', () => {
    const perDateMap = makePerDateMap();
    const orphan = selectPriorWinRateForDate(
      perDateMap,
      new Date('2026-05-19T00:00:00.000Z'),
    );
    expect(orphan.size).toBe(0);
    expect(orphan.get('SPY')).toBeUndefined();
  });

  it('keys by UTC date slice — fire_time-of-day does not change lookup', () => {
    const perDateMap = makePerDateMap();
    const earlyTick = selectPriorWinRateForDate(
      perDateMap,
      new Date('2026-05-12T00:00:00.000Z'),
    );
    const lateTick = selectPriorWinRateForDate(
      perDateMap,
      new Date('2026-05-12T23:59:59.999Z'),
    );
    expect(lateTick).toBe(earlyTick);
    expect(lateTick.get('SPY')).toBe(0.4);
  });
});
