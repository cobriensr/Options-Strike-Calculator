/**
 * The shape of one lottery score version's weights (phase 4, decision D5).
 *
 * Spec: docs/superpowers/plans/2026-11-05-nightly-pipeline-phase4.md (D5).
 *
 * A version is one JSON object: the per-feature weights that
 * `scoreLotteryV2` sums, the quintile boundaries those features are cut at,
 * the composite bonuses, and the two pairs of tier cutoffs. This schema is the
 * single TypeScript gate for it. The Python training side checks the same
 * rules in `validate_weights`, so a version the nightly refit writes is one
 * the scorer here accepts.
 *
 * Every object is strict: an unknown key anywhere is a rejection, never
 * silently dropped, so a typo in a key can't turn a table off. `z.number()`
 * already rejects NaN and the infinities in Zod 4.
 */

import { z } from 'zod';

// ── Building blocks ────────────────────────────────────────────────────

/** The four time-of-day buckets a fire falls in. */
export const TimeOfDaySchema = z.enum(['AM_open', 'MID', 'LUNCH', 'PM']);
export type TimeOfDay = z.infer<typeof TimeOfDaySchema>;

/** An integer weight in [-20, 20]: the range every table but tickers uses. */
const weight = z.number().int().min(-20).max(20);

/** The ticker symbols the universe can hold: `BRK.B`, `SPXW`, `T`. */
const TICKER_KEY = /^[A-Z][A-Z0-9.]{0,9}$/;

/** A tod table: one weight per bucket, no more, no fewer. */
const todWeights = z.strictObject({
  AM_open: weight,
  MID: weight,
  LUNCH: weight,
  PM: weight,
});

/** Five weights, one per quintile; index = quintile 0-4. */
const quintileWeights = z.array(weight).length(5);

/**
 * Four quintile boundaries, finite and strictly increasing. Right-closed: a
 * value on a boundary falls in the lower quintile (`assignQuintile`).
 */
const quintileBoundaries = z
  .array(z.number())
  .length(4)
  .refine((b) => b.every((v, i) => i === 0 || v > b[i - 1]!), {
    error: 'boundaries must be strictly increasing',
  });

/** A quintile label in a composite match: "0".."4", or "null" (feature missing). */
const quintileLabel = z.enum(['0', '1', '2', '3', '4', 'null']);

const WEEKDAYS = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
] as const;

// ── Composite bonuses ──────────────────────────────────────────────────

/**
 * A composite fires when every key in `match` agrees with the fire; a missing
 * key is a wildcard. At least one key, or the entry would fire on everything.
 */
const compositeMatch = z
  .strictObject({
    ticker: z.string(),
    tod: TimeOfDaySchema,
    gamma_q: quintileLabel,
    vol_oi_q: quintileLabel,
    ask_pct_q: quintileLabel,
  })
  .partial()
  .refine((m) => Object.values(m).some((v) => v !== undefined), {
    error: 'match needs at least one key',
  });

const compositeBonus = z.strictObject({
  match: compositeMatch,
  /** Added to the score when the composite fires; negative = a penalty. */
  bonus: z.number().int().min(-10).max(10),
  /** Training rows the pattern was mined from. */
  support: z.number().int().min(0),
  win_rate: z.number().min(0).max(1),
  note: z.string(),
});

// ── The weights object ─────────────────────────────────────────────────

const features = z.strictObject({
  ticker_weights: z
    .record(z.string().regex(TICKER_KEY), z.number().int().min(-5).max(10))
    .refine((t) => Object.keys(t).length >= 1 && Object.keys(t).length <= 500, {
      error: 'ticker_weights needs 1 to 500 tickers',
    }),
  tod_weights: todWeights,
  /** Per-weekday replacement for `tod_weights`; a weekday with no entry uses it. */
  tod_weights_dow_overrides: z.partialRecord(z.enum(WEEKDAYS), todWeights),
  /** Keys are the string-encoded DTEs 0-3: the whole scoring universe. */
  dte_weights: z.strictObject({
    '0': weight,
    '1': weight,
    '2': weight,
    '3': weight,
  }),
  vol_oi_quintile_weights: quintileWeights,
  vol_oi_quintile_boundaries: quintileBoundaries,
  gamma_quintile_weights: quintileWeights,
  gamma_quintile_boundaries: quintileBoundaries,
  ask_pct_quintile_weights: quintileWeights,
  ask_pct_quintile_boundaries: quintileBoundaries,
  option_type_weights: z.strictObject({ C: weight, P: weight }),
  composite_bonuses: z.array(compositeBonus).max(50),
});

export const LotteryWeightsSchema = z.strictObject({
  schema_version: z.literal(1),
  /** The training method that produced these weights, not the version id. */
  model_version: z.string().min(1),
  /** Last session the training window covered (ISO date). */
  trained_through: z.iso.date(),
  features,
  /**
   * Cutoffs on the bare score `scoreLotteryV2` returns. Only the cluster bonus
   * reads them (a fire at `t1` or above counts as a tier-1 co-fire).
   */
  cutoffs: z
    .strictObject({ t1: z.number().int(), t2: z.number().int() })
    .refine((c) => c.t1 > c.t2, { error: 't1 must exceed t2' }),
  /**
   * Cutoffs on the quality-adjusted score (the bare score plus the cluster
   * bonus); these set the feed's tier 1 and tier 2.
   */
  feed_cutoffs: z
    .strictObject({
      tier1_min_score: z.number().int(),
      tier2_min_score: z.number().int().min(0),
    })
    .refine((c) => c.tier1_min_score > c.tier2_min_score, {
      error: 'tier1_min_score must exceed tier2_min_score',
    }),
});

export type LotteryWeights = z.infer<typeof LotteryWeightsSchema>;
export type FeedTierCutoffs = LotteryWeights['feed_cutoffs'];
export type CompositeBonus =
  LotteryWeights['features']['composite_bonuses'][number];
