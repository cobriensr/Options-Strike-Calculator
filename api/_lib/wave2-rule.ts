/**
 * The wave-2 verdict rule, in one place.
 *
 * Two callers decide a wave-2 label and must never disagree:
 *   - api/cron/wave2-confirmation.ts, every 5 min, for fires 75 to 90 min old;
 *   - scripts/_lib/wave2-backfill.ts, a one-shot over old NULL rows.
 *
 * What is shared here:
 *   - the window constants and the two table descriptors;
 *   - `wave2Verdict`, the pure decision: given the wave-1 trigger time, the
 *     earliest follow-up time (or none) and "now", it returns the status and
 *     the `wave2_detected_at` value, or null while the fire has not settled.
 *     The cron calls it per candidate. The backfill calls the same function
 *     on rows it reads in bulk, so the 30-minute bound, the inclusive
 *     60-minute bound, the settle age and the millisecond truncation of
 *     `wave2_detected_at` exist exactly once.
 *
 * What is NOT shared: the follow-up lookup. The cron runs it as one indexed
 * SELECT per candidate; the backfill runs it as a LATERAL join over a page
 * of candidates. Both apply the same predicate (same underlying_symbol and
 * option_type, a different id, strictly after the trigger and no later than
 * LAGGING_WINDOW_MIN minutes after it, earliest first). The row-by-row
 * parity test, scripts/_lib/wave2-backfill.test.ts, runs the cron's own
 * handler and the backfill over the same rows on real Postgres, so a change
 * to either lookup that the other lacks fails it.
 */

/** Wave-2 windows, in minutes from the wave-1 trigger time. */
export const CONFIRMED_WINDOW_MIN = 30;
export const LAGGING_WINDOW_MIN = 60;

/**
 * How long after its own trigger time a fire can still be written to the
 * database. The detectors insert a fire 40 s to 9 min after the trigger time
 * it carries: median 40-105 s, p95 about 5-7 min, max about 9 min (production,
 * the week to 2026-11-03). 9 min is the observed worst case for lottery. For
 * silent boom, `bucket_ct` is the start of the 5-minute bucket, so the bucket
 * itself counts toward the lag, and detect-silent-boom (every 5 minutes,
 * SCAN_WINDOW_MIN = 35) could lag 15-20 min if a detector tick fails. A
 * follow-up that triggered inside a wave-1 fire's 60-minute window can
 * therefore be missing from the table for minutes after that window closes.
 * 15 min covers the observed steady state for both tables and about one
 * failed silent-boom detector tick.
 */
export const INSERT_MARGIN_MIN = 15;

/**
 * A fire is labelled only once it is this old (75 min): the lagging window
 * plus the insert margin. By then every follow-up that can count has been
 * written, so the label is the one a complete table gives, which is also what
 * the backfill (which only reads old rows) produces. Labelling earlier saw an
 * incomplete table: it fizzled a fire whose follow-up was not written yet
 * (184 lottery rows since May) and recorded a later follow-up as the first
 * when an earlier one arrived late (about 5.6% of rows had a wrong
 * `wave2_detected_at`).
 */
export const SETTLE_AGE_MIN = LAGGING_WINDOW_MIN + INSERT_MARGIN_MIN;

export type Wave2Status = 'confirmed' | 'lagging' | 'fizzled';

export interface Wave2Table {
  /** Display name for logs/metadata. */
  readonly name: 'lottery' | 'silentboom';
  /** Fully qualified SQL identifier for the table. */
  readonly table: 'lottery_finder_fires' | 'silent_boom_alerts';
  /** Name of the trigger-time column on this table. */
  readonly triggerCol: 'trigger_time_ct' | 'bucket_ct';
}

export const LOTTERY_TABLE: Wave2Table = {
  name: 'lottery',
  table: 'lottery_finder_fires',
  triggerCol: 'trigger_time_ct',
};

export const SILENT_BOOM_TABLE: Wave2Table = {
  name: 'silentboom',
  table: 'silent_boom_alerts',
  triggerCol: 'bucket_ct',
};

/** Both tables, in the order the cron processes them. */
export const WAVE2_TABLES: readonly Wave2Table[] = [
  LOTTERY_TABLE,
  SILENT_BOOM_TABLE,
];

/**
 * `detectedAtIso` is what to write to `wave2_detected_at`: the follow-up's
 * time as an ISO string (millisecond precision) for 'confirmed' and
 * 'lagging'; null for 'fizzled', whose UPDATE leaves that column alone.
 */
export type Wave2Verdict =
  | { status: 'confirmed' | 'lagging'; detectedAtIso: string }
  | { status: 'fizzled'; detectedAtIso: null };

/**
 * Decide one fire's label.
 *
 * - Younger than SETTLE_AGE_MIN (inclusive at the bound): null, whatever the
 *   table holds. A follow-up already present may not be the earliest one,
 *   and the absence of one may only mean it is not written yet; a later run
 *   decides.
 * - Settled, a follow-up exists (the lookup already limited it to the 60
 *   minutes after the trigger): 'confirmed' when it landed within
 *   CONFIRMED_WINDOW_MIN (inclusive), else 'lagging'.
 * - Settled, no follow-up: 'fizzled'. A settled fire is past the lagging
 *   window and the insert margin, so a missing follow-up is not coming.
 *
 * Inputs are epoch milliseconds, as `new Date(value).getTime()` gives them
 * for the timestamptz values the driver returns.
 */
export function wave2Verdict(
  triggerMs: number,
  followupMs: number | null,
  nowMs: number,
): Wave2Verdict | null {
  const ageMin = (nowMs - triggerMs) / 60_000;
  if (ageMin < SETTLE_AGE_MIN) return null;
  if (followupMs === null) return { status: 'fizzled', detectedAtIso: null };
  const deltaMin = (followupMs - triggerMs) / 60_000;
  return {
    status: deltaMin <= CONFIRMED_WINDOW_MIN ? 'confirmed' : 'lagging',
    detectedAtIso: new Date(followupMs).toISOString(),
  };
}
