#!/usr/bin/env tsx
/**
 * Refine the honest (leakage-free) conviction gate — OOS.
 *
 * Builds on analyze-conviction-oos-tune: keeps conviction geometry,
 * layers ONLY honest fire-time features (no model output), and searches
 * combinations to maximise out-of-sample lift while keeping the tag
 * selective-but-usable. Same temporal split (train = earlier 60% of
 * dates, test = later 40%). Reports test retention (share of conviction
 * fires kept) so we can see how rare each recipe makes the badge.
 *
 * Counterintuitive priors from the prior run: high vol/OI and high ask%
 * HURT, so this pass also tests their anti-gates (low vol/OI, mid-
 * dominated). dte=0 overfit (failed OOS) so it's excluded.
 *
 * Read-only. Run: npx tsx scripts/analyze-conviction-refine-2026-05-29.ts
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
  tod: string | null;
  volOi: number | null;
  askPct: number | null;
  entry: number | null;
  reload: boolean | null;
}

async function load(): Promise<Fire[][]> {
  const PAGE = 40_000;
  type Raw = Record<string, unknown>;
  const rows: Raw[] = [];
  for (let lastId = 0; ; ) {
    const page = (await sql`
      SELECT id, underlying_symbol, date, trigger_time_ct AS ts, option_type, strike,
             peak_ceiling_pct, tod, trigger_vol_to_oi_window,
             trigger_ask_pct, entry_price, reload_tagged
      FROM lottery_finder_fires
      WHERE peak_ceiling_pct IS NOT NULL AND id > ${lastId}
      ORDER BY id ASC LIMIT ${PAGE}
    `) as unknown as Raw[];
    if (page.length === 0) break;
    rows.push(...page);
    lastId = Number(page[page.length - 1]!.id);
    if (page.length < PAGE) break;
  }

  const num = (v: unknown): number | null => (v == null ? null : Number(v));
  const byKey = new Map<string, Fire[]>();
  for (const r of rows) {
    const ms = Date.parse(String(r.ts));
    if (!Number.isFinite(ms)) continue;
    const dateStr =
      typeof r.date === 'string'
        ? r.date
        : new Date(r.date as string).toISOString().slice(0, 10);
    const fire: Fire = {
      ms,
      date: dateStr,
      ot: r.option_type === 'C' ? 'C' : 'P',
      strike: Number(r.strike),
      peak: num(r.peak_ceiling_pct),
      tod: (r.tod as string) ?? null,
      volOi: num(r.trigger_vol_to_oi_window),
      askPct: num(r.trigger_ask_pct),
      entry: num(r.entry_price),
      reload: (r.reload_tagged as boolean) ?? null,
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
const liftStr = (s: number | null, base: number) =>
  s == null ? '—' : (s - base > 0 ? '+' : '') + (s - base).toFixed(1);

const AM = (f: Fire) => f.tod === 'AM_open';
const notPM = (f: Fire) => f.tod !== 'PM';
const cheap = (c: number) => (f: Fire) => (f.entry ?? 1e9) <= c;
const reload = (f: Fire) => f.reload === true;
const loVolOi = (f: Fire) => f.volOi == null || f.volOi < 1; // anti-churn
const mid = (f: Fire) => f.askPct != null && f.askPct <= 0.5; // mid-dominated
const and =
  (...ps: ((f: Fire) => boolean)[]) =>
  (f: Fire) =>
    ps.every((p) => p(f));
const or =
  (...ps: ((f: Fire) => boolean)[]) =>
  (f: Fire) =>
    ps.some((p) => p(f));

type Gate = { name: string; pred: (f: Fire) => boolean };
const GATES: Gate[] = [
  { name: '(geometry only)', pred: () => true },
  { name: 'AM_open', pred: AM },
  { name: 'not-PM', pred: notPM },
  { name: 'cheap ≤ $1.50', pred: cheap(1.5) },
  { name: 'cheap ≤ $1.00', pred: cheap(1.0) },
  { name: 'cheap ≤ $0.75', pred: cheap(0.75) },
  { name: 'cheap ≤ $0.50', pred: cheap(0.5) },
  { name: 'cheap ≤ $0.30', pred: cheap(0.3) },
  { name: 'cheap≤1 ∩ AM_open', pred: and(cheap(1), AM) },
  { name: 'cheap≤1 ∪ AM_open', pred: or(cheap(1), AM) },
  { name: 'cheap≤0.5 ∩ AM_open', pred: and(cheap(0.5), AM) },
  { name: 'cheap≤1 ∩ not-PM', pred: and(cheap(1), notPM) },
  { name: 'cheap≤1 ∩ reload', pred: and(cheap(1), reload) },
  { name: 'AM_open ∩ reload', pred: and(AM, reload) },
  { name: 'cheap≤1 ∪ reload', pred: or(cheap(1), reload) },
  { name: 'cheap≤1 ∩ lo-vol/OI (anti-churn)', pred: and(cheap(1), loVolOi) },
  { name: 'cheap≤1 ∩ AM ∩ lo-vol/OI', pred: and(cheap(1), AM, loVolOi) },
  { name: 'cheap≤1 ∩ mid-dominated', pred: and(cheap(1), mid) },
  { name: 'AM ∩ lo-vol/OI', pred: and(AM, loVolOi) },
];

(async () => {
  console.log('Loading LF …');
  const groups = await load();
  const allFires = groups.flat();

  const dates = [...new Set(allFires.map((f) => f.date))].sort();
  const splitDate = dates[Math.floor(dates.length * 0.6)]!;
  const isTrain = (f: Fire) => f.date < splitDate;

  const convTrain: Fire[] = [];
  const convTest: Fire[] = [];
  for (const g of groups) {
    const marks = markConviction(g);
    g.forEach((f, i) => {
      if (marks[i]) (isTrain(f) ? convTrain : convTest).push(f);
    });
  }
  const baseTrain = hit50(allFires.filter(isTrain))!;
  const baseTest = hit50(allFires.filter((f) => !isTrain(f)))!;
  const convTestN = convTest.length;

  const lines: string[] = [];
  lines.push('# Conviction honest-gate refinement (OOS) — LF — 2026-05-29');
  lines.push('');
  lines.push(
    `Train < **${splitDate}**, test ≥ it. Baseline hit≥50%: train ` +
      `${baseTrain.toFixed(1)}%, test ${baseTest.toFixed(1)}%. ` +
      `Conviction-marked test fires: ${convTestN}.`,
  );
  lines.push('');
  lines.push(
    '| honest gate | train hit≥50% | train lift | test n | test hit≥50% | **test lift** | test retain% |',
  );
  lines.push('|---|---|---|---|---|---|---|');
  for (const g of GATES) {
    const tr = convTrain.filter(g.pred);
    const te = convTest.filter(g.pred);
    lines.push(
      `| ${g.name} | ${f1(hit50(tr))}% | ${liftStr(hit50(tr), baseTrain)} | ` +
        `${te.length} | ${f1(hit50(te))}% | **${liftStr(hit50(te), baseTest)}** | ` +
        `${((te.length / convTestN) * 100).toFixed(0)}% |`,
    );
  }
  lines.push('');
  lines.push(
    '_Want: solidly positive **test lift**, test n ≥ ~300, and retain% high ' +
      'enough that the badge still fires usefully often. All gates here are ' +
      'leakage-free (no model output)._',
  );

  const out = lines.join('\n') + '\n';
  const path = 'docs/tmp/conviction-refine-2026-05-29.md';
  writeFileSync(path, out);
  console.log(`\nWrote ${path}\n`);
  console.log(out);
})();
