#!/usr/bin/env tsx
/**
 * Measure the realized edge of the ✦ conviction tag.
 *
 * Reconstructs the LIVE conviction predicate over historical fires by
 * reusing the production pure functions (findEarliestConvictionWindow /
 * isHighConviction) so the measurement cannot drift from the badge.
 *
 * For each (system, ticker, trading-date) group we:
 *   1. Classify whether a conviction window ever formed that day.
 *   2. Find the TRIGGER moment — the first fire that completes a
 *      qualifying trailing 15-min window (i.e. when the badge would
 *      first light up as fires stream in).
 *   3. Tag every fire as pre-trigger / trigger-onward.
 *
 * Then compares realized outcomes (peak_ceiling_pct, hit-≥50%,
 * hit-≥100%, a stop-based realized policy, minutes_to_peak) across:
 *   - ALL fires (baseline)
 *   - non-conviction groups with ≥3 fires (the honest control)
 *   - conviction groups, WHOLE cluster (includes fire #1)
 *   - conviction groups, TRIGGER-ONWARD only (the tradeable edge)
 *   - conviction groups, PRE-TRIGGER only (the move you'd have missed)
 *
 * Plus stratifications that test the "edge concentrates, uniform lift =
 * leakage" rule: by ticker, by time-of-day, by reload vs spread, and by
 * inferred multi-leg structure (spread-leg contamination).
 *
 * Read-only. Run: npx tsx scripts/analyze-conviction-edge-2026-05-29.ts
 */

import { writeFileSync } from 'node:fs';

import { neon } from '@neondatabase/serverless';
import { config } from 'dotenv';

import {
  findEarliestConvictionWindow,
  HIGH_CONVICTION_MAX_SPREAD_MINUTES,
  HIGH_CONVICTION_MIN_FIRES,
  type RollupAlertSummary,
} from '../src/utils/ticker-rollup-aggregates.ts';

config({ path: '.env.local' });
const sql = neon(process.env.DATABASE_URL!);

const WINDOW_MS = HIGH_CONVICTION_MAX_SPREAD_MINUTES * 60_000;

// ----------------------------------------------------------------------
// Per-fire shape carried through the analysis.
// ----------------------------------------------------------------------
interface Fire extends RollupAlertSummary {
  ms: number;
  peak: number | null;
  realized: number | null; // stop-based policy (trail30_10), common to both
  minutesToPeak: number | null;
  takeitProb: number | null;
  tod: string | null;
  reload: boolean | null;
  isIsolatedLeg: boolean | null;
  inferredStructure: string | null;
}

/**
 * Streaming trigger: the first fire that completes a qualifying trailing
 * 15-min window (≥3 fires, single bias, ≥2 distinct strikes ending at
 * that fire). This is exactly when the live badge would first turn on as
 * fires arrive. Returns the trigger ms, or null if no window ever forms.
 */
function convictionTriggerMs(sorted: Fire[]): number | null {
  for (let i = 0; i < sorted.length; i++) {
    const endMs = sorted[i]!.ms;
    let calls = 0;
    let puts = 0;
    const strikes = new Set<number>();
    let count = 0;
    for (let j = i; j >= 0; j--) {
      if (endMs - sorted[j]!.ms > WINDOW_MS) break;
      count += 1;
      strikes.add(sorted[j]!.strike);
      if (sorted[j]!.optionType === 'C') calls += 1;
      else puts += 1;
    }
    const singleBias = (calls > 0 && puts === 0) || (puts > 0 && calls === 0);
    if (count >= HIGH_CONVICTION_MIN_FIRES && singleBias && strikes.size >= 2) {
      return endMs;
    }
  }
  return null;
}

// ----------------------------------------------------------------------
// Stats helpers.
// ----------------------------------------------------------------------
interface Stats {
  n: number;
  meanPeak: number | null;
  medPeak: number | null;
  hit50: number | null;
  hit100: number | null;
  meanRealized: number | null;
  medMinToPeak: number | null;
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}
function mean(xs: number[]): number | null {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

function statsOf(fires: Fire[]): Stats {
  const peaks = fires.map((f) => f.peak).filter((v): v is number => v != null);
  const realized = fires
    .map((f) => f.realized)
    .filter((v): v is number => v != null);
  const mtp = fires
    .map((f) => f.minutesToPeak)
    .filter((v): v is number => v != null);
  return {
    n: fires.length,
    meanPeak: mean(peaks),
    medPeak: median(peaks),
    hit50: peaks.length
      ? (peaks.filter((p) => p >= 50).length / peaks.length) * 100
      : null,
    hit100: peaks.length
      ? (peaks.filter((p) => p >= 100).length / peaks.length) * 100
      : null,
    meanRealized: mean(realized),
    medMinToPeak: median(mtp),
  };
}

const f1 = (v: number | null) => (v == null ? '—' : v.toFixed(1));

function statsRow(label: string, s: Stats): string {
  return `| ${label} | ${s.n} | ${f1(s.meanPeak)} | ${f1(s.medPeak)} | ${f1(s.hit50)}% | ${f1(s.hit100)}% | ${f1(s.meanRealized)} | ${f1(s.medMinToPeak)} |`;
}
const STATS_HEADER =
  '| bucket | n | mean peak% | median peak% | hit≥50% | hit≥100% | mean realized% | med min→peak |\n' +
  '|---|---|---|---|---|---|---|---|';

// ----------------------------------------------------------------------
// Load + group + classify one system.
// ----------------------------------------------------------------------
interface Group {
  key: string;
  ticker: string;
  date: string;
  fires: Fire[]; // time-sorted
  triggerMs: number | null;
  isConviction: boolean;
}

interface RawRow {
  underlying_symbol: string;
  date: string;
  ts: string;
  option_type: string;
  strike: number;
  mkt_tide_diff: number | null;
  direction_gated: boolean | null;
  peak_ceiling_pct: number | null;
  realized: number | null;
  minutes_to_peak: number | null;
  takeit_prob: number | null;
  tod: string | null;
  reload_tagged: boolean | null;
  is_isolated_leg: boolean | null;
  inferred_structure: string | null;
}

function buildGroups(rows: RawRow[]): Group[] {
  const byKey = new Map<string, Fire[]>();
  for (const r of rows) {
    const ms = Date.parse(r.ts);
    if (!Number.isFinite(ms)) continue;
    const ot = r.option_type === 'C' ? 'C' : 'P';
    const fire: Fire = {
      optionType: ot,
      mktTideDiff: r.mkt_tide_diff == null ? null : Number(r.mkt_tide_diff),
      directionGated: !!r.direction_gated,
      triggeredAt: new Date(ms).toISOString(),
      strike: Number(r.strike),
      tickerNetFlowAtFire: null,
      ms,
      peak: r.peak_ceiling_pct == null ? null : Number(r.peak_ceiling_pct),
      realized: r.realized == null ? null : Number(r.realized),
      minutesToPeak:
        r.minutes_to_peak == null ? null : Number(r.minutes_to_peak),
      takeitProb: r.takeit_prob == null ? null : Number(r.takeit_prob),
      tod: r.tod,
      reload: r.reload_tagged,
      isIsolatedLeg: r.is_isolated_leg,
      inferredStructure: r.inferred_structure,
    };
    const dateStr =
      typeof r.date === 'string'
        ? r.date
        : new Date(r.date).toISOString().slice(0, 10);
    const key = `${r.underlying_symbol}|${dateStr}`;
    const arr = byKey.get(key);
    if (arr) arr.push(fire);
    else byKey.set(key, [fire]);
  }

  const groups: Group[] = [];
  for (const [key, fires] of byKey) {
    fires.sort((a, b) => a.ms - b.ms);
    const [ticker, date] = key.split('|');
    const win = findEarliestConvictionWindow(fires);
    const triggerMs = win ? convictionTriggerMs(fires) : null;
    groups.push({
      key,
      ticker: ticker!,
      date: date!,
      fires,
      triggerMs,
      isConviction: win != null,
    });
  }
  return groups;
}

// ----------------------------------------------------------------------
// Build the comparison buckets for one system.
// ----------------------------------------------------------------------
function analyzeSystem(name: string, groups: Group[]): string {
  const allFires: Fire[] = [];
  const nonConv3plus: Fire[] = []; // ≥3 fires but no conviction window
  const convAll: Fire[] = [];
  const convTriggerOn: Fire[] = [];
  const convPre: Fire[] = [];

  let convDays = 0;
  const totalDays = groups.length;

  for (const g of groups) {
    allFires.push(...g.fires);
    if (g.isConviction) {
      convDays += 1;
      convAll.push(...g.fires);
      const t = g.triggerMs;
      for (const f of g.fires) {
        if (t != null && f.ms >= t) convTriggerOn.push(f);
        else convPre.push(f);
      }
    } else if (g.fires.length >= HIGH_CONVICTION_MIN_FIRES) {
      nonConv3plus.push(...g.fires);
    }
  }

  const lines: string[] = [];
  lines.push(`## ${name}`);
  lines.push('');
  lines.push(
    `Ticker-days: **${totalDays}** total, **${convDays}** had a conviction window ` +
      `(${((convDays / totalDays) * 100).toFixed(1)}%). ` +
      `Fires: ${allFires.length} total, ${convAll.length} in conviction groups ` +
      `(${convTriggerOn.length} trigger-onward, ${convPre.length} pre-trigger).`,
  );
  lines.push('');
  lines.push(STATS_HEADER);
  lines.push(statsRow('ALL fires (baseline)', statsOf(allFires)));
  lines.push(
    statsRow('non-conviction, ≥3 fires (control)', statsOf(nonConv3plus)),
  );
  lines.push(statsRow('conviction — whole cluster', statsOf(convAll)));
  lines.push(statsRow('conviction — TRIGGER-ONWARD', statsOf(convTriggerOn)));
  lines.push(statsRow('conviction — pre-trigger', statsOf(convPre)));
  lines.push('');

  // ---- Stratification: by time-of-day (trigger-onward) ----
  if (convTriggerOn.some((f) => f.tod)) {
    lines.push('### Conviction trigger-onward, by time-of-day');
    lines.push('');
    lines.push(STATS_HEADER);
    const tods = [...new Set(convTriggerOn.map((f) => f.tod).filter(Boolean))];
    for (const t of tods.sort()) {
      lines.push(
        statsRow(String(t), statsOf(convTriggerOn.filter((f) => f.tod === t))),
      );
    }
    lines.push('');
  }

  // ---- Stratification: reload (same-strike reload) vs not ----
  if (convTriggerOn.some((f) => f.reload != null)) {
    lines.push('### Conviction trigger-onward, reload-tagged vs not');
    lines.push('');
    lines.push(STATS_HEADER);
    lines.push(
      statsRow(
        'reload_tagged = true',
        statsOf(convTriggerOn.filter((f) => f.reload === true)),
      ),
    );
    lines.push(
      statsRow(
        'reload_tagged = false',
        statsOf(convTriggerOn.filter((f) => f.reload === false)),
      ),
    );
    lines.push('');
  }

  // ---- Stratification: multi-leg structure contamination ----
  if (convTriggerOn.some((f) => f.isIsolatedLeg != null)) {
    lines.push(
      '### Conviction trigger-onward, isolated-leg vs inferred multi-leg',
    );
    lines.push('');
    lines.push(STATS_HEADER);
    lines.push(
      statsRow(
        'is_isolated_leg = true (standalone bet)',
        statsOf(convTriggerOn.filter((f) => f.isIsolatedLeg === true)),
      ),
    );
    lines.push(
      statsRow(
        'is_isolated_leg = false (spread leg)',
        statsOf(convTriggerOn.filter((f) => f.isIsolatedLeg === false)),
      ),
    );
    lines.push('');
  }

  // ---- Stratification: top tickers by conviction trigger-onward volume ----
  const byTicker = new Map<string, Fire[]>();
  for (const g of groups) {
    if (!g.isConviction) continue;
    const t = g.triggerMs;
    const arr = byTicker.get(g.ticker) ?? [];
    for (const f of g.fires) if (t == null || f.ms >= t) arr.push(f);
    byTicker.set(g.ticker, arr);
  }
  const topTickers = [...byTicker.entries()]
    .filter(([, fs]) => fs.length >= 20)
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 15);
  if (topTickers.length) {
    lines.push('### Conviction trigger-onward, top tickers (≥20 fires)');
    lines.push('');
    lines.push(STATS_HEADER);
    for (const [t, fs] of topTickers) lines.push(statsRow(t, statsOf(fs)));
    lines.push('');
  }

  return lines.join('\n');
}

// ----------------------------------------------------------------------
// Run.
// ----------------------------------------------------------------------
(async () => {
  const PAGE = 40_000;

  console.log('Loading lottery_finder_fires …');
  const lfRows: RawRow[] = [];
  for (let lastId = 0; ; ) {
    const page = (await sql`
      SELECT id, underlying_symbol, date, trigger_time_ct AS ts, option_type, strike,
             mkt_tide_diff, direction_gated, peak_ceiling_pct,
             realized_trail30_10_pct AS realized, minutes_to_peak,
             takeit_prob, tod, reload_tagged, is_isolated_leg, inferred_structure
      FROM lottery_finder_fires
      WHERE peak_ceiling_pct IS NOT NULL AND id > ${lastId}
      ORDER BY id ASC LIMIT ${PAGE}
    `) as unknown as (RawRow & { id: number })[];
    if (page.length === 0) break;
    lfRows.push(...page);
    lastId = Number(page[page.length - 1]!.id);
    if (page.length < PAGE) break;
  }
  console.log(`  ${lfRows.length} rows`);

  console.log('Loading silent_boom_alerts …');
  const sbRows: RawRow[] = [];
  for (let lastId = 0; ; ) {
    const page = (await sql`
      SELECT id, underlying_symbol, date, bucket_ct AS ts, option_type, strike,
             mkt_tide_diff, direction_gated, peak_ceiling_pct,
             realized_trail30_10_pct AS realized, minutes_to_peak,
             takeit_prob, NULL AS tod, NULL AS reload_tagged,
             is_isolated_leg, inferred_structure
      FROM silent_boom_alerts
      WHERE peak_ceiling_pct IS NOT NULL AND id > ${lastId}
      ORDER BY id ASC LIMIT ${PAGE}
    `) as unknown as (RawRow & { id: number })[];
    if (page.length === 0) break;
    sbRows.push(...page);
    lastId = Number(page[page.length - 1]!.id);
    if (page.length < PAGE) break;
  }
  console.log(`  ${sbRows.length} rows`);

  const lfReport = analyzeSystem('Lottery Finder', buildGroups(lfRows));
  const sbReport = analyzeSystem('Silent Boom', buildGroups(sbRows));

  const out =
    `# Conviction tag — realized edge measurement\n\n` +
    `Generated 2026-05-29. Reconstructs the live ✦ conviction predicate ` +
    `(≥${HIGH_CONVICTION_MIN_FIRES} fires, single bias, ≥2 strikes, ` +
    `≤${HIGH_CONVICTION_MAX_SPREAD_MINUTES}-min window) over all enriched fires ` +
    `using the production pure functions. Outcomes are realized after the fire; ` +
    `"trigger-onward" scores only fires at/after the moment the badge would first ` +
    `light up (the tradeable edge), "pre-trigger" is the move that already happened.\n\n` +
    `**peak%** = max % gain reached after fire; **realized%** = trail-30m-max then ` +
    `-10%-stop exit policy; **hit≥50/100%** = share of fires whose peak cleared that bar.\n\n` +
    lfReport +
    '\n\n' +
    sbReport +
    '\n';

  const path = 'docs/tmp/conviction-edge-2026-05-29.md';
  writeFileSync(path, out);
  console.log(`\nWrote ${path}\n`);
  console.log(out);
})();
