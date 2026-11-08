/**
 * GET /api/cron/fetch-spot-gex
 *
 * Fetches SPX Spot GEX exposures (per 1-minute) from Unusual Whales API.
 * This is the Aggregate GEX panel as a time series — includes:
 *   - OI Net Gamma (Rule 16 regime)
 *   - Volume Net Gamma (intraday trading gamma)
 *   - Directionalized Volume Net Gamma (intent-weighted)
 *   - Plus charm and vanna equivalents
 *   - SPX price at each timestamp
 *
 * Writes all 1-minute ticks newer than the high-water-mark for today in
 * `spot_exposures`. Designed to run every minute during RTH so the UI
 * sees fresh dealer positioning within 60 s. A single missed run
 * auto-backfills on the next
 * invocation because UW returns the full session history and we diff
 * against the HWM before inserting. `ON CONFLICT DO NOTHING` on
 * (date, timestamp, ticker) is the belt-and-braces dedup.
 *
 * R-zero (docs/superpowers/specs/live-data-integrity-2026-11-06.md, F14,
 * P0.4): UW answers the first minutes of the session (09:30 to 09:33 ET)
 * with rows whose every value column is zero, and ON CONFLICT DO NOTHING plus
 * the high-water-mark kept each one for good (129 rows, 02-19 to 07-22, plus
 * 3 pre-market days). A row whose nine value columns are all zero or null is
 * not stored: a warning and the `fetch_spot_gex.zero_row_skip` metric each
 * run, and from 09:40 ET a Sentry error when the NEWEST row of the answer is
 * all-zero (the feed is stuck, not rolling over). A run that stored nothing
 * only because of that is `skipped`, never `success`.
 *
 * A skipped row can leave a gap. The high-water-mark diff only moves
 * forward, so once a later row is stored an earlier skipped minute is never
 * re-read, even if UW later fills its values. A gap is better than a zero
 * row. While the zero rows are the newest ones, nothing newer is stored, the
 * mark stays put and every run looks at them again, so a value UW fills in
 * before a later row lands is picked up.
 *
 * Total API calls per invocation: 1
 *
 * Environment: UW_API_KEY, CRON_SECRET
 */

import { getDb, withDbRetry } from '../_lib/db.js';
import {
  uwFetch,
  cronJitter,
  checkDataQuality,
  withRetry,
} from '../_lib/api-helpers.js';
import {
  withCronInstrumentation,
  type CronResult,
} from '../_lib/cron-instrumentation.js';
import { BULK_UPSERT_DEFAULT_CHUNK_SIZE } from '../_lib/bulk-upsert.js';
import { reportSkippedWrite } from '../_lib/ladder-skip.js';
import { getETDateStr } from '../../src/utils/timezone.js';

// ── Types ───────────────────────────────────────────────────

interface SpotExposureRow {
  time: string;
  start_time?: string;
  price: string;
  gamma_per_one_percent_move_oi: string;
  gamma_per_one_percent_move_vol: string;
  gamma_per_one_percent_move_dir: string;
  charm_per_one_percent_move_oi: string;
  charm_per_one_percent_move_vol: string;
  charm_per_one_percent_move_dir: string;
  vanna_per_one_percent_move_oi: string;
  vanna_per_one_percent_move_vol: string;
  vanna_per_one_percent_move_dir: string;
}

// ── R-zero ──────────────────────────────────────────────────

/** The nine value columns of a row (price is not one of them). */
const VALUE_FIELDS = [
  'gamma_per_one_percent_move_oi',
  'gamma_per_one_percent_move_vol',
  'gamma_per_one_percent_move_dir',
  'charm_per_one_percent_move_oi',
  'charm_per_one_percent_move_vol',
  'charm_per_one_percent_move_dir',
  'vanna_per_one_percent_move_oi',
  'vanna_per_one_percent_move_vol',
  'vanna_per_one_percent_move_dir',
] as const satisfies ReadonlyArray<keyof SpotExposureRow>;

/** True when every value column is zero, null, missing or not a number. */
function isAllZeroRow(row: SpotExposureRow): boolean {
  return VALUE_FIELDS.every((field) => {
    const n = Number.parseFloat(String(row[field]));
    return !Number.isFinite(n) || n === 0;
  });
}

const rowTimeMs = (r: SpotExposureRow) => Date.parse(r.start_time ?? r.time);

// ── Fetch helper ────────────────────────────────────────────

async function fetchSpotExposures(apiKey: string): Promise<SpotExposureRow[]> {
  return uwFetch<SpotExposureRow>(apiKey, '/stock/SPX/spot-exposures');
}

// ── Bulk insert rows newer than the DB high-water-mark ──────
//
// UW returns today's full session history on every call. We query the
// latest timestamp we already have for today, filter UW rows to only the
// ones past that mark, and insert them. On a steady-state run this is
// usually 1 row; after a missed cron it catches up all the gap rows.

async function storeNewRows(
  rows: SpotExposureRow[],
  today: string,
): Promise<{
  /** Rows that actually went in (the rest were conflict no-ops). */
  stored: number;
  /** Rows sent to the database: past the mark and not all-zero. */
  submitted: number;
  timestamp?: string;
  /** New rows left out because every value column was zero or null. */
  zeroSkipped: number;
  /** The oldest and newest of them. */
  zeroFrom?: string;
  zeroTo?: string;
}> {
  if (rows.length === 0) return { stored: 0, submitted: 0, zeroSkipped: 0 };

  const sql = getDb();
  const hwmRows = (await withDbRetry(
    () => sql`
      SELECT MAX(timestamp) AS max_ts
      FROM spot_exposures
      WHERE date = ${today} AND ticker = 'SPX'
    `,
    2,
    10_000,
  )) as Array<{ max_ts: string | Date | null }>;
  const rawMax = hwmRows[0]?.max_ts ?? null;
  const hwmIso =
    rawMax === null
      ? null
      : rawMax instanceof Date
        ? rawMax.toISOString()
        : new Date(rawMax).toISOString();

  const newer = rows
    .map((r) => ({
      row: r,
      tsIso: new Date(r.start_time ?? r.time).toISOString(),
    }))
    .filter(({ tsIso }) => hwmIso === null || tsIso > hwmIso)
    .sort((a, b) => a.tsIso.localeCompare(b.tsIso));

  // R-zero (F14): an all-zero row is not data.
  const toInsert = newer.filter(({ row }) => !isAllZeroRow(row));
  const zeroRows = newer.filter(({ row }) => isAllZeroRow(row));
  const zero = {
    zeroSkipped: zeroRows.length,
    ...(zeroRows.length > 0
      ? { zeroFrom: zeroRows[0]!.tsIso, zeroTo: zeroRows.at(-1)!.tsIso }
      : {}),
  };

  if (toInsert.length === 0) return { stored: 0, submitted: 0, ...zero };

  // R5: one unnest statement per chunk of up to 500 rows, not a statement
  // per row. Before the rollover the mark is null and UW still serves the
  // whole previous session (about 494 rows), each a conflict no-op; that was
  // 494 awaited round trips. The rows are ascending by time, so a chunk that
  // fails leaves the earlier ones stored and the next run's mark picks up the
  // rest. `stored` counts the rows that actually went in (RETURNING), not the
  // rows submitted.
  let stored = 0;
  for (let i = 0; i < toInsert.length; i += BULK_UPSERT_DEFAULT_CHUNK_SIZE) {
    const chunk = toInsert.slice(i, i + BULK_UPSERT_DEFAULT_CHUNK_SIZE);
    const column = (pick: (r: SpotExposureRow) => string | null | undefined) =>
      chunk.map(({ row }) => pick(row) ?? null);
    const inserted = (await withDbRetry(
      () => sql`
        INSERT INTO spot_exposures (
          date, timestamp, ticker, price,
          gamma_oi, gamma_vol, gamma_dir,
          charm_oi, charm_vol, charm_dir,
          vanna_oi, vanna_vol, vanna_dir
        )
        SELECT t.row_date, t.ts, 'SPX', t.price,
               t.gamma_oi, t.gamma_vol, t.gamma_dir,
               t.charm_oi, t.charm_vol, t.charm_dir,
               t.vanna_oi, t.vanna_vol, t.vanna_dir
        FROM unnest(
          ${chunk.map(({ row }) => getETDateStr(new Date(row.start_time ?? row.time)))}::date[],
          ${chunk.map(({ tsIso }) => tsIso)}::timestamptz[],
          ${column((r) => r.price)}::numeric[],
          ${column((r) => r.gamma_per_one_percent_move_oi)}::numeric[],
          ${column((r) => r.gamma_per_one_percent_move_vol)}::numeric[],
          ${column((r) => r.gamma_per_one_percent_move_dir)}::numeric[],
          ${column((r) => r.charm_per_one_percent_move_oi)}::numeric[],
          ${column((r) => r.charm_per_one_percent_move_vol)}::numeric[],
          ${column((r) => r.charm_per_one_percent_move_dir)}::numeric[],
          ${column((r) => r.vanna_per_one_percent_move_oi)}::numeric[],
          ${column((r) => r.vanna_per_one_percent_move_vol)}::numeric[],
          ${column((r) => r.vanna_per_one_percent_move_dir)}::numeric[]
        ) AS t(
          row_date, ts, price,
          gamma_oi, gamma_vol, gamma_dir,
          charm_oi, charm_vol, charm_dir,
          vanna_oi, vanna_vol, vanna_dir
        )
        ON CONFLICT (date, timestamp, ticker) DO NOTHING
        RETURNING id
      `,
      2,
      10_000,
    )) as Array<{ id: number }>;
    stored += inserted.length;
  }

  return {
    stored,
    submitted: toInsert.length,
    timestamp: toInsert.at(-1)!.tsIso,
    ...zero,
  };
}

// ── Handler ─────────────────────────────────────────────────

export default withCronInstrumentation(
  'fetch-spot-gex',
  async (ctx): Promise<CronResult> => {
    const { apiKey, today } = ctx;
    await cronJitter();

    const rows = await withRetry(() => fetchSpotExposures(apiKey));

    // An empty answer is not a clean run: UW serves the whole session so far
    // on every call, so no rows at all means it has nothing (R4). Warn and
    // count it always; from 09:40 ET it is a Sentry error (before that it is
    // the pre-open or the rollover). Never a success.
    if (rows.length === 0) {
      reportSkippedWrite({
        job: 'fetch-spot-gex',
        metric: 'fetch_spot_gex.empty_payload',
        warning: 'fetch-spot-gex: UW returned no spot-exposure rows',
        detail: { date: today },
        alert: 'fetch-spot-gex: UW returned no SPX spot-exposure rows',
      });
      return {
        status: 'skipped',
        message: 'UW returned no spot-exposure rows',
        metadata: { ticks: 0, stored: 0, submitted: 0, zeroSkipped: 0 },
      };
    }

    const result = await withRetry(() => storeNewRows(rows, today));

    // R-zero: say so every run the zero rows are still beyond the mark. The
    // Sentry error (from 09:40 ET) only when the NEWEST row is all-zero: a
    // zero row followed by real ones was the rollover and has passed.
    const newest = rows.reduce<SpotExposureRow | undefined>(
      (best, r) =>
        best === undefined || rowTimeMs(r) > rowTimeMs(best) ? r : best,
      undefined,
    );
    const newestIsZero = newest !== undefined && isAllZeroRow(newest);
    if (result.zeroSkipped > 0) {
      reportSkippedWrite({
        job: 'fetch-spot-gex',
        metric: 'fetch_spot_gex.zero_row_skip',
        warning:
          'fetch-spot-gex: all-zero spot exposure row(s), skipping store',
        detail: {
          zeroSkipped: result.zeroSkipped,
          zeroFrom: result.zeroFrom,
          zeroTo: result.zeroTo,
          newestIsZero,
          newestTime: newest?.start_time ?? newest?.time,
          date: today,
        },
        // A constant text, the row's time is in `detail`: a stuck feed is one
        // Sentry issue, not a new one every minute.
        ...(newestIsZero
          ? {
              alert:
                'fetch-spot-gex: the newest UW SPX spot-exposure row is all-zero, nothing stored',
            }
          : {}),
      });
    }

    // Data quality check: alert if all gamma_oi values are null/zero
    const qcSql = getDb();
    const qcRows = await withDbRetry(
      () => qcSql`
        SELECT COUNT(*) AS total,
               COUNT(*) FILTER (WHERE gamma_oi::numeric != 0) AS nonzero
        FROM spot_exposures
        WHERE date = ${today} AND ticker = 'SPX'
      `,
      2,
      10_000,
    );
    const { total, nonzero } = qcRows[0]!;
    await checkDataQuality({
      job: 'fetch-spot-gex',
      table: 'spot_exposures',
      date: today,
      total: Number(total),
      nonzero: Number(nonzero),
    });

    ctx.logger.info(
      { ticks: rows.length, ...result },
      'fetch-spot-gex completed',
    );

    // Nothing sent only because the new rows were all-zero: skipped, never a
    // success. `submitted`, not `stored`: before the rollover UW replays
    // yesterday's session, whose real rows all conflict (stored 0) next to an
    // all-zero opening minute, and that run is a success.
    const onlyZeroRows = result.submitted === 0 && result.zeroSkipped > 0;

    return {
      status: onlyZeroRows ? 'skipped' : 'success',
      ...(onlyZeroRows ? { message: 'new rows are all-zero, not stored' } : {}),
      metadata: {
        ticks: rows.length,
        ...result,
      },
    };
  },
);
