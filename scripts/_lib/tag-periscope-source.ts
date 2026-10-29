/**
 * The one-time `periscope_snapshots.source` backfill (migration #194).
 * Logic for scripts/tag-periscope-source.mts (runbook, usage and the
 * deploy gate are in that header); it lives here so vitest covers it
 * (scripts/_lib/**).
 *
 * Why: the table holds two different measurements under one schema. UW
 * Periscope (the scraper, until 2026-05-26) estimated market-maker
 * positions; GEXBot (since) is a classified taker-flow imbalance in its
 * taker-side sign. Owner decision D1 revised (2026-10-29): keep them
 * apart, tag every row with its source, and convert no values.
 * populate-periscope-from-gexbot tags new rows; this tags the old ones.
 *
 * Per ET day, one transaction of two guarded UPDATEs that change only
 * `source`, never `value`:
 *   1. rows before the cutover: source = 'scraper'
 *   2. rows from the cutover:   source = 'gexbot'
 * Each requires `source IS NULL`, so the script is run-once and
 * order-safe: a row it already tagged, or one the new ingest wrote, is
 * left alone. A retried or re-run day is a no-op; an interrupted run
 * resumes where it stopped. The largest day is ~20.6K rows (R5: one
 * bounded statement per source, no per-row writes).
 *
 * Era split: PERISCOPE_GEXBOT_CUTOVER, cross-checked on every row by the
 * timeframe fingerprint before anything is written.
 */

import { getDb, withDbRetry } from '../../api/_lib/db.js';
import {
  PERISCOPE_GEXBOT_CUTOVER,
  PERISCOPE_SOURCE,
} from '../../src/utils/periscope-source.js';

/**
 * Fingerprint cross-check (0 of 2,240,813 production rows disagreed on
 * 2026-10-28): the GEXBot cron labels each row with the 10-min CT slot
 * its own captured_at falls in (`formatTimeframe`), while the scraper
 * stored UW's label for the slot BEFORE the capture (or none). So
 * `left(timeframe, 5)` equals captured_at floored to 10 min in CT exactly
 * for GEXBot rows.
 */

/** NULL-source rows of one ET day, by the tag they will get. */
export interface DayPlan {
  day: string;
  gexbotToTag: number;
  scraperToTag: number;
  /** Rows whose cutover era and timeframe fingerprint disagree. */
  fingerprintMismatch: number;
}

export interface DayResult {
  gexbotTagged: number;
  scraperTagged: number;
}

async function hasSourceColumn(): Promise<boolean> {
  const sql = getDb();
  const rows = (await withDbRetry(
    () => sql`
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'periscope_snapshots'
        AND column_name = 'source'
    `,
  )) as unknown[];
  return rows.length > 0;
}

/**
 * One scan of the NULL-source rows, grouped by ET day (about 4 s on the
 * 2.24M-row production table).
 */
export async function planDays(): Promise<DayPlan[]> {
  const sql = getDb();
  const rows = (await withDbRetry(
    () => sql`
      WITH x AS (
        SELECT (captured_at AT TIME ZONE 'America/New_York')::date AS day,
               captured_at >= ${PERISCOPE_GEXBOT_CUTOVER}::timestamptz AS gexbot_era,
               COALESCE(
                 left(timeframe, 5) = to_char(
                   date_trunc('hour', captured_at AT TIME ZONE 'America/Chicago')
                   + floor(extract(minute FROM captured_at AT TIME ZONE 'America/Chicago') / 10)
                     * interval '10 minutes',
                   'HH24:MI'),
                 FALSE) AS gexbot_fingerprint
        FROM periscope_snapshots
        WHERE source IS NULL
      )
      SELECT to_char(day, 'YYYY-MM-DD') AS day,
             count(*) FILTER (WHERE gexbot_era)::int AS gexbot,
             count(*) FILTER (WHERE NOT gexbot_era)::int AS scraper,
             count(*) FILTER (WHERE gexbot_era <> gexbot_fingerprint)::int AS mismatch
      FROM x
      GROUP BY day
      ORDER BY day
    `,
  )) as Array<{
    day: string;
    gexbot: number;
    scraper: number;
    mismatch: number;
  }>;
  return rows.map((r) => ({
    day: r.day,
    gexbotToTag: r.gexbot,
    scraperToTag: r.scraper,
    fingerprintMismatch: r.mismatch,
  }));
}

/**
 * Tag one ET day (`YYYY-MM-DD`) in one transaction. The day's bounds are
 * ET midnights; the scraper statement ends at the earlier of the day end
 * and the cutover, the GEXBot one starts at the later of the day start
 * and the cutover, so only 2026-05-26 has rows in both. Values are not
 * touched.
 */
export async function tagDay(day: string): Promise<DayResult> {
  const sql = getDb();
  const results = (await withDbRetry(() =>
    sql.transaction([
      sql`
        WITH u AS (
          UPDATE periscope_snapshots
          SET source = ${PERISCOPE_SOURCE.scraper}
          WHERE source IS NULL
            AND captured_at >= (${day}::date::timestamp AT TIME ZONE 'America/New_York')
            AND captured_at < LEAST(
                  ((${day}::date + 1)::timestamp AT TIME ZONE 'America/New_York'),
                  ${PERISCOPE_GEXBOT_CUTOVER}::timestamptz)
          RETURNING 1
        )
        SELECT count(*)::int AS n FROM u
      `,
      sql`
        WITH u AS (
          UPDATE periscope_snapshots
          SET source = ${PERISCOPE_SOURCE.gexbot}
          WHERE source IS NULL
            AND captured_at >= GREATEST(
                  (${day}::date::timestamp AT TIME ZONE 'America/New_York'),
                  ${PERISCOPE_GEXBOT_CUTOVER}::timestamptz)
            AND captured_at < ((${day}::date + 1)::timestamp AT TIME ZONE 'America/New_York')
          RETURNING 1
        )
        SELECT count(*)::int AS n FROM u
      `,
    ]),
  )) as Array<Array<{ n: number }>>;
  const count = (i: number): number => results[i]?.[0]?.n ?? 0;
  return { scraperTagged: count(0), gexbotTagged: count(1) };
}

function totals(plan: DayPlan[]) {
  let gexbot = 0;
  let scraper = 0;
  let mismatch = 0;
  for (const d of plan) {
    gexbot += d.gexbotToTag;
    scraper += d.scraperToTag;
    mismatch += d.fingerprintMismatch;
  }
  return { gexbot, scraper, mismatch, rows: gexbot + scraper };
}

/**
 * The whole run. Dry run: prints the per-day counts and writes nothing.
 * Otherwise tags day by day, oldest first, printing progress (and a
 * warning when a day's counts differ from its plan, i.e. rows changed
 * after the scan), then re-scans and returns 1 if any NULL-source row is
 * left. Returns the process exit code. A DB error propagates after
 * withDbRetry; the days already done stay committed and a re-run resumes.
 */
export async function runTag(opts: { dryRun: boolean }): Promise<number> {
  console.log(
    `Tag periscope_snapshots.source — ${
      opts.dryRun ? 'DRY RUN (no writes)' : 'APPLY (writes)'
    }. Values are never changed.`,
  );
  console.log(
    `Cutover ${PERISCOPE_GEXBOT_CUTOVER}: 'scraper' before it, 'gexbot' from it on.`,
  );

  if (!(await hasSourceColumn())) {
    console.error(
      'periscope_snapshots has no source column: apply migration #194 first.',
    );
    return 1;
  }

  const plan = await planDays();
  const t = totals(plan);
  console.log(
    `Rows with source IS NULL: ${plan.length} ET days · ${t.gexbot} GEXBot rows to tag · ` +
      `${t.scraper} scraper rows to tag (${t.rows} total)`,
  );

  if (t.mismatch > 0) {
    console.error(
      `\n${t.mismatch} rows disagree with the cutover (era by time ≠ era by ` +
        'timeframe fingerprint). Nothing written. Days:',
    );
    for (const d of plan) {
      if (d.fingerprintMismatch > 0) {
        console.error(`  ${d.day}: ${d.fingerprintMismatch}`);
      }
    }
    return 1;
  }

  if (opts.dryRun) {
    for (const d of plan) {
      console.log(
        `  ${d.day}  gexbot ${d.gexbotToTag} · scraper ${d.scraperToTag}`,
      );
    }
    console.log('Dry run: nothing written.');
    return 0;
  }

  if (plan.length === 0) {
    console.log('Nothing to do: every row already has a source.');
    return 0;
  }

  const done = { gexbot: 0, scraper: 0 };
  const started = Date.now();
  for (const [i, d] of plan.entries()) {
    const dayStart = Date.now();
    const r = await tagDay(d.day);
    done.gexbot += r.gexbotTagged;
    done.scraper += r.scraperTagged;
    console.log(
      `[${i + 1}/${plan.length}] ${d.day}  gexbot ${r.gexbotTagged} · ` +
        `scraper ${r.scraperTagged} (${Date.now() - dayStart} ms)`,
    );
    if (
      r.gexbotTagged !== d.gexbotToTag ||
      r.scraperTagged !== d.scraperToTag
    ) {
      console.warn(
        `  warning: ${d.day} tagged gexbot ${r.gexbotTagged} · scraper ${r.scraperTagged}, ` +
          `planned gexbot ${d.gexbotToTag} · scraper ${d.scraperToTag} ` +
          '(rows changed after the scan; the final re-scan checks the result)',
      );
    }
  }
  console.log(
    `Done: tagged ${done.gexbot} GEXBot rows and ${done.scraper} scraper rows ` +
      `in ${((Date.now() - started) / 1000).toFixed(1)} s.`,
  );

  const left = totals(await planDays()).rows;
  if (left > 0) {
    console.error(
      `${left} rows still have no source (written during the run, or by ` +
        'code that predates the source column). Re-run to finish.',
    );
    return 1;
  }
  console.log('Verified: no row is left with source IS NULL.');
  return 0;
}
