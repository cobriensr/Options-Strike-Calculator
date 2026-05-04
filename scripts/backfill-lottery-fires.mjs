#!/usr/bin/env node

/**
 * One-shot historical backfill of lottery_finder_fires from the
 * Python analysis pipeline output CSVs. Runs locally — depends on
 * docs/tmp/options-flow-analysis/outputs/{p14_event_triggers,
 * p26_per_trade_realized}.csv which the user generates from the
 * /Users/charlesobrien/Desktop/Bot-Eod-parquet/ archive.
 *
 * Maps p14 (trigger features) + p26 (mode/flow_quad/tod/reload +
 * realized exit policies) into the lottery_finder_fires schema and
 * bulk-inserts with ON CONFLICT (option_chain_id, trigger_time_ct)
 * DO NOTHING. Macro snapshot columns are left NULL on backfill — they
 * are display-only per spec Appendix A and the macro context tables
 * (flow_data, spot_exposures, strike_exposures) only have data from
 * the live cron era forward, not the historical parquet window.
 *
 * Usage:
 *   DATABASE_URL=... node scripts/backfill-lottery-fires.mjs
 *
 * Optional env:
 *   P14_CSV  — path to p14 CSV (default: docs/tmp/.../outputs/p14_event_triggers.csv)
 *   P26_CSV  — path to p26 CSV (default: docs/tmp/.../outputs/p26_per_trade_realized.csv)
 *   P27_CSV  — path to p27 CSV (optional; supplies tier_50_holdEod policy)
 *   DRY_RUN=1 — parse + report counts, no DB writes
 *   BATCH_SIZE — rows per INSERT (default 500)
 */

import { neon } from '@neondatabase/serverless';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const DATABASE_URL = process.env.DATABASE_URL;
const DRY_RUN = process.env.DRY_RUN === '1';
const BATCH_SIZE = Number.parseInt(process.env.BATCH_SIZE ?? '500', 10);

if (!DRY_RUN && !DATABASE_URL) {
  console.error('Missing DATABASE_URL (or set DRY_RUN=1 to skip writes)');
  process.exit(1);
}

const REPO_ROOT = resolve(new URL('..', import.meta.url).pathname);
const P14_PATH =
  process.env.P14_CSV ??
  resolve(
    REPO_ROOT,
    'docs/tmp/options-flow-analysis/outputs/p14_event_triggers.csv',
  );
const P26_PATH =
  process.env.P26_CSV ??
  resolve(
    REPO_ROOT,
    'docs/tmp/options-flow-analysis/outputs/p26_per_trade_realized.csv',
  );
const P27_PATH =
  process.env.P27_CSV ??
  resolve(
    REPO_ROOT,
    'docs/tmp/options-flow-analysis/outputs/p27_policy_grid.csv',
  );

if (!existsSync(P14_PATH)) {
  console.error(`p14 CSV not found at ${P14_PATH}`);
  console.error(
    'Run: ml/.venv/bin/python docs/tmp/options-flow-analysis/scripts/p14_event_trigger.py',
  );
  process.exit(1);
}
if (!existsSync(P26_PATH)) {
  console.error(`p26 CSV not found at ${P26_PATH}`);
  console.error(
    'Run: ml/.venv/bin/python docs/tmp/options-flow-analysis/scripts/p26_canonical_realized.py',
  );
  process.exit(1);
}

// ============================================================
// Minimal CSV parser — pandas writes well-formed RFC 4180 with
// quoted strings only when commas are inside fields. The p14/p26
// outputs don't have embedded commas, so a simple split is safe.
// ============================================================

function parseCsv(path) {
  const raw = readFileSync(path, 'utf8');
  const lines = raw.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length < 2) return [];
  const header = lines[0].split(',');
  return lines.slice(1).map((line) => {
    const cells = line.split(',');
    const obj = {};
    for (let i = 0; i < header.length; i++) {
      obj[header[i]] = cells[i] ?? '';
    }
    return obj;
  });
}

function num(v) {
  if (v == null || v === '' || v === 'nan' || v === 'NaN') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function bool(v) {
  if (v == null || v === '') return false;
  const lo = String(v).trim().toLowerCase();
  return lo === 'true' || lo === 't' || lo === '1';
}

// p14 dates carry a timezone offset like 2026-04-13 09:06:12.168259-05:00
// — need to convert to UTC ISO for TIMESTAMPTZ columns. JS Date can
// parse them as long as the space-separator is replaced with 'T'.
function toIsoUtc(v) {
  if (!v) return null;
  const s = String(v).trim().replace(' ', 'T');
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// ============================================================
// Load + join p14 + p26
// ============================================================

console.log('Reading', P14_PATH);
const p14Rows = parseCsv(P14_PATH);
console.log(`  ${p14Rows.length} p14 rows`);

console.log('Reading', P26_PATH);
const p26Rows = parseCsv(P26_PATH);
console.log(`  ${p26Rows.length} p26 rows`);

// p27 is optional — supplies tier_50_holdEod (the third Phase-1 exit
// policy) and the wider grid. Joined on (date, chain, entry_price)
// since p27 lacks alert_seq. Collisions on identical entry_price are
// rare; if they happen, last-write-wins is fine because both rows are
// the same fire's outcome.
let p27ByKey = new Map();
if (existsSync(P27_PATH)) {
  console.log('Reading', P27_PATH);
  const p27Rows = parseCsv(P27_PATH);
  console.log(`  ${p27Rows.length} p27 rows`);
  for (const r of p27Rows) {
    const key = `${r.date_str}|${r.option_chain_id}|${r.entry_price}`;
    p27ByKey.set(key, r);
  }
} else {
  console.log(
    `  (p27 CSV not found at ${P27_PATH} — tier_50_holdEod will be NULL)`,
  );
}

// Index p14 by (date, chain, alert_seq) — alert_seq is 1-indexed and
// unique per (chain, day). entry_price is sometimes off by a sub-cent
// rounding so we don't include it in the key.
const p14Index = new Map();
for (const r of p14Rows) {
  const key = `${r.date}|${r.option_chain_id}|${r.alert_seq}`;
  p14Index.set(key, r);
}

let unmatched = 0;
let outOfUniverse = 0; // p26 only contains in-universe fires already
const records = [];
for (const m of p26Rows) {
  const key = `${m.date_str}|${m.option_chain_id}|${m.alert_seq}`;
  const t = p14Index.get(key);
  if (!t) {
    unmatched += 1;
    continue;
  }

  // p14 has option_type as 'call'/'put'; the schema enforces 'C'/'P'.
  const optionType =
    (t.option_type ?? m.option_type ?? '').toLowerCase() === 'put' ? 'P' : 'C';

  // RE-LOAD discriminator inputs were not stamped in p26 directly.
  // Compute on the fly from prev fire on the same chain.
  const prevSeq = Number(m.alert_seq) - 1;
  const prevKey = `${m.date_str}|${m.option_chain_id}|${prevSeq}`;
  const prev = p14Index.get(prevKey);
  let burstRatio = null;
  let entryDrop = null;
  if (prev) {
    const prevSize = num(prev.trigger_window_size);
    const prevEntry = num(prev.entry_price);
    const curSize = num(t.trigger_window_size);
    const curEntry = num(t.entry_price);
    if (prevSize && curSize) burstRatio = curSize / prevSize;
    if (prevEntry && curEntry)
      entryDrop = ((curEntry - prevEntry) / prevEntry) * 100;
  }

  const reloadTagged = bool(m.reload);
  const tod = m.tod;
  const cheapCallPm =
    optionType === 'C' &&
    tod === 'PM' &&
    num(t.entry_price) != null &&
    num(t.entry_price) < 1;

  records.push({
    date: m.date_str,
    trigger_time_ct: toIsoUtc(t.trigger_time_ct),
    entry_time_ct: toIsoUtc(t.entry_time_ct),
    option_chain_id: m.option_chain_id,
    underlying_symbol: m.underlying_symbol,
    option_type: optionType,
    strike: num(t.strike),
    expiry: t.expiry,
    dte: Number(t.dte),

    trigger_vol_to_oi_window: num(t.trigger_vol_to_oi_window),
    trigger_vol_to_oi_cum: num(t.trigger_vol_to_oi_cum),
    trigger_iv: num(t.trigger_iv),
    trigger_delta: num(t.trigger_delta),
    trigger_ask_pct: num(t.trigger_ask_pct),
    trigger_window_size: num(t.trigger_window_size),
    trigger_window_prints: Number(t.trigger_window_prints),

    entry_price: num(t.entry_price),
    open_interest: Number(t.open_interest),
    spot_at_first: num(t.spot_at_first),
    alert_seq: Number(m.alert_seq),
    minutes_since_prev_fire: num(t.minutes_since_prev_fire) ?? 0,

    flow_quad: m.flow_quad,
    tod,
    mode: m.mode,
    reload_tagged: reloadTagged,
    cheap_call_pm_tagged: cheapCallPm,
    burst_ratio_vs_prev: burstRatio,
    entry_drop_pct_vs_prev: entryDrop,

    realized_trail30_10_pct: num(m.realized_trail30_10_pct),
    realized_hard30m_pct: num(m.realized_hard30m_pct),
    // tier_50_holdEod isn't in p26; pull from p27 when available.
    realized_tier50_holdeod_pct: num(
      p27ByKey.get(`${m.date_str}|${m.option_chain_id}|${t.entry_price}`)
        ?.tier_50_holdEod,
    ),
    realized_eod_pct: num(m.realized_eod_pct),
    peak_ceiling_pct: num(m.peak_ceiling_pct),
    minutes_to_peak: num(t.minutes_to_peak_eod),
  });
}

// Sanity drops — rows with bad timestamps or missing required fields.
const valid = records.filter(
  (r) =>
    r.trigger_time_ct &&
    r.entry_time_ct &&
    r.entry_price != null &&
    r.spot_at_first != null &&
    r.trigger_window_size != null,
);
const dropped = records.length - valid.length;

console.log('');
console.log('Join summary:');
console.log(`  joined:           ${records.length}`);
console.log(`  unmatched (p26→p14): ${unmatched}`);
console.log(`  out_of_universe:  ${outOfUniverse}`);
console.log(`  dropped (bad ts):  ${dropped}`);
console.log(`  ready to insert:  ${valid.length}`);
console.log('');
console.log('Per-mode breakdown:');
const byMode = new Map();
for (const r of valid) byMode.set(r.mode, (byMode.get(r.mode) ?? 0) + 1);
for (const [mode, n] of [...byMode].sort(([a], [b]) => a.localeCompare(b))) {
  console.log(`  ${mode.padEnd(20)} ${n}`);
}
const reloadCount = valid.filter((r) => r.reload_tagged).length;
const cheapCount = valid.filter((r) => r.cheap_call_pm_tagged).length;
console.log(`\n  RE-LOAD-tagged:    ${reloadCount}`);
console.log(`  cheap-call-PM:     ${cheapCount}`);

if (DRY_RUN) {
  console.log('\nDRY_RUN=1 — no writes performed.');
  process.exit(0);
}

// ============================================================
// Bulk INSERT in batches.
// ============================================================

const sql = neon(DATABASE_URL);

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

let inserted = 0;
let conflicts = 0;
const batches = chunk(valid, BATCH_SIZE);
console.log(
  `\nInserting ${valid.length} rows in ${batches.length} batches of ≤${BATCH_SIZE}...`,
);

for (let i = 0; i < batches.length; i++) {
  const batch = batches[i];
  // Use sql.transaction over an array of unsafe-template inserts; the
  // tagged-template approach with a single multi-row VALUES clause is
  // cleaner but neon-serverless limits parameter count per call. The
  // transaction batches keep us safe under that ceiling.
  const queries = batch.map(
    (r) => sql`
      INSERT INTO lottery_finder_fires (
        date, trigger_time_ct, entry_time_ct, option_chain_id,
        underlying_symbol, option_type, strike, expiry, dte,
        trigger_vol_to_oi_window, trigger_vol_to_oi_cum,
        trigger_iv, trigger_delta, trigger_ask_pct,
        trigger_window_size, trigger_window_prints,
        entry_price, open_interest, spot_at_first,
        alert_seq, minutes_since_prev_fire,
        flow_quad, tod, mode,
        reload_tagged, cheap_call_pm_tagged,
        burst_ratio_vs_prev, entry_drop_pct_vs_prev,
        realized_trail30_10_pct, realized_hard30m_pct,
        realized_tier50_holdeod_pct, realized_eod_pct,
        peak_ceiling_pct, minutes_to_peak,
        enriched_at
      ) VALUES (
        ${r.date}::date, ${r.trigger_time_ct}, ${r.entry_time_ct},
        ${r.option_chain_id}, ${r.underlying_symbol}, ${r.option_type},
        ${r.strike}, ${r.expiry}::date, ${r.dte},
        ${r.trigger_vol_to_oi_window}, ${r.trigger_vol_to_oi_cum},
        ${r.trigger_iv}, ${r.trigger_delta}, ${r.trigger_ask_pct},
        ${r.trigger_window_size}, ${r.trigger_window_prints},
        ${r.entry_price}, ${r.open_interest}, ${r.spot_at_first},
        ${r.alert_seq}, ${r.minutes_since_prev_fire},
        ${r.flow_quad}, ${r.tod}, ${r.mode},
        ${r.reload_tagged}, ${r.cheap_call_pm_tagged},
        ${r.burst_ratio_vs_prev}, ${r.entry_drop_pct_vs_prev},
        ${r.realized_trail30_10_pct}, ${r.realized_hard30m_pct},
        ${r.realized_tier50_holdeod_pct}, ${r.realized_eod_pct},
        ${r.peak_ceiling_pct}, ${r.minutes_to_peak},
        NOW()
      )
      ON CONFLICT (option_chain_id, trigger_time_ct) DO NOTHING
      RETURNING id
    `,
  );

  const results = await sql.transaction(queries);
  for (const rs of results) {
    if (rs.length > 0) inserted += 1;
    else conflicts += 1;
  }
  process.stdout.write(
    `  batch ${i + 1}/${batches.length}: inserted=${inserted} conflicts=${conflicts}\r`,
  );
}

console.log('');
console.log('');
console.log(
  `Done. inserted=${inserted}, conflicts (already present)=${conflicts}`,
);
