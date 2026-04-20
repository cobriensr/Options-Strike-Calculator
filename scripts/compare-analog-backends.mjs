#!/usr/bin/env node

/**
 * Backend-comparison report for day-analog retrieval.
 *
 * For each trading day in a configurable range, runs BOTH backends
 * (Phase B text embedding + Phase C engineered features) with a
 * temporal leakage guard (only considers analogs STRICTLY BEFORE the
 * target date), then computes:
 *
 *   - Top-k cohort from each backend
 *   - Overlap between the two cohorts
 *   - Each cohort's directional prediction (majority of analog closes
 *     above their opens -> UP, else DOWN)
 *   - Actual directional outcome for the target day (parsed from
 *     day_embeddings.summary close-delta)
 *   - Per-backend hit/miss on direction
 *
 * Emits a Markdown report at the path given by --out (default
 * comparison.md) with:
 *   - Per-day row with both cohorts side-by-side
 *   - Hit-rate summary
 *   - Interesting-disagreement section listing days where the two
 *     backends predicted OPPOSITE directions (the informative days)
 *
 * Prereqs:
 *   - day_embeddings populated (Phase B backfill complete)
 *   - day_features populated (Phase C backfill complete)
 *
 * Usage:
 *   source .env.local && node scripts/compare-analog-backends.mjs \
 *     --start 2024-01-01 --end 2024-12-31 --k 15 --out comparison.md
 *
 *   --every N : sample every Nth weekday (default 1 = all).
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { argv, exit } from 'node:process';
import { fileURLToPath } from 'node:url';

import { neon } from '@neondatabase/serverless';

function arg(name, fallback) {
  const i = argv.indexOf(name);
  if (i < 0) return fallback;
  return argv[i + 1];
}

const DATABASE_URL = globalThis.process?.env?.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('Missing DATABASE_URL');
  exit(1);
}

function yesterdayIso() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

const START = arg('--start', '2024-01-01');
const END = arg('--end', yesterdayIso());
const K = Number.parseInt(arg('--k', '15'), 10);
const EVERY = Number.parseInt(arg('--every', '1'), 10);
const OUT = arg('--out', 'comparison.md');

const sql = neon(DATABASE_URL);

/** Pull signed close-delta from a summary string. NaN if no match. */
function parseCloseDelta(summary) {
  const m = /close \S+ \(([+-]?\d+\.\d+)\)/.exec(summary);
  return m ? Number(m[1]) : Number.NaN;
}

/** Pull 1h delta and 1h range from a prediction-time summary. */
function parsePredictionFields(summary) {
  const hd = /1h delta ([+-]?\d+\.\d+)/.exec(summary);
  const hr = /1h range (\d+\.\d+)/.exec(summary);
  return {
    hourDelta: hd ? Number(hd[1]) : Number.NaN,
    hourRange: hr ? Number(hr[1]) : Number.NaN,
  };
}

/** Assign regime tags from target metadata. Missing-data values are
 * tagged 'unknown' so they still show up in stratified output. */
function regimeTags(date, predictionSummary) {
  const fields = parsePredictionFields(predictionSummary);
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
  const dowLabel = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][dow];

  const hd = fields.hourDelta;
  let hourBucket;
  if (!Number.isFinite(hd)) hourBucket = 'unknown';
  else if (hd < -10) hourBucket = 'strong-down';
  else if (hd < -3) hourBucket = 'mild-down';
  else if (hd <= 3) hourBucket = 'flat';
  else if (hd <= 10) hourBucket = 'mild-up';
  else hourBucket = 'strong-up';

  const hr = fields.hourRange;
  let rangeBucket;
  if (!Number.isFinite(hr)) rangeBucket = 'unknown';
  else if (hr < 10) rangeBucket = 'tight';
  else if (hr < 25) rangeBucket = 'normal';
  else rangeBucket = 'wide';

  const year = date.slice(0, 4);

  return {
    dow: dowLabel,
    openBias: hourBucket,
    openRange: rangeBucket,
    year,
  };
}

function isoDate(v) {
  return v instanceof Date
    ? v.toISOString().slice(0, 10)
    : String(v).slice(0, 10);
}

async function textAnalogs(targetDate, k) {
  const rows = await sql`
    WITH target AS (
      SELECT embedding FROM day_embeddings WHERE date = ${targetDate}::date
    )
    SELECT de.date, de.summary,
           de.embedding <=> (SELECT embedding FROM target) AS distance
    FROM day_embeddings de, target
    WHERE de.date < ${targetDate}::date
    ORDER BY de.embedding <=> (SELECT embedding FROM target)
    LIMIT ${k}
  `;
  return rows.map((r) => ({
    date: isoDate(r.date),
    summary: r.summary,
    distance: Number(r.distance),
  }));
}

async function featuresAnalogs(targetDate, k) {
  const rows = await sql`
    WITH target AS (
      SELECT features FROM day_features WHERE date = ${targetDate}::date
    )
    SELECT df.date,
           df.features <=> (SELECT features FROM target) AS distance
    FROM day_features df, target
    WHERE df.date < ${targetDate}::date
    ORDER BY df.features <=> (SELECT features FROM target)
    LIMIT ${k}
  `;
  const dates = rows.map((r) => isoDate(r.date));
  const summaries = dates.length
    ? await sql`
        SELECT date, summary FROM day_embeddings WHERE date = ANY(${dates})
      `
    : [];
  const byDate = new Map(summaries.map((r) => [isoDate(r.date), r.summary]));
  return rows.map((r) => ({
    date: isoDate(r.date),
    summary: byDate.get(isoDate(r.date)) ?? '',
    distance: Number(r.distance),
  }));
}

/**
 * Load VIX OHLC data from the local JSON file and build a date →
 * VIX-bucket map. This is truly orthogonal to the morning features
 * vector: VIX is the market-implied 30-day volatility going INTO the
 * day (yesterday's close + overnight moves), whereas our features
 * only see post-open minute bars.
 *
 * Buckets use fixed thresholds rather than data-driven terciles so
 * the regime labels match trader intuition: LOW<15, NORMAL 15-22,
 * ELEVATED 22-30, CRISIS>30. Pools per bucket over 15 years:
 *   LOW     ~1600 days
 *   NORMAL  ~1800 days
 *   ELEVATED ~400 days
 *   CRISIS  ~100 days
 */
function loadVixBucketMap() {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const vixPath = resolve(scriptDir, '..', 'public', 'vix-data.json');
  let raw;
  try {
    raw = JSON.parse(readFileSync(vixPath, 'utf8'));
  } catch (err) {
    console.error(`Failed to load ${vixPath}: ${err.message}`);
    return new Map();
  }

  const bucketOf = (v) =>
    v < 15 ? 'low' : v < 22 ? 'normal' : v < 30 ? 'elevated' : 'crisis';

  const out = new Map();
  for (const [date, ohlc] of Object.entries(raw)) {
    const close = Number(ohlc.close ?? ohlc.c);
    if (Number.isFinite(close)) {
      out.set(date, { close, bucket: bucketOf(close) });
    }
  }
  return out;
}

/**
 * Build date → prior-day-return-sign map. This is the Path 3 candidate
 * filter: orthogonal to morning shape AND correlated with direction
 * (momentum is a weak but real predictor of next-day direction).
 */
function buildPriorReturnSignMap(dirMap) {
  const sortedDates = Array.from(dirMap.keys()).sort();
  const out = new Map();
  for (let i = 1; i < sortedDates.length; i++) {
    const prior = dirMap.get(sortedDates[i - 1]);
    if (!prior || !Number.isFinite(prior.delta) || !prior.open) continue;
    const priorRet = prior.delta / prior.open;
    // 0.3% threshold for "meaningful" — below this is noise-level.
    const sign = priorRet > 0.003 ? 'up' : priorRet < -0.003 ? 'down' : 'flat';
    out.set(sortedDates[i], sign);
  }
  return out;
}

/**
 * Build date → calendar-flag map: {isOpEx, isQuadWitch, isMonthEnd}.
 * Deterministic from calendar — no external data, zero leakage risk.
 *
 *   isOpEx      : 3rd Friday of month (SPX monthly expiration)
 *   isQuadWitch : 3rd Friday of Mar/Jun/Sep/Dec (equity & index opts + futures)
 *   isMonthEnd  : last 2 trading days of the month (pension rebalancing window)
 *
 * These flags are hypothesized to carry directional edge: OpEx Fridays
 * have documented pin behavior; quad-witch adds futures rollover flow;
 * month-end has mechanical rebalancing.
 */
function buildCalendarFlagMap(sortedDates) {
  const out = new Map();
  // Find last trading day of each YYYY-MM so month-end detection uses
  // the TRADING calendar, not the literal 28-31st.
  const lastOfMonth = new Map();
  for (const d of sortedDates) {
    const ym = d.slice(0, 7);
    lastOfMonth.set(ym, d); // overwrites; final value = last trading day
  }
  // Build a position index so we can count backwards from last-of-month
  // by 0 or 1 trading days.
  const posOf = new Map(sortedDates.map((d, i) => [d, i]));
  const isMonthEndDate = new Set();
  for (const lastDay of lastOfMonth.values()) {
    const pos = posOf.get(lastDay);
    isMonthEndDate.add(lastDay);
    if (pos > 0) isMonthEndDate.add(sortedDates[pos - 1]);
  }

  for (const date of sortedDates) {
    const d = new Date(`${date}T00:00:00Z`);
    const month = d.getUTCMonth(); // 0-indexed
    const day = d.getUTCDate();
    const dow = d.getUTCDay();

    const isFriday = dow === 5;
    const isThirdFriday = isFriday && day >= 15 && day <= 21;
    const isQuadWitch = isThirdFriday && [2, 5, 8, 11].includes(month);

    out.set(date, {
      isOpEx: isThirdFriday ? 1 : 0,
      isQuadWitch: isQuadWitch ? 1 : 0,
      isMonthEnd: isMonthEndDate.has(date) ? 1 : 0,
    });
  }
  return out;
}

/**
 * Build date → scalar feature vector {priorReturn, overnightGap,
 * trailing5dReturn, vixLevel, vixChange, + calendar flags} for the
 * Path 3-real experiment. All features are available pre-open so
 * no temporal leakage.
 *
 * Continuous scalars z-score normalized; binary flags pass through
 * raw. Both concatenated into a per-date scaled vector.
 */
function buildScalarFeatureMap(dirMap, vixMap) {
  // Anchor on VIX's calendar — VIX ticks only on SPX trading days (Mon-Fri,
  // ex-holidays), which is exactly the universe where 0DTE SPX analogs
  // are meaningful. The ES futures archive includes Sunday-evening and
  // NYSE-holiday sessions that have no equity-market counterpart.
  const sortedDates = Array.from(vixMap.keys())
    .filter((d) => dirMap.has(d))
    .sort();
  const calendarFlags = buildCalendarFlagMap(sortedDates);
  const out = new Map();
  const drops = {
    missingOpenOrDelta: 0,
    trailing5dSparse: 0,
    ok: 0,
  };
  for (let i = 5; i < sortedDates.length; i++) {
    const date = sortedDates[i];
    const priorDate = sortedDates[i - 1];
    const entry = dirMap.get(date);
    const prior = dirMap.get(priorDate);
    if (!entry?.open || !prior?.open || !Number.isFinite(prior.delta)) {
      drops.missingOpenOrDelta += 1;
      continue;
    }
    const priorReturn = prior.delta / prior.open;
    const priorClose = prior.open + prior.delta;
    const overnightGap = (entry.open - priorClose) / priorClose;
    // Trailing 5-day sum of daily returns (prior to date, excludes today).
    let trailing5d = 0;
    let trailing5dCount = 0;
    for (let j = i - 5; j < i; j++) {
      const d = dirMap.get(sortedDates[j]);
      if (d?.open && Number.isFinite(d.delta)) {
        trailing5d += d.delta / d.open;
        trailing5dCount += 1;
      }
    }
    if (trailing5dCount < 3) {
      drops.trailing5dSparse += 1;
      continue;
    }
    // VIX features must be observable BEFORE target open. priorDate's
    // close is known as of 4 PM yesterday; day-before-prior's close is
    // known earlier still. vixChange uses yesterday's VIX move, NOT
    // target-day move — the target-day VIX close would leak EOD
    // direction (VIX and SPX are inversely correlated intraday).
    const dayBeforePrior = sortedDates[i - 2];
    if (!dayBeforePrior) {
      drops.missingOpenOrDelta += 1;
      continue;
    }
    const vixLevel = vixMap.get(priorDate).close;
    const vixPriorPrior = vixMap.get(dayBeforePrior)?.close;
    if (!Number.isFinite(vixPriorPrior)) {
      drops.missingOpenOrDelta += 1;
      continue;
    }
    const vixChange = vixLevel - vixPriorPrior;

    const flags = calendarFlags.get(date);
    drops.ok += 1;
    out.set(date, {
      priorReturn,
      overnightGap,
      trailing5d,
      vixLevel,
      vixChange,
      isOpEx: flags?.isOpEx ?? 0,
      isQuadWitch: flags?.isQuadWitch ?? 0,
      isMonthEnd: flags?.isMonthEnd ?? 0,
    });
  }
  console.log(
    `  scalar-feature drops: missingOpenOrDelta=${drops.missingOpenOrDelta} trailing5dSparse=${drops.trailing5dSparse} ok=${drops.ok}`,
  );

  // z-score normalize continuous dims; keep binary flags raw (0/1).
  // Both classes multiplied by SCALAR_SCALE so each scalar dim
  // contributes ~0.01 per-dim, roughly matching minute-bar percent
  // changes (typically ±0.005).
  const continuousDims = [
    'priorReturn',
    'overnightGap',
    'trailing5d',
    'vixLevel',
    'vixChange',
  ];
  const flagDims = ['isOpEx', 'isQuadWitch', 'isMonthEnd'];
  const stats = {};
  for (const k of continuousDims) {
    const vals = Array.from(out.values()).map((e) => e[k]);
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const variance =
      vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length;
    stats[k] = { mean, stddev: Math.sqrt(variance) || 1 };
  }
  const SCALAR_SCALE = 0.01;
  for (const [date, entry] of out) {
    const continuousVec = continuousDims.map(
      (k) => ((entry[k] - stats[k].mean) / stats[k].stddev) * SCALAR_SCALE,
    );
    const flagVec = flagDims.map((k) => entry[k] * SCALAR_SCALE);
    entry.scaled = [...continuousVec, ...flagVec];
    out.set(date, entry);
  }
  return out;
}

/**
 * Path 3-real: enriched-vector analogs.
 *
 * Over-retrieve by cosine on the 60-dim features prefilter, then
 * re-rank the top-N by cosine on the 68-dim enriched vector
 * (60 minute-bar percent-changes + 5 scaled continuous scalars +
 * 3 calendar flags).
 * The top-N prefilter catches the structurally most similar days;
 * the re-rank adjusts for scalar regime + calendar proximity.
 */
async function featuresAnalogsEnrichedRerank(targetDate, k, scalarMap) {
  const targetScalars = scalarMap.get(targetDate)?.scaled;
  if (!targetScalars) return [];

  const PREFILTER = 100;

  // Over-retrieve top-PREFILTER by cosine on existing 60-dim features,
  // plus each candidate's full features vector for re-scoring.
  const rows = await sql`
    WITH target AS (
      SELECT features FROM day_features WHERE date = ${targetDate}::date
    )
    SELECT df.date,
           df.features::text AS features_text,
           df.features <=> (SELECT features FROM target) AS distance
    FROM day_features df, target
    WHERE df.date < ${targetDate}::date
    ORDER BY df.features <=> (SELECT features FROM target)
    LIMIT ${PREFILTER}
  `;

  const [targetRow] = await sql`
    SELECT features::text AS features_text
    FROM day_features
    WHERE date = ${targetDate}::date
  `;
  const targetFeatures = parseVectorText(targetRow?.features_text ?? '');
  if (!targetFeatures) return [];
  const targetEnriched = [...targetFeatures, ...targetScalars];

  // Re-score each candidate by cosine on enriched vector.
  const candidates = [];
  for (const r of rows) {
    const features = parseVectorText(r.features_text);
    const scalars = scalarMap.get(isoDate(r.date))?.scaled;
    if (!features || !scalars) continue;
    const candEnriched = [...features, ...scalars];
    const dist = 1 - cosineSim(targetEnriched, candEnriched);
    candidates.push({
      date: isoDate(r.date),
      distance: dist,
    });
  }
  candidates.sort((a, b) => a.distance - b.distance);
  return candidates.slice(0, k);
}

function parseVectorText(s) {
  if (!s?.startsWith('[') || !s.endsWith(']')) return null;
  const parts = s.slice(1, -1).split(',');
  const out = new Array(parts.length);
  for (let i = 0; i < parts.length; i++) {
    const n = Number(parts[i]);
    if (!Number.isFinite(n)) return null;
    out[i] = n;
  }
  return out;
}

function cosineSim(a, b) {
  let dot = 0,
    na = 0,
    nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Regime-filtered features analogs (Path 3).
 *
 * Filter candidate pool by `prior-day-return-sign` match. This is
 * orthogonal to the features vector (which only sees post-open minute
 * structure) AND correlated with direction (prior-day momentum is a
 * weak but real EOD-direction predictor).
 */
async function featuresAnalogsRegimeFiltered(
  targetDate,
  k,
  targetPriorSign,
  priorSignMap,
) {
  if (!targetPriorSign) return [];
  const overRetrieve = 10;
  const rows = await sql`
    WITH target AS (
      SELECT features FROM day_features WHERE date = ${targetDate}::date
    )
    SELECT df.date,
           df.features <=> (SELECT features FROM target) AS distance
    FROM day_features df, target
    WHERE df.date < ${targetDate}::date
    ORDER BY df.features <=> (SELECT features FROM target)
    LIMIT ${k * overRetrieve}
  `;
  const candidateDates = rows.map((r) => isoDate(r.date));
  const summaries = candidateDates.length
    ? await sql`
        SELECT date, summary FROM day_embeddings WHERE date = ANY(${candidateDates})
      `
    : [];
  const byDate = new Map(summaries.map((r) => [isoDate(r.date), r.summary]));

  const filtered = [];
  for (const r of rows) {
    const d = isoDate(r.date);
    if (priorSignMap.get(d) !== targetPriorSign) continue;
    filtered.push({
      date: d,
      summary: byDate.get(d) ?? '',
      distance: Number(r.distance),
    });
    if (filtered.length >= k) break;
  }
  return filtered;
}

function directionalPrediction(cohort, dirMap) {
  const dirs = cohort
    .map((c) => dirMap.get(c.date)?.dir)
    .filter((d) => d === 'UP' || d === 'DOWN');
  if (dirs.length === 0) return { pred: null, upCount: 0, n: 0 };
  const upCount = dirs.filter((d) => d === 'UP').length;
  const pred = upCount > dirs.length / 2 ? 'UP' : 'DOWN';
  return { pred, upCount, n: dirs.length };
}

function overlapCount(a, b) {
  const aSet = new Set(a.map((x) => x.date));
  let n = 0;
  for (const x of b) if (aSet.has(x.date)) n++;
  return n;
}

async function candidateDates(startIso, endIso, every) {
  const rows = await sql`
    SELECT de.date
    FROM day_embeddings de
    INNER JOIN day_features df USING (date)
    WHERE de.date BETWEEN ${startIso}::date AND ${endIso}::date
    ORDER BY de.date
  `;
  const all = rows.map((r) => isoDate(r.date));
  return all.filter((_, i) => i % every === 0);
}

/** Parse day open from the rich summary: `"... | open 5324.00 | ..."`. */
function parseOpen(summary) {
  const m = /open (\d+(?:\.\d+)?)/.exec(summary);
  return m ? Number(m[1]) : Number.NaN;
}

/** Parse total daily range (high - low) from the rich summary:
 * `"... | range 204.50 | ..."`. This is the single most important field
 * for condor strike placement — it tells you how far price stretched
 * top-to-bottom through the session, regardless of direction. */
function parseRange(summary) {
  const m = /range (\d+(?:\.\d+)?)/.exec(summary);
  return m ? Number(m[1]) : Number.NaN;
}

/** Classify a day as chop (round-trip, range-bound) or trend (one-way).
 * trendScore = |close - open| / daily_range, normalized [0, 1].
 *   0.0 → close returned to open; no directional commitment
 *   1.0 → close at one extreme of the day's range
 * Breakpoints are conservative: 0.3/0.6 avoids the ambiguous middle. */
function classifyDay(closeDelta, range) {
  if (!Number.isFinite(closeDelta) || !Number.isFinite(range) || range <= 0) {
    return { trendScore: null, isChop: false, isTrend: false };
  }
  const trendScore = Math.abs(closeDelta) / range;
  return {
    trendScore,
    isChop: trendScore < 0.3,
    isTrend: trendScore > 0.6,
  };
}

/** Sort + pick percentile from a numeric array. Linear interpolation
 * between adjacent samples so percentile is well-defined for small
 * cohorts (k=15 means only 15 range samples — want smooth quantiles
 * rather than step function). */
function percentile(values, p) {
  const sorted = [...values].filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length === 0) return Number.NaN;
  if (sorted.length === 1) return sorted[0];
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

/** Quantiles used for the nominal-vs-empirical calibration curve.
 * Sweep lets us discover which cohort percentile corresponds to the
 * target's actual 80% coverage (often ≠ the nominal p80). The trader
 * looks at this table to pick the right percentile for their intended
 * strike confidence level. */
const CALIB_QUANTILES = [
  0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95, 0.98,
];

/** Summarize a cohort's expected range and chop/trend distribution.
 * Returned object drives the strike-placement hints and calibration
 * sweep. */
function cohortRangeStats(cohort, dayMap) {
  const ranges = [];
  const absDeltas = [];
  const upExcursions = [];
  const downExcursions = [];
  let chopCount = 0;
  let trendCount = 0;
  let n = 0;
  for (const c of cohort) {
    const entry = dayMap.get(c.date);
    if (!entry) continue;
    if (Number.isFinite(entry.range)) ranges.push(entry.range);
    if (Number.isFinite(entry.delta)) absDeltas.push(Math.abs(entry.delta));
    if (Number.isFinite(entry.upExcursion))
      upExcursions.push(entry.upExcursion);
    if (Number.isFinite(entry.downExcursion))
      downExcursions.push(entry.downExcursion);
    if (entry.isChop) chopCount += 1;
    if (entry.isTrend) trendCount += 1;
    n += 1;
  }
  if (ranges.length === 0) return null;
  const rangeQuantiles = {};
  const absDeltaQuantiles = {};
  const upExcQuantiles = {};
  const downExcQuantiles = {};
  for (const q of CALIB_QUANTILES) {
    rangeQuantiles[q] = percentile(ranges, q);
    absDeltaQuantiles[q] = percentile(absDeltas, q);
    upExcQuantiles[q] = percentile(upExcursions, q);
    downExcQuantiles[q] = percentile(downExcursions, q);
  }
  return {
    n,
    rangeQuantiles,
    absDeltaQuantiles,
    upExcQuantiles,
    downExcQuantiles,
    hasExcursion: upExcursions.length > 0,
    range_p20: rangeQuantiles[0.2],
    range_p50: rangeQuantiles[0.5],
    range_p80: rangeQuantiles[0.8],
    range_p95: rangeQuantiles[0.95],
    absDelta_p50: absDeltaQuantiles[0.5],
    absDelta_p80: absDeltaQuantiles[0.8],
    chopRate: chopCount / n,
    trendRate: trendCount / n,
  };
}

/** Build a date-indexed global baseline: unconditional distribution of
 * ranges across all history strictly before a cutoff. Used as the
 * "do-nothing" bar for evaluating whether cohort conditioning adds
 * information (narrower bands at same coverage = real signal). */
function globalBaselineStats(dayMap, cutoffDate) {
  const ranges = [];
  const absDeltas = [];
  let chopCount = 0;
  let n = 0;
  for (const [d, entry] of dayMap) {
    if (d >= cutoffDate) continue;
    if (Number.isFinite(entry.range)) ranges.push(entry.range);
    if (Number.isFinite(entry.delta)) absDeltas.push(Math.abs(entry.delta));
    if (entry.isChop) chopCount += 1;
    n += 1;
  }
  if (ranges.length === 0) return null;
  const rangeQuantiles = {};
  const absDeltaQuantiles = {};
  for (const q of CALIB_QUANTILES) {
    rangeQuantiles[q] = percentile(ranges, q);
    absDeltaQuantiles[q] = percentile(absDeltas, q);
  }
  return {
    n,
    rangeQuantiles,
    absDeltaQuantiles,
    range_p20: rangeQuantiles[0.2],
    range_p50: rangeQuantiles[0.5],
    range_p80: rangeQuantiles[0.8],
    range_p95: rangeQuantiles[0.95],
    absDelta_p50: absDeltaQuantiles[0.5],
    absDelta_p80: absDeltaQuantiles[0.8],
    chopRate: chopCount / n,
  };
}

// Build a date → {dir, delta, open, range, trendScore, isChop, isTrend}
// map via the batched rich-summary endpoint. ONE sidecar call populates
// ground truth for every target AND every analog across the whole
// comparison range. The range + classification fields are what drive
// the chop/range calibration report — direction fields kept for the
// legacy directional hit-rate section.
async function buildActualDirectionMap(startIso, endIso) {
  const SIDECAR_URL = globalThis.process?.env?.SIDECAR_URL?.trim().replace(
    /\/$/,
    '',
  );
  if (!SIDECAR_URL) return new Map();

  // Batch endpoint caps at 3 years — split if wider.
  const toDate = (s) => new Date(`${s}T00:00:00Z`);
  const addYears = (s, n) => {
    const d = toDate(s);
    d.setUTCFullYear(d.getUTCFullYear() + n);
    return d.toISOString().slice(0, 10);
  };

  // Historical analogs can come from years before START, so fetch from
  // the earliest known date through END to cover any analog pull.
  const archiveStart = '2010-06-07';
  const map = new Map();

  let cur = archiveStart;
  while (cur <= endIso) {
    const stop = addYears(cur, 3) < endIso ? addYears(cur, 3) : endIso;
    const res = await fetch(
      `${SIDECAR_URL}/archive/day-summary-batch?from=${cur}&to=${stop}`,
    );
    if (res.ok) {
      const body = await res.json();
      for (const r of body.rows ?? []) {
        // Prefer structured fields if the sidecar emits them (new format);
        // fall back to regex-parsed summary text (legacy format).
        const hasStructured =
          typeof r.open === 'number' && typeof r.range === 'number';
        let o;
        let rng;
        let d;
        let upExc = null;
        let downExc = null;
        if (hasStructured) {
          o = r.open;
          rng = r.range;
          d =
            typeof r.close === 'number'
              ? r.close - r.open
              : parseCloseDelta(r.summary);
          if (typeof r.up_excursion === 'number') upExc = r.up_excursion;
          if (typeof r.down_excursion === 'number') downExc = r.down_excursion;
        } else {
          o = parseOpen(r.summary);
          rng = parseRange(r.summary);
          d = parseCloseDelta(r.summary);
        }
        if (Number.isFinite(d)) {
          const cls = classifyDay(d, rng);
          map.set(r.date, {
            dir: d > 0 ? 'UP' : 'DOWN',
            delta: d,
            open: Number.isFinite(o) ? o : null,
            range: Number.isFinite(rng) ? rng : null,
            upExcursion: Number.isFinite(upExc) ? upExc : null,
            downExcursion: Number.isFinite(downExc) ? downExc : null,
            trendScore: cls.trendScore,
            isChop: cls.isChop,
            isTrend: cls.isTrend,
          });
        }
      }
    }
    if (stop === endIso) break;
    const next = new Date(toDate(stop).getTime() + 86400000)
      .toISOString()
      .slice(0, 10);
    if (next > endIso) break;
    cur = next;
  }
  return map;
}

async function run() {
  console.log(
    `Comparing backends across ${START} -> ${END} (k=${K}, every=${EVERY})`,
  );

  const datesAll = await candidateDates(START, END, EVERY);
  console.log(
    `  ${datesAll.length} target dates with both embeddings present (pre-VIX filter)`,
  );

  // ONE sidecar call populates ground-truth close directions for all
  // historical dates — used for both target outcomes and analog-cohort
  // direction scoring.
  console.log('  Fetching ground-truth close directions via sidecar batch...');
  const dirMap = await buildActualDirectionMap(START, END);
  console.log(`  ${dirMap.size} dates with known actual close direction`);

  // Load VIX OHLC JSON (stratification + calendar anchor for scalar map).
  const vixMap = loadVixBucketMap();
  console.log(`  ${vixMap.size} dates with VIX data`);

  // Restrict target dates to SPX trading days (those with VIX ticks).
  // Sunday-evening ES sessions and NYSE holidays don't have equity-market
  // analog meaning for a 0DTE SPX trader.
  const dates = datesAll.filter((d) => vixMap.has(d));
  const droppedNonTrading = datesAll.length - dates.length;
  console.log(
    `  ${dates.length} target dates on SPX trading days (dropped ${droppedNonTrading} non-trading)`,
  );

  // Path 3 filter: prior-day return sign (direction momentum).
  const priorSignMap = buildPriorReturnSignMap(dirMap);
  console.log(
    `  ${priorSignMap.size} dates with prior-day return sign for regime filter`,
  );

  // Path 3-real: enriched 65-dim vector (60 minute-bars + 5 scaled scalars).
  // Computed in JS rather than a re-backfill — experimentation speed.
  const scalarMap = buildScalarFeatureMap(dirMap, vixMap);
  console.log(
    `  ${scalarMap.size} dates with scalar regime features (enriched vector)`,
  );

  // Diagnose target-side miss: which of the 415 targets lack scalar entry?
  const missingTargets = dates.filter((d) => !scalarMap.has(d));
  if (missingTargets.length > 0) {
    const firstMissing = missingTargets.slice(0, 5);
    const lastMissing = missingTargets.slice(-5);
    console.log(
      `  ${missingTargets.length}/${dates.length} target dates MISSING scalars`,
    );
    console.log(`    first: ${firstMissing.join(', ')}`);
    console.log(`    last:  ${lastMissing.join(', ')}`);
    // VIX-availability check for target misses
    const missVixToday = missingTargets.filter((d) => !vixMap.get(d)?.close);
    const hasVixToday = missingTargets.length - missVixToday.length;
    console.log(
      `    of those: ${missVixToday.length} missing target-day VIX, ${hasVixToday} have target-day VIX (so miss is on prior-day/trailing/open)`,
    );
  }
  console.log('');

  const rows = [];
  const disagreements = [];

  let textHits = 0;
  let featuresHits = 0;
  let regimeHits = 0;
  let enrichedHits = 0;
  let enrichedEmpty = 0;
  // Enriched populated subset — for apples-to-apples compare, count
  // features hits restricted to the same subset so the enriched lift
  // is measured against the same dates that had enough scalar data.
  let enrichedPopulatedN = 0;
  let featuresHitsOnPopulated = 0;
  let enrichedHitsOnPopulated = 0;
  let regimeEmptyCohort = 0; // cohort filter returned 0 matches
  let bothHit = 0;
  let bothMiss = 0;
  let overlapSum = 0;
  let overlapN = 0;

  // Accumulators for stratified hit rates. Each tag dimension maps
  // { tagValue -> { textHits, featuresHits, n } }.
  const strata = {
    dow: {},
    openBias: {},
    openRange: {},
    year: {},
    vix: {},
    priorSign: {},
  };

  // Global baseline: unconditional range/chop distribution across all
  // history strictly before the earliest target. Constant across the
  // whole experiment — it's the "do-nothing" benchmark. A cohort
  // beats this baseline if it gives a narrower band at equivalent
  // coverage, or higher Brier skill on chop classification.
  const earliestTarget = dates[0];
  const globalStats = globalBaselineStats(dirMap, earliestTarget);
  if (globalStats) {
    console.log(
      `  Global baseline (pre-${earliestTarget}, n=${globalStats.n}): ` +
        `range p20=${globalStats.range_p20.toFixed(1)} p50=${globalStats.range_p50.toFixed(1)} p80=${globalStats.range_p80.toFixed(1)} p95=${globalStats.range_p95.toFixed(1)} | ` +
        `chopRate=${(100 * globalStats.chopRate).toFixed(1)}%`,
    );
  }

  // Calibration accumulators. One "calib" slot per backend. Each slot
  // tracks: p80-coverage hit count, p20-p80 band coverage, band widths,
  // squared errors (MAE proxy), Brier terms for chop, and sample count.
  const makeCalib = () => ({
    n: 0,
    p80_covered: 0,
    p20_p80_covered: 0,
    p20_p80_width_sum: 0,
    range_abs_err_sum: 0, // |cohort p50 - actual range|
    range_squared_err_sum: 0,
    absDelta_p80_covered: 0,
    absDelta_p80_width_sum: 0,
    chop_brier_sum: 0, // (predicted_chop_rate - actual_chop)^2
    chop_correct: 0, // predicted_chop_rate >= 0.5 matches actual isChop
    // Quantile sweep: for each q in CALIB_QUANTILES, count how often
    // actual range ≤ cohort q. Drives the calibration curve.
    rangeCoverageByQ: Object.fromEntries(CALIB_QUANTILES.map((q) => [q, 0])),
    absDeltaCoverageByQ: Object.fromEntries(CALIB_QUANTILES.map((q) => [q, 0])),
    upExcCoverageByQ: Object.fromEntries(CALIB_QUANTILES.map((q) => [q, 0])),
    downExcCoverageByQ: Object.fromEntries(CALIB_QUANTILES.map((q) => [q, 0])),
    excursionN: 0,
    upExc_p50_width_sum: 0,
    downExc_p50_width_sum: 0,
    upExc_p80_width_sum: 0,
    downExc_p80_width_sum: 0,
  });
  const calib = {
    text: makeCalib(),
    features: makeCalib(),
    regime: makeCalib(),
    enriched: makeCalib(),
    global: makeCalib(),
  };
  // Regime-stratified calibration. Nested: {dim -> {bucket -> {backend
  // -> calibSlot}}}. Only text + features tracked per stratum since
  // those are the headline backends; saves rows in the report.
  const stratCalib = {
    vix: {},
    openBias: {},
  };
  const stratBackends = ['text', 'features', 'global'];
  const stratBucket = (dim, value) => {
    if (!stratCalib[dim][value]) {
      stratCalib[dim][value] = Object.fromEntries(
        stratBackends.map((b) => [b, makeCalib()]),
      );
    }
    return stratCalib[dim][value];
  };

  for (const date of dates) {
    const actualEntry = dirMap.get(date);
    const actualDir = actualEntry?.dir ?? null;
    const actualDelta = actualEntry?.delta ?? Number.NaN;

    // Pull the target's own leakage-free summary for regime tagging.
    const [predRow] = await sql`
      SELECT summary FROM day_embeddings WHERE date = ${date}::date
    `;
    const predSummary = predRow?.summary ?? '';
    const tags = regimeTags(date, predSummary);
    // Add VIX bucket + prior-day-return sign to the tag set.
    tags.vix = vixMap.get(date)?.bucket ?? 'unknown';
    tags.priorSign = priorSignMap.get(date) ?? 'unknown';

    const [tAn, fAn, rAn, eAn] = await Promise.all([
      textAnalogs(date, K),
      featuresAnalogs(date, K),
      featuresAnalogsRegimeFiltered(date, K, tags.priorSign, priorSignMap),
      featuresAnalogsEnrichedRerank(date, K, scalarMap),
    ]);

    const tPred = directionalPrediction(tAn, dirMap);
    const fPred = directionalPrediction(fAn, dirMap);
    const rPred = directionalPrediction(rAn, dirMap);
    const ePred = directionalPrediction(eAn, dirMap);
    if (rAn.length === 0) regimeEmptyCohort += 1;
    if (eAn.length === 0) enrichedEmpty += 1;
    const overlap = overlapCount(tAn, fAn);
    overlapSum += overlap;
    overlapN += 1;

    const tHit = actualDir && tPred.pred === actualDir;
    const fHit = actualDir && fPred.pred === actualDir;
    const rHit = actualDir && rPred.pred === actualDir;
    const eHit = actualDir && ePred.pred === actualDir;
    if (tHit) textHits += 1;
    if (fHit) featuresHits += 1;
    if (rHit) regimeHits += 1;
    if (eHit) enrichedHits += 1;
    // Track features vs enriched on the populated subset for fair
    // comparison (empty enriched cohort = no fair comparison possible).
    if (actualDir && eAn.length > 0) {
      enrichedPopulatedN += 1;
      if (fHit) featuresHitsOnPopulated += 1;
      if (eHit) enrichedHitsOnPopulated += 1;
    }
    if (tHit && fHit) bothHit += 1;
    if (!tHit && !fHit && actualDir) bothMiss += 1;

    // Bucket into strata only when ground truth is known — otherwise
    // the bucket stats get polluted by "can't score" dates.
    if (actualDir) {
      for (const [dim, value] of Object.entries(tags)) {
        const bucket = (strata[dim][value] ??= {
          textHits: 0,
          featuresHits: 0,
          regimeHits: 0,
          enrichedHits: 0,
          n: 0,
        });
        bucket.n += 1;
        if (tHit) bucket.textHits += 1;
        if (fHit) bucket.featuresHits += 1;
        if (rHit) bucket.regimeHits += 1;
        if (eHit) bucket.enrichedHits += 1;
      }
    }

    // Chop/range calibration — per-target, per-backend.
    // For each cohort, compute predicted range percentiles + chop rate,
    // then score against the target day's actual range/delta/chop flag.
    // Same scoring function applies to overall + stratified accumulators.
    const targetEntry = dirMap.get(date);
    const actualRange = targetEntry?.range ?? null;
    const actualAbsDelta = Number.isFinite(actualDelta)
      ? Math.abs(actualDelta)
      : null;
    const actualIsChop = targetEntry?.isChop ?? null;
    if (Number.isFinite(actualRange) && actualIsChop !== null && globalStats) {
      const cohorts = {
        text: tAn,
        features: fAn,
        regime: rAn,
        enriched: eAn,
      };
      const statsByBackend = {};
      for (const [name, cohort] of Object.entries(cohorts)) {
        const s = cohortRangeStats(cohort, dirMap);
        if (s) statsByBackend[name] = s;
      }

      const actualUpExc = targetEntry?.upExcursion ?? null;
      const actualDownExc = targetEntry?.downExcursion ?? null;
      const hasTargetExc =
        Number.isFinite(actualUpExc) && Number.isFinite(actualDownExc);

      const scoreSlot = (c, s) => {
        c.n += 1;
        if (actualRange <= s.range_p80) c.p80_covered += 1;
        if (actualRange >= s.range_p20 && actualRange <= s.range_p80) {
          c.p20_p80_covered += 1;
        }
        c.p20_p80_width_sum += s.range_p80 - s.range_p20;
        c.range_abs_err_sum += Math.abs(s.range_p50 - actualRange);
        c.range_squared_err_sum += (s.range_p50 - actualRange) ** 2;
        if (actualAbsDelta !== null) {
          if (actualAbsDelta <= s.absDelta_p80) c.absDelta_p80_covered += 1;
          c.absDelta_p80_width_sum += s.absDelta_p80;
        }
        const actualChopBin = actualIsChop ? 1 : 0;
        c.chop_brier_sum += (s.chopRate - actualChopBin) ** 2;
        if (s.chopRate >= 0.5 === actualIsChop) c.chop_correct += 1;
        for (const q of CALIB_QUANTILES) {
          if (actualRange <= s.rangeQuantiles[q]) c.rangeCoverageByQ[q] += 1;
          if (
            actualAbsDelta !== null &&
            actualAbsDelta <= s.absDeltaQuantiles[q]
          ) {
            c.absDeltaCoverageByQ[q] += 1;
          }
        }
        // Asymmetric excursion scoring — only when both target AND cohort
        // have up/down quantiles (requires post-deploy sidecar output).
        if (hasTargetExc && s.hasExcursion) {
          c.excursionN += 1;
          c.upExc_p50_width_sum += s.upExcQuantiles[0.5];
          c.downExc_p50_width_sum += s.downExcQuantiles[0.5];
          c.upExc_p80_width_sum += s.upExcQuantiles[0.8];
          c.downExc_p80_width_sum += s.downExcQuantiles[0.8];
          for (const q of CALIB_QUANTILES) {
            if (actualUpExc <= s.upExcQuantiles[q]) c.upExcCoverageByQ[q] += 1;
            if (actualDownExc <= s.downExcQuantiles[q])
              c.downExcCoverageByQ[q] += 1;
          }
        }
      };

      for (const [name, s] of Object.entries(statsByBackend)) {
        scoreSlot(calib[name], s);
      }
      scoreSlot(calib.global, globalStats);

      // Stratified accumulators: VIX regime + first-hour-bias bucket.
      for (const dim of ['vix', 'openBias']) {
        const bucket = stratBucket(dim, tags[dim]);
        for (const b of stratBackends) {
          const s = b === 'global' ? globalStats : statsByBackend[b];
          if (s) scoreSlot(bucket[b], s);
        }
      }
    }

    rows.push({
      date,
      actualDir,
      actualDelta,
      tPred: tPred.pred,
      tUpFrac: tPred.n ? tPred.upCount / tPred.n : 0,
      fPred: fPred.pred,
      fUpFrac: fPred.n ? fPred.upCount / fPred.n : 0,
      overlap,
      tHit,
      fHit,
    });

    if (actualDir && tPred.pred && fPred.pred && tPred.pred !== fPred.pred) {
      disagreements.push({
        date,
        actualDir,
        tPred: tPred.pred,
        fPred: fPred.pred,
      });
    }
  }

  const textRate = (100 * textHits) / Math.max(1, rows.length);
  const featuresRate = (100 * featuresHits) / Math.max(1, rows.length);
  const regimeRate = (100 * regimeHits) / Math.max(1, rows.length);
  const enrichedRate = (100 * enrichedHits) / Math.max(1, rows.length);
  const overlapMean = overlapSum / Math.max(1, overlapN);

  const md = [];
  md.push(`# Analog Backend Comparison\n`);
  md.push(`**Range**: ${START} -> ${END}  `);
  md.push(`**k**: ${K}  `);
  md.push(`**Sample cadence**: every ${EVERY} trading day(s)  `);
  md.push(`**N target dates**: ${rows.length}  \n`);

  md.push(`## Summary\n`);
  md.push(
    `| Metric | Text (B) | Features (C) | Regime filter | Enriched (P3-real) |`,
  );
  md.push(`| --- | --- | --- | --- | --- |`);
  md.push(
    `| Directional hit rate | ${textHits}/${rows.length} (${textRate.toFixed(1)}%) | ${featuresHits}/${rows.length} (${featuresRate.toFixed(1)}%) | ${regimeHits}/${rows.length} (${regimeRate.toFixed(1)}%) | ${enrichedHits}/${rows.length} (${enrichedRate.toFixed(1)}%) |`,
  );
  md.push(
    `| Both text/features agreed on a hit | ${bothHit}/${rows.length} | --- | --- | --- |`,
  );
  md.push(
    `| Both text/features missed | ${bothMiss}/${rows.length} | --- | --- | --- |`,
  );
  md.push(
    `| Mean text/features top-${K} overlap | ${overlapMean.toFixed(1)}/${K} (${((100 * overlapMean) / K).toFixed(0)}%) | --- | --- | --- |`,
  );
  md.push(
    `| Cohorts with 0 matches | --- | --- | ${regimeEmptyCohort}/${rows.length} | ${enrichedEmpty}/${rows.length} |`,
  );
  const enrichedLiftBase =
    (100 * featuresHitsOnPopulated) / Math.max(1, enrichedPopulatedN);
  const enrichedLiftNew =
    (100 * enrichedHitsOnPopulated) / Math.max(1, enrichedPopulatedN);
  md.push(
    `| **Enriched vs Features, populated-only (n=${enrichedPopulatedN})** | --- | ${featuresHitsOnPopulated}/${enrichedPopulatedN} (${enrichedLiftBase.toFixed(1)}%) | --- | ${enrichedHitsOnPopulated}/${enrichedPopulatedN} (${enrichedLiftNew.toFixed(1)}%) |\n`,
  );

  // ---------------------------------------------------------------
  // Chop / range calibration report — the primary output now. This
  // is what tells you whether cohort conditioning gives you tradable
  // information about today's range, chop probability, and strike-
  // placement bands, independent of directional prediction.
  // ---------------------------------------------------------------
  md.push(`## Chop / range calibration\n`);
  md.push(
    `For each target day, the cohort's range-distribution is treated as a forecast. We score calibration (actual range lands inside predicted percentile band at expected rate) and information gain (cohort band narrower than global at same coverage = real signal).\n`,
  );
  if (globalStats) {
    md.push(
      `**Global baseline** (unconditional, computed from all history before ${earliestTarget}, n=${globalStats.n}):  `,
    );
    md.push(
      `  range p20=${globalStats.range_p20.toFixed(1)}pt, p50=${globalStats.range_p50.toFixed(1)}pt, p80=${globalStats.range_p80.toFixed(1)}pt, p95=${globalStats.range_p95.toFixed(1)}pt  `,
    );
    md.push(
      `  |close-open| p50=${globalStats.absDelta_p50.toFixed(1)}pt, p80=${globalStats.absDelta_p80.toFixed(1)}pt  `,
    );
    md.push(`  chop rate = ${(100 * globalStats.chopRate).toFixed(1)}%\n`);
  }

  md.push(
    `| Backend | N | Range p80 coverage | p20-p80 band width (pt) | Range MAE (p50 vs actual) | \\|ΔClose\\| p80 coverage | Chop Brier ↓ | Chop classify acc |`,
  );
  md.push(`| --- | --- | --- | --- | --- | --- | --- | --- |`);
  const order = ['global', 'text', 'features', 'regime', 'enriched'];
  const labelOf = {
    global: 'Global (unconditional)',
    text: 'Text (B)',
    features: 'Features (C)',
    regime: 'Regime-filtered (prior-sign)',
    enriched: 'Enriched (P3-real)',
  };
  for (const key of order) {
    const c = calib[key];
    if (c.n === 0) continue;
    const p80cov = (100 * c.p80_covered) / c.n;
    const p20p80cov = (100 * c.p20_p80_covered) / c.n;
    const bandW = c.p20_p80_width_sum / c.n;
    const rangeMAE = c.range_abs_err_sum / c.n;
    const absDp80cov = (100 * c.absDelta_p80_covered) / c.n;
    const brier = c.chop_brier_sum / c.n;
    const chopAcc = (100 * c.chop_correct) / c.n;
    md.push(
      `| ${labelOf[key]} | ${c.n} | ${p80cov.toFixed(1)}% (target 80%) | ${bandW.toFixed(1)} (${p20p80cov.toFixed(0)}% in-band) | ${rangeMAE.toFixed(1)} | ${absDp80cov.toFixed(1)}% | ${brier.toFixed(3)} | ${chopAcc.toFixed(1)}% |`,
    );
  }
  md.push('');
  md.push(
    `**How to read:**  \n` +
      `- **Range p80 coverage** — % of actual ranges ≤ cohort p80. Well-calibrated = 80%. Above 80% = cohort overestimates; below = underestimates.  \n` +
      `- **p20-p80 band width** — mean width of cohort's 20-80 predicted range in points. *Smaller is better AT SAME coverage.* Narrower band = more information. Global baseline is the "do-nothing" reference.  \n` +
      `- **Range MAE** — mean absolute error between cohort's predicted median range (p50) and actual realized range. Lower is better.  \n` +
      `- **|ΔClose| p80 coverage** — same idea for close-to-open move size. Relevant for expected drift.  \n` +
      `- **Chop Brier** — mean squared error between predicted chop probability and actual chop/trend outcome. Lower is better. Global baseline is the skill floor.  \n` +
      `- **Chop classify acc** — did cohort's majority-vote (chop if rate ≥ 50%) match actual?\n`,
  );

  // Quantile-sweep calibration curve.
  md.push(
    `### Range calibration curve (actual coverage at each nominal cohort percentile)\n`,
  );
  md.push(
    `For each cohort's nominal percentile, what fraction of actual ranges fell ≤ the cohort's value at that percentile? Well-calibrated = diagonal (50→50%, 80→80%). Reading off this curve gives you the empirical-to-nominal mapping: to get honest 80%-coverage strike placement, find the row where "Text" or "Features" hits ~80% and use that nominal percentile.\n`,
  );
  const qHeaderCells = CALIB_QUANTILES.map(
    (q) => `p${Math.round(q * 100)}`,
  ).join(' | ');
  md.push(`| Backend | ${qHeaderCells} |`);
  md.push(`| --- ${' | ---'.repeat(CALIB_QUANTILES.length)} |`);
  for (const key of order) {
    const c = calib[key];
    if (c.n === 0) continue;
    const cells = CALIB_QUANTILES.map((q) => {
      const pct = (100 * c.rangeCoverageByQ[q]) / c.n;
      return `${pct.toFixed(0)}%`;
    }).join(' | ');
    md.push(`| ${labelOf[key]} | ${cells} |`);
  }
  md.push('');

  md.push(
    `### |ΔClose| calibration curve (actual coverage at each nominal cohort percentile)\n`,
  );
  md.push(
    `Same analysis for absolute close-to-open move. Drives strike placement on the non-wing side (credit spreads where the *directional* side matters more than total range).\n`,
  );
  md.push(`| Backend | ${qHeaderCells} |`);
  md.push(`| --- ${' | ---'.repeat(CALIB_QUANTILES.length)} |`);
  for (const key of order) {
    const c = calib[key];
    if (c.n === 0) continue;
    const cells = CALIB_QUANTILES.map((q) => {
      const pct = (100 * c.absDeltaCoverageByQ[q]) / c.n;
      return `${pct.toFixed(0)}%`;
    }).join(' | ');
    md.push(`| ${labelOf[key]} | ${cells} |`);
  }
  md.push('');

  // Asymmetric excursion — only populated when sidecar ships up/down
  // excursion numbers (post-deploy). Skipped silently when not available.
  const anyExcursion = Object.values(calib).some((c) => c.excursionN > 0);
  if (anyExcursion) {
    md.push(`### Upside excursion calibration (high − open)\n`);
    md.push(
      `How high above open did price stretch? Drives the CALL-side strike. Well-calibrated means cohort p80 covers actual 80% of the time. Narrower p80 at 80% coverage = real information for call-wing placement.\n`,
    );
    md.push(`| Backend | N | ${qHeaderCells} |`);
    md.push(`| --- | --- ${' | ---'.repeat(CALIB_QUANTILES.length)} |`);
    for (const key of order) {
      const c = calib[key];
      if (c.excursionN === 0) continue;
      const cells = CALIB_QUANTILES.map((q) => {
        const pct = (100 * c.upExcCoverageByQ[q]) / c.excursionN;
        return `${pct.toFixed(0)}%`;
      }).join(' | ');
      md.push(`| ${labelOf[key]} | ${c.excursionN} | ${cells} |`);
    }
    md.push('');

    md.push(`### Downside excursion calibration (open − low)\n`);
    md.push(
      `How far below open did price stretch? Drives the PUT-side strike. Independent of upside — asymmetric strikes live or die on calibrating these separately.\n`,
    );
    md.push(`| Backend | N | ${qHeaderCells} |`);
    md.push(`| --- | --- ${' | ---'.repeat(CALIB_QUANTILES.length)} |`);
    for (const key of order) {
      const c = calib[key];
      if (c.excursionN === 0) continue;
      const cells = CALIB_QUANTILES.map((q) => {
        const pct = (100 * c.downExcCoverageByQ[q]) / c.excursionN;
        return `${pct.toFixed(0)}%`;
      }).join(' | ');
      md.push(`| ${labelOf[key]} | ${c.excursionN} | ${cells} |`);
    }
    md.push('');

    md.push(`### Strike-placement cheat sheet (median p80 excursions)\n`);
    md.push(
      `Median cohort p80 up/down excursion — the number you'd use to place asymmetric short strikes at ~80% coverage. Global is the "no-info" fallback.\n`,
    );
    md.push(`| Backend | N | Up p50 | Up p80 | Down p50 | Down p80 |`);
    md.push(`| --- | --- | --- | --- | --- | --- |`);
    for (const key of order) {
      const c = calib[key];
      if (c.excursionN === 0) continue;
      const n = c.excursionN;
      md.push(
        `| ${labelOf[key]} | ${n} | ${(c.upExc_p50_width_sum / n).toFixed(1)}pt | ${(c.upExc_p80_width_sum / n).toFixed(1)}pt | ${(c.downExc_p50_width_sum / n).toFixed(1)}pt | ${(c.downExc_p80_width_sum / n).toFixed(1)}pt |`,
      );
    }
    md.push('');
  }

  // Stratified calibration. For each regime bucket, emit range p80
  // coverage + band width for text/features/global. Tells you where
  // cohort conditioning gains (or loses) information.
  md.push(`### Stratified range calibration (by regime)\n`);
  md.push(
    `Range p80 coverage and band width broken out by VIX regime and first-hour bias. Information gain concentrates where the cohort can distinguish "today's day" from the unconditional average.\n`,
  );
  const stratDims = [
    {
      dim: 'vix',
      label: 'VIX regime',
      order: ['low', 'normal', 'elevated', 'crisis', 'unknown'],
    },
    {
      dim: 'openBias',
      label: 'First-hour bias',
      order: [
        'strong-down',
        'mild-down',
        'flat',
        'mild-up',
        'strong-up',
        'unknown',
      ],
    },
  ];
  for (const { dim, label, order: bucketOrder } of stratDims) {
    md.push(`**${label}**  `);
    md.push(
      `| Bucket | N | Text cov% | Text band | Feat cov% | Feat band | Global cov% | Global band | Text vs Global band |`,
    );
    md.push(`| --- | --- | --- | --- | --- | --- | --- | --- | --- |`);
    const buckets = Object.keys(stratCalib[dim]);
    const ordered = bucketOrder.filter((b) => buckets.includes(b));
    for (const bucket of ordered) {
      const slots = stratCalib[dim][bucket];
      const t = slots.text;
      const f = slots.features;
      const g = slots.global;
      if (t.n === 0 || g.n === 0) continue;
      const pct = (slot) => (100 * slot.p80_covered) / slot.n;
      const w = (slot) => slot.p20_p80_width_sum / slot.n;
      const gap = w(t) - w(g);
      md.push(
        `| ${bucket} | ${t.n} | ${pct(t).toFixed(0)}% | ${w(t).toFixed(1)} | ${pct(f).toFixed(0)}% | ${w(f).toFixed(1)} | ${pct(g).toFixed(0)}% | ${w(g).toFixed(1)} | ${gap >= 0 ? '+' : ''}${gap.toFixed(1)} |`,
      );
    }
    md.push('');
  }

  md.push(`## Stratified hit rates\n`);
  md.push(
    `For each regime dimension, hit rate broken out by bucket. A bucket where one backend meaningfully beats the other (≥10pt gap) AND has decent sample size (≥10 dates) is where the cohort is actually informative.\n`,
  );
  const dimLabels = {
    dow: 'Day of week',
    openBias: 'First-hour bias (delta bucket)',
    openRange: 'First-hour range bucket',
    year: 'Year',
    vix: 'VIX regime (close-of-prior-day)',
    priorSign: 'Prior-day return sign (momentum, Path 3 filter)',
  };
  const bucketOrder = {
    dow: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'],
    openBias: ['strong-down', 'mild-down', 'flat', 'mild-up', 'strong-up'],
    openRange: ['tight', 'normal', 'wide'],
    year: null,
    vix: ['low', 'normal', 'elevated', 'crisis'],
    priorSign: ['down', 'flat', 'up'],
  };
  for (const dim of [
    'dow',
    'openBias',
    'openRange',
    'year',
    'vix',
    'priorSign',
  ]) {
    md.push(`### ${dimLabels[dim]}\n`);
    md.push(
      `| Bucket | N | Text | Features | Regime-filtered | Enriched (P3-real) | Enriched vs Features |`,
    );
    md.push(`| --- | --- | --- | --- | --- | --- | --- |`);
    const entries = Object.entries(strata[dim]);
    const ordered =
      bucketOrder[dim] !== null
        ? bucketOrder[dim]
            .filter((v) => strata[dim][v])
            .map((v) => [v, strata[dim][v]])
        : entries.sort(([a], [b]) => a.localeCompare(b));
    for (const [value, bucket] of ordered) {
      const tPct = ((100 * bucket.textHits) / Math.max(1, bucket.n)).toFixed(0);
      const fPct = (
        (100 * bucket.featuresHits) /
        Math.max(1, bucket.n)
      ).toFixed(0);
      const rPct = ((100 * bucket.regimeHits) / Math.max(1, bucket.n)).toFixed(
        0,
      );
      const ePct = (
        (100 * bucket.enrichedHits) /
        Math.max(1, bucket.n)
      ).toFixed(0);
      const eGap = Number(ePct) - Number(fPct);
      const eGapMark = Math.abs(eGap) >= 5 && bucket.n >= 10 ? ' ◂' : '';
      md.push(
        `| ${value} | ${bucket.n} | ${bucket.textHits}/${bucket.n} (${tPct}%) | ${bucket.featuresHits}/${bucket.n} (${fPct}%) | ${bucket.regimeHits}/${bucket.n} (${rPct}%) | ${bucket.enrichedHits}/${bucket.n} (${ePct}%) | ${eGap >= 0 ? '+' : ''}${eGap.toFixed(0)}%${eGapMark} |`,
      );
    }
    md.push('');
  }

  md.push(`## Interesting disagreements (${disagreements.length})\n`);
  md.push(
    `Target dates where the two backends predicted OPPOSITE directions. The Winner column shows which backend (if either) matched the actual outcome. These are the days with the highest information value for deciding which backend to trust.\n`,
  );
  md.push(`| Date | Actual | Text pred | Features pred | Winner |`);
  md.push(`| --- | --- | --- | --- | --- |`);
  for (const d of disagreements) {
    const winner =
      d.actualDir === d.tPred
        ? 'text'
        : d.actualDir === d.fPred
          ? 'features'
          : '---';
    md.push(
      `| ${d.date} | ${d.actualDir} | ${d.tPred} | ${d.fPred} | ${winner} |`,
    );
  }
  md.push('');

  md.push(`## Per-date detail\n`);
  md.push(
    `| Date | Actual Δ | Text pred (up %) | Features pred (up %) | Overlap | T hit | F hit |`,
  );
  md.push(`| --- | --- | --- | --- | --- | --- | --- |`);
  for (const r of rows) {
    md.push(
      `| ${r.date} | ${r.actualDelta.toFixed(2)} (${r.actualDir ?? '?'}) | ${r.tPred ?? '?'} (${(100 * r.tUpFrac).toFixed(0)}%) | ${r.fPred ?? '?'} (${(100 * r.fUpFrac).toFixed(0)}%) | ${r.overlap}/${K} | ${r.tHit ? '✓' : '✗'} | ${r.fHit ? '✓' : '✗'} |`,
    );
  }
  md.push('');

  writeFileSync(OUT, md.join('\n'), 'utf8');
  console.log(`\n✓ Wrote ${OUT}`);
  console.log(
    `  text hit rate ${textRate.toFixed(1)}%  |  features hit rate ${featuresRate.toFixed(1)}%  |  overlap ${overlapMean.toFixed(1)}/${K}`,
  );
}

try {
  await run();
} catch (err) {
  console.error('Comparison failed:', err);
  exit(1);
}
