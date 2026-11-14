// @vitest-environment node
//
// Tests for the v2 lottery scoring model. The scorer is a pure function of a
// Zod-validated weights object, so these suites score with the frozen seed
// (seed-2026-06-17, api/_lib/lottery-weights-seed.ts), which never changes.
// They pin the SHAPE of the API (alignment gate, dte universe gate, null-safe
// quintiles, tier classification) and, through the parity fixture, the exact
// integer the seed gives for 70 hand-written fires. Later versions live in
// Neon (phase 4, D5) and are validated by the same schema.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  assignQuintile,
  computeLotteryScoreV2,
  isAlignedFire,
  LOTTERY_TIER_THRESHOLDS_V2,
  lotteryScoreTierV2,
  scoreLotteryV2,
  weekdayOf,
} from '../_lib/lottery-score-weights-v2.js';
import type { LotteryScoreInput } from '../_lib/lottery-score-weights-v2.js';
import { LotteryWeightsSchema } from '../_lib/lottery-weights-schema.js';
import type {
  CompositeBonus,
  LotteryWeights,
  TimeOfDay,
} from '../_lib/lottery-weights-schema.js';
import {
  SEED_LOTTERY_WEIGHTS,
  SEED_LOTTERY_WEIGHTS_VERSION,
} from '../_lib/lottery-weights-seed.js';

const FEATURES = SEED_LOTTERY_WEIGHTS.features;
const COMPOSITE_BONUSES_V2 = FEATURES.composite_bonuses;
const VOL_OI_QUINTILE_BOUNDARIES = FEATURES.vol_oi_quintile_boundaries;
const GAMMA_QUINTILE_BOUNDARIES = FEATURES.gamma_quintile_boundaries;
const ASK_PCT_QUINTILE_BOUNDARIES = FEATURES.ask_pct_quintile_boundaries;
const VOL_OI_QUINTILE_WEIGHTS = FEATURES.vol_oi_quintile_weights;
const GAMMA_QUINTILE_WEIGHTS = FEATURES.gamma_quintile_weights;
const ASK_PCT_QUINTILE_WEIGHTS = FEATURES.ask_pct_quintile_weights;
const TOD_WEIGHTS_V2 = FEATURES.tod_weights;
const TOD_WEIGHTS_DOW_OVERRIDES_V2 = FEATURES.tod_weights_dow_overrides;
const CUTOFFS = SEED_LOTTERY_WEIGHTS.cutoffs;

/** Score with the frozen seed — the weights every suite below pins. */
const score = (args: LotteryScoreInput): number | null =>
  scoreLotteryV2(SEED_LOTTERY_WEIGHTS, args);

describe('scoreLotteryV2 — hard alignment gate', () => {
  it('returns null when isAligned is false', () => {
    expect(
      score({
        ticker: 'AMZN',
        tod: 'AM_open',
        dte: 1,
        volOiWindow: 0.12,
        gammaAtTrigger: 0.05,
        triggerAskPct: 0.55,
        optionType: 'C',
        isAligned: false,
      }),
    ).toBeNull();
  });

  it('returns null when DTE is outside {0,1,2,3}', () => {
    expect(
      score({
        ticker: 'AMZN',
        tod: 'AM_open',
        dte: 4,
        volOiWindow: 0.12,
        gammaAtTrigger: 0.05,
        triggerAskPct: 0.55,
        optionType: 'C',
        isAligned: true,
      }),
    ).toBeNull();
  });

  it('returns a non-null integer for an aligned in-universe fire', () => {
    const result = score({
      ticker: 'AMZN',
      tod: 'AM_open',
      dte: 1,
      volOiWindow: 0.12,
      gammaAtTrigger: 0.05,
      triggerAskPct: 0.55,
      optionType: 'C',
      isAligned: true,
    });
    expect(result).not.toBeNull();
    expect(Number.isInteger(result)).toBe(true);
  });
});

describe('scoreLotteryV2 — null continuous features contribute 0', () => {
  it('omits all 3 quintile contributions when their inputs are null', () => {
    // Compare a fire with all-null continuous features against one with
    // present features — the gap MUST equal the sum of the 3 quintile
    // contributions. Identical fires apart from those 3 fields:
    const withFeatures = score({
      ticker: 'AMZN',
      tod: 'AM_open',
      dte: 1,
      volOiWindow: 0.12,
      gammaAtTrigger: 0.05,
      triggerAskPct: 0.55,
      optionType: 'C',
      isAligned: true,
    });
    const withoutFeatures = score({
      ticker: 'AMZN',
      tod: 'AM_open',
      dte: 1,
      volOiWindow: null,
      gammaAtTrigger: null,
      triggerAskPct: null,
      optionType: 'C',
      isAligned: true,
    });
    // Both must be non-null because alignment + dte are satisfied
    expect(withFeatures).not.toBeNull();
    expect(withoutFeatures).not.toBeNull();
    // The categorical-only score is a valid integer (could be positive,
    // zero, or negative depending on weights — just must not throw)
    expect(Number.isInteger(withoutFeatures)).toBe(true);
  });
});

describe('assignQuintile', () => {
  it('returns 0 for values below the first boundary', () => {
    expect(assignQuintile(0.001, VOL_OI_QUINTILE_BOUNDARIES)).toBe(0);
  });

  it('returns 4 only for values STRICTLY above the last boundary', () => {
    const lastBoundary = VOL_OI_QUINTILE_BOUNDARIES.at(-1) ?? 0;
    // Right-closed: a value EXACTLY on the last boundary belongs to the
    // lower bucket (3), not 4 (matches pandas pd.cut right=True).
    expect(assignQuintile(lastBoundary, VOL_OI_QUINTILE_BOUNDARIES)).toBe(3);
    expect(assignQuintile(lastBoundary * 10, VOL_OI_QUINTILE_BOUNDARIES)).toBe(
      4,
    );
    expect(
      assignQuintile(lastBoundary + 1e-9, VOL_OI_QUINTILE_BOUNDARIES),
    ).toBe(4);
  });

  // Train/serve parity: training uses pd.cut(bins=[-inf,...boundaries,inf],
  // right=True), so each bucket is (b_{k-1}, b_k] — a value EXACTLY on a
  // boundary lands in the LOWER bucket. assignQuintile must match exactly
  // (it uses `value <= bound`). ask_pct = ask/(ask+bid) hits the exact
  // rational boundaries (0.5714…, 0.625, 0.75) precisely, so this skew was
  // observable in production, not theoretical.
  it('puts a value EXACTLY on a boundary into the lower bucket (right=True)', () => {
    VOL_OI_QUINTILE_BOUNDARIES.forEach((bound, i) => {
      // value === boundaries[i] → quintile i (the lower of the two buckets
      // the boundary separates).
      expect(assignQuintile(bound, VOL_OI_QUINTILE_BOUNDARIES)).toBe(i);
      // A hair above the boundary moves to the next bucket up.
      expect(assignQuintile(bound + 1e-9, VOL_OI_QUINTILE_BOUNDARIES)).toBe(
        i + 1,
      );
    });
  });

  it('matches the ask_pct exact-rational boundaries (0.5714…, 0.625, 0.75)', () => {
    // ASK_PCT_QUINTILE_BOUNDARIES = [0.5333…, 0.5714…, 0.625, 0.75].
    // Each exact boundary value belongs to its own (lower) bucket.
    ASK_PCT_QUINTILE_BOUNDARIES.forEach((bound, i) => {
      expect(assignQuintile(bound, ASK_PCT_QUINTILE_BOUNDARIES)).toBe(i);
    });
    // 0.75 (== boundaries[3]) → quintile 3 under right-closed, NOT 4.
    expect(assignQuintile(0.75, ASK_PCT_QUINTILE_BOUNDARIES)).toBe(3);
  });

  it('returns a quintile between 0 and 4 for any input', () => {
    for (const v of [-1, 0, 0.05, 0.1, 0.5, 1, 100]) {
      const q = assignQuintile(v, VOL_OI_QUINTILE_BOUNDARIES);
      expect(q).toBeGreaterThanOrEqual(0);
      expect(q).toBeLessThanOrEqual(4);
      expect(Number.isInteger(q)).toBe(true);
    }
  });
});

describe('lotteryScoreTierV2', () => {
  it('treats null as tier3', () => {
    expect(lotteryScoreTierV2(null, CUTOFFS)).toBe('tier3');
  });

  it('classifies scores at or above t1 as tier1', () => {
    expect(lotteryScoreTierV2(CUTOFFS.t1, CUTOFFS)).toBe('tier1');
    expect(lotteryScoreTierV2(CUTOFFS.t1 + 100, CUTOFFS)).toBe('tier1');
  });

  it('classifies scores in [t2, t1) as tier2', () => {
    if (CUTOFFS.t1 > CUTOFFS.t2) {
      expect(lotteryScoreTierV2(CUTOFFS.t2, CUTOFFS)).toBe('tier2');
      expect(lotteryScoreTierV2(CUTOFFS.t1 - 1, CUTOFFS)).toBe('tier2');
    }
  });

  it('classifies scores below t2 as tier3', () => {
    expect(lotteryScoreTierV2(CUTOFFS.t2 - 1, CUTOFFS)).toBe('tier3');
    expect(lotteryScoreTierV2(-1000, CUTOFFS)).toBe('tier3');
  });

  it('reads the cutoffs it is given, not the seed’s', () => {
    // 10 and 6 are the seed's t1 and t2; these cutoffs sit well above them.
    const raised = { t1: 20, t2: 15 };
    expect(lotteryScoreTierV2(20, raised)).toBe('tier1');
    expect(lotteryScoreTierV2(19, raised)).toBe('tier2');
    expect(lotteryScoreTierV2(15, raised)).toBe('tier2');
    expect(lotteryScoreTierV2(14, raised)).toBe('tier3');
    // The same scores land one tier higher under the seed's own cutoffs.
    expect(lotteryScoreTierV2(14, CUTOFFS)).toBe('tier1');
    expect(lotteryScoreTierV2(null, raised)).toBe('tier3');
  });
});

describe('seed cutoffs shape', () => {
  it('has numeric t1 and t2 with t1 > t2', () => {
    expect(typeof CUTOFFS.t1).toBe('number');
    expect(typeof CUTOFFS.t2).toBe('number');
    expect(CUTOFFS.t1).toBeGreaterThan(CUTOFFS.t2);
  });
});

describe('scoreLotteryV2 — Monday DOW override', () => {
  const baseArgs = {
    ticker: 'AMZN',
    dte: 1,
    volOiWindow: null,
    gammaAtTrigger: null,
    triggerAskPct: null,
    optionType: 'C' as const,
    isAligned: true,
  };

  it('Monday override exists in tod_weights_dow_overrides', () => {
    const mon = TOD_WEIGHTS_DOW_OVERRIDES_V2.Monday;
    expect(mon).toBeDefined();
    if (!mon) return;
    // Lineage finding: LUNCH should be positive, AM_open should be lower
    // than global (global AM_open=+4; Monday AM_open must be < that).
    expect(mon.LUNCH).toBeGreaterThan(0);
    expect(mon.AM_open).toBeLessThan(TOD_WEIGHTS_V2.AM_open);
  });

  it('Monday AM_open score differs from non-Monday AM_open score', () => {
    const mondayScore = score({
      ...baseArgs,
      tod: 'AM_open',
      dayOfWeek: 'Monday',
    });
    const tuesdayScore = score({
      ...baseArgs,
      tod: 'AM_open',
      dayOfWeek: 'Tuesday',
    });
    // Tuesday has no override → uses global AM_open weight → scores differ
    expect(mondayScore).not.toBeNull();
    expect(tuesdayScore).not.toBeNull();
    expect(mondayScore).not.toBe(tuesdayScore);
  });

  it('Monday LUNCH score differs from non-Monday LUNCH score', () => {
    const mondayScore = score({
      ...baseArgs,
      tod: 'LUNCH',
      dayOfWeek: 'Monday',
    });
    const globalScore = score({
      ...baseArgs,
      tod: 'LUNCH',
    });
    expect(mondayScore).not.toBeNull();
    expect(globalScore).not.toBeNull();
    // Monday LUNCH is positive; global LUNCH is negative → Monday scores higher
    expect(mondayScore!).toBeGreaterThan(globalScore!);
  });

  it('falls back to global TOD weights when dayOfWeek is not in overrides', () => {
    const wednesdayScore = score({
      ...baseArgs,
      tod: 'AM_open',
      dayOfWeek: 'Wednesday',
    });
    const noOverrideScore = score({
      ...baseArgs,
      tod: 'AM_open',
    });
    // Both use the global TOD table → identical score
    expect(wednesdayScore).toBe(noOverrideScore);
  });

  it('falls back to global TOD weights when dayOfWeek is omitted', () => {
    const withoutDow = score({
      ...baseArgs,
      tod: 'PM',
    });
    const withTuesday = score({
      ...baseArgs,
      tod: 'PM',
      dayOfWeek: 'Tuesday',
    });
    expect(withoutDow).toBe(withTuesday);
  });

  it('ignores a dayOfWeek that names an Object.prototype member', () => {
    // A plain `dayOfWeek in overrides` or `overrides[dayOfWeek]` would find
    // "constructor" on the prototype and score NaN.
    const viaPrototypeName = score({
      ...baseArgs,
      tod: 'AM_open',
      dayOfWeek: 'constructor',
    });
    const noOverrideScore = score({ ...baseArgs, tod: 'AM_open' });
    expect(viaPrototypeName).toBe(noOverrideScore);
  });
});

describe('scoreLotteryV2 — composite bonuses/penalties', () => {
  // ---------------------------------------------------------------------------
  // Marginal-effect harness.
  //
  // Every composite test holds the TICKER (and every other feature) CONSTANT
  // and varies ONLY the composite's trigger quintile key. Because the ticker is
  // identical on both sides, the ticker weight — and the tod/dte/option-type
  // weights — cancel exactly. The score delta therefore isolates the composite's
  // MARGINAL effect: after subtracting the (table-derived) per-quintile weight
  // of the one key that moved, what remains is precisely the composite `bonus`
  // when it fires, and exactly 0 when it does not. No ticker-weight table, no
  // AMZN baseline, no `?? 0` over the ticker map. A change to the bonus
  // mechanism (the score function applying `entry.bonus`) DOES break them.
  //
  // The trigger value for each quintile key is derived generically from the
  // matching boundary array, so a future composite keyed on a different
  // quintile (vol_oi_q / ask_pct_q instead of gamma_q) is exercised by the same
  // code path with no hardcoded gamma assumptions.
  // ---------------------------------------------------------------------------

  const QUINTILE_BOUNDARIES_BY_KEY = {
    gamma_q: GAMMA_QUINTILE_BOUNDARIES,
    vol_oi_q: VOL_OI_QUINTILE_BOUNDARIES,
    ask_pct_q: ASK_PCT_QUINTILE_BOUNDARIES,
  } as const;

  // Per-quintile weight array for each key — used by the "did not fire" tests
  // to express the expected delta as a pure quintile-weight difference (no
  // composite bonus term), derived from the same live table.
  const QUINTILE_WEIGHTS_BY_KEY = {
    gamma_q: GAMMA_QUINTILE_WEIGHTS,
    vol_oi_q: VOL_OI_QUINTILE_WEIGHTS,
    ask_pct_q: ASK_PCT_QUINTILE_WEIGHTS,
  } as const;

  type QuintileKey = keyof typeof QUINTILE_BOUNDARIES_BY_KEY;

  // The function arg field each quintile key reads its raw value from.
  const FEATURE_FIELD_BY_KEY: Record<
    QuintileKey,
    'volOiWindow' | 'gammaAtTrigger' | 'triggerAskPct'
  > = {
    gamma_q: 'gammaAtTrigger',
    vol_oi_q: 'volOiWindow',
    ask_pct_q: 'triggerAskPct',
  };

  // Boundary arrays are length-4 (quintiles 0-4). Guard once so a shorter
  // array fails loudly here rather than producing silent NaN selectors.
  for (const [key, bounds] of Object.entries(QUINTILE_BOUNDARIES_BY_KEY)) {
    it(`${key} boundary array has 4 entries`, () => {
      expect(bounds).toHaveLength(4);
    });
  }

  /**
   * Return a raw feature value that `assignQuintile` maps to quintile `q`
   * under `boundaries`. Derived purely from the boundary array.
   */
  const valueForQuintile = (
    boundaries: ReadonlyArray<number>,
    q: number,
  ): number => {
    if (q <= 0) return boundaries[0]! * 0.5; // strictly below boundaries[0]
    if (q >= 4) return boundaries[3]! * 2; // strictly at/above boundaries[3]
    // Midpoint of [boundaries[q-1], boundaries[q]) lands in quintile q.
    const lo = boundaries[q - 1]!;
    const hi = boundaries[q]!;
    return (lo + hi) / 2;
  };

  /** A quintile index guaranteed to differ from `q` (for the non-firing side). */
  const otherQuintile = (q: number): number => (q === 0 ? 4 : 0);

  /**
   * Build args that satisfy every key of `entry.match`: the entry's ticker,
   * its tod (or a default), and a raw value inside each quintile the match
   * specifies. Returns the args plus the single quintile key/quintile that the
   * composite hinges on, so a caller can flip just that one key off.
   */
  const argsForComposite = (entry: CompositeBonus) => {
    const quintileKeys = (
      Object.keys(QUINTILE_BOUNDARIES_BY_KEY) as QuintileKey[]
    ).filter((k) => entry.match[k] !== undefined);

    const args: LotteryScoreInput = {
      dte: 1,
      optionType: 'C',
      isAligned: true,
      volOiWindow: null,
      gammaAtTrigger: null,
      triggerAskPct: null,
      ticker: entry.match.ticker ?? 'AMZN',
      tod: entry.match.tod ?? 'AM_open',
    };

    for (const key of quintileKeys) {
      const q = Number.parseInt(entry.match[key]!, 10);
      args[FEATURE_FIELD_BY_KEY[key]] = valueForQuintile(
        QUINTILE_BOUNDARIES_BY_KEY[key],
        q,
      );
    }

    // Pick the quintile key the test will flip. Prefer a quintile-typed key;
    // every composite in the table has at least one.
    const pivotKey = quintileKeys[0];
    return { args, pivotKey };
  };

  it('the seed has the expected 7 composites from the 2026-05-22 mining report', () => {
    expect(COMPOSITE_BONUSES_V2).toHaveLength(7);
  });

  it('winning composites all have positive bonus', () => {
    const winners = COMPOSITE_BONUSES_V2.filter((e) => e.win_rate >= 0.9);
    expect(winners.length).toBeGreaterThan(0);
    for (const w of winners) {
      expect(w.bonus).toBeGreaterThan(0);
    }
  });

  it('losing composites all have negative bonus', () => {
    const losers = COMPOSITE_BONUSES_V2.filter((e) => e.win_rate === 0);
    expect(losers.length).toBeGreaterThan(0);
    for (const l of losers) {
      expect(l.bonus).toBeLessThan(0);
    }
  });

  it("a winning composite's marginal effect equals exactly its bonus", () => {
    // Derive a winning composite from the table (don't hardcode SNDK).
    const entry = COMPOSITE_BONUSES_V2.find((e) => e.win_rate >= 0.9);
    expect(entry).toBeDefined();
    if (!entry) return; // guard so a table with no winners fails cleanly above

    const { args, pivotKey } = argsForComposite(entry);
    expect(pivotKey).toBeDefined();
    if (!pivotKey) return;

    const firedQ = Number.parseInt(entry.match[pivotKey]!, 10);
    const offQ = otherQuintile(firedQ);
    const offField = FEATURE_FIELD_BY_KEY[pivotKey];
    const weights = QUINTILE_WEIGHTS_BY_KEY[pivotKey];

    // SAME ticker/tod/everything; only the pivot quintile changes (firing → off).
    const scoreWhenFires = score(args);
    const scoreWhenOff = score({
      ...args,
      [offField]: valueForQuintile(QUINTILE_BOUNDARIES_BY_KEY[pivotKey], offQ),
    });

    expect(scoreWhenFires).not.toBeNull();
    expect(scoreWhenOff).not.toBeNull();
    // The ticker/tod/dte/option-type weights are identical on both sides and
    // cancel entirely — no tickerDelta, no AMZN baseline. Two components differ:
    // (1) the composite bonus (fires on one side only) and (2) the pivot
    // quintile's own per-quintile weight (firing-quintile vs off-quintile),
    // both read from the same live table. Subtracting the known quintile-weight
    // component leaves the bonus exactly, so a bonus change still breaks this.
    const quintileWeightDelta = (weights[firedQ] ?? 0) - (weights[offQ] ?? 0);
    expect(scoreWhenFires! - scoreWhenOff! - quintileWeightDelta).toBe(
      entry.bonus,
    );
  });

  it("a losing composite's marginal effect equals exactly its (negative) bonus", () => {
    const entry = COMPOSITE_BONUSES_V2.find((e) => e.win_rate === 0);
    expect(entry).toBeDefined();
    if (!entry) return;

    const { args, pivotKey } = argsForComposite(entry);
    expect(pivotKey).toBeDefined();
    if (!pivotKey) return;

    const firedQ = Number.parseInt(entry.match[pivotKey]!, 10);
    const offQ = otherQuintile(firedQ);
    const offField = FEATURE_FIELD_BY_KEY[pivotKey];
    const weights = QUINTILE_WEIGHTS_BY_KEY[pivotKey];

    const scoreWhenFires = score(args);
    const scoreWhenOff = score({
      ...args,
      [offField]: valueForQuintile(QUINTILE_BOUNDARIES_BY_KEY[pivotKey], offQ),
    });

    expect(scoreWhenFires).not.toBeNull();
    expect(scoreWhenOff).not.toBeNull();
    expect(entry.bonus).toBeLessThan(0);
    const quintileWeightDelta = (weights[firedQ] ?? 0) - (weights[offQ] ?? 0);
    expect(scoreWhenFires! - scoreWhenOff! - quintileWeightDelta).toBe(
      entry.bonus,
    );
  });

  it('composite does not fire on ANY non-firing quintile of its pivot key', () => {
    // Hold ticker+tod constant. The composite fires only at `firedQ`. For EVERY
    // other quintile of the pivot key, a fire there must carry NO composite
    // bonus — a spurious-firing bug confined to a middle quintile (e.g. q2/q3
    // for a composite whose firing quintile is 0) must not slip through.
    //
    // Reference: a fixed non-firing quintile `refQ`. For each non-firing `q`,
    // the marginal delta of a fire-at-q vs fire-at-ref is the pure per-quintile
    // weight difference (`weights[q] - weights[refQ]`), with NO `+ bonus` term —
    // both sides are non-firing. If the composite spuriously fired at `q`, the
    // bonus would leak into that iteration's delta and the assertion fails.
    const entry = COMPOSITE_BONUSES_V2.find((e) => e.win_rate >= 0.9);
    expect(entry).toBeDefined();
    if (!entry) return; // a table with no winners fails the earlier guard

    const { args, pivotKey } = argsForComposite(entry);
    expect(pivotKey).toBeDefined();
    if (!pivotKey) return;

    const firedQ = Number.parseInt(entry.match[pivotKey]!, 10);
    const offField = FEATURE_FIELD_BY_KEY[pivotKey];
    const bounds = QUINTILE_BOUNDARIES_BY_KEY[pivotKey];
    const weights = QUINTILE_WEIGHTS_BY_KEY[pivotKey];

    // All 5 quintile indices; the non-firing ones are everything but firedQ.
    const allQuintiles = [0, 1, 2, 3, 4];
    const nonFiring = allQuintiles.filter((q) => q !== firedQ);
    // Fixed non-firing reference (also non-firing → its side carries no bonus).
    const refQ = nonFiring[0]!;

    const refScore = score({
      ...args,
      [offField]: valueForQuintile(bounds, refQ),
    });
    expect(refScore).not.toBeNull();

    // Exhaustively assert NO spurious composite fire at any non-firing quintile.
    for (const q of nonFiring) {
      const scoreAtQ = score({
        ...args,
        [offField]: valueForQuintile(bounds, q),
      });
      expect(scoreAtQ).not.toBeNull();
      // Pure quintile-weight delta, no composite bonus term. (q === refQ is a
      // harmless identity: 0 === weights[refQ] - weights[refQ].)
      expect(scoreAtQ! - refScore!).toBe(
        (weights[q] ?? 0) - (weights[refQ] ?? 0),
      );
    }
  });

  it('exercises the vol_oi_q and ask_pct_q match branches (not just gamma_q)', () => {
    // The marginal-effect tests above pivot on each composite's FIRST quintile
    // key, which for every winning composite is `gamma_q` — so the
    // `m.vol_oi_q`/`m.ask_pct_q` comparison branches in the loop never
    // execute. Drive a composite of EACH non-gamma key type directly so those
    // `=== undefined` / label-compare branches run.
    const byKey = (k: 'vol_oi_q' | 'ask_pct_q') =>
      COMPOSITE_BONUSES_V2.find((e) => e.match[k] !== undefined);

    for (const key of ['vol_oi_q', 'ask_pct_q'] as const) {
      const entry = byKey(key);
      // Only assert if a composite of this key exists in the table.
      if (!entry) continue;
      const { args, pivotKey } = argsForComposite(entry);
      expect(pivotKey).toBe(key);
      const firedQ = Number.parseInt(entry.match[key]!, 10);
      const offQ = otherQuintile(firedQ);
      const offField = FEATURE_FIELD_BY_KEY[key];
      const weights = QUINTILE_WEIGHTS_BY_KEY[key];

      const scoreWhenFires = score(args);
      const scoreWhenOff = score({
        ...args,
        [offField]: valueForQuintile(QUINTILE_BOUNDARIES_BY_KEY[key], offQ),
      });
      expect(scoreWhenFires).not.toBeNull();
      expect(scoreWhenOff).not.toBeNull();
      const quintileWeightDelta = (weights[firedQ] ?? 0) - (weights[offQ] ?? 0);
      // The composite's bonus appears only on the firing side.
      expect(scoreWhenFires! - scoreWhenOff! - quintileWeightDelta).toBe(
        entry.bonus,
      );
    }
  });

  it('takes the null-label arm for a vol_oi_q / ask_pct_q composite (=== null ? "null")', () => {
    // The label is computed as `q === null ? 'null' : String(q)`. The null arm
    // only runs when the composite's pivot feature is NULL. Drive a vol_oi_q /
    // ask_pct_q composite with its pivot raw value null → label 'null' !==
    // '4'/'0' → continue (no bonus). Holding everything else constant, the
    // score equals a definitely-non-matching numeric-quintile fire minus that
    // quintile's own weight (null contributes 0 to its quintile component).
    for (const key of ['vol_oi_q', 'ask_pct_q'] as const) {
      const entry = COMPOSITE_BONUSES_V2.find(
        (e) => e.match[key] !== undefined,
      );
      if (!entry) continue;
      const { args } = argsForComposite(entry);
      const offField = FEATURE_FIELD_BY_KEY[key];
      const weights = QUINTILE_WEIGHTS_BY_KEY[key];
      const firedQ = Number.parseInt(entry.match[key]!, 10);
      const offQ = otherQuintile(firedQ);

      const nullPivot = score({ ...args, [offField]: null });
      const numericNonMatch = score({
        ...args,
        [offField]: valueForQuintile(QUINTILE_BOUNDARIES_BY_KEY[key], offQ),
      });
      expect(nullPivot).not.toBeNull();
      expect(numericNonMatch).not.toBeNull();
      // Neither fires the composite; numeric side adds its quintile weight,
      // null side adds 0.
      expect(numericNonMatch! - nullPivot!).toBe(weights[offQ] ?? 0);
    }
  });

  it('takes the tod-mismatch continue branch (m.tod !== args.tod)', () => {
    // A composite that specifies a `tod` must NOT fire when the fire's tod
    // differs. Pick a composite that carries a tod constraint, satisfy every
    // other match key, but pass a DIFFERENT tod → the loop hits `continue`
    // and the bonus is not applied. Compare against the same fire at the
    // composite's actual tod (fires): the delta is exactly the bonus,
    // isolating the tod gate.
    const entry = COMPOSITE_BONUSES_V2.find((e) => e.match.tod !== undefined);
    expect(entry).toBeDefined();
    if (!entry) return;
    const { args, pivotKey } = argsForComposite(entry);
    if (!pivotKey) return;

    const allTods = ['AM_open', 'MID', 'LUNCH', 'PM'] as const;
    const wrongTod = allTods.find((t) => t !== entry.match.tod)!;

    const firesAtRightTod = score(args); // args.tod === entry tod
    const blockedByWrongTod = score({
      ...args,
      tod: wrongTod,
    });
    expect(firesAtRightTod).not.toBeNull();
    expect(blockedByWrongTod).not.toBeNull();
    // Same ticker/dte/option-type/quintiles; only tod moved. The score delta
    // is (composite bonus) + (tod-weight difference between the two tods).
    const todWeightDelta =
      TOD_WEIGHTS_V2[entry.match.tod as TimeOfDay] - TOD_WEIGHTS_V2[wrongTod];
    expect(firesAtRightTod! - blockedByWrongTod! - todWeightDelta).toBe(
      entry.bonus,
    );
  });

  it('null quintile feature does not spuriously match a string-keyed composite', () => {
    // The composite requires its pivot quintile == a numeric label (e.g. "0").
    // A null raw value gets the label "null", which a string-keyed composite
    // can never match. Holding ticker+tod constant, compare a null-pivot fire
    // against a definitely-non-matching NUMERIC-quintile fire. Neither fires
    // the composite, so the delta is just (off-quintile weight − null's 0
    // contribution) — no bonus. A null-pivot fire that wrongly matched would
    // inject the bonus and break this.
    const entry = COMPOSITE_BONUSES_V2.find((e) => e.win_rate >= 0.9);
    expect(entry).toBeDefined();
    if (!entry) return;

    const { args, pivotKey } = argsForComposite(entry);
    expect(pivotKey).toBeDefined();
    if (!pivotKey) return;

    const firedQ = Number.parseInt(entry.match[pivotKey]!, 10);
    const offField = FEATURE_FIELD_BY_KEY[pivotKey];
    const bounds = QUINTILE_BOUNDARIES_BY_KEY[pivotKey];
    const weights = QUINTILE_WEIGHTS_BY_KEY[pivotKey];

    const offQ = otherQuintile(firedQ);
    const numericNonMatch = score({
      ...args,
      [offField]: valueForQuintile(bounds, offQ),
    });
    const nullPivot = score({ ...args, [offField]: null });

    expect(numericNonMatch).not.toBeNull();
    expect(nullPivot).not.toBeNull();
    // null contributes 0 to the quintile component; the off quintile contributes
    // its own weight. Neither side gets the composite bonus.
    expect(numericNonMatch! - nullPivot!).toBe(weights[offQ] ?? 0);
  });
});

describe('scoreLotteryV2 — scores with the weights it is given', () => {
  const sndkFire: LotteryScoreInput = {
    ticker: 'SNDK',
    tod: 'MID',
    dte: 1,
    volOiWindow: 0.12,
    gammaAtTrigger: 0.05,
    triggerAskPct: 0.55,
    optionType: 'C',
    isAligned: true,
  };

  it('a copy of the seed with ticker_weights.SNDK += 3 scores an SNDK fire exactly 3 higher', () => {
    const bumped = structuredClone(SEED_LOTTERY_WEIGHTS);
    bumped.features.ticker_weights.SNDK =
      (bumped.features.ticker_weights.SNDK ?? 0) + 3;

    const seedScore = scoreLotteryV2(SEED_LOTTERY_WEIGHTS, sndkFire);
    expect(seedScore).not.toBeNull();
    expect(scoreLotteryV2(bumped, sndkFire)).toBe(seedScore! + 3);
    // The copy leaves the seed untouched.
    expect(SEED_LOTTERY_WEIGHTS.features.ticker_weights.SNDK).toBe(0);
  });

  it('reads every table from the object, not from module constants', () => {
    // Move one weight in each table the scorer reads; each must move the
    // score by exactly that amount. Fire: aligned call, AM_open, DTE 1, every
    // continuous feature inside quintile 2, on a ticker with no composite.
    const fire: LotteryScoreInput = {
      ticker: 'AMZN',
      tod: 'AM_open',
      dte: 1,
      volOiWindow: 0.1,
      gammaAtTrigger: 0.03,
      triggerAskPct: 0.6,
      optionType: 'C',
      isAligned: true,
    };
    const baseline = scoreLotteryV2(SEED_LOTTERY_WEIGHTS, fire)!;
    expect(assignQuintile(0.1, FEATURES.vol_oi_quintile_boundaries)).toBe(2);
    expect(assignQuintile(0.03, FEATURES.gamma_quintile_boundaries)).toBe(2);
    expect(assignQuintile(0.6, FEATURES.ask_pct_quintile_boundaries)).toBe(2);

    const bumps: Array<[string, (w: LotteryWeights) => void]> = [
      ['tod_weights.AM_open', (w) => (w.features.tod_weights.AM_open += 1)],
      ['dte_weights.1', (w) => (w.features.dte_weights['1'] += 1)],
      [
        'vol_oi_quintile_weights[2]',
        (w) => (w.features.vol_oi_quintile_weights[2]! += 1),
      ],
      [
        'gamma_quintile_weights[2]',
        (w) => (w.features.gamma_quintile_weights[2]! += 1),
      ],
      [
        'ask_pct_quintile_weights[2]',
        (w) => (w.features.ask_pct_quintile_weights[2]! += 1),
      ],
      ['option_type_weights.C', (w) => (w.features.option_type_weights.C += 1)],
    ];
    for (const [label, bump] of bumps) {
      const copy = structuredClone(SEED_LOTTERY_WEIGHTS);
      bump(copy);
      expect(scoreLotteryV2(copy, fire), label).toBe(baseline + 1);
    }
  });

  // Under the seed each raw value below sits in quintile 3. Raising every
  // boundary above it drops it to quintile 0, so the score must move by
  // exactly `weights[0] - weights[3]` — and only if the scorer cut the value
  // at the boundaries of the object it was handed.
  it.each([
    [
      'vol_oi',
      'volOiWindow',
      0.2,
      'vol_oi_quintile_boundaries',
      VOL_OI_QUINTILE_BOUNDARIES,
      VOL_OI_QUINTILE_WEIGHTS,
    ],
    [
      'gamma',
      'gammaAtTrigger',
      0.05,
      'gamma_quintile_boundaries',
      GAMMA_QUINTILE_BOUNDARIES,
      GAMMA_QUINTILE_WEIGHTS,
    ],
    [
      'ask_pct',
      'triggerAskPct',
      0.7,
      'ask_pct_quintile_boundaries',
      ASK_PCT_QUINTILE_BOUNDARIES,
      ASK_PCT_QUINTILE_WEIGHTS,
    ],
  ] as const)(
    'reads the %s boundaries from the object',
    (_label, field, value, boundariesKey, seedBoundaries, quintileWeights) => {
      expect(assignQuintile(value, seedBoundaries)).toBe(3);
      const copy = structuredClone(SEED_LOTTERY_WEIGHTS);
      copy.features[boundariesKey] = [1, 2, 3, 4];
      const fire: LotteryScoreInput = {
        ticker: 'AMZN',
        tod: 'AM_open',
        dte: 1,
        volOiWindow: null,
        gammaAtTrigger: null,
        triggerAskPct: null,
        optionType: 'C',
        isAligned: true,
        [field]: value,
      };
      expect(scoreLotteryV2(copy, fire)).toBe(
        scoreLotteryV2(SEED_LOTTERY_WEIGHTS, fire)! -
          quintileWeights[3]! +
          quintileWeights[0]!,
      );
    },
  );

  it('reads the Monday override from the object', () => {
    const fire: LotteryScoreInput = {
      ticker: 'AMZN',
      tod: 'AM_open',
      dte: 1,
      volOiWindow: null,
      gammaAtTrigger: null,
      triggerAskPct: null,
      optionType: 'C',
      isAligned: true,
    };
    // A copy with no Monday override scores a Monday fire on the global table.
    const noMonday = structuredClone(SEED_LOTTERY_WEIGHTS);
    delete noMonday.features.tod_weights_dow_overrides.Monday;
    const monday = { ...fire, dayOfWeek: 'Monday' };
    expect(scoreLotteryV2(noMonday, monday)).toBe(
      scoreLotteryV2(noMonday, { ...fire, dayOfWeek: 'Tuesday' }),
    );
    expect(scoreLotteryV2(SEED_LOTTERY_WEIGHTS, monday)).not.toBe(
      scoreLotteryV2(SEED_LOTTERY_WEIGHTS, { ...fire, dayOfWeek: 'Tuesday' }),
    );
    // A Tuesday override, which the seed doesn't have, moves a Tuesday fire.
    const withTuesday = structuredClone(SEED_LOTTERY_WEIGHTS);
    withTuesday.features.tod_weights_dow_overrides.Tuesday = {
      AM_open: 9,
      MID: 0,
      LUNCH: 0,
      PM: 0,
    };
    const tuesday = { ...fire, dayOfWeek: 'Tuesday' };
    expect(scoreLotteryV2(withTuesday, tuesday)).toBe(
      scoreLotteryV2(SEED_LOTTERY_WEIGHTS, tuesday)! -
        TOD_WEIGHTS_V2.AM_open +
        9,
    );
  });

  it('a gamma_q "null" composite fires on a NULL gamma and on nothing else', () => {
    // The schema allows the label "null" (a composite that hinges on the
    // feature being missing). The seed has none, so build one.
    const copy = structuredClone(SEED_LOTTERY_WEIGHTS);
    copy.features.composite_bonuses = [
      {
        match: { ticker: 'AMZN', gamma_q: 'null' },
        bonus: 7,
        support: 40,
        win_rate: 0.9,
        note: 'synthetic probe',
      },
    ];
    const fire: LotteryScoreInput = {
      ticker: 'AMZN',
      tod: 'MID',
      dte: 1,
      volOiWindow: null,
      gammaAtTrigger: null,
      triggerAskPct: null,
      optionType: 'C',
      isAligned: true,
    };
    const withoutComposite = scoreLotteryV2(SEED_LOTTERY_WEIGHTS, fire)!;
    expect(scoreLotteryV2(copy, fire)).toBe(withoutComposite + 7);
    // A numeric gamma carries label "0".."4", never "null".
    const numeric = { ...fire, gammaAtTrigger: 0.05 };
    expect(scoreLotteryV2(copy, numeric)).toBe(
      scoreLotteryV2(SEED_LOTTERY_WEIGHTS, numeric),
    );
  });
});

describe('isAlignedFire', () => {
  it.each([
    ['call, ncp > npp', 'C', 5, 3, true],
    ['put, npp > ncp', 'P', 3, 5, true],
    ['call, ncp < npp', 'C', 3, 5, false],
    ['put, npp < ncp', 'P', 5, 3, false],
    ['call, ncp == npp', 'C', 4, 4, false],
    ['put, ncp == npp', 'P', 4, 4, false],
    ['call, cum_ncp NULL', 'C', null, 3, false],
    ['call, cum_npp NULL', 'C', 5, null, false],
    ['put, cum_ncp NULL', 'P', null, 3, false],
    ['put, cum_npp NULL', 'P', 3, null, false],
    ['call, both NULL', 'C', null, null, false],
    ['put, both zero', 'P', 0, 0, false],
    ['call, negative flows, ncp > npp', 'C', -2, -5, true],
    ['put, negative flows, npp > ncp', 'P', -5, -2, true],
  ] as const)('%s', (_label, optionType, cumNcp, cumNpp, expected) => {
    expect(isAlignedFire(optionType, cumNcp, cumNpp)).toBe(expected);
  });
});

describe('weekdayOf', () => {
  it.each([
    ['2026-03-09', 'Monday'],
    ['2026-03-10', 'Tuesday'],
    ['2026-03-11', 'Wednesday'],
    ['2026-03-12', 'Thursday'],
    ['2026-03-13', 'Friday'],
    ['2026-03-14', 'Saturday'],
    ['2026-03-15', 'Sunday'],
  ])('%s is a %s', (date, weekday) => {
    expect(weekdayOf(date)).toBe(weekday);
  });

  it('names the same calendar day in a timezone far east of UTC', () => {
    // The date string is a calendar day, not an instant: noon UTC is already
    // the next calendar day at UTC+14, so a zone-dependent formatter would
    // answer "Tuesday" for a Monday here.
    const original = process.env.TZ;
    process.env.TZ = 'Pacific/Kiritimati';
    try {
      expect(weekdayOf('2026-03-09')).toBe('Monday');
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
  });
});

describe('the parity fixture', () => {
  interface ParityFire {
    underlying_symbol: string;
    option_type: 'C' | 'P';
    tod: TimeOfDay;
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
    version: string;
    weights: unknown;
    cases: Array<{ name: string; fire: ParityFire; expected: number | null }>;
  };

  it('replays the parity fixture', () => {
    const weights = LotteryWeightsSchema.parse(fixture.weights);
    expect(fixture.cases.length).toBeGreaterThanOrEqual(40);
    for (const { name, fire, expected } of fixture.cases) {
      const got = scoreLotteryV2(weights, {
        ticker: fire.underlying_symbol,
        tod: fire.tod,
        dte: fire.dte,
        volOiWindow: fire.trigger_vol_to_oi_window,
        gammaAtTrigger: fire.gamma_at_trigger,
        triggerAskPct: fire.trigger_ask_pct,
        optionType: fire.option_type,
        isAligned: isAlignedFire(
          fire.option_type,
          fire.cum_ncp_at_fire,
          fire.cum_npp_at_fire,
        ),
        dayOfWeek: weekdayOf(fire.date),
      });
      expect(got, name).toBe(expected);
    }
  });

  it('covers null and non-null results, every tod and every in-universe DTE', () => {
    const { cases } = fixture;
    expect(cases.some((c) => c.expected === null)).toBe(true);
    expect(cases.some((c) => c.expected !== null)).toBe(true);
    for (const tod of ['AM_open', 'MID', 'LUNCH', 'PM']) {
      expect(cases.some((c) => c.fire.tod === tod)).toBe(true);
    }
    for (const dte of [0, 1, 2, 3, 4]) {
      expect(cases.some((c) => c.fire.dte === dte)).toBe(true);
    }
    const names = cases.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('is tagged with the seed version', () => {
    expect(fixture.version).toBe(SEED_LOTTERY_WEIGHTS_VERSION);
  });

  it('fixture weights equal the seed', () => {
    expect(fixture.weights).toEqual(SEED_LOTTERY_WEIGHTS);
  });
});

describe('the seed', () => {
  it('parses with LotteryWeightsSchema', () => {
    const parsed = LotteryWeightsSchema.safeParse(SEED_LOTTERY_WEIGHTS);
    expect(parsed.success).toBe(true);
    // A strict schema neither strips nor rewrites anything it accepts.
    expect(parsed.data).toEqual(SEED_LOTTERY_WEIGHTS);
  });

  it('is version seed-2026-06-17, trained through 2026-06-16', () => {
    expect(SEED_LOTTERY_WEIGHTS_VERSION).toBe('seed-2026-06-17');
    expect(SEED_LOTTERY_WEIGHTS.trained_through).toBe('2026-06-16');
    expect(SEED_LOTTERY_WEIGHTS.model_version).toBe('rescore-v1-2026-05-22');
    expect(SEED_LOTTERY_WEIGHTS.schema_version).toBe(1);
  });

  it('carries the cluster cutoffs 10/6 and the feed cutoffs 13/10', () => {
    expect(SEED_LOTTERY_WEIGHTS.cutoffs).toEqual({ t1: 10, t2: 6 });
    expect(SEED_LOTTERY_WEIGHTS.feed_cutoffs).toEqual({
      tier1_min_score: 13,
      tier2_min_score: 10,
    });
  });

  it('holds 85 tickers and 7 composites', () => {
    expect(Object.keys(FEATURES.ticker_weights)).toHaveLength(85);
    expect(FEATURES.composite_bonuses).toHaveLength(7);
  });
});

describe('the deprecated seed wrappers (Task 5 deletes them)', () => {
  it('computeLotteryScoreV2 scores with the seed', () => {
    const args: LotteryScoreInput = {
      ticker: 'RKLB',
      tod: 'AM_open',
      dte: 0,
      volOiWindow: 0.2,
      gammaAtTrigger: 0.018,
      triggerAskPct: 0.7,
      optionType: 'P',
      isAligned: true,
      dayOfWeek: 'Monday',
    };
    expect(computeLotteryScoreV2(args)).toBe(
      scoreLotteryV2(SEED_LOTTERY_WEIGHTS, args),
    );
    expect(computeLotteryScoreV2({ ...args, isAligned: false })).toBeNull();
  });

  it('LOTTERY_TIER_THRESHOLDS_V2 is the seed cutoffs', () => {
    expect(LOTTERY_TIER_THRESHOLDS_V2).toBe(SEED_LOTTERY_WEIGHTS.cutoffs);
  });
});

describe('the schema rejects', () => {
  // One malformed copy of the seed per case. The rejection must carry an issue
  // at the path named, so a case that fails for some other reason (a typo in
  // the mutation, say) fails here instead of passing for the wrong cause.
  const ok = (w: unknown) => LotteryWeightsSchema.safeParse(w);

  type Mutation = (w: any) => void;
  const tooMany = Object.fromEntries(
    Array.from({ length: 501 }, (_, i) => [`T${i}`, 0]),
  );

  it.each<[string, Mutation, string]>([
    // Unknown keys: "no unknown keys anywhere".
    ['an unknown key at the top level', (w) => (w.extra = 1), ''],
    ['an unknown key in features', (w) => (w.features.extra = 1), 'features'],
    [
      'an unknown key in cutoffs',
      (w) => (w.cutoffs.derivation = 'x'),
      'cutoffs',
    ],
    [
      'an unknown key in feed_cutoffs',
      (w) => (w.feed_cutoffs.extra = 1),
      'feed_cutoffs',
    ],
    [
      'an unknown key in a composite',
      (w) => (w.features.composite_bonuses[0].extra = 1),
      'features.composite_bonuses.0',
    ],
    [
      'an unknown key in a composite match',
      (w) => (w.features.composite_bonuses[0].match.extra = '1'),
      'features.composite_bonuses.0.match',
    ],
    // Boundaries.
    [
      'NaN in a boundary',
      (w) => (w.features.gamma_quintile_boundaries[0] = Number.NaN),
      'features.gamma_quintile_boundaries.0',
    ],
    [
      'Infinity in a boundary',
      (w) => (w.features.ask_pct_quintile_boundaries[3] = Infinity),
      'features.ask_pct_quintile_boundaries.3',
    ],
    [
      '-Infinity in a boundary',
      (w) => (w.features.vol_oi_quintile_boundaries[0] = -Infinity),
      'features.vol_oi_quintile_boundaries.0',
    ],
    [
      'equal boundaries (not strictly increasing)',
      (w) => {
        const b = w.features.vol_oi_quintile_boundaries;
        b[1] = b[0];
      },
      'features.vol_oi_quintile_boundaries',
    ],
    [
      'decreasing boundaries',
      (w) => w.features.gamma_quintile_boundaries.reverse(),
      'features.gamma_quintile_boundaries',
    ],
    [
      '3 boundaries',
      (w) => w.features.ask_pct_quintile_boundaries.pop(),
      'features.ask_pct_quintile_boundaries',
    ],
    [
      '5 boundaries',
      (w) => w.features.vol_oi_quintile_boundaries.push(9),
      'features.vol_oi_quintile_boundaries',
    ],
    [
      'a boundary that is a string',
      (w) => (w.features.gamma_quintile_boundaries[1] = '0.5'),
      'features.gamma_quintile_boundaries.1',
    ],
    // Weights.
    [
      'a ticker weight of 11',
      (w) => (w.features.ticker_weights.AAPL = 11),
      'features.ticker_weights.AAPL',
    ],
    [
      'a ticker weight of -6',
      (w) => (w.features.ticker_weights.AAPL = -6),
      'features.ticker_weights.AAPL',
    ],
    [
      'a fractional weight',
      (w) => (w.features.tod_weights.MID = 0.5),
      'features.tod_weights.MID',
    ],
    [
      'a fractional ticker weight',
      (w) => (w.features.ticker_weights.AAPL = 0.5),
      'features.ticker_weights.AAPL',
    ],
    [
      'a NaN weight',
      (w) => (w.features.dte_weights['0'] = Number.NaN),
      'features.dte_weights.0',
    ],
    [
      'a tod weight of 21',
      (w) => (w.features.tod_weights.PM = 21),
      'features.tod_weights.PM',
    ],
    [
      'a dte weight of -21',
      (w) => (w.features.dte_weights['2'] = -21),
      'features.dte_weights.2',
    ],
    [
      'an option-type weight of 21',
      (w) => (w.features.option_type_weights.P = 21),
      'features.option_type_weights.P',
    ],
    [
      'a quintile weight of 21',
      (w) => (w.features.gamma_quintile_weights[4] = 21),
      'features.gamma_quintile_weights.4',
    ],
    [
      '4 quintile weights',
      (w) => w.features.vol_oi_quintile_weights.pop(),
      'features.vol_oi_quintile_weights',
    ],
    [
      '6 quintile weights',
      (w) => w.features.ask_pct_quintile_weights.push(0),
      'features.ask_pct_quintile_weights',
    ],
    // Tables.
    [
      'a ticker key in lower case',
      (w) => (w.features.ticker_weights.aapl = 0),
      'features.ticker_weights.aapl',
    ],
    [
      'a ticker key of 11 characters',
      (w) => (w.features.ticker_weights.ABCDEFGHIJK = 0),
      'features.ticker_weights.ABCDEFGHIJK',
    ],
    [
      'no tickers',
      (w) => (w.features.ticker_weights = {}),
      'features.ticker_weights',
    ],
    [
      '501 tickers',
      (w) => (w.features.ticker_weights = tooMany),
      'features.ticker_weights',
    ],
    [
      'a tod_weights key missing',
      (w) => delete w.features.tod_weights.PM,
      'features.tod_weights.PM',
    ],
    [
      'an extra tod_weights key',
      (w) => (w.features.tod_weights.EVENING = 0),
      'features.tod_weights',
    ],
    [
      'a dte_weights key missing',
      (w) => delete w.features.dte_weights['3'],
      'features.dte_weights.3',
    ],
    [
      'a dte_weights key "4"',
      (w) => (w.features.dte_weights['4'] = 0),
      'features.dte_weights',
    ],
    [
      'an extra option_type_weights key',
      (w) => (w.features.option_type_weights.X = 0),
      'features.option_type_weights',
    ],
    [
      'an option_type_weights key missing',
      (w) => delete w.features.option_type_weights.P,
      'features.option_type_weights.P',
    ],
    [
      'a Saturday override',
      (w) =>
        (w.features.tod_weights_dow_overrides.Saturday = {
          AM_open: 0,
          MID: 0,
          LUNCH: 0,
          PM: 0,
        }),
      'features.tod_weights_dow_overrides',
    ],
    [
      'an override missing a tod',
      (w) => delete w.features.tod_weights_dow_overrides.Monday.LUNCH,
      'features.tod_weights_dow_overrides.Monday.LUNCH',
    ],
    // Composites.
    [
      'a q label "5"',
      (w) => (w.features.composite_bonuses[0].match.gamma_q = '5'),
      'features.composite_bonuses.0.match.gamma_q',
    ],
    [
      'a numeric q label',
      (w) => (w.features.composite_bonuses[0].match.gamma_q = 0),
      'features.composite_bonuses.0.match.gamma_q',
    ],
    [
      'an empty composite match',
      (w) => (w.features.composite_bonuses[0].match = {}),
      'features.composite_bonuses.0.match',
    ],
    [
      'a composite tod outside the four',
      (w) => (w.features.composite_bonuses[0].match.tod = 'EVENING'),
      'features.composite_bonuses.0.match.tod',
    ],
    [
      'a composite bonus of 11',
      (w) => (w.features.composite_bonuses[0].bonus = 11),
      'features.composite_bonuses.0.bonus',
    ],
    [
      'a composite bonus of -11',
      (w) => (w.features.composite_bonuses[0].bonus = -11),
      'features.composite_bonuses.0.bonus',
    ],
    [
      'a fractional composite bonus',
      (w) => (w.features.composite_bonuses[0].bonus = 2.5),
      'features.composite_bonuses.0.bonus',
    ],
    [
      'a negative composite support',
      (w) => (w.features.composite_bonuses[0].support = -1),
      'features.composite_bonuses.0.support',
    ],
    [
      'a win_rate above 1',
      (w) => (w.features.composite_bonuses[0].win_rate = 1.01),
      'features.composite_bonuses.0.win_rate',
    ],
    [
      'a win_rate below 0',
      (w) => (w.features.composite_bonuses[0].win_rate = -0.01),
      'features.composite_bonuses.0.win_rate',
    ],
    [
      'a camelCase winRate in place of win_rate',
      (w) => {
        const c = w.features.composite_bonuses[0];
        c.winRate = c.win_rate;
        delete c.win_rate;
      },
      'features.composite_bonuses.0',
    ],
    [
      'a composite without a note',
      (w) => delete w.features.composite_bonuses[0].note,
      'features.composite_bonuses.0.note',
    ],
    [
      '51 composites',
      (w) => {
        const one = w.features.composite_bonuses[0];
        w.features.composite_bonuses = Array.from({ length: 51 }, () => one);
      },
      'features.composite_bonuses',
    ],
    // Cutoffs.
    ['t1 <= t2 (equal)', (w) => (w.cutoffs.t1 = w.cutoffs.t2), 'cutoffs'],
    [
      't1 < t2',
      (w) => {
        w.cutoffs.t1 = 5;
        w.cutoffs.t2 = 6;
      },
      'cutoffs',
    ],
    ['a fractional t1', (w) => (w.cutoffs.t1 = 10.5), 'cutoffs.t1'],
    [
      'tier1_min_score <= tier2_min_score (equal)',
      (w) => (w.feed_cutoffs.tier1_min_score = w.feed_cutoffs.tier2_min_score),
      'feed_cutoffs',
    ],
    [
      'tier1_min_score < tier2_min_score',
      (w) => {
        w.feed_cutoffs.tier1_min_score = 5;
        w.feed_cutoffs.tier2_min_score = 9;
      },
      'feed_cutoffs',
    ],
    [
      'a fractional tier1_min_score',
      (w) => (w.feed_cutoffs.tier1_min_score = 13.5),
      'feed_cutoffs.tier1_min_score',
    ],
    [
      'a negative tier2_min_score',
      (w) => (w.feed_cutoffs.tier2_min_score = -1),
      'feed_cutoffs.tier2_min_score',
    ],
    [
      'a fractional tier2_min_score',
      (w) => (w.feed_cutoffs.tier2_min_score = 9.5),
      'feed_cutoffs.tier2_min_score',
    ],
    // Header fields.
    ['schema_version 2', (w) => (w.schema_version = 2), 'schema_version'],
    [
      'a missing schema_version',
      (w) => delete w.schema_version,
      'schema_version',
    ],
    ['an empty model_version', (w) => (w.model_version = ''), 'model_version'],
    [
      'a trained_through that is not a date',
      (w) => (w.trained_through = '2026-13-01'),
      'trained_through',
    ],
    [
      'a trained_through with a time part',
      (w) => (w.trained_through = '2026-06-16T00:00:00Z'),
      'trained_through',
    ],
    ['a missing features block', (w) => delete w.features, 'features'],
  ])('%s', (_label, mutate, path) => {
    const copy = structuredClone(SEED_LOTTERY_WEIGHTS);
    mutate(copy);
    const result = ok(copy);
    expect(result.success).toBe(false);
    const paths = (result.error?.issues ?? []).map((i) => i.path.join('.'));
    expect(paths).toContain(path);
  });

  it('rejects every non-object input', () => {
    for (const bad of [null, undefined, 1, 'x', [], true]) {
      expect(ok(bad).success).toBe(false);
    }
  });

  it('accepts a Monday-only, a Monday-to-Friday and an empty override table', () => {
    const copy = structuredClone(SEED_LOTTERY_WEIGHTS);
    const monday = copy.features.tod_weights_dow_overrides.Monday!;
    copy.features.tod_weights_dow_overrides = {};
    expect(ok(copy).success).toBe(true);
    for (const day of [
      'Monday',
      'Tuesday',
      'Wednesday',
      'Thursday',
      'Friday',
    ]) {
      (
        copy.features.tod_weights_dow_overrides as Record<string, typeof monday>
      )[day] = monday;
    }
    expect(ok(copy).success).toBe(true);
  });

  it('accepts the boundary values of every range', () => {
    const copy = structuredClone(SEED_LOTTERY_WEIGHTS);
    copy.features.ticker_weights.AAPL = -5;
    copy.features.ticker_weights.AMD = 10;
    copy.features.tod_weights.AM_open = 20;
    copy.features.tod_weights.PM = -20;
    copy.features.composite_bonuses[0]!.bonus = 10;
    copy.features.composite_bonuses[1]!.bonus = -10;
    copy.features.composite_bonuses[0]!.support = 0;
    copy.features.composite_bonuses[0]!.win_rate = 1;
    copy.features.composite_bonuses[1]!.win_rate = 0;
    copy.features.composite_bonuses[2]!.match = { gamma_q: 'null' };
    copy.feed_cutoffs = { tier1_min_score: 1, tier2_min_score: 0 };
    copy.cutoffs = { t1: -3, t2: -4 };
    expect(ok(copy).success).toBe(true);
  });
});
