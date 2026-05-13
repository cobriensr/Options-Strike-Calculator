#!/usr/bin/env node

/**
 * Probe: MM-attributed bias calibration distribution.
 *
 * Reads the last 5 trading days of gamma slots from periscope_snapshots,
 * joins each with the SPX spot at captured_at from index_candles_1m,
 * then replays the GexLandscape bias logic in JS to surface:
 *
 *   - Verdict distribution (how often each label fires)
 *   - |gravityOffset| percentiles (does SPX_SPOT_BAND = 25 fit the data?)
 *   - Total net GEX sign distribution (regime balance)
 *   - Floor/Ceiling Δ% magnitudes at 10m + 30m (are trend cols useful?)
 *   - Per-strike gamma magnitudes near ATM
 *
 * Output is for human eyeballing — decisions like "tighten SPX_SPOT_BAND"
 * or "drop a trend column" come from looking at the printed percentiles.
 *
 * Usage:
 *   DATABASE_URL="postgresql://..." node scripts/probe-mm-bias-calibration.mjs
 */

import { neon } from '@neondatabase/serverless';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('Missing DATABASE_URL');
  process.exit(1);
}

const sql = neon(DATABASE_URL);

// Mirror the runtime constants from constants.ts so the probe replays
// the SAME logic against historical slots. Update these here if the
// runtime values change.
const PRICE_WINDOW = 50;
const SPX_SPOT_BAND = 25;
const DAYS = 5;

function percentile(arr, p) {
  if (arr.length === 0) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(
    sorted.length - 1,
    Math.floor((p / 100) * sorted.length),
  );
  return sorted[idx];
}

function summary(label, arr) {
  if (arr.length === 0) {
    console.log(`  ${label}: n=0 (empty)`);
    return;
  }
  const min = Math.min(...arr);
  const max = Math.max(...arr);
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  console.log(
    `  ${label}: n=${arr.length} min=${min.toFixed(2)} ` +
      `p10=${percentile(arr, 10).toFixed(2)} ` +
      `p50=${percentile(arr, 50).toFixed(2)} ` +
      `p90=${percentile(arr, 90).toFixed(2)} ` +
      `max=${max.toFixed(2)} mean=${mean.toFixed(2)}`,
  );
}

async function main() {
  // 1. Fetch all gamma rows for the last N trading days.
  const gammaRows = await sql`
    SELECT captured_at, strike, value::float8 AS gamma
    FROM periscope_snapshots
    WHERE panel = 'gamma'
      AND captured_at >= NOW() - (${DAYS + 2} || ' days')::interval
    ORDER BY captured_at ASC, strike ASC
  `;
  console.log(`Loaded ${gammaRows.length} gamma rows`);

  // 2. Group by captured_at into per-slot strike maps. JS Map preserves
  // insertion order so iteration order matches captured_at ascending.
  const slotByCapturedAt = new Map();
  for (const r of gammaRows) {
    const key =
      r.captured_at instanceof Date
        ? r.captured_at.toISOString()
        : r.captured_at;
    if (!slotByCapturedAt.has(key)) slotByCapturedAt.set(key, []);
    slotByCapturedAt.get(key).push({ strike: r.strike, gamma: r.gamma });
  }
  const slotKeys = [...slotByCapturedAt.keys()];
  console.log(`Distinct slots: ${slotKeys.length}`);

  if (slotKeys.length === 0) {
    console.log('No data — exiting');
    return;
  }

  // 3. Fetch SPX spot at each captured_at. Use a single query with the
  // slot list to amortize the lateral join cost.
  const slotIsoList = slotKeys.map((k) => k);
  const spotRows = await sql`
    SELECT ic.timestamp::text AS ts, ic.close::float8 AS spot
    FROM unnest(${slotIsoList}::timestamptz[]) AS t(captured_at)
    JOIN LATERAL (
      SELECT timestamp, close
      FROM index_candles_1m
      WHERE symbol = 'SPX'
        AND date = (t.captured_at AT TIME ZONE 'America/Chicago')::date
        AND timestamp <= t.captured_at
      ORDER BY timestamp DESC
      LIMIT 1
    ) ic ON true
  `;
  // The lateral join returns rows in input order, but to be safe we
  // build a spot lookup by approximate captured_at — actually the
  // unnest-with-lateral pattern doesn't reliably preserve order so we
  // fetch the spot per slot via a Map keyed on the slot's
  // captured_at minute.
  const spotByMinute = new Map();
  for (const r of spotRows) {
    // Truncate spot timestamp to the minute so we can look up by the
    // slot's captured_at minute.
    const minute = r.ts.slice(0, 16);
    spotByMinute.set(minute, r.spot);
  }

  // 4. Walk slots ascending, compute bias metrics, accumulate stats.
  const verdictCount = new Map();
  const regimeCount = { positive: 0, negative: 0 };
  const gravityOffsets = [];
  const gravityGexs = [];
  const totalNetGexs = [];
  const floorTrend10m = [];
  const ceilingTrend10m = [];
  const floorTrend30m = [];
  const ceilingTrend30m = [];
  // Per-strike gamma absolute magnitudes near ATM (within band).
  const atmGammaAbs = [];
  let slotsWithoutSpot = 0;
  let slotsAnalyzed = 0;

  // Maintain a slot-keyed gamma map so we can compute Δ% to prior 1/3
  // slots. The slot list is ascending; for each slot we look up the
  // slot at index-1 (10m) and index-3 (30m).
  const slotGammaMaps = slotKeys.map((k) => {
    const m = new Map();
    for (const s of slotByCapturedAt.get(k)) m.set(s.strike, s.gamma);
    return m;
  });

  for (let i = 0; i < slotKeys.length; i++) {
    const key = slotKeys[i];
    const strikes = slotByCapturedAt.get(key);
    if (!strikes || strikes.length === 0) continue;

    // Look up SPX spot near this captured_at (truncate to the minute).
    // Lateral join in step 3 already pulled the at-or-before close.
    // Fall back to scanning if the minute key isn't found exactly.
    const minute = new Date(key).toISOString().slice(0, 16);
    let spot = spotByMinute.get(minute);
    if (!spot) {
      // Scan within ±2 min for a usable spot.
      const captTs = new Date(key).getTime();
      for (const [mk, sv] of spotByMinute) {
        const mt = new Date(mk + ':00.000Z').getTime();
        if (Math.abs(mt - captTs) <= 120_000) {
          spot = sv;
          break;
        }
      }
    }
    if (!spot) {
      slotsWithoutSpot++;
      continue;
    }
    slotsAnalyzed++;

    // Filter to ±PRICE_WINDOW pts, then compute regime + gravity.
    const inWindow = strikes.filter(
      (s) => Math.abs(s.strike - spot) <= PRICE_WINDOW,
    );
    if (inWindow.length === 0) continue;

    let totalNetGex = 0;
    let gravity = inWindow[0];
    for (const s of inWindow) {
      totalNetGex += s.gamma;
      if (Math.abs(s.gamma) > Math.abs(gravity.gamma)) gravity = s;
      if (Math.abs(s.strike - spot) <= SPX_SPOT_BAND) {
        atmGammaAbs.push(Math.abs(s.gamma));
      }
    }
    const regime = totalNetGex >= 0 ? 'positive' : 'negative';
    const gravityOffset = gravity.strike - spot;

    let verdict;
    if (Math.abs(gravityOffset) <= SPX_SPOT_BAND) {
      verdict = regime === 'negative' ? 'volatile' : 'rangebound';
    } else if (gravityOffset > 0) {
      verdict = regime === 'negative' ? 'breakout-risk-up' : 'gex-pull-up';
    } else {
      verdict = regime === 'negative' ? 'breakdown-risk-down' : 'gex-pull-down';
    }
    if (verdict === 'gex-pull-down') verdict = 'gex-floor-below';

    verdictCount.set(verdict, (verdictCount.get(verdict) ?? 0) + 1);
    regimeCount[regime]++;
    gravityOffsets.push(Math.abs(gravityOffset));
    gravityGexs.push(Math.abs(gravity.gamma));
    totalNetGexs.push(totalNetGex);

    // Δ% trends — 10m (i-1) and 30m (i-3) priors.
    const prior10m = slotGammaMaps[i - 1] ?? null;
    const prior30m = slotGammaMaps[i - 3] ?? null;

    const above = inWindow.filter((s) => s.strike > spot + SPX_SPOT_BAND);
    const below = inWindow.filter((s) => s.strike < spot - SPX_SPOT_BAND);

    const trendAvg = (slice, prior) => {
      if (!prior) return null;
      const pcts = [];
      for (const s of slice) {
        const p = prior.get(s.strike);
        if (p === undefined || p === 0) continue;
        pcts.push(((s.gamma - p) / Math.abs(p)) * 100);
      }
      return pcts.length > 0
        ? pcts.reduce((a, b) => a + b, 0) / pcts.length
        : null;
    };

    const f10 = trendAvg(below, prior10m);
    const c10 = trendAvg(above, prior10m);
    const f30 = trendAvg(below, prior30m);
    const c30 = trendAvg(above, prior30m);
    if (f10 !== null) floorTrend10m.push(f10);
    if (c10 !== null) ceilingTrend10m.push(c10);
    if (f30 !== null) floorTrend30m.push(f30);
    if (c30 !== null) ceilingTrend30m.push(c30);
  }

  // 5. Print findings.
  console.log('\n=== Slots ===');
  console.log(`  Analyzed: ${slotsAnalyzed}`);
  console.log(`  Skipped (no spot): ${slotsWithoutSpot}`);

  console.log('\n=== Verdict distribution ===');
  const verdictTotal = [...verdictCount.values()].reduce((a, b) => a + b, 0);
  for (const [v, c] of [...verdictCount.entries()].sort(
    (a, b) => b[1] - a[1],
  )) {
    const pct = ((c / verdictTotal) * 100).toFixed(1);
    console.log(`  ${v.padEnd(25)} ${c} (${pct}%)`);
  }

  console.log('\n=== Regime ===');
  console.log(
    `  positive: ${regimeCount.positive} ` +
      `(${((regimeCount.positive / verdictTotal) * 100).toFixed(1)}%)`,
  );
  console.log(
    `  negative: ${regimeCount.negative} ` +
      `(${((regimeCount.negative / verdictTotal) * 100).toFixed(1)}%)`,
  );

  console.log('\n=== |gravityOffset| (does SPX_SPOT_BAND=25 fit?) ===');
  summary('|gravityOffset|', gravityOffsets);
  const inBand = gravityOffsets.filter((g) => g <= SPX_SPOT_BAND).length;
  console.log(
    `  ${inBand} of ${gravityOffsets.length} (${((inBand / gravityOffsets.length) * 100).toFixed(1)}%) ` +
      `have |offset| <= ${SPX_SPOT_BAND} (ATM → rangebound/volatile)`,
  );

  console.log('\n=== Gravity GEX magnitude ===');
  summary('|gravityGamma|', gravityGexs);

  console.log('\n=== Total net GEX ===');
  summary('totalNetGex', totalNetGexs);

  console.log('\n=== Floor/Ceiling Δ% — 10m window ===');
  summary('floorTrend10m', floorTrend10m);
  summary('ceilingTrend10m', ceilingTrend10m);

  console.log('\n=== Floor/Ceiling Δ% — 30m window ===');
  summary('floorTrend30m', floorTrend30m);
  summary('ceilingTrend30m', ceilingTrend30m);

  console.log('\n=== ATM strike gamma magnitudes (within band) ===');
  summary('|gamma| @ ATM', atmGammaAbs);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
