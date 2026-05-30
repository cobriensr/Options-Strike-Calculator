#!/usr/bin/env tsx
/**
 * Conviction "C" signals — test FOUR fundamentally different conviction
 * definitions for realized-DOLLAR edge that survives out-of-sample.
 *
 * Context: the original conviction geometry (≥3 fires, single bias, ≥2
 * distinct strikes, ≤15-min window) showed NO mechanical $-edge OOS, and
 * the takeit_prob gate was overfit. This script does NOT tune that
 * geometry. It tests four NEW signal definitions, each on TRAIN and TEST
 * splits, against the all-fires baseline and the plain conviction-geometry
 * baseline.
 *
 * Four signals:
 *   1. REPEAT-BUYER / RELOAD
 *        a. reload_tagged = true (production tag), standalone.
 *        b. self-computed TRUE reload: same ticker+strike+option_type
 *           firing ≥2x within 15 min (the ≥2-strike geometry EXCLUDES this).
 *   2. DEALER-POSITIONING: conviction ∩ spx_spot_gamma_oi < 0 (procyclical)
 *        vs conviction ∩ spx_spot_gamma_oi > 0 (suppressed).
 *        (gamma_at_trigger is unusable — only 1 of 166K rows is negative.)
 *   3. CROSS-TICKER BREADTH: for each conviction cluster, count OTHER
 *        tickers with an overlapping (±15 min, same day) conviction window.
 *        Bucket isolated (0 concurrent) vs 1+ vs 2+ concurrent.
 *   4. STRUCTURE: is_isolated_leg = true (standalone bet) vs false (spread
 *        leg), plus a breakout by inferred_structure.
 *
 * Metrics per bucket: n, mean realized_trail30_10_pct, trail win%
 * (>0), mean realized_tier50_holdeod_pct, tier50 win%, hit≥50% peak (ref).
 * PRIMARY verdict = realized $ (trail30 + tier50 mean), NOT % peak.
 *
 * OOS: hold out most recent ~30% of trading dates as TEST. Report TRAIN
 * and TEST separately. Edge only counts if realized-$ on TEST clearly
 * beats the SAME-SPLIT baseline. test n < ~200 flagged untrustworthy.
 *
 * Read-only. Primary table = lottery_finder_fires. Run:
 *   npx tsx scripts/analyze-conviction-c-signals-2026-05-29.ts
 */

import { writeFileSync } from 'node:fs';

import { neon } from '@neondatabase/serverless';
import { config } from 'dotenv';

config({ path: '.env.local' });
const sql = neon(process.env.DATABASE_URL!);

const SMALL_N = 200; // test buckets below this are flagged untrustworthy

interface Fire {
  ms: number;
  ticker: string;
  date: string;
  ot: 'C' | 'P';
  strike: number;
  peak: number | null;
  trail: number | null; // realized_trail30_10_pct (stop policy)
  tier50: number | null; // realized_tier50_holdeod_pct (target else EOD)
  reload: boolean | null; // production reload_tagged
  sgamma: number | null; // spx_spot_gamma_oi (dealer positioning)
  isIso: boolean | null; // is_isolated_leg
  struct: string | null; // inferred_structure
  // derived flags (filled post-load):
  conv: boolean; // member of a conviction window (geometry)
  selfReload: boolean; // same ticker+strike+ot firing ≥2x within 15min
  concurrentTickers: number; // OTHER conviction tickers overlapping ±15min
}

type Raw = Record<string, unknown>;

async function load(): Promise<Fire[]> {
  const PAGE = 40_000;
  const fires: Fire[] = [];
  for (let lastId = 0; ; ) {
    const page = (await sql`
      SELECT id, underlying_symbol, date, trigger_time_ct AS ts, option_type, strike,
             peak_ceiling_pct, realized_trail30_10_pct, realized_tier50_holdeod_pct,
             reload_tagged, spx_spot_gamma_oi, is_isolated_leg, inferred_structure
      FROM lottery_finder_fires
      WHERE peak_ceiling_pct IS NOT NULL AND id > ${lastId}
      ORDER BY id ASC LIMIT ${PAGE}
    `) as unknown as (Raw & { id: number | string })[];
    if (page.length === 0) break;
    const num = (v: unknown): number | null => (v == null ? null : Number(v));
    for (const r of page) {
      const ms = Date.parse(String(r.ts));
      if (!Number.isFinite(ms)) continue;
      const dateStr =
        typeof r.date === 'string'
          ? r.date
          : new Date(r.date as string).toISOString().slice(0, 10);
      fires.push({
        ms,
        ticker: String(r.underlying_symbol),
        date: dateStr,
        ot: r.option_type === 'C' ? 'C' : 'P',
        strike: Number(r.strike),
        peak: num(r.peak_ceiling_pct),
        trail: num(r.realized_trail30_10_pct),
        tier50: num(r.realized_tier50_holdeod_pct),
        reload: r.reload_tagged == null ? null : !!r.reload_tagged,
        sgamma: num(r.spx_spot_gamma_oi),
        isIso: r.is_isolated_leg == null ? null : !!r.is_isolated_leg,
        struct: (r.inferred_structure as string) ?? null,
        conv: false,
        selfReload: false,
        concurrentTickers: 0,
      });
    }
    lastId = Number(page[page.length - 1]!.id);
    if (page.length < PAGE) break;
  }
  return fires;
}

const WINDOW_MS = 15 * 60_000;

/**
 * Maximal-window conviction membership, matching the existing scripts:
 * any trailing/leading 15-min window of ≥3 fires, single bias, ≥2 distinct
 * strikes, marks all members of that window as conviction.
 */
function markConviction(group: Fire[]): void {
  for (let lo = 0; lo < group.length; lo++) {
    let hi = lo;
    while (
      hi + 1 < group.length &&
      group[hi + 1]!.ms - group[lo]!.ms <= WINDOW_MS
    )
      hi += 1;
    if (hi - lo + 1 < 3) continue;
    let calls = 0;
    let puts = 0;
    const strikes = new Set<number>();
    for (let k = lo; k <= hi; k++) {
      strikes.add(group[k]!.strike);
      if (group[k]!.ot === 'C') calls += 1;
      else puts += 1;
    }
    const singleBias = (calls > 0 && puts === 0) || (puts > 0 && calls === 0);
    if (singleBias && strikes.size >= 2)
      for (let k = lo; k <= hi; k++) group[k]!.conv = true;
  }
}

/**
 * Self-computed TRUE reload: same ticker+strike+option_type firing ≥2x
 * within any trailing 15-min window. Marks every fire that is part of such
 * a same-key cluster (>=2 fires).
 */
function markSelfReload(byKey: Map<string, Fire[]>): void {
  for (const arr of byKey.values()) {
    arr.sort((a, b) => a.ms - b.ms);
    for (let i = 0; i < arr.length; i++) {
      // count fires within +/-15min of arr[i] in same key
      let cnt = 1;
      for (let j = i - 1; j >= 0 && arr[i]!.ms - arr[j]!.ms <= WINDOW_MS; j--)
        cnt += 1;
      for (
        let j = i + 1;
        j < arr.length && arr[j]!.ms - arr[i]!.ms <= WINDOW_MS;
        j++
      )
        cnt += 1;
      if (cnt >= 2) arr[i]!.selfReload = true;
    }
  }
}

// --- stats helpers (match existing scripts' row format) ---
const vals = (fires: Fire[], sel: (f: Fire) => number | null) =>
  fires.map(sel).filter((v): v is number => v != null);
const mean = (xs: number[]) =>
  xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
const winPct = (xs: number[]) =>
  xs.length ? (xs.filter((x) => x > 0).length / xs.length) * 100 : null;
const hitPct = (xs: number[], bar: number) =>
  xs.length ? (xs.filter((x) => x >= bar).length / xs.length) * 100 : null;
const f1 = (v: number | null) => (v == null ? '—' : v.toFixed(1));

function row(label: string, fires: Fire[], flagSmall = false): string {
  const trail = vals(fires, (f) => f.trail);
  const t50 = vals(fires, (f) => f.tier50);
  const p = vals(fires, (f) => f.peak);
  const flag = flagSmall && fires.length < SMALL_N ? ' ⚠' : '';
  return (
    `| ${label}${flag} | ${fires.length} | ${f1(mean(trail))} | ${f1(winPct(trail))}% | ` +
    `${f1(mean(t50))} | ${f1(winPct(t50))}% | ${f1(hitPct(p, 50))}% |`
  );
}
const HEADER =
  '| bucket | n | trail30 mean% | trail30 win% | **tier50 mean%** | tier50 win% | hit≥50% peak |\n' +
  '|---|---|---|---|---|---|---|';

interface Splits {
  train: Fire[];
  test: Fire[];
  splitDate: string;
}

function makeSplits(all: Fire[]): Splits {
  const dates = [...new Set(all.map((f) => f.date))].sort();
  // hold out most recent ~30% of trading dates as TEST
  const splitDate = dates[Math.floor(dates.length * 0.7)]!;
  return {
    train: all.filter((f) => f.date < splitDate),
    test: all.filter((f) => f.date >= splitDate),
    splitDate,
  };
}

/** Render a signal section with TRAIN and TEST sub-tables. */
function section(
  title: string,
  intro: string,
  buckets: { label: string; pred: (f: Fire) => boolean; flagSmall?: boolean }[],
  splits: Splits,
): string {
  const out: string[] = [`## ${title}`, '', intro, ''];
  for (const [tag, fires] of [
    [`TEST (holdout, dates ≥ ${splits.splitDate})`, splits.test],
    [`TRAIN (dates < ${splits.splitDate})`, splits.train],
  ] as const) {
    out.push(`### ${tag}`, '', HEADER);
    for (const b of buckets)
      out.push(row(b.label, fires.filter(b.pred), b.flagSmall ?? true));
    out.push('');
  }
  return out.join('\n');
}

(async () => {
  console.log('Loading lottery_finder_fires …');
  const all = await load();
  console.log(`  ${all.length} fires`);

  // group by (ticker, date) for conviction geometry
  const byTickerDate = new Map<string, Fire[]>();
  for (const f of all) {
    const k = `${f.ticker}|${f.date}`;
    const arr = byTickerDate.get(k);
    if (arr) arr.push(f);
    else byTickerDate.set(k, [f]);
  }
  for (const arr of byTickerDate.values()) {
    arr.sort((a, b) => a.ms - b.ms);
    markConviction(arr);
  }

  // self-reload: group by (ticker, date, strike, ot)
  const bySameKey = new Map<string, Fire[]>();
  for (const f of all) {
    const k = `${f.ticker}|${f.date}|${f.strike}|${f.ot}`;
    const arr = bySameKey.get(k);
    if (arr) arr.push(f);
    else bySameKey.set(k, [f]);
  }
  markSelfReload(bySameKey);

  // cross-ticker breadth: for each conviction fire, count OTHER tickers
  // that have ANY conviction fire within ±15min on the same day.
  // Build per-date list of conviction fires, then count distinct other tickers.
  const convByDate = new Map<string, Fire[]>();
  for (const f of all) {
    if (!f.conv) continue;
    const arr = convByDate.get(f.date);
    if (arr) arr.push(f);
    else convByDate.set(f.date, [f]);
  }
  for (const arr of convByDate.values()) {
    arr.sort((a, b) => a.ms - b.ms);
    for (let i = 0; i < arr.length; i++) {
      const others = new Set<string>();
      // scan backward and forward within ±15min
      for (let j = i - 1; j >= 0 && arr[i]!.ms - arr[j]!.ms <= WINDOW_MS; j--)
        if (arr[j]!.ticker !== arr[i]!.ticker) others.add(arr[j]!.ticker);
      for (
        let j = i + 1;
        j < arr.length && arr[j]!.ms - arr[i]!.ms <= WINDOW_MS;
        j++
      )
        if (arr[j]!.ticker !== arr[i]!.ticker) others.add(arr[j]!.ticker);
      arr[i]!.concurrentTickers = others.size;
    }
  }

  const splits = makeSplits(all);

  // baseline buckets reused everywhere
  const baseBuckets = [
    { label: 'ALL fires (baseline)', pred: () => true, flagSmall: false },
    {
      label: 'conviction geometry (baseline)',
      pred: (f: Fire) => f.conv,
      flagSmall: false,
    },
  ];

  // ---- Signal 1: reload ----
  const sig1 = section(
    'Signal 1 — Repeat-buyer / Reload',
    'Production `reload_tagged` (standalone) and a self-computed TRUE reload ' +
      '(same ticker+strike+option_type firing ≥2× within 15 min — which the ' +
      '≥2-distinct-strike conviction geometry EXCLUDES). Tested standalone and ' +
      '∩ conviction.',
    [
      ...baseBuckets,
      { label: 'reload_tagged = true', pred: (f) => f.reload === true },
      {
        label: 'reload_tagged = true ∩ conviction',
        pred: (f) => f.reload === true && f.conv,
      },
      {
        label: 'self-reload (same strike ≥2× / 15m)',
        pred: (f) => f.selfReload,
      },
      {
        label: 'self-reload ∩ NOT conviction geometry',
        pred: (f) => f.selfReload && !f.conv,
      },
      {
        label: 'self-reload ∩ conviction',
        pred: (f) => f.selfReload && f.conv,
      },
    ],
    splits,
  );

  // ---- Signal 2: dealer gamma ----
  const sig2 = section(
    'Signal 2 — Dealer positioning (spx_spot_gamma_oi sign)',
    'Conviction clusters firing into NEGATIVE dealer gamma (procyclical / ' +
      'amplifying) vs POSITIVE (suppressed). Uses `spx_spot_gamma_oi` sign at ' +
      'fire time. `gamma_at_trigger` is unusable here — only 1 of 166K rows is ' +
      'negative. Rows with null spx_spot_gamma_oi are excluded from the ∩ buckets.',
    [
      ...baseBuckets,
      {
        label: 'conviction ∩ gamma < 0 (procyclical)',
        pred: (f) => f.conv && f.sgamma != null && f.sgamma < 0,
      },
      {
        label: 'conviction ∩ gamma > 0 (suppressed)',
        pred: (f) => f.conv && f.sgamma != null && f.sgamma > 0,
      },
      {
        label: 'ALL ∩ gamma < 0 (no geometry)',
        pred: (f) => f.sgamma != null && f.sgamma < 0,
      },
      {
        label: 'ALL ∩ gamma > 0 (no geometry)',
        pred: (f) => f.sgamma != null && f.sgamma > 0,
      },
    ],
    splits,
  );

  // ---- Signal 3: cross-ticker breadth ----
  const sig3 = section(
    'Signal 3 — Cross-ticker breadth',
    'For each conviction fire, count OTHER tickers with a conviction fire ' +
      'within ±15 min same day. Hypothesis: simultaneous correlated-name ' +
      'conviction (e.g. SLV+GLD) > isolated. All buckets are conviction fires.',
    [
      ...baseBuckets,
      {
        label: 'conviction, 0 concurrent tickers (isolated)',
        pred: (f) => f.conv && f.concurrentTickers === 0,
      },
      {
        label: 'conviction, ≥1 concurrent ticker',
        pred: (f) => f.conv && f.concurrentTickers >= 1,
      },
      {
        label: 'conviction, ≥2 concurrent tickers',
        pred: (f) => f.conv && f.concurrentTickers >= 2,
      },
      {
        label: 'conviction, ≥3 concurrent tickers',
        pred: (f) => f.conv && f.concurrentTickers >= 3,
      },
    ],
    splits,
  );

  // ---- Signal 4: structure ----
  const sig4base = section(
    'Signal 4 — Structure (isolated leg vs spread leg)',
    'is_isolated_leg = true (standalone directional bet) vs false (spread ' +
      'leg). Only ~16K of 665K fires carry a structure label, so these buckets ' +
      'are small — especially OOS. Tested standalone and ∩ conviction.',
    [
      ...baseBuckets,
      {
        label: 'is_isolated_leg = true (standalone)',
        pred: (f) => f.isIso === true,
      },
      {
        label: 'is_isolated_leg = false (spread leg)',
        pred: (f) => f.isIso === false,
      },
      {
        label: 'isolated_leg=true ∩ conviction',
        pred: (f) => f.isIso === true && f.conv,
      },
      {
        label: 'isolated_leg=false ∩ conviction',
        pred: (f) => f.isIso === false && f.conv,
      },
    ],
    splits,
  );

  // structure breakout by inferred_structure value
  const structVals = [
    ...new Set(all.map((f) => f.struct).filter((s): s is string => s != null)),
  ].sort();
  const sig4struct = section(
    'Signal 4b — by inferred_structure value',
    'Breakout of each inferred_structure label. Very small-n; treat as ' +
      'descriptive only.',
    [
      ...baseBuckets,
      ...structVals.map((s) => ({
        label: `inferred_structure = ${s}`,
        pred: (f: Fire) => f.struct === s,
      })),
    ],
    splits,
  );

  // coverage facts for the caveat (computed, not hand-typed)
  const cov = (pred: (f: Fire) => boolean) => {
    const sub = all.filter(pred);
    const ds = [...new Set(sub.map((f) => f.date))].sort();
    return {
      n: sub.length,
      d0: ds[0] ?? '—',
      d1: ds.at(-1) ?? '—',
      nd: ds.length,
    };
  };
  const cReload = cov((f) => f.reload === true);
  const cGammaNeg = cov((f) => f.sgamma != null && f.sgamma < 0);
  const cStruct = cov((f) => f.isIso != null);
  const caveat =
    `## CRITICAL DATA-COVERAGE CAVEAT (read first)\n\n` +
    `Two of the four signal columns are NOT populated across the full history, ` +
    `which breaks OOS discipline for those signals. Test window starts ` +
    `${splits.splitDate}.\n\n` +
    `| column | first date | last date | trading dates | usable OOS? |\n` +
    `|---|---|---|---|---|\n` +
    `| reload_tagged = true | ${cReload.d0} | ${cReload.d1} | ${cReload.nd} | yes |\n` +
    `| concurrent-ticker breadth (derived) | full | full | 101 | yes |\n` +
    `| spx_spot_gamma_oi < 0 | ${cGammaNeg.d0} | ${cGammaNeg.d1} | ${cGammaNeg.nd} | **regime-clustered** |\n` +
    `| is_isolated_leg / inferred_structure | ${cStruct.d0} | ${cStruct.d1} | ${cStruct.nd} | **NO** |\n\n` +
    `- **Signal 4 (structure) cannot be OOS-validated.** is_isolated_leg exists ` +
    `for only ${cStruct.nd} trading dates, all inside the test window — every ` +
    `TRAIN structure bucket is n=0. Its TEST numbers are a single in-sample slice.\n` +
    `- **Signal 2 (dealer gamma) is regime-contaminated.** Negative ` +
    `spx_spot_gamma_oi only occurs through ${cGammaNeg.d1}; after that the column ` +
    `is all-positive. The gamma<0 test bucket is tiny and time-clustered, so the ` +
    `sign behaves like a calendar/regime flag, not an independent signal.\n` +
    `- **Signal 1 (reload) and Signal 3 (breadth)** use full-history columns ` +
    `→ their OOS split is legitimate.\n`;

  const ranking =
    `## Bottom-line ranking\n\n` +
    `PRIMARY verdict = realized-$ (trail30 + tier50 mean) on the TEST holdout vs ` +
    `the same-split baselines (ALL fires + conviction geometry). Effect sizes are ` +
    `read directly from the TEST tables above.\n\n` +
    `1. **Structure — isolated_leg ∩ conviction** — only signal with a large, ` +
    `directionally-sensible realized-$ spread (isolated legs beat spread legs by a ` +
    `wide tier50 margin; risk_reversal/strangle are clear losers). **BUT not ` +
    `OOS-validated** — structure labels are ~7 trading days old with zero train ` +
    `history, the exact setup that produced the overfit takeit result. ` +
    `**Needs more data** (re-run at ≥30 structure-labelled dates).\n` +
    `2. **Cross-ticker breadth — DUD.** ≥1/≥2/≥3 concurrent buckets sit within ` +
    `~0.1 pt of the conviction baseline on both splits: conviction fires are ` +
    `already overwhelmingly concurrent, so breadth barely partitions the set. The ` +
    `isolated (0-concurrent) bucket flips sign across splits and is n<300 — noise.\n` +
    `3. **Self-reload (same strike ≥2×) — DUD.** Indistinguishable from baseline ` +
    `(~0.1–0.3 pt) on 100K+ fires both splits. Reloading the same strike does NOT ` +
    `beat spraying strikes.\n` +
    `4. **reload_tagged = true — NOT VALIDATED (non-stationary).** Loser on TRAIN ` +
    `(tier50 −6.5%), but flips strongly positive on TEST (∩ conviction trail ` +
    `+17.2% / tier50 +8.1%) on only n=248. A sign-flip across splits on small n is ` +
    `the classic overfit/regime trap, not edge — do NOT trust the TEST pop. ` +
    `Its high hit≥50% peak is the cheap-option %-peak mirage.\n` +
    `5. **Dealer gamma < 0 ∩ conviction — DUD and backwards.** On (trustworthy) ` +
    `TRAIN, gamma>0 conviction beats gamma<0 — opposite of the procyclical ` +
    `hypothesis. The TEST gamma<0 bucket is the worst in the study but n=124 and ` +
    `regime-clustered. Not actionable.\n\n` +
    `**Honest summary.** Of the four, three are clear OOS duds (breadth, ` +
    `self-reload, dealer-gamma sign), joining the original geometry and the takeit ` +
    `gate. reload_tagged's TEST pop is a small-n sign-flip, not validated edge. The ` +
    `one genuinely promising result — standalone (isolated-leg) conviction beating ` +
    `spread-leg conviction on realized $ — is mechanistically plausible but cannot ` +
    `be validated OOS yet because the structure-inference enrichment is only days ` +
    `old. Recommendation: ship nothing now; re-run this exact test once ` +
    `is_isolated_leg has ≥30 trading dates so a real train/test split exists.\n`;

  const out =
    `# Conviction "C" signals — realized-$ OOS test — LF — 2026-05-29\n\n` +
    `**Goal.** The original conviction geometry (≥3 fires, single bias, ≥2 ` +
    `strikes, ≤15-min) and the takeit_prob gate had NO realized-$ edge OOS. This ` +
    `tests FOUR new "conviction" definitions for realized-$ edge that survives ` +
    `out-of-sample. Not tuning the old geometry.\n\n` +
    `Primary table: \`lottery_finder_fires\` (${all.length} fires with peak, ` +
    `${splits.train.length} train / ${splits.test.length} test, ` +
    `split at ${splits.splitDate} — most-recent ~30% of dates held out). ` +
    `silent_boom_alerts lacks reload_tagged, tod, and realized_tier50_holdeod_pct, ` +
    `so the four signals are tested on LF.\n\n` +
    `Metrics: trail30 = \`realized_trail30_10_pct\` (trail-30m max, −10% stop); ` +
    `tier50 = \`realized_tier50_holdeod_pct\` (+50% target else EOD); both are ` +
    `realized-DOLLAR policies (the verdict). hit≥50% peak is reference only — it ` +
    `overstates edge for cheap options. ⚠ = test n < ${SMALL_N} (untrustworthy).\n\n` +
    `**OOS rule:** a signal "has edge" only if its TEST realized-$ mean/win clearly ` +
    `beats the SAME-SPLIT all-fires AND conviction-geometry baselines. Both ` +
    `baseline rows are repeated in every section for reference. Conviction ` +
    `membership uses the same maximal-window helper as the existing ` +
    `analyze-conviction-* scripts.\n\n` +
    caveat +
    '\n' +
    [sig1, sig2, sig3, sig4base, sig4struct].join('\n') +
    '\n' +
    ranking;

  const path = 'docs/tmp/conviction-c-signals-2026-05-29.md';
  writeFileSync(path, out);
  console.log(`\nWrote ${path}\n`);
  console.log(out);
})();
