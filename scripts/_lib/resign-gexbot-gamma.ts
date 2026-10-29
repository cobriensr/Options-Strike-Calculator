/**
 * The one-time re-sign of periscope_snapshots for owner decision D1:
 * GEXBot-era gamma rows are negated to MM sign, and every row gets its
 * `source` tag. Logic for scripts/resign-gexbot-gamma.mts (run order,
 * usage and the deploy constraint are in that header); it lives here so
 * vitest covers it (scripts/_lib/**).
 *
 * Why: GEXBot's per-strike gamma is taker-signed, the negative of the UW
 * Periscope scraper's MM convention that every reader and rule assumes.
 * populate-periscope-from-gexbot negates it on ingest from P10b on; this
 * fixes the rows it wrote before that.
 *
 * Per ET day, one transaction of three guarded UPDATEs:
 *   1. GEXBot-era gamma:     value = -value, source = 'gexbot'
 *   2. GEXBot-era non-gamma: source = 'gexbot' (charm and vanna keep the
 *      vendor sign)
 *   3. scraper era:          source = 'scraper'
 * Each one requires `source IS NULL`, so the script is run-once and
 * order-safe: a row it already tagged, or a row the new ingest wrote
 * (negated and tagged 'gexbot'), is never flipped again. A retried or
 * re-run day is a no-op; an interrupted run resumes where it stopped.
 * The largest day is ~20.6K rows (R5: one bounded statement per class,
 * no per-row writes).
 *
 * Era split: GEXBOT_CUTOVER, cross-checked on every row by the timeframe
 * fingerprint before anything is written.
 */

import { getDb, withDbRetry } from '../../api/_lib/db.js';
import { PERISCOPE_SOURCE } from '../../api/_lib/periscope-gexbot.js';

/**
 * The instant the GEXBot adapter cron replaced the UW Periscope scraper.
 * Measured on production 2026-10-28: the last scraper row was captured
 * 2026-05-26 17:13:26.475Z and the first GEXBot row 17:29:32.914Z (the
 * cron was committed at 17:13Z that day); no other day mixes the two.
 * Any instant in between splits the eras.
 *
 * Fingerprint cross-check (0 of 2,240,813 rows disagreed): the cron
 * labels each row with the 10-min CT slot its own captured_at falls in
 * (`formatTimeframe`), while the scraper stored UW's label for the slot
 * BEFORE the capture (or none). So `left(timeframe, 5)` equals
 * captured_at floored to 10 min in CT exactly for GEXBot rows.
 */
export const GEXBOT_CUTOVER = '2026-05-26T17:20:00Z';

/** NULL-source rows of one ET day, by what the re-sign will do to them. */
export interface DayPlan {
  day: string;
  gammaToNegate: number;
  gexbotToTag: number;
  scraperToTag: number;
  /** Rows whose cutover era and timeframe fingerprint disagree. */
  fingerprintMismatch: number;
}

export interface DayResult {
  gammaNegated: number;
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
 * One scan of the NULL-source rows, grouped by ET day (a few seconds on
 * the 2.24M-row production table).
 */
export async function planDays(): Promise<DayPlan[]> {
  const sql = getDb();
  const rows = (await withDbRetry(
    () => sql`
      WITH x AS (
        SELECT (captured_at AT TIME ZONE 'America/New_York')::date AS day,
               panel,
               captured_at >= ${GEXBOT_CUTOVER}::timestamptz AS gexbot_era,
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
             count(*) FILTER (WHERE gexbot_era AND panel = 'gamma')::int AS gamma,
             count(*) FILTER (WHERE gexbot_era AND panel <> 'gamma')::int AS gexbot,
             count(*) FILTER (WHERE NOT gexbot_era)::int AS scraper,
             count(*) FILTER (WHERE gexbot_era <> gexbot_fingerprint)::int AS mismatch
      FROM x
      GROUP BY day
      ORDER BY day
    `,
  )) as Array<{
    day: string;
    gamma: number;
    gexbot: number;
    scraper: number;
    mismatch: number;
  }>;
  return rows.map((r) => ({
    day: r.day,
    gammaToNegate: r.gamma,
    gexbotToTag: r.gexbot,
    scraperToTag: r.scraper,
    fingerprintMismatch: r.mismatch,
  }));
}

/**
 * Re-sign and tag one ET day (`YYYY-MM-DD`) in one transaction. The day's
 * bounds are ET midnights; the GEXBot statements start at the later of
 * the day start and the cutover, the scraper one ends at the earlier of
 * the day end and the cutover, so only 2026-05-26 has rows in both.
 */
export async function resignDay(day: string): Promise<DayResult> {
  const sql = getDb();
  const results = (await withDbRetry(() =>
    sql.transaction([
      sql`
        WITH u AS (
          UPDATE periscope_snapshots
          SET value = -value, source = ${PERISCOPE_SOURCE.gexbot}
          WHERE panel = 'gamma'
            AND source IS NULL
            AND captured_at >= GREATEST(
                  (${day}::date::timestamp AT TIME ZONE 'America/New_York'),
                  ${GEXBOT_CUTOVER}::timestamptz)
            AND captured_at < ((${day}::date + 1)::timestamp AT TIME ZONE 'America/New_York')
          RETURNING 1
        )
        SELECT count(*)::int AS n FROM u
      `,
      sql`
        WITH u AS (
          UPDATE periscope_snapshots
          SET source = ${PERISCOPE_SOURCE.gexbot}
          WHERE panel <> 'gamma'
            AND source IS NULL
            AND captured_at >= GREATEST(
                  (${day}::date::timestamp AT TIME ZONE 'America/New_York'),
                  ${GEXBOT_CUTOVER}::timestamptz)
            AND captured_at < ((${day}::date + 1)::timestamp AT TIME ZONE 'America/New_York')
          RETURNING 1
        )
        SELECT count(*)::int AS n FROM u
      `,
      sql`
        WITH u AS (
          UPDATE periscope_snapshots
          SET source = ${PERISCOPE_SOURCE.scraper}
          WHERE source IS NULL
            AND captured_at >= (${day}::date::timestamp AT TIME ZONE 'America/New_York')
            AND captured_at < LEAST(
                  ((${day}::date + 1)::timestamp AT TIME ZONE 'America/New_York'),
                  ${GEXBOT_CUTOVER}::timestamptz)
          RETURNING 1
        )
        SELECT count(*)::int AS n FROM u
      `,
    ]),
  )) as Array<Array<{ n: number }>>;
  const count = (i: number): number => results[i]?.[0]?.n ?? 0;
  return {
    gammaNegated: count(0),
    gexbotTagged: count(1),
    scraperTagged: count(2),
  };
}

function totals(plan: DayPlan[]) {
  let gamma = 0;
  let gexbot = 0;
  let scraper = 0;
  let mismatch = 0;
  for (const d of plan) {
    gamma += d.gammaToNegate;
    gexbot += d.gexbotToTag;
    scraper += d.scraperToTag;
    mismatch += d.fingerprintMismatch;
  }
  return { gamma, gexbot, scraper, mismatch, rows: gamma + gexbot + scraper };
}

/**
 * The whole run. Dry run: prints the per-day counts and writes nothing.
 * Otherwise re-signs day by day, oldest first, printing progress, then
 * re-scans to confirm no NULL-source row is left. Returns the process
 * exit code. A DB error propagates after withDbRetry; the days already
 * done stay committed and a re-run resumes.
 */
export async function runResign(opts: { dryRun: boolean }): Promise<number> {
  console.log(
    `Re-sign GEXBot gamma in periscope_snapshots — ${
      opts.dryRun ? 'DRY RUN (no writes)' : 'APPLY (writes)'
    }`,
  );
  console.log(
    `Cutover ${GEXBOT_CUTOVER}: scraper rows before it, GEXBot rows from it on.`,
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
    `Rows with source IS NULL: ${plan.length} ET days · ${t.gamma} gamma rows to negate · ` +
      `${t.gexbot} GEXBot rows to tag · ${t.scraper} scraper rows to tag (${t.rows} total)`,
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
        `  ${d.day}  negate ${d.gammaToNegate} · gexbot ${d.gexbotToTag} · scraper ${d.scraperToTag}`,
      );
    }
    console.log('Dry run: nothing written.');
    return 0;
  }

  if (plan.length === 0) {
    console.log('Nothing to do: every row already has a source.');
    return 0;
  }

  const done = { gamma: 0, gexbot: 0, scraper: 0 };
  const started = Date.now();
  for (const [i, d] of plan.entries()) {
    const dayStart = Date.now();
    const r = await resignDay(d.day);
    done.gamma += r.gammaNegated;
    done.gexbot += r.gexbotTagged;
    done.scraper += r.scraperTagged;
    console.log(
      `[${i + 1}/${plan.length}] ${d.day}  negated ${r.gammaNegated} · ` +
        `gexbot ${r.gexbotTagged} · scraper ${r.scraperTagged} ` +
        `(${Date.now() - dayStart} ms)`,
    );
  }
  console.log(
    `Done: negated ${done.gamma} gamma rows, tagged ${done.gexbot} GEXBot rows ` +
      `and ${done.scraper} scraper rows in ${((Date.now() - started) / 1000).toFixed(1)} s.`,
  );

  const left = totals(await planDays()).rows;
  if (left > 0) {
    console.error(
      `${left} rows still have no source (written during the run?). Re-run to finish.`,
    );
    return 1;
  }
  console.log('Verified: no row is left with source IS NULL.');
  return 0;
}
