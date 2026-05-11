#!/usr/bin/env node

/**
 * Grade every completed auto-generated Periscope playbook for a
 * trading date using the deterministic grader
 * (api/_lib/periscope-grader.ts).
 *
 * Phase 3 of docs/superpowers/specs/periscope-calibration-grading-2026-05-11.md.
 *
 * # Usage
 *
 *   source .env.local
 *   node scripts/grade-periscope-day.mjs --date 2026-05-08
 *
 *   # Range (one day at a time, sequentially):
 *   for d in 2026-05-06 2026-05-07 2026-05-08; do
 *     node scripts/grade-periscope-day.mjs --date $d
 *   done
 *
 *   # Dry run — counts slots and shows what would be graded
 *   node scripts/grade-periscope-day.mjs --date 2026-05-08 --dry-run
 *
 * # What it does
 *
 *  1. Pulls all `periscope_analyses` rows for the date where
 *     auto_generated=TRUE AND status='complete'
 *  2. For each row: fetches SPX 1m candles [slot, 15:00 CT], ES + NQ
 *     candles over the same window, and SPX prior-30-min candles (for
 *     ATR)
 *  3. Calls gradePlaybook() to compute the structured Grade
 *  4. UPSERTs into periscope_grades (ON CONFLICT (periscope_analysis_id,
 *     grader_version) DO UPDATE — re-running re-grades cleanly)
 *  5. Prints summary: total graded, % correct per dimension, sim PnL
 *     totals per asset
 *
 * # Idempotent
 *
 * Re-running for the same date overwrites prior grades for the same
 * GRADER_VERSION. To preserve old grades when shipping a new rubric,
 * bump GRADER_VERSION in api/_lib/periscope-grades-types.ts BEFORE
 * running — the unique (analysis_id, version) constraint lets v1 and
 * v2 grades coexist on the same playbook for compare.
 *
 * # Required env vars
 *
 *   DATABASE_URL — Neon Postgres
 */

// Run with: npx tsx scripts/grade-periscope-day.mjs --date YYYY-MM-DD
// tsx maps the .js extensions below to the .ts source files.

import process from 'node:process';
import { neon } from '@neondatabase/serverless';
import { gradePlaybook } from '../api/_lib/periscope-grader.js';
import { GRADER_VERSION } from '../api/_lib/periscope-grades-types.js';

const DATABASE_URL = required('DATABASE_URL');

function required(name) {
  const v = process.env[name];
  if (v == null || v.trim() === '') {
    console.error(`ERROR: missing required env var ${name}`);
    process.exit(1);
  }
  return v.trim();
}

function parseDateFlag() {
  const argv = process.argv;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--date') return validate(argv[i + 1] ?? '', '--date');
    if (a.startsWith('--date=')) return validate(a.slice(7), '--date=');
  }
  return null;
}

function validate(value, label) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    console.error(`ERROR: ${label} requires YYYY-MM-DD, got "${value}"`);
    process.exit(1);
  }
  return value;
}

const DATE = parseDateFlag();
if (DATE == null) {
  console.error('ERROR: --date YYYY-MM-DD is required');
  process.exit(1);
}
const DRY = process.argv.includes('--dry-run');

const sql = neon(DATABASE_URL);

/**
 * EOD in CT for the trading date — 15:00 CT (0DTE SPX cash settle
 * reference). Convert to UTC for the candle query. CT is UTC-5 in
 * summer (CDT, Mar–Nov) and UTC-6 in winter (CST). We rely on the
 * date being in 2026-03-09 or later (DST active) for current usage;
 * a more rigorous Intl-based conversion would work year-round but
 * adds complexity for a script that only runs on recent dates.
 */
function eodForDate(dateStr) {
  // Use a UTC anchor and let JS render the CT moment indirectly. We
  // pick the UTC instant that corresponds to 15:00 CT on the given
  // date — implemented via toLocaleString round-trip for safety.
  // Cheap approximation for May: CT = UTC-5 → 15:00 CT = 20:00 UTC.
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 20, 0, 0));
}

async function loadPlaybooks() {
  // RTH-only filter: the auto-playbook system sometimes wrote rows for
  // pre-market scraper captures (timeframe="08:20 - 08:30" but the
  // capture actually ran at 03:30 CT during overnight scrape passes).
  // Those rows have meaningless `spot` values (stale UW panel) so the
  // grader's bias / regime / sim outputs are garbage for them. Filter
  // by CT wall-clock here so the aggregate stats reflect real RTH
  // playbooks only.
  const rows = await sql`
    SELECT
      id,
      mode,
      slot_captured_at,
      panel_payload,
      confidence
    FROM periscope_analyses
    WHERE trading_date = ${DATE}
      AND auto_generated = TRUE
      AND status = 'complete'
      AND (slot_captured_at AT TIME ZONE 'America/Chicago')::time
          BETWEEN '08:30' AND '15:00'
    ORDER BY slot_captured_at ASC
  `;
  return rows;
}

/**
 * Pull the daily 0DTE straddle breakeven cone from cone_levels
 * (migration #138). Used as the fallback when panel_payload.cone is
 * null. Returns {lower, upper} or null if no row.
 */
async function loadDailyCone(date) {
  const rows = await sql`
    SELECT cone_lower, cone_upper
    FROM cone_levels
    WHERE date = ${date}
  `;
  const r = rows[0];
  if (r == null || r.cone_lower == null || r.cone_upper == null) return null;
  return { lower: Number(r.cone_lower), upper: Number(r.cone_upper) };
}

async function loadSpxCandles(start, end) {
  const rows = await sql`
    SELECT timestamp AS ts, open, high, low, close
    FROM index_candles_1m
    WHERE symbol = 'SPX'
      AND timestamp >= ${start.toISOString()}
      AND timestamp <= ${end.toISOString()}
    ORDER BY timestamp ASC
  `;
  return rows.map((r) => ({
    ts: r.ts instanceof Date ? r.ts : new Date(r.ts),
    open: Number(r.open),
    high: Number(r.high),
    low: Number(r.low),
    close: Number(r.close),
  }));
}

async function loadFuturesCandles(symbol, start, end) {
  const rows = await sql`
    SELECT ts, open, high, low, close
    FROM futures_bars
    WHERE symbol = ${symbol}
      AND ts >= ${start.toISOString()}
      AND ts <= ${end.toISOString()}
    ORDER BY ts ASC
  `;
  return rows.map((r) => ({
    ts: r.ts instanceof Date ? r.ts : new Date(r.ts),
    open: Number(r.open),
    high: Number(r.high),
    low: Number(r.low),
    close: Number(r.close),
  }));
}

function parsePayload(raw) {
  if (raw == null) return null;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  return raw;
}

function toGraderPlaybook(panelPayload, fallbackCone) {
  // panel_payload uses snake_case-ish field names matching the runner
  // schema; map to camelCase for the grader. Most fields pass through
  // unchanged.
  //
  // Cone fallback: the playbook frequently omits `cone` on older
  // schemas. We fall back to the deterministic 0DTE straddle cone
  // from cone_levels (migration #138, populated daily at 9:31 ET from
  // the ATM call+put premiums). The grader needs SOME cone to do
  // cone-held / regime classification.
  const playbookCone =
    panelPayload.cone &&
    typeof panelPayload.cone === 'object' &&
    panelPayload.cone.lower != null &&
    panelPayload.cone.upper != null
      ? {
          lower: Number(panelPayload.cone.lower),
          upper: Number(panelPayload.cone.upper),
        }
      : null;
  return {
    spot: nullable(panelPayload.spot),
    cone: playbookCone ?? fallbackCone ?? null,
    longTrigger: nullable(
      panelPayload.longTrigger ?? panelPayload.long_trigger,
    ),
    shortTrigger: nullable(
      panelPayload.shortTrigger ?? panelPayload.short_trigger,
    ),
    regime: panelPayload.regime ?? null,
    bias: panelPayload.bias ?? null,
    recommended: Array.isArray(panelPayload.recommended)
      ? panelPayload.recommended
      : [],
    avoid: Array.isArray(panelPayload.avoid) ? panelPayload.avoid : [],
    gammaFloor: nullable(panelPayload.gammaFloor ?? panelPayload.gamma_floor),
    gammaCeiling: nullable(
      panelPayload.gammaCeiling ?? panelPayload.gamma_ceiling,
    ),
    magnet: nullable(panelPayload.magnet),
    charmZero: nullable(panelPayload.charmZero ?? panelPayload.charm_zero),
    confidence: panelPayload.confidence ?? null,
    charmDriftDirection: panelPayload.charmDriftDirection ?? null,
  };
}

function nullable(v) {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function upsertGrade(grade) {
  await sql`
    INSERT INTO periscope_grades (
      periscope_analysis_id, trading_date, slot_captured_at, mode,
      confidence, grader_version,
      regime_call, regime_observed, regime_correct,
      bias_call, bias_observed_return, bias_correct,
      cone_lower, cone_upper, cone_held,
      gamma_floor, gamma_floor_held, gamma_ceiling, gamma_ceiling_held,
      charm_zero, charm_drift_call, charm_drift_observed_pct, charm_drift_correct,
      long_trigger, long_fired, long_fired_at,
      short_trigger, short_fired, short_fired_at,
      trade_sims,
      eod_close, ic_blown_at_eod,
      recommended_structures_correct, avoid_structures_correct
    ) VALUES (
      ${grade.periscopeAnalysisId}, ${grade.tradingDate}, ${grade.slotCapturedAt}, ${grade.mode},
      ${grade.confidence}, ${grade.graderVersion},
      ${grade.regimeCall}, ${grade.regimeObserved}, ${grade.regimeCorrect},
      ${grade.biasCall}, ${grade.biasObservedReturn}, ${grade.biasCorrect},
      ${grade.coneLower}, ${grade.coneUpper}, ${grade.coneHeld},
      ${grade.gammaFloor}, ${grade.gammaFloorHeld}, ${grade.gammaCeiling}, ${grade.gammaCeilingHeld},
      ${grade.charmZero}, ${grade.charmDriftCall}, ${grade.charmDriftObservedPct}, ${grade.charmDriftCorrect},
      ${grade.longTrigger}, ${grade.longFired}, ${grade.longFiredAt},
      ${grade.shortTrigger}, ${grade.shortFired}, ${grade.shortFiredAt},
      ${JSON.stringify(grade.tradeSims)}::jsonb,
      ${grade.eodClose}, ${grade.icBlownAtEod},
      ${JSON.stringify(grade.recommendedStructuresCorrect)}::jsonb,
      ${JSON.stringify(grade.avoidStructuresCorrect)}::jsonb
    )
    ON CONFLICT (periscope_analysis_id, grader_version)
    DO UPDATE SET
      regime_call = EXCLUDED.regime_call,
      regime_observed = EXCLUDED.regime_observed,
      regime_correct = EXCLUDED.regime_correct,
      bias_call = EXCLUDED.bias_call,
      bias_observed_return = EXCLUDED.bias_observed_return,
      bias_correct = EXCLUDED.bias_correct,
      cone_lower = EXCLUDED.cone_lower,
      cone_upper = EXCLUDED.cone_upper,
      cone_held = EXCLUDED.cone_held,
      gamma_floor = EXCLUDED.gamma_floor,
      gamma_floor_held = EXCLUDED.gamma_floor_held,
      gamma_ceiling = EXCLUDED.gamma_ceiling,
      gamma_ceiling_held = EXCLUDED.gamma_ceiling_held,
      charm_zero = EXCLUDED.charm_zero,
      charm_drift_call = EXCLUDED.charm_drift_call,
      charm_drift_observed_pct = EXCLUDED.charm_drift_observed_pct,
      charm_drift_correct = EXCLUDED.charm_drift_correct,
      long_trigger = EXCLUDED.long_trigger,
      long_fired = EXCLUDED.long_fired,
      long_fired_at = EXCLUDED.long_fired_at,
      short_trigger = EXCLUDED.short_trigger,
      short_fired = EXCLUDED.short_fired,
      short_fired_at = EXCLUDED.short_fired_at,
      trade_sims = EXCLUDED.trade_sims,
      eod_close = EXCLUDED.eod_close,
      ic_blown_at_eod = EXCLUDED.ic_blown_at_eod,
      recommended_structures_correct = EXCLUDED.recommended_structures_correct,
      avoid_structures_correct = EXCLUDED.avoid_structures_correct,
      graded_at = NOW()
  `;
}

function bumpBinary(bucket, field, ok) {
  bucket.graded += 1;
  if (ok) bucket[field] += 1;
}

function accumulateGradeStats(grade, correctCounts, simPnl) {
  if (grade.regimeCorrect != null)
    bumpBinary(correctCounts.regime, 'correct', grade.regimeCorrect);
  if (grade.biasCorrect != null)
    bumpBinary(correctCounts.bias, 'correct', grade.biasCorrect);
  if (grade.coneHeld != null)
    bumpBinary(correctCounts.cone, 'held', grade.coneHeld);
  if (grade.gammaFloorHeld != null)
    bumpBinary(correctCounts.floor, 'held', grade.gammaFloorHeld);
  if (grade.gammaCeilingHeld != null)
    bumpBinary(correctCounts.ceiling, 'held', grade.gammaCeilingHeld);
  if (grade.charmDriftCorrect != null)
    bumpBinary(correctCounts.charm, 'correct', grade.charmDriftCorrect);
  if (grade.longFired) correctCounts.longFires += 1;
  if (grade.shortFired) correctCounts.shortFires += 1;
  if (grade.icBlownAtEod === true) correctCounts.icBlown += 1;
  if (grade.icBlownAtEod === false) correctCounts.icSafe += 1;
  for (const sim of grade.tradeSims) simPnl[sim.asset].push(sim.pnlPct);
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  Periscope Calibration Grading');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`  date:             ${DATE}`);
  console.log(`  grader version:   v${GRADER_VERSION}`);
  console.log(`  dry run:          ${DRY ? 'YES' : 'no'}`);
  console.log('');

  const playbooks = await loadPlaybooks();
  console.log(
    `▸ Found ${playbooks.length} completed auto-playbooks for ${DATE}`,
  );
  if (playbooks.length === 0) {
    console.log('  Nothing to grade.');
    return;
  }

  const eodCloseTs = eodForDate(DATE);
  const dayStart = new Date(eodCloseTs.getTime() - 8 * 60 * 60_000); // ~7:00 CT lookback for prior candles
  const dayEnd = eodCloseTs;

  // Bulk-fetch all candle data ONCE for the day, then filter per slot.
  // Cone fallback lives outside the playbook on older runs — pull it
  // once and pass to every slot whose playbook doesn't carry one.
  const [spxAll, esAll, nqAll, dailyCone] = await Promise.all([
    loadSpxCandles(dayStart, dayEnd),
    loadFuturesCandles('ES', dayStart, dayEnd),
    loadFuturesCandles('NQ', dayStart, dayEnd),
    loadDailyCone(DATE),
  ]);
  console.log(
    `  candles: SPX=${spxAll.length} ES=${esAll.length} NQ=${nqAll.length}`,
  );
  if (dailyCone) {
    console.log(
      `  cone fallback:    [${dailyCone.lower} - ${dailyCone.upper}] (cone_levels, used when payload.cone is null)`,
    );
  } else {
    console.log(
      `  cone fallback:    NONE (cone_levels has no row for ${DATE})`,
    );
  }
  console.log('');

  const correctCounts = {
    regime: { correct: 0, graded: 0 },
    bias: { correct: 0, graded: 0 },
    cone: { held: 0, graded: 0 },
    floor: { held: 0, graded: 0 },
    ceiling: { held: 0, graded: 0 },
    charm: { correct: 0, graded: 0 },
    longFires: 0,
    shortFires: 0,
    icSafe: 0,
    icBlown: 0,
  };
  const simPnl = { SPX: [], ES: [], NQ: [] };

  let graded = 0;
  for (const row of playbooks) {
    const slotCapturedAt =
      row.slot_captured_at instanceof Date
        ? row.slot_captured_at
        : new Date(row.slot_captured_at);
    const panelPayload = parsePayload(row.panel_payload);
    if (panelPayload == null) {
      console.log(
        `  ✗ skipping analysis ${row.id} — panel_payload is null/invalid`,
      );
      continue;
    }
    const graderPlaybook = toGraderPlaybook(panelPayload, dailyCone);

    // Filter candles for this slot's windows.
    const slotMs = slotCapturedAt.getTime();
    const spxAfter = spxAll.filter((c) => c.ts.getTime() >= slotMs);
    const esAfter = esAll.filter((c) => c.ts.getTime() >= slotMs);
    const nqAfter = nqAll.filter((c) => c.ts.getTime() >= slotMs);
    // Prior 30 min SPX candles for ATR.
    const priorStart = slotMs - 30 * 60_000;
    const spxPrior = spxAll.filter(
      (c) => c.ts.getTime() >= priorStart && c.ts.getTime() < slotMs,
    );

    const grade = gradePlaybook({
      periscopeAnalysisId: Number(row.id),
      tradingDate: DATE,
      slotCapturedAt,
      mode: row.mode,
      playbook: graderPlaybook,
      spxCandles: spxAfter,
      esCandles: esAfter,
      nqCandles: nqAfter,
      spxPriorCandles: spxPrior,
      eodCloseTs,
    });

    accumulateGradeStats(grade, correctCounts, simPnl);

    if (!DRY) await upsertGrade(grade);
    graded += 1;
  }

  console.log('');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`  Graded ${graded}/${playbooks.length} slots`);
  console.log('═══════════════════════════════════════════════════════════');
  printPct(
    '  regime correct       ',
    correctCounts.regime.correct,
    correctCounts.regime.graded,
  );
  printPct(
    '  bias correct         ',
    correctCounts.bias.correct,
    correctCounts.bias.graded,
  );
  printPct(
    '  cone held            ',
    correctCounts.cone.held,
    correctCounts.cone.graded,
  );
  printPct(
    '  gamma floor held     ',
    correctCounts.floor.held,
    correctCounts.floor.graded,
  );
  printPct(
    '  gamma ceiling held   ',
    correctCounts.ceiling.held,
    correctCounts.ceiling.graded,
  );
  printPct(
    '  charm drift correct  ',
    correctCounts.charm.correct,
    correctCounts.charm.graded,
  );
  console.log(
    `  long triggers fired  : ${correctCounts.longFires} / short fired: ${correctCounts.shortFires}`,
  );
  console.log(
    `  iron condor          : safe=${correctCounts.icSafe}  blown=${correctCounts.icBlown}`,
  );
  console.log('');
  for (const asset of ['SPX', 'ES', 'NQ']) {
    const pnls = simPnl[asset];
    if (pnls.length === 0) {
      console.log(`  ${asset.padEnd(3)} sims: 0 fires`);
      continue;
    }
    const total = pnls.reduce((a, b) => a + b, 0);
    const wins = pnls.filter((p) => p > 0).length;
    const meanBp = (total / pnls.length) * 10_000;
    console.log(
      `  ${asset.padEnd(3)} sims: n=${pnls.length}  win-rate=${((wins / pnls.length) * 100).toFixed(0)}%  mean=${meanBp.toFixed(1)}bp  total=${(total * 100).toFixed(2)}%`,
    );
  }
}

function printPct(label, num, denom) {
  if (denom === 0) {
    console.log(`${label}: 0/0 (ungraded)`);
    return;
  }
  const pct = ((num / denom) * 100).toFixed(0);
  console.log(`${label}: ${num}/${denom} (${pct}%)`);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
