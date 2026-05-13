#!/usr/bin/env node

/**
 * Verify a single GEX Landscape snapshot against periscope_snapshots.
 *
 * Replays the hook + bias logic in JS for a given (date, CT time) so the
 * panel's rendered numbers can be cross-checked against the source data.
 * Prints:
 *   - Slot resolution (captured_at)
 *   - SPX spot at that moment
 *   - GEX gravity (strike + offset)
 *   - Verdict + regime
 *   - Top 5 strikes by |gamma| with gamma / charm / 10m Δ% / 30m Δ%
 *   - Floor / Ceiling 10m + 30m trend averages
 *
 * Usage:
 *   DATABASE_URL="postgresql://..." node scripts/verify-periscope-snapshot.mjs \
 *     --date 2026-05-12 --time 09:50
 */

import { neon } from '@neondatabase/serverless';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('Missing DATABASE_URL');
  process.exit(1);
}
const sql = neon(DATABASE_URL);

// Mirror runtime constants from src/components/GexLandscape/constants.ts
// and src/hooks/useGexLandscapeData.ts so the probe stays in sync with
// what the panel actually computes.
const PRICE_WINDOW = 50;
const SPX_SPOT_BAND = 25;
const DELTA_NOISE_FLOOR = 100;

// ── Args ───────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
let date = '';
let time = '';
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--date') date = args[i + 1] ?? '';
  if (args[i] === '--time') time = args[i + 1] ?? '';
}
if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) {
  console.error('Need --date YYYY-MM-DD --time HH:MM (CT)');
  process.exit(1);
}

// Convert CT wall-clock → UTC ISO. CDT (May) = UTC-5. Use Intl-safe
// math: compute the wall-clock minute as a Date in America/Chicago and
// take its ISO string.
function ctToUtcIso(dateStr, hhmm) {
  // Build a UTC date with the wall-clock fields, then offset by the
  // CT→UTC delta. For May this is +5h.
  const [h, m] = hhmm.split(':').map(Number);
  // CDT = UTC-5 from second Sunday of March; CST = UTC-6 from first
  // Sunday of November. Use Intl to compute the offset at this date.
  const probe = new Date(`${dateStr}T${hhmm}:00-05:00`);
  // Verify with Intl that we're in CDT at this date. If we'd been in
  // CST instead, we'd be off by an hour — surface that.
  const ctFmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(probe);
  if (ctFmt !== `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`) {
    // Re-anchor as CST.
    return new Date(`${dateStr}T${hhmm}:00-06:00`).toISOString();
  }
  return probe.toISOString();
}

const targetUtcIso = ctToUtcIso(date, time);
// Round UP to end-of-minute (matches the endpoint's endOfMinute rule).
const asOfDate = new Date(targetUtcIso);
asOfDate.setUTCSeconds(59, 999);
const asOfIso = asOfDate.toISOString();

console.log(`Target CT: ${date} ${time}`);
console.log(`Target UTC asOf: ${asOfIso}`);

async function main() {
  // 1. Resolve the latest slot at-or-before asOf.
  const slotRow = await sql`
    SELECT MAX(captured_at) AS captured_at
    FROM periscope_snapshots
    WHERE expiry = ${date} AND panel = 'gamma' AND captured_at <= ${asOfIso}
  `;
  const capturedAt = slotRow[0]?.captured_at;
  if (!capturedAt) {
    console.log('No slot at-or-before asOf');
    return;
  }
  const capturedIso =
    capturedAt instanceof Date ? capturedAt.toISOString() : capturedAt;
  console.log(`Resolved slot: ${capturedIso}`);

  // 2. Get SPX spot at the captured_at.
  const spotRow = await sql`
    SELECT close::float8 AS close
    FROM index_candles_1m
    WHERE symbol = 'SPX' AND date = ${date} AND timestamp <= ${capturedIso}
    ORDER BY timestamp DESC LIMIT 1
  `;
  const spot = spotRow[0]?.close;
  if (!spot) {
    console.log('No SPX spot');
    return;
  }
  console.log(`SPX spot: ${spot.toFixed(2)}`);

  // 3. Get gamma + charm panels for the resolved slot.
  const panelRows = await sql`
    SELECT panel, strike, value::float8 AS value
    FROM periscope_snapshots
    WHERE expiry = ${date} AND captured_at = ${capturedIso}
      AND panel IN ('gamma', 'charm')
    ORDER BY panel, strike
  `;
  const byStrike = new Map();
  for (const r of panelRows) {
    const cur = byStrike.get(r.strike) ?? {
      strike: r.strike,
      gamma: 0,
      charm: 0,
    };
    if (r.panel === 'gamma') cur.gamma = r.value;
    else cur.charm = r.value;
    byStrike.set(r.strike, cur);
  }
  const allStrikes = [...byStrike.values()].sort((a, b) => a.strike - b.strike);

  // 4. Filter to ±PRICE_WINDOW pts. Compute regime + gravity within window.
  const inWindow = allStrikes.filter(
    (s) => Math.abs(s.strike - spot) <= PRICE_WINDOW,
  );
  let totalNetGex = 0;
  let gravity = inWindow[0];
  for (const s of inWindow) {
    totalNetGex += s.gamma;
    if (Math.abs(s.gamma) > Math.abs(gravity.gamma)) gravity = s;
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

  console.log('');
  console.log('=== Bias ===');
  console.log(`  Verdict: ${verdict}`);
  console.log(`  Regime: ${regime} (total net γ = ${totalNetGex.toFixed(0)})`);
  console.log(
    `  Gravity: strike=${gravity.strike} offset=${gravityOffset >= 0 ? '+' : ''}${gravityOffset.toFixed(2)}pts γ=${gravity.gamma.toFixed(0)}`,
  );

  // 5. Get 10m-prior and 30m-prior slots for Δ%.
  const priorSlots = await sql`
    SELECT DISTINCT captured_at
    FROM periscope_snapshots
    WHERE expiry = ${date} AND panel = 'gamma' AND captured_at < ${capturedIso}
    ORDER BY captured_at DESC LIMIT 5
  `;
  const priorCaptureds = priorSlots.map((r) =>
    r.captured_at instanceof Date ? r.captured_at.toISOString() : r.captured_at,
  );
  const slot10m = priorCaptureds[0] ?? null;
  const slot30m = priorCaptureds[2] ?? null;

  async function loadGammaMap(capturedIso) {
    if (!capturedIso) return null;
    const rows = await sql`
      SELECT strike, value::float8 AS gamma
      FROM periscope_snapshots
      WHERE expiry = ${date} AND panel = 'gamma' AND captured_at = ${capturedIso}
    `;
    const m = new Map();
    for (const r of rows) m.set(r.strike, r.gamma);
    return m;
  }
  const prior10m = await loadGammaMap(slot10m);
  const prior30m = await loadGammaMap(slot30m);
  console.log(`  Prior 10m slot: ${slot10m ?? 'none'}`);
  console.log(`  Prior 30m slot: ${slot30m ?? 'none'}`);

  function deltaPct(curr, prior) {
    if (!prior) return null;
    const p = prior.get(curr.strike);
    if (p === undefined || Math.abs(p) < DELTA_NOISE_FLOOR) return null;
    return ((curr.gamma - p) / Math.abs(p)) * 100;
  }
  function fmtPct(v) {
    if (v === null) return '—';
    return `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`;
  }
  function fmtVal(v) {
    const abs = Math.abs(v);
    const sign = v < 0 ? '−' : '+';
    if (abs >= 1e9) return `${sign}${(abs / 1e9).toFixed(1)}B`;
    if (abs >= 1e6) return `${sign}${(abs / 1e6).toFixed(1)}M`;
    if (abs >= 1e3) return `${sign}${(abs / 1e3).toFixed(0)}K`;
    return `${sign}${abs.toFixed(0)}`;
  }

  // 6. Top 5 by |gamma|.
  const top5 = [...inWindow]
    .sort((a, b) => Math.abs(b.gamma) - Math.abs(a.gamma))
    .slice(0, 5);

  console.log('');
  console.log('=== Top 5 strikes within ±50pt window ===');
  console.log('  strike | offset    | gamma   | charm   | 10m Δ%  | 30m Δ%');
  for (const s of top5) {
    const offset = s.strike - spot;
    const d10 = deltaPct(s, prior10m);
    const d30 = deltaPct(s, prior30m);
    console.log(
      `  ${s.strike.toString().padStart(5)}  | ${(offset >= 0 ? '+' : '') + offset.toFixed(2).padStart(7)}pts | ${fmtVal(s.gamma).padStart(7)} | ${fmtVal(s.charm).padStart(7)} | ${fmtPct(d10).padStart(7)} | ${fmtPct(d30).padStart(7)}`,
    );
  }

  // 7. Floor / Ceiling 10m + 30m trend averages (above/below ± SPX_SPOT_BAND).
  const above = inWindow.filter((s) => s.strike > spot + SPX_SPOT_BAND);
  const below = inWindow.filter((s) => s.strike < spot - SPX_SPOT_BAND);
  const avgPct = (slice, prior) => {
    if (!prior) return null;
    const pcts = [];
    for (const s of slice) {
      const v = deltaPct(s, prior);
      if (v !== null) pcts.push(v);
    }
    return pcts.length > 0
      ? pcts.reduce((a, b) => a + b, 0) / pcts.length
      : null;
  };

  console.log('');
  console.log('=== Floor / Ceiling trends ===');
  console.log(`  10m floor: ${fmtPct(avgPct(below, prior10m))}`);
  console.log(`  10m ceil:  ${fmtPct(avgPct(above, prior10m))}`);
  console.log(`  30m floor: ${fmtPct(avgPct(below, prior30m))}`);
  console.log(`  30m ceil:  ${fmtPct(avgPct(above, prior30m))}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
