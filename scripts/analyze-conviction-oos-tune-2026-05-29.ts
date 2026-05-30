#!/usr/bin/env tsx
/**
 * Tune the conviction tag until it has REAL edge — out-of-sample.
 *
 * Keeps the conviction geometry (≥3 fires, single bias, ≥2 strikes,
 * ≤15-min window) and layers candidate gates on top. We SELECT the best
 * gate on an earlier-dates training slice and CONFIRM it on a later-dates
 * holdout. A gate is only "real" if its lift over baseline survives on the
 * holdout — anything that only works in-sample is fitted noise.
 *
 * Lottery Finder only (the system where conviction is currently broken,
 * and where SLV/TSLA/etc. live). Honest fire-time features (vol/OI, ask%,
 * cheapness, reload, time-of-day, DTE) are computed pre-outcome and carry
 * no leakage. takeit_prob is a model output — included but flagged, with
 * coverage reported, since "model predicts its own target" can be circular.
 *
 * Read-only. Run: npx tsx scripts/analyze-conviction-oos-tune-2026-05-29.ts
 */

import { writeFileSync } from 'node:fs';

import { neon } from '@neondatabase/serverless';
import { config } from 'dotenv';

config({ path: '.env.local' });
const sql = neon(process.env.DATABASE_URL!);

interface Fire {
  ms: number;
  date: string;
  ot: 'C' | 'P';
  strike: number;
  peak: number | null;
  takeit: number | null;
  tod: string | null;
  volOi: number | null;
  askPct: number | null;
  entry: number | null;
  reload: boolean | null;
  dte: number | null;
}

interface RawRow {
  underlying_symbol: string;
  date: string;
  ts: string;
  option_type: string;
  strike: number;
  peak_ceiling_pct: number | null;
  takeit_prob: number | null;
  tod: string | null;
  trigger_vol_to_oi_window: number | null;
  trigger_ask_pct: number | null;
  entry_price: number | null;
  reload_tagged: boolean | null;
  dte: number | null;
  id: number;
}

async function load(): Promise<Fire[][]> {
  const PAGE = 40_000;
  const rows: RawRow[] = [];
  for (let lastId = 0; ; ) {
    const page = (await sql`
      SELECT id, underlying_symbol, date, trigger_time_ct AS ts, option_type, strike,
             peak_ceiling_pct, takeit_prob, tod, trigger_vol_to_oi_window,
             trigger_ask_pct, entry_price, reload_tagged, dte
      FROM lottery_finder_fires
      WHERE peak_ceiling_pct IS NOT NULL AND id > ${lastId}
      ORDER BY id ASC LIMIT ${PAGE}
    `) as unknown as RawRow[];
    if (page.length === 0) break;
    rows.push(...page);
    lastId = Number(page[page.length - 1]!.id);
    if (page.length < PAGE) break;
  }

  const byKey = new Map<string, Fire[]>();
  for (const r of rows) {
    const ms = Date.parse(r.ts);
    if (!Number.isFinite(ms)) continue;
    const dateStr =
      typeof r.date === 'string'
        ? r.date
        : new Date(r.date).toISOString().slice(0, 10);
    const fire: Fire = {
      ms,
      date: dateStr,
      ot: r.option_type === 'C' ? 'C' : 'P',
      strike: Number(r.strike),
      peak: r.peak_ceiling_pct == null ? null : Number(r.peak_ceiling_pct),
      takeit: r.takeit_prob == null ? null : Number(r.takeit_prob),
      tod: r.tod,
      volOi:
        r.trigger_vol_to_oi_window == null
          ? null
          : Number(r.trigger_vol_to_oi_window),
      askPct: r.trigger_ask_pct == null ? null : Number(r.trigger_ask_pct),
      entry: r.entry_price == null ? null : Number(r.entry_price),
      reload: r.reload_tagged,
      dte: r.dte == null ? null : Number(r.dte),
    };
    const key = `${r.underlying_symbol}|${dateStr}`;
    const arr = byKey.get(key);
    if (arr) arr.push(fire);
    else byKey.set(key, [fire]);
  }
  const groups = [...byKey.values()];
  for (const g of groups) g.sort((a, b) => a.ms - b.ms);
  return groups;
}

/** Production conviction geometry: 3 fires / 15 min / 2 strikes, maximal window. */
function markConviction(fires: Fire[]): boolean[] {
  const spreadMs = 15 * 60_000;
  const mark = new Array<boolean>(fires.length).fill(false);
  for (let lo = 0; lo < fires.length; lo++) {
    let hi = lo;
    while (
      hi + 1 < fires.length &&
      fires[hi + 1]!.ms - fires[lo]!.ms <= spreadMs
    )
      hi += 1;
    if (hi - lo + 1 < 3) continue;
    let calls = 0;
    let puts = 0;
    const strikes = new Set<number>();
    for (let k = lo; k <= hi; k++) {
      strikes.add(fires[k]!.strike);
      if (fires[k]!.ot === 'C') calls += 1;
      else puts += 1;
    }
    const singleBias = (calls > 0 && puts === 0) || (puts > 0 && calls === 0);
    if (singleBias && strikes.size >= 2)
      for (let k = lo; k <= hi; k++) mark[k] = true;
  }
  return mark;
}

const hit50 = (fires: Fire[]): number | null => {
  const p = fires.map((f) => f.peak).filter((v): v is number => v != null);
  return p.length ? (p.filter((x) => x >= 50).length / p.length) * 100 : null;
};
const f1 = (v: number | null) => (v == null ? '—' : v.toFixed(1));
const lift = (subset: number | null, base: number) =>
  subset == null
    ? '—'
    : (subset - base > 0 ? '+' : '') + (subset - base).toFixed(1);

type Gate = { name: string; pred: (f: Fire) => boolean };
const GATES: Gate[] = [
  { name: '(geometry only)', pred: () => true },
  // honest fire-time features
  { name: 'AM_open only', pred: (f) => f.tod === 'AM_open' },
  { name: 'reload_tagged', pred: (f) => f.reload === true },
  { name: 'vol/OI ≥ 1', pred: (f) => (f.volOi ?? -1) >= 1 },
  { name: 'vol/OI ≥ 2', pred: (f) => (f.volOi ?? -1) >= 2 },
  { name: 'ask% ≥ 0.7', pred: (f) => (f.askPct ?? -1) >= 0.7 },
  { name: 'ask% ≥ 0.85', pred: (f) => (f.askPct ?? -1) >= 0.85 },
  { name: 'entry ≤ $1.00 (cheap)', pred: (f) => (f.entry ?? 1e9) <= 1.0 },
  { name: 'dte = 0', pred: (f) => f.dte === 0 },
  // honest combos
  {
    name: 'AM_open + vol/OI ≥ 1',
    pred: (f) => f.tod === 'AM_open' && (f.volOi ?? -1) >= 1,
  },
  {
    name: 'AM_open + ask% ≥ 0.85',
    pred: (f) => f.tod === 'AM_open' && (f.askPct ?? -1) >= 0.85,
  },
  {
    name: 'AM_open + reload',
    pred: (f) => f.tod === 'AM_open' && f.reload === true,
  },
  {
    name: 'vol/OI ≥ 2 + ask% ≥ 0.85',
    pred: (f) => (f.volOi ?? -1) >= 2 && (f.askPct ?? -1) >= 0.85,
  },
  // model output (flagged — possible circularity)
  { name: '[model] takeit ≥ 0.5', pred: (f) => (f.takeit ?? -1) >= 0.5 },
  { name: '[model] takeit ≥ 0.6', pred: (f) => (f.takeit ?? -1) >= 0.6 },
  {
    name: '[model] takeit ≥ 0.6 + AM_open',
    pred: (f) => (f.takeit ?? -1) >= 0.6 && f.tod === 'AM_open',
  },
];

(async () => {
  console.log('Loading LF …');
  const groups = await load();
  const allFires = groups.flat();
  console.log(`  ${allFires.length} fires, ${groups.length} ticker-days`);

  // Temporal split: train = earliest 60% of dates, test = latest 40%.
  const dates = [...new Set(allFires.map((f) => f.date))].sort();
  const splitIdx = Math.floor(dates.length * 0.6);
  const splitDate = dates[splitIdx]!;
  const isTrain = (f: Fire) => f.date < splitDate;

  // takeit coverage (leakage/coverage caveat).
  const tkNonNull = allFires.filter((f) => f.takeit != null);
  const tkDates = [...new Set(tkNonNull.map((f) => f.date))].sort();

  // Mark conviction across all groups, partition by split.
  const convTrain: Fire[] = [];
  const convTest: Fire[] = [];
  for (const g of groups) {
    const marks = markConviction(g);
    g.forEach((f, i) => {
      if (!marks[i]) return;
      (isTrain(f) ? convTrain : convTest).push(f);
    });
  }
  const allTrain = allFires.filter(isTrain);
  const allTest = allFires.filter((f) => !isTrain(f));

  const baseTrain = hit50(allTrain)!;
  const baseTest = hit50(allTest)!;

  const lines: string[] = [];
  lines.push('# Conviction OOS tuning — Lottery Finder — 2026-05-29');
  lines.push('');
  lines.push(
    `Train = dates < **${splitDate}** (${allTrain.length} fires), ` +
      `Test = dates ≥ **${splitDate}** (${allTest.length} fires).`,
  );
  lines.push(
    `Baseline hit≥50% (all fires): train **${baseTrain.toFixed(1)}%**, ` +
      `test **${baseTest.toFixed(1)}%**.`,
  );
  lines.push(
    `Conviction-marked fires: train ${convTrain.length}, test ${convTest.length}.`,
  );
  lines.push(
    `\n⚠️ takeit_prob coverage: ${tkNonNull.length}/${allFires.length} fires ` +
      `(${((tkNonNull.length / allFires.length) * 100).toFixed(1)}%), ` +
      `dates ${tkDates[0]}…${tkDates.at(-1)}. Model-output gates are ` +
      `flagged [model] — lift may be partly circular (model scoring its own target).`,
  );
  lines.push('');
  lines.push(
    '| gate (on top of conviction geometry) | train n | train hit≥50% | train lift | test n | test hit≥50% | **test lift** |',
  );
  lines.push('|---|---|---|---|---|---|---|');
  for (const g of GATES) {
    const tr = convTrain.filter(g.pred);
    const te = convTest.filter(g.pred);
    const trH = hit50(tr);
    const teH = hit50(te);
    lines.push(
      `| ${g.name} | ${tr.length} | ${f1(trH)}% | ${lift(trH, baseTrain)} | ` +
        `${te.length} | ${f1(teH)}% | **${lift(teH, baseTest)}** |`,
    );
  }
  lines.push('');
  lines.push(
    '_Read: a gate has REAL edge only if **test lift** is solidly positive ' +
      'with adequate test n (≥~200). Honest-feature gates are leakage-free; ' +
      '[model] gates need a separate train-cutoff check before trusting._',
  );

  const out = lines.join('\n') + '\n';
  const path = 'docs/tmp/conviction-oos-tune-2026-05-29.md';
  writeFileSync(path, out);
  console.log(`\nWrote ${path}\n`);
  console.log(out);
})();
