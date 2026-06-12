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
// RFC 4180 CSV parser. pandas writes well-formed RFC 4180 and
// quotes any field containing a comma, a double-quote, or a
// newline. A naive `.split(',')` corrupts every such row, so we
// parse character-by-character: track whether we're inside a
// quoted field, treat `""` as an escaped quote, and honor quoted
// newlines (a record can span multiple physical lines).
// ============================================================

/**
 * Split the full CSV text into records, each an array of string fields.
 * Handles quoted fields with embedded commas, escaped `""`, and embedded
 * newlines. Trailing whitespace-only lines are dropped.
 *
 * Implemented as a small state machine. `state` is mutated in place by the
 * two per-character handlers so the top-level loop stays flat (keeps
 * cognitive complexity low).
 */
function parseCsvRecords(raw) {
  const records = [];
  const state = {
    field: '',
    record: [],
    inQuotes: false,
    sawField: false, // distinguishes an empty trailing line from a real row
  };

  const pushField = () => {
    state.record.push(state.field);
    state.field = '';
    state.sawField = true;
  };
  const pushRecord = () => {
    pushField();
    records.push(state.record);
    state.record = [];
    state.sawField = false;
  };

  // Returns the index to resume at (lets the `""` escape consume two chars).
  const handleQuoted = (ch, i) => {
    if (ch !== '"') {
      state.field += ch;
      return i;
    }
    if (raw[i + 1] === '"') {
      state.field += '"'; // escaped quote
      return i + 1;
    }
    state.inQuotes = false;
    return i;
  };

  const handleUnquoted = (ch) => {
    if (ch === '"') state.inQuotes = true;
    else if (ch === ',') pushField();
    else if (ch === '\n') pushRecord();
    else if (ch !== '\r') state.field += ch;
    // '\r' is swallowed — '\n' handles the record break (CRLF or lone CR)
  };

  // `while` (not `for`) so the escaped-quote skip can advance the index
  // without tripping sonarjs/updated-loop-counter on a for-counter.
  let i = 0;
  while (i < raw.length) {
    const ch = raw[i];
    if (state.inQuotes) i = handleQuoted(ch, i);
    else handleUnquoted(ch);
    i += 1;
  }

  // Flush the last record if the file didn't end with a newline.
  if (state.sawField || state.field.length > 0) pushRecord();

  return records;
}

function parseCsv(path) {
  const raw = readFileSync(path, 'utf8');
  const records = parseCsvRecords(raw);
  if (records.length < 2) return [];
  const header = records[0];
  return records.slice(1).map((cells) => {
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

// Stable price-join key. The p27 join keys on entry_price, but p14 and p27
// are written by different pipeline stages and the same fire's entry_price
// can differ by sub-cent float/format noise ("1.05" vs "1.0500000001" vs
// "1.050"). Raw-string equality misses those; raw float equality is equally
// fragile. Round to 4 decimals (premiums are cent-meaningful) and format to
// a canonical fixed-precision string so both sides collapse to the same key.
// Returns '' for non-numeric input so a bad value never spuriously matches.
function priceKey(v) {
  const n = num(v);
  return n == null ? '' : n.toFixed(4);
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
// policy) and the wider grid. Joined on (date, chain, entry_price) since
// p27 lacks alert_seq. entry_price is normalized via priceKey() so sub-cent
// float/format noise between p14 and p27 doesn't break the match. Collisions
// on identical entry_price are rare; if they happen, last-write-wins is fine
// because both rows are the same fire's outcome.
let p27ByKey = new Map();
if (existsSync(P27_PATH)) {
  console.log('Reading', P27_PATH);
  const p27Rows = parseCsv(P27_PATH);
  console.log(`  ${p27Rows.length} p27 rows`);
  for (const r of p27Rows) {
    const key = `${r.date_str}|${r.option_chain_id}|${priceKey(r.entry_price)}`;
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
    // tier_50_holdEod isn't in p26; pull from p27 when available. Key on the
    // normalized entry_price (priceKey) to match the p27 index above.
    realized_tier50_holdeod_pct: num(
      p27ByKey.get(
        `${m.date_str}|${m.option_chain_id}|${priceKey(t.entry_price)}`,
      )?.tier_50_holdEod,
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
