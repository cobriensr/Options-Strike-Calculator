// scripts/backfill-takeit-scores.mjs
//
// Strict-clean lottery TAKE-IT backfill. Replaces the prior backfill which
// passed raw `SELECT *` rows to scoreLottery and (a) crashed on the date
// column shape and (b) silently zeroed out sequential features because
// the stubs returned empty arrays. Both have been fixed:
//
//   1. Rows go through `dbRowToLotteryAlertRow` (api/_lib/takeit-backfill-
//      mapper.ts) which produces the exact LotteryAlertRow shape the live
//      cron builds before calling scoreLottery — including coercing NUMERIC
//      strings to numbers and translating trigger_time_ct → fire_time.
//
//   2. Sequential context (recentSameTypeFires, recentOtherTypeByChain,
//      recentOtherTypeByTickerDir, priorSessionWinRateByTicker) is RECON-
//      STRUCTED PIT-correctly by querying lottery_finder_fires + silent_
//      boom_alerts history once up front, then filtering in-memory per row
//      relative to that row's trigger_time_ct. Same window constants as
//      the live cron (35 min same-type, 10 min cofire).
//
//   3. Only "strict-clean" rows are scored — see STRICT_CLEAN_WHERE. We
//      will NOT reconstruct missing macro fields. Anything that requires
//      reconstruction is left as takeit_prob = NULL; the cron will score
//      future rows live.
//
// Silent-boom is intentionally NOT supported here — the row shapes diverge
// and silent-boom needs its own mapper. Pass FEED=silent_boom or FEED=both
// and the script hard-errors.
//
// Pre-flight: source .env.local for DATABASE_URL + BLOB_READ_WRITE_TOKEN.
//
// Invocation: npx tsx scripts/backfill-takeit-scores.mjs
//   (tsx required — imports api/_lib/*.ts TypeScript source directly.)

import { neon } from '@neondatabase/serverless';
import { config as dotenvConfig } from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';

import {
  STRICT_CLEAN_WHERE,
  dbRowToLotteryAlertRow,
  isoDateKey,
  selectPriorWinRateForDate,
} from '../api/_lib/takeit-backfill-mapper.ts';
import {
  loadTakeitDetectContext,
  scoreLottery,
} from '../api/_lib/takeit-detect.ts';
import { tickerDirKey } from '../api/_lib/takeit-features.ts';

dotenvConfig({ path: '.env.local' });

// Fail fast on missing env vars — both are required downstream and the
// neon driver / bundle loader otherwise throws a less obvious error.
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL not set — source .env.local first.');
  process.exit(1);
}
if (!process.env.BLOB_READ_WRITE_TOKEN) {
  console.error(
    'BLOB_READ_WRITE_TOKEN not set — required for loadTakeitDetectContext bundle fetch.',
  );
  process.exit(1);
}

const FEED = process.env.FEED ?? 'lottery';
const SINCE = process.env.SINCE ?? null; // YYYY-MM-DD
const LIMIT = process.env.LIMIT ? Number.parseInt(process.env.LIMIT, 10) : null;

// FEED guard — strict-clean backfill is lottery-only.
if (FEED === 'silent_boom' || FEED === 'silentboom' || FEED === 'both') {
  console.error(
    `Invalid FEED: "${FEED}". Silent boom backfill is not supported by the strict-clean backfill — the row shapes diverge and would require a separate mapper. Re-run with FEED=lottery (or omit FEED entirely).`,
  );
  process.exit(1);
}
if (FEED !== 'lottery') {
  console.error(
    `Invalid FEED: "${FEED}". Expected 'lottery' (the only supported feed).`,
  );
  process.exit(1);
}

if (SINCE && !/^\d{4}-\d{2}-\d{2}$/.test(SINCE)) {
  console.error(`Invalid SINCE format: "${SINCE}". Expected YYYY-MM-DD.`);
  process.exit(1);
}

if (LIMIT !== null && (Number.isNaN(LIMIT) || LIMIT <= 0)) {
  console.error(
    `Invalid LIMIT: "${process.env.LIMIT}". Expected a positive integer.`,
  );
  process.exit(1);
}

// 2000 rows keeps the in-memory updates[] array and the per-batch transaction
// payload small. Each update is a tagged-template object holding {id, prob,
// version, features}; at 10k+ the per-tx payload becomes measurable. Leave at
// 2000 unless profiled.
const BATCH_SIZE = 2000;

// Same lookback constants as api/_lib/takeit-detect.ts. Wider than the
// in-feature window so a fire at minute 29 in a 30-min sliding window still
// sees prior fires from minute 0.
const SEQ_LOOKBACK_MIN = 35;
const COFIRE_LOOKBACK_MIN = 10;
const SEQ_LOOKBACK_MS = SEQ_LOOKBACK_MIN * 60_000;
const COFIRE_LOOKBACK_MS = COFIRE_LOOKBACK_MIN * 60_000;

// Tag persisted to takeit_model_version so ML can split live-scored from
// backfilled rows. Suffix is the policy version, not the bundle version.
const BACKFILL_TAG_SUFFIX = '+backfill-strict-v1';

const sql = neon(process.env.DATABASE_URL);
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const logPath = path.resolve('scripts/output', `backfill-takeit-${runId}.log`);
fs.mkdirSync(path.dirname(logPath), { recursive: true });
const log = (msg) => {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  fs.appendFileSync(logPath, line + '\n');
};

/**
 * Pre-load the full sequential-history window once. The window spans
 * (earliestCandidate - SEQ_LOOKBACK) to (latestCandidate + 1 min) so every
 * per-row filter is purely an in-memory slice.
 *
 * Returns:
 *   - sameTypeFires: lottery fires (for burst-storm + same-direction features)
 *   - otherTypeFires: silent-boom alerts (for cofire features)
 *   - perDateWinRateMap: Map<isoDate, Map<ticker, winRate>> — ONE map per
 *     distinct candidate session date, each one computed with strictly-
 *     earlier-dates semantics (live-cron parity). PIT-correct lookup is
 *     `selectPriorWinRateForDate(perDateWinRateMap, row.date)`.
 */
async function preloadHistory(windowStart, windowEnd, candidateDates) {
  log(
    `preload window: ${windowStart.toISOString()} → ${windowEnd.toISOString()}`,
  );

  const [sameTypeRows, otherTypeRows] = await Promise.all([
    sql`
      SELECT trigger_time_ct, underlying_symbol, option_type
      FROM lottery_finder_fires
      WHERE trigger_time_ct >= ${windowStart}
        AND trigger_time_ct <= ${windowEnd}
      ORDER BY trigger_time_ct
    `,
    sql`
      SELECT option_chain_id, underlying_symbol, option_type, bucket_ct
      FROM silent_boom_alerts
      WHERE bucket_ct >= ${windowStart}
        AND bucket_ct <= ${windowEnd}
      ORDER BY bucket_ct
    `,
  ]);

  // Materialize {fire_time, underlying_symbol, option_type} — same shape
  // the live cron returns from its fetchRecentSameType helper.
  const sameTypeFires = sameTypeRows.map((r) => ({
    fire_time: r.trigger_time_ct,
    underlying_symbol: r.underlying_symbol,
    option_type: r.option_type,
    fire_time_ms: r.trigger_time_ct.getTime(),
  }));

  const otherTypeFires = otherTypeRows.map((r) => ({
    fire_time: r.bucket_ct,
    underlying_symbol: r.underlying_symbol,
    option_type: r.option_type,
    option_chain_id: r.option_chain_id,
    fire_time_ms: r.bucket_ct.getTime(),
  }));

  const perDateWinRateMap = await loadPerDateWinRates(candidateDates);

  log(
    `preload: ${sameTypeFires.length} lottery fires, ${otherTypeFires.length} silent-boom alerts, ${perDateWinRateMap.size} per-date win-rate maps`,
  );

  return { sameTypeFires, otherTypeFires, perDateWinRateMap };
}

/**
 * Run one prior-session win-rate aggregate per distinct candidate date.
 * Mirrors the live cron's query (api/cron/detect-lottery-fires.ts:425-441)
 * exactly: per-ticker expanding mean over fires with peak_ceiling_pct IS
 * NOT NULL and date strictly EARLIER than the candidate row's session
 * date. Returns Map<isoDate, Map<ticker, winRate>>.
 *
 * Cost: ~22 aggregates for a 22-day backfill window. Each is a small
 * grouped-AVG against an indexed table. Run sequentially to keep Neon
 * connection pressure low (Promise.all on 22 simultaneously is fine in
 * theory but offers no wall-clock benefit here — the bottleneck is
 * Postgres planner time, not network parallelism).
 */
async function loadPerDateWinRates(candidateDates) {
  const out = new Map();
  for (const isoDate of candidateDates) {
    const rows = await sql`
      SELECT underlying_symbol, AVG(daily_rate)::float AS win_rate
      FROM (
        SELECT underlying_symbol, date,
               AVG((peak_ceiling_pct >= 20)::int::float) AS daily_rate
        FROM lottery_finder_fires
        WHERE peak_ceiling_pct IS NOT NULL
          AND date < ${isoDate}::date
        GROUP BY underlying_symbol, date
      ) per_day
      GROUP BY underlying_symbol
    `;
    const tickerMap = new Map();
    for (const r of rows) {
      tickerMap.set(r.underlying_symbol, r.win_rate);
    }
    out.set(isoDate, tickerMap);
    log(
      `per-date win rates: ${isoDate} → ${tickerMap.size} tickers (strictly-earlier sessions only)`,
    );
  }
  return out;
}

/**
 * Build a per-row TakeitDetectContext by slicing the pre-loaded arrays to
 * this row's time window. Mirrors what `loadTakeitDetectContext` does once
 * per cron tick, but per-row + against in-memory data, so no DB hits.
 *
 * PIT-correctness: priorSessionWinRateByTicker is selected from the
 * per-date map keyed by the ROW's session date (NOT a global map). This
 * matches the live cron's `date < ${ctx.today}::date` semantics.
 */
function buildRowContext(bundle, history, fireTimeMs, rowDate) {
  const sameTypeCutoff = fireTimeMs - SEQ_LOOKBACK_MS;
  const otherTypeCutoff = fireTimeMs - COFIRE_LOOKBACK_MS;

  // recentSameTypeFires — fires strictly within [t - 35min, t)
  const recentSameTypeFires = [];
  for (const f of history.sameTypeFires) {
    if (f.fire_time_ms >= sameTypeCutoff && f.fire_time_ms < fireTimeMs) {
      recentSameTypeFires.push({
        fire_time: f.fire_time,
        underlying_symbol: f.underlying_symbol,
        option_type: f.option_type,
      });
    }
  }

  // recentOtherType — silent_boom alerts in [t - 10min, t). Indexed BOTH by
  // option_chain_id and by (ticker|direction), same as the live cron.
  const recentOtherTypeByChain = new Map();
  const recentOtherTypeByTickerDir = new Map();
  for (const f of history.otherTypeFires) {
    if (f.fire_time_ms < otherTypeCutoff || f.fire_time_ms >= fireTimeMs) {
      continue;
    }
    const chainList = recentOtherTypeByChain.get(f.option_chain_id);
    const chainEntry = { fire_time: f.fire_time };
    if (chainList) chainList.push(chainEntry);
    else recentOtherTypeByChain.set(f.option_chain_id, [chainEntry]);

    const dirKey = tickerDirKey(f.underlying_symbol, f.option_type);
    const dirEntry = {
      fire_time: f.fire_time,
      option_chain_id: f.option_chain_id,
    };
    const dirList = recentOtherTypeByTickerDir.get(dirKey);
    if (dirList) dirList.push(dirEntry);
    else recentOtherTypeByTickerDir.set(dirKey, [dirEntry]);
  }

  const priorSessionWinRateByTicker = selectPriorWinRateForDate(
    history.perDateWinRateMap,
    rowDate,
  );

  return {
    bundle,
    ctx: {
      recentSameTypeFires,
      recentOtherTypeByChain,
      recentOtherTypeByTickerDir,
      priorSessionWinRateByTicker,
    },
  };
}

/**
 * Load the TAKE-IT bundle. We discard the helper's ctx (empty-stubs only)
 * and build per-row contexts ourselves later.
 */
async function loadBundleOrAbort() {
  const bundleCtx = await loadTakeitDetectContext('lottery', {
    fetchRecentSameType: async () => [],
    fetchRecentOtherTypeByChain: async () => [],
    fetchPriorSessionWinRateByTicker: async () => [],
  });
  if (!bundleCtx) {
    log('lottery: bundle unreachable, aborting');
    process.exit(1);
  }
  const { bundle } = bundleCtx;
  const taggedVersion = `${bundle.version}${BACKFILL_TAG_SUFFIX}`;
  log(
    `lottery: bundle version=${bundle.version} schema=${bundle.xgb_json_schema}`,
  );
  log(`lottery: tagged version=${taggedVersion}`);
  return { bundle, taggedVersion };
}

/** Build the SQL WHERE clause (strict-clean + optional SINCE). */
function buildWhereClause() {
  const where = [...STRICT_CLEAN_WHERE];
  if (SINCE) where.push(`date >= '${SINCE}'::date`);
  return where.join(' AND ');
}

/**
 * Count candidates + return time envelope so we can preload sequential
 * history with the widest possible window. Also returns the sorted set of
 * distinct candidate session dates (ISO `YYYY-MM-DD`) so the win-rate
 * pre-loader can run one PIT aggregate per date.
 */
async function loadEnvelope(whereClause) {
  const envelope = await sql.query(
    `SELECT COUNT(*) AS n,
            MIN(trigger_time_ct) AS min_t,
            MAX(trigger_time_ct) AS max_t
       FROM lottery_finder_fires
      WHERE ${whereClause}`,
  );
  const { n, min_t, max_t } = envelope[0];

  // Distinct dates — neon returns DATE as Date objects (memory:
  // feedback_neon_date_columns.md), so we coerce via isoDateKey.
  const dateRows = await sql.query(
    `SELECT DISTINCT date FROM lottery_finder_fires WHERE ${whereClause} ORDER BY date`,
  );
  const candidateDates = dateRows.map((r) => isoDateKey(r.date));

  return {
    candidateCount: Number(n),
    minT: min_t,
    maxT: max_t,
    candidateDates,
  };
}

/**
 * Score one row up front and refuse to proceed if prob is null — that
 * means the inputs are still wrong and a mass run would write garbage.
 * Also logs the PIT win-rate map size for the probe row so we can
 * sanity-check that early-date rows see a SMALLER map than late-date rows
 * (the buggy global map made them all the same size).
 */
async function runPreflight(whereClause, bundle, history) {
  const probeBatch = await sql.query(
    `SELECT * FROM lottery_finder_fires WHERE ${whereClause} ORDER BY id LIMIT 1`,
  );
  if (probeBatch.length === 0) {
    log('lottery: probe found no rows (race?), aborting');
    process.exit(1);
  }
  const probeRow = probeBatch[0];
  const probeAlert = dbRowToLotteryAlertRow(probeRow);
  const probeDateKey = isoDateKey(probeAlert.date);
  const probeWinRateMap = selectPriorWinRateForDate(
    history.perDateWinRateMap,
    probeAlert.date,
  );
  log(
    `lottery: pre-flight probe id=${probeRow.id} date=${probeDateKey} prior-win-rate map size=${probeWinRateMap.size} (PIT: strictly-earlier sessions only)`,
  );
  const probeDetectCtx = buildRowContext(
    bundle,
    history,
    probeAlert.fire_time.getTime(),
    probeAlert.date,
  );
  const probeResult = scoreLottery(probeDetectCtx, probeAlert);
  log(
    `lottery: pre-flight probe id=${probeRow.id} prob=${probeResult.prob} version=${probeResult.version}`,
  );
  if (probeResult.prob === null) {
    log(
      'lottery: pre-flight probe returned null prob — refusing to proceed. Inspect the row + scoreLottery before continuing.',
    );
    process.exit(1);
  }
}

/**
 * Score one row and append its update tuple to `updates`. Returns
 * 'scored' | 'null' | 'skipped' for counter bookkeeping. Mapper errors
 * are logged + skipped — we never write a wrong score.
 */
function scoreOneRow(row, bundle, history, updates) {
  let alert;
  try {
    alert = dbRowToLotteryAlertRow(row);
  } catch (err) {
    log(
      `lottery: row id=${row.id} mapper threw, skipping: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 'skipped';
  }
  const rowCtx = buildRowContext(
    bundle,
    history,
    alert.fire_time.getTime(),
    alert.date,
  );
  const { prob } = scoreLottery(rowCtx, alert);
  updates.push({ id: row.id, prob });
  return prob == null ? 'null' : 'scored';
}

/**
 * Persist a batch of UPDATE statements atomically. If the transaction
 * throws, none of the rows update — and the next run picks them back up
 * via `takeit_prob IS NULL`.
 */
async function persistUpdates(updates, taggedVersion) {
  if (updates.length === 0) return;
  await sql.transaction(
    updates.map(
      (u) => sql`
        UPDATE lottery_finder_fires
           SET takeit_prob = ${u.prob},
               takeit_model_version = ${taggedVersion}
         WHERE id = ${u.id}
      `,
    ),
  );
}

/**
 * Process one SELECT batch: score every row, persist the updates, return
 * the per-batch counters + the new lastId checkpoint.
 */
async function processBatch(batch, bundle, history, taggedVersion) {
  const updates = [];
  let scored = 0;
  let nulls = 0;
  for (const row of batch) {
    const result = scoreOneRow(row, bundle, history, updates);
    if (result === 'scored') scored += 1;
    else if (result === 'null') nulls += 1;
  }
  await persistUpdates(updates, taggedVersion);
  const lastRow = batch.at(-1);
  return { scored, nulls, lastId: lastRow.id };
}

async function main() {
  const { bundle, taggedVersion } = await loadBundleOrAbort();
  const whereClause = buildWhereClause();
  const { candidateCount, minT, maxT, candidateDates } =
    await loadEnvelope(whereClause);
  if (candidateCount === 0) {
    log('lottery: no candidate rows under strict-clean WHERE, done.');
    return;
  }
  log(
    `lottery: ${candidateCount} candidate rows across ${candidateDates.length} sessions, from ${minT.toISOString()} to ${maxT.toISOString()}`,
  );

  const windowStart = new Date(minT.getTime() - SEQ_LOOKBACK_MS);
  const windowEnd = new Date(maxT.getTime() + 60_000);
  const history = await preloadHistory(windowStart, windowEnd, candidateDates);

  await runPreflight(whereClause, bundle, history);

  // Mass loop.
  let totalScored = 0;
  let totalNull = 0;
  let lastId = 0;

  while (true) {
    // Clamp the per-batch SELECT to the remaining LIMIT so `LIMIT=1` writes
    // exactly 1 row instead of rolling the full 2000-row batch. With LIMIT
    // unset, fall back to BATCH_SIZE.
    const remaining = LIMIT ? LIMIT - (totalScored + totalNull) : BATCH_SIZE;
    const batchSize = Math.min(BATCH_SIZE, remaining);
    if (batchSize <= 0) {
      log(`lottery: hit LIMIT=${LIMIT}, stopping`);
      break;
    }
    const batch = await sql.query(
      `SELECT * FROM lottery_finder_fires
        WHERE ${whereClause} AND id > ${lastId}
        ORDER BY id
        LIMIT ${batchSize}`,
    );
    if (!batch.length) {
      log('lottery: no more rows, done');
      break;
    }
    log(`lottery: batch of ${batch.length} rows starting at id=${batch[0].id}`);

    const {
      scored,
      nulls,
      lastId: newLastId,
    } = await processBatch(batch, bundle, history, taggedVersion);
    totalScored += scored;
    totalNull += nulls;
    lastId = newLastId;
    log(
      `lottery: progress scored=${totalScored} null=${totalNull} lastId=${lastId}`,
    );
    // No post-batch LIMIT check — the pre-batch clamp above
    // (`batchSize <= 0`) handles the stop condition cleanly.
  }
  log(`lottery: COMPLETE scored=${totalScored} null=${totalNull}`);
  log(`backfill done. log: ${logPath}`);
}

try {
  await main();
} catch (err) {
  log(
    `Backfill failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
  );
  process.exit(1);
}
