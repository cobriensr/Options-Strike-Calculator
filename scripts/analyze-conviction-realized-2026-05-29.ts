#!/usr/bin/env tsx
/**
 * Verify the cheap-gate conviction edge on a REALIZED stop-based metric,
 * not just % peak — guarding against the "% favors cheap options"
 * artifact. Metric: realized_trail30_10_pct (trail 30-min max, exit on
 * -10%), which includes the downside you actually eat with a stop.
 *
 * Same OOS split (train = earlier 60% of dates, test = later 40%). We
 * report, per gate, on BOTH metrics so we can see if the realized story
 * matches the peak story:
 *   - mean realized %  (≈ average R if you risk a fixed $ per play)
 *   - win%  (realized > 0)
 *   - realized ≥ +50%  (big-win rate on the policy)
 *   - hit≥50% peak     (the prior metric, for reference)
 *
 * Focus: the chosen balanced recipe cheap≤$1 ∩ not-PM, plus the cheapness
 * ladder to check the dose-response also holds on realized R.
 *
 * Read-only. Run: npx tsx scripts/analyze-conviction-realized-2026-05-29.ts
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
  realized: number | null; // trail30_10 (stop-based)
  tier50: number | null; // tier50_holdeod (profit-target exit)
  tod: string | null;
  entry: number | null;
}

async function load(): Promise<Fire[][]> {
  const PAGE = 40_000;
  type Raw = Record<string, unknown>;
  const rows: Raw[] = [];
  for (let lastId = 0; ; ) {
    const page = (await sql`
      SELECT id, underlying_symbol, date, trigger_time_ct AS ts, option_type, strike,
             peak_ceiling_pct, realized_trail30_10_pct,
             realized_tier50_holdeod_pct, tod, entry_price
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
      realized: num(r.realized_trail30_10_pct),
      tier50: num(r.realized_tier50_holdeod_pct),
      tod: (r.tod as string) ?? null,
      entry: num(r.entry_price),
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

const vals = (fires: Fire[], sel: (f: Fire) => number | null) =>
  fires.map(sel).filter((v): v is number => v != null);
const mean = (xs: number[]) =>
  xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
const pct = (xs: number[], pred: (x: number) => boolean) =>
  xs.length ? (xs.filter(pred).length / xs.length) * 100 : null;
const f1 = (v: number | null) => (v == null ? '—' : v.toFixed(1));

const notPM = (f: Fire) => f.tod !== 'PM';
const AM = (f: Fire) => f.tod === 'AM_open';
const cheap = (c: number) => (f: Fire) => (f.entry ?? 1e9) <= c;
const and =
  (...ps: ((f: Fire) => boolean)[]) =>
  (f: Fire) =>
    ps.every((p) => p(f));

type Gate = { name: string; pred: (f: Fire) => boolean };
const GATES: Gate[] = [
  { name: 'ALL fires (baseline)', pred: () => true },
  { name: 'geometry only', pred: () => true }, // applied to conviction set
  { name: 'cheap ≤ $1.50', pred: cheap(1.5) },
  { name: 'cheap ≤ $1.00', pred: cheap(1.0) },
  { name: 'cheap ≤ $0.75', pred: cheap(0.75) },
  { name: 'cheap ≤ $0.50', pred: cheap(0.5) },
  { name: 'cheap ≤ $0.30', pred: cheap(0.3) },
  { name: '★ cheap≤1 ∩ not-PM (chosen)', pred: and(cheap(1), notPM) },
  { name: 'cheap≤1 ∩ AM_open', pred: and(cheap(1), AM) },
];

function row(label: string, fires: Fire[]): string {
  const trail = vals(fires, (f) => f.realized);
  const t50 = vals(fires, (f) => f.tier50);
  const p = vals(fires, (f) => f.peak);
  return (
    `| ${label} | ${fires.length} | ${f1(mean(trail))} | ${f1(pct(trail, (x) => x > 0))}% | ` +
    `${f1(mean(t50))} | ${f1(pct(t50, (x) => x > 0))}% | ${f1(pct(p, (x) => x >= 50))}% |`
  );
}
const HEADER =
  '| bucket | n | trail30 mean% | trail30 win% | **tier50 mean%** | tier50 win% | hit≥50% peak |\n' +
  '|---|---|---|---|---|---|---|';

(async () => {
  console.log('Loading LF …');
  const groups = await load();
  const allFires = groups.flat();
  const dates = [...new Set(allFires.map((f) => f.date))].sort();
  const splitDate = dates[Math.floor(dates.length * 0.6)]!;
  const isTrain = (f: Fire) => f.date < splitDate;

  const convAll: Fire[] = [];
  for (const g of groups) {
    const marks = markConviction(g);
    g.forEach((f, i) => {
      if (marks[i]) convAll.push(f);
    });
  }

  const sections: string[] = [];
  for (const [tag, keep] of [
    ['TEST (holdout, dates ≥ ' + splitDate + ')', (f: Fire) => !isTrain(f)],
    ['TRAIN (dates < ' + splitDate + ')', isTrain],
  ] as const) {
    const allS = allFires.filter(keep);
    const convS = convAll.filter(keep);
    const out: string[] = [`### ${tag}`, '', HEADER];
    for (const g of GATES) {
      if (g.name === 'ALL fires (baseline)') out.push(row(g.name, allS));
      else if (g.name === 'geometry only') out.push(row(g.name, convS));
      else out.push(row(g.name, convS.filter(g.pred)));
    }
    sections.push(out.join('\n'));
  }

  const out =
    `# Conviction cheap-gate — realized-metric verification (OOS) — LF — 2026-05-29\n\n` +
    `Realized metric: \`realized_trail30_10_pct\` (trail 30-min max, exit −10%). ` +
    `Checks whether the cheap-gate edge survives a stop-based outcome, not just % peak. ` +
    `Gates apply on top of conviction geometry (except the all-fires baseline row).\n\n` +
    sections.join('\n\n') +
    `\n\n_If mean realized% and realized win% rise monotonically with cheapness on the ` +
    `TEST holdout (mirroring peak), the edge is real and not a %-metric artifact._\n`;

  const path = 'docs/tmp/conviction-realized-2026-05-29.md';
  writeFileSync(path, out);
  console.log(`\nWrote ${path}\n`);
  console.log(out);
})();
