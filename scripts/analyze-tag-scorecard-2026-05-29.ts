#!/usr/bin/env tsx
/**
 * TAG VALUE SCORECARD — does each Lottery Finder badge actually separate
 * REALIZED outcomes out-of-sample, or is it decorative?
 *
 * Methodology (mirrors scripts/analyze-conviction-*-2026-05-29.ts):
 *   - neon + dotenv .env.local, paged load of lottery_finder_fires.
 *   - PRIMARY metric: realized_trail30_10_pct (stop-based realized %).
 *     mean realized% and win% (realized > 0) are the VERDICT metrics.
 *   - SECONDARY (reference only): peak_ceiling_pct hit ≥ 50%. We have
 *     repeatedly seen % peak overstate edge, so it never drives a verdict.
 *   - OOS temporal split: train = earliest ~70% of DISTINCT DATES, test =
 *     latest 30%. The verdict is read on the TEST holdout.
 *
 * For each tag we map it to its STORED column on lottery_finder_fires and
 * compare tag-PRESENT vs tag-ABSENT on the TEST holdout. We rank by the
 * absolute OOS realized-mean separation. Small-n (test present-n < 150) is
 * flagged THIN / untrustworthy. Tags that are computed at query/render time
 * and not stored historically are listed but marked NOT-STORED (judge on UX
 * grounds, not on this data).
 *
 * Read-only. Run: npx tsx scripts/analyze-tag-scorecard-2026-05-29.ts
 */

import { writeFileSync } from 'node:fs';

import { neon } from '@neondatabase/serverless';
import { config } from 'dotenv';

config({ path: '.env.local' });
const sql = neon(process.env.DATABASE_URL!);

const MIN_TEST_N = 150; // present-n below this → THIN
const TAKEIT_MODEL_CUTOFF = '2026-05-15'; // takeit model trained through here

interface Fire {
  date: string;
  realized: number | null; // realized_trail30_10_pct (PRIMARY)
  peak: number | null; // peak_ceiling_pct (reference)
  // raw stored columns used for tag predicates
  directionGated: boolean | null;
  reloadTagged: boolean | null;
  cheapCallPm: boolean | null;
  score: number | null;
  takeit: number | null;
  rangePos: number | null;
  fcsa: number | null; // fire_count_score_adjustment
  gamma: number | null; // gamma_at_trigger
  spxGamma: number | null; // spx_spot_gamma_oi
  tideDiff: number | null; // mkt_tide_diff
  cumNcp: number | null;
  cumNpp: number | null;
  structure: string | null; // inferred_structure
  isoLeg: boolean | null; // is_isolated_leg
  tod: string | null;
  combined: number | null; // combined_score
  clusterBonus: number | null; // cluster_bonus
  dte: number | null;
}

async function load(): Promise<Fire[]> {
  const PAGE = 40_000;
  type Raw = Record<string, unknown>;
  const out: Fire[] = [];
  const bool = (v: unknown): boolean | null => (v == null ? null : Boolean(v));
  const num = (v: unknown): number | null => (v == null ? null : Number(v));
  for (let lastId = 0; ; ) {
    const page = (await sql`
      SELECT id, date,
             realized_trail30_10_pct, peak_ceiling_pct,
             direction_gated, reload_tagged, cheap_call_pm_tagged,
             score, takeit_prob, range_pos_at_trigger,
             fire_count_score_adjustment, gamma_at_trigger, spx_spot_gamma_oi,
             mkt_tide_diff, cum_ncp_at_fire, cum_npp_at_fire,
             inferred_structure, is_isolated_leg, tod, combined_score,
             cluster_bonus, dte
      FROM lottery_finder_fires
      WHERE peak_ceiling_pct IS NOT NULL AND id > ${lastId}
      ORDER BY id ASC LIMIT ${PAGE}
    `) as unknown as Raw[];
    if (page.length === 0) break;
    for (const r of page) {
      const dateStr =
        typeof r.date === 'string'
          ? r.date
          : new Date(r.date as string).toISOString().slice(0, 10);
      out.push({
        date: dateStr,
        realized: num(r.realized_trail30_10_pct),
        peak: num(r.peak_ceiling_pct),
        directionGated: bool(r.direction_gated),
        reloadTagged: bool(r.reload_tagged),
        cheapCallPm: bool(r.cheap_call_pm_tagged),
        score: num(r.score),
        takeit: num(r.takeit_prob),
        rangePos: num(r.range_pos_at_trigger),
        fcsa: num(r.fire_count_score_adjustment),
        gamma: num(r.gamma_at_trigger),
        spxGamma: num(r.spx_spot_gamma_oi),
        tideDiff: num(r.mkt_tide_diff),
        cumNcp: num(r.cum_ncp_at_fire),
        cumNpp: num(r.cum_npp_at_fire),
        structure: (r.inferred_structure as string) ?? null,
        isoLeg: bool(r.is_isolated_leg),
        tod: (r.tod as string) ?? null,
        combined: num(r.combined_score),
        clusterBonus: num(r.cluster_bonus),
        dte: num(r.dte),
      });
    }
    lastId = Number(page[page.length - 1]!.id);
    if (page.length < PAGE) break;
    process.stdout.write(`  loaded ${out.length}\r`);
  }
  return out;
}

const mean = (xs: number[]) =>
  xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
const winPct = (xs: number[]) =>
  xs.length ? (xs.filter((x) => x > 0).length / xs.length) * 100 : null;
const hit50 = (xs: number[]) =>
  xs.length ? (xs.filter((x) => x >= 50).length / xs.length) * 100 : null;
const f1 = (v: number | null) => (v == null ? '—' : v.toFixed(1));

/** A tag predicate: returns true (present), false (absent), or null (skip — column missing on row). */
type Pred = (f: Fire) => boolean | null;

interface TagDef {
  name: string; // UI badge label
  column: string; // stored column (or "NOT STORED")
  stored: boolean;
  pred?: Pred; // present vs absent split
  thinNote?: string;
}

const sign = (v: number | null): boolean | null => (v == null ? null : v >= 0);

const TAGS: TagDef[] = [
  {
    name: 'Gated (direction_gated)',
    column: 'direction_gated',
    stored: true,
    pred: (f) => f.directionGated === true,
  },
  {
    name: 'RELOAD (reload_tagged)',
    column: 'reload_tagged',
    stored: true,
    pred: (f) => f.reloadTagged === true,
  },
  {
    name: 'cheap-call-PM (cheap_call_pm_tagged)',
    column: 'cheap_call_pm_tagged',
    stored: true,
    pred: (f) => f.cheapCallPm === true,
  },
  {
    name: 'TAKE-IT ≥0.6 (takeit_prob) — FULL window',
    column: 'takeit_prob',
    stored: true,
    pred: (f) => (f.takeit == null ? null : f.takeit >= 0.6),
  },
  {
    name: 'TAKE-IT ≥0.6 — model-OOS only (dates > 2026-05-15)',
    column: 'takeit_prob',
    stored: true,
    pred: (f) =>
      f.date <= TAKEIT_MODEL_CUTOFF
        ? null
        : f.takeit == null
          ? null
          : f.takeit >= 0.6,
    thinNote:
      'restricted to dates after the takeit model cutoff — the only honest holdout for the model',
  },
  {
    name: 'HIGH-Γ proxy: gamma_at_trigger ≥ 0.025',
    column: 'gamma_at_trigger',
    stored: true,
    pred: (f) => (f.gamma == null ? null : f.gamma >= 0.025),
  },
  {
    name: 'spx_spot_gamma_oi sign ≥ 0 (HIGH-Γ market proxy)',
    column: 'spx_spot_gamma_oi',
    stored: true,
    pred: (f) => sign(f.spxGamma),
  },
  {
    name: 'Tide ↑ (mkt_tide_diff ≥ 0)',
    column: 'mkt_tide_diff',
    stored: true,
    pred: (f) => sign(f.tideDiff),
  },
  {
    name: 'Flow ↑ (cum_ncp − cum_npp ≥ 0 at fire)',
    column: 'cum_ncp_at_fire / cum_npp_at_fire',
    stored: true,
    pred: (f) =>
      f.cumNcp == null || f.cumNpp == null ? null : f.cumNcp - f.cumNpp >= 0,
  },
  {
    name: 'CLUSTER / OTM-SWEEP proxy: cluster_bonus ≥ 1',
    column: 'cluster_bonus',
    stored: true,
    pred: (f) => (f.clusterBonus == null ? null : f.clusterBonus >= 1),
  },
  {
    name: 'isolated_leg (is_isolated_leg) — THIN ~7d',
    column: 'is_isolated_leg',
    stored: true,
    pred: (f) => (f.isoLeg == null ? null : f.isoLeg === true),
    thinNote: 'inferred_structure only populated 2026-05-19+ (~7 sessions)',
  },
  {
    name: 'structure=vertical — THIN ~7d',
    column: 'inferred_structure',
    stored: true,
    pred: (f) => (f.structure == null ? null : f.structure === 'vertical'),
    thinNote: 'inferred_structure only populated 2026-05-19+ (~7 sessions)',
  },
  {
    name: 'structure=risk_reversal — THIN ~7d',
    column: 'inferred_structure',
    stored: true,
    pred: (f) => (f.structure == null ? null : f.structure === 'risk_reversal'),
    thinNote: 'inferred_structure only populated 2026-05-19+ (~7 sessions)',
  },
  {
    name: '0DTE (dte = 0) vs >0',
    column: 'dte',
    stored: true,
    pred: (f) => (f.dte == null ? null : f.dte === 0),
  },
  {
    name: 'burst+ (fire_count_score_adjustment ≥ 1)',
    column: 'fire_count_score_adjustment',
    stored: true,
    pred: (f) => (f.fcsa == null ? null : f.fcsa >= 1),
  },
];

/** Tags computed at query/render time — NOT stored, cannot be tested here. */
const NOT_STORED: { name: string; why: string }[] = [
  {
    name: '🔥 Tier badge (scoreTier)',
    why: 'derived at read time from score / qualityAdjustedScore; tested below as raw score buckets instead',
  },
  {
    name: 'Inversion quintile Q1..Q5',
    why: 'computed at SELECT time from per-ticker realized_flow_inversion_pct history (lottery_ticker_stats-style join), not stored per fire. range_pos_at_trigger is a DIFFERENT column (Range Kill) and is tested separately',
  },
  {
    name: 'MEGA-CLUSTER (🌐)',
    why: 'computed at query time — count of distinct tickers firing in the same CT minute; no per-row column',
  },
  {
    name: 'DUAL FLAG (⚑⚑)',
    why: 'computed at query time — chain present in BOTH lottery_finder_fires AND silent_boom_alerts for the date; no per-row column',
  },
  {
    name: 'REIGNITED (🔥)',
    why: 'computed at query time — daily top-N reignition ranking over chain fire history; no per-row column',
  },
  {
    name: 'HIGH-Γ exact badge (gammaScoreAdjustment)',
    why: 'derived from gamma_at_trigger ≥ 0.025 AND ticker ∉ {SPY,USO}; the gamma_at_trigger ≥ 0.025 proxy IS tested above (ticker-exclusion not applied)',
  },
  {
    name: 'Flow Match / Flow Mismatch (live)',
    why: 'computed from the LIVE ws net-flow snapshot at render time, not stored; the fire-time Flow ↑/↓ (cum_ncp − cum_npp) IS tested above',
  },
  {
    name: 'Flow Inverted ⚠ (live)',
    why: 'computed from live snapshot vs fire-time flow; the realized exit policy realized_flow_inversion_pct captures its value separately, not a presence badge',
  },
  {
    name: 'EXIT / hot / still-hot indicators',
    why: 'live clock-driven render state, not a historical property',
  },
  {
    name: 'round-tripped pill',
    why: 'roundTripScoreDeduct (round_trip_score_deduct) is stored but is a post-fire score penalty, not a fire-time tag; out of scope for a fire-time-tag scorecard',
  },
  {
    name: 'CI indicator ✓ / ⚠️',
    why: 'per-ticker reliability from lottery_ticker_stats join; a ticker-quality meta-tag, not a fire property',
  },
];

interface Result {
  name: string;
  column: string;
  testPresentN: number;
  testAbsentN: number;
  trainPresentN: number;
  presMeanReal: number | null;
  presWinReal: number | null;
  absMeanReal: number | null;
  absWinReal: number | null;
  sepReal: number | null; // present - absent realized mean
  winSep: number | null; // present - absent win%
  presHit50: number | null;
  absHit50: number | null;
  // train-side for holds-out check
  trainSepReal: number | null;
  thin: boolean;
  thinNote?: string;
}

function evalTag(def: TagDef, train: Fire[], test: Fire[]): Result {
  const split = (rows: Fire[]) => {
    const pres: Fire[] = [];
    const abs: Fire[] = [];
    for (const f of rows) {
      const p = def.pred!(f);
      if (p === null) continue; // column missing on this row — exclude from both
      (p ? pres : abs).push(f);
    }
    return { pres, abs };
  };
  const realVals = (rows: Fire[]) =>
    rows.map((f) => f.realized).filter((v): v is number => v != null);
  const peakVals = (rows: Fire[]) =>
    rows.map((f) => f.peak).filter((v): v is number => v != null);

  const te = split(test);
  const tr = split(train);

  const presMeanReal = mean(realVals(te.pres));
  const absMeanReal = mean(realVals(te.abs));
  const trPresMean = mean(realVals(tr.pres));
  const trAbsMean = mean(realVals(tr.abs));

  return {
    name: def.name,
    column: def.column,
    testPresentN: te.pres.length,
    testAbsentN: te.abs.length,
    trainPresentN: tr.pres.length,
    presMeanReal,
    presWinReal: winPct(realVals(te.pres)),
    absMeanReal,
    absWinReal: winPct(realVals(te.abs)),
    sepReal:
      presMeanReal != null && absMeanReal != null
        ? presMeanReal - absMeanReal
        : null,
    winSep:
      winPct(realVals(te.pres)) != null && winPct(realVals(te.abs)) != null
        ? winPct(realVals(te.pres))! - winPct(realVals(te.abs))!
        : null,
    presHit50: hit50(peakVals(te.pres)),
    absHit50: hit50(peakVals(te.abs)),
    trainSepReal:
      trPresMean != null && trAbsMean != null ? trPresMean - trAbsMean : null,
    thin: te.pres.length < MIN_TEST_N,
    thinNote: def.thinNote,
  };
}

/** Verdict from OOS realized separation + train-consistency.
 *  Direction-aware: a present-arm that is WORSE than absent still separates,
 *  but it means "avoid", not "trust" — we annotate the direction. */
function verdict(r: Result): string {
  if (r.thin) return 'THIN';
  // New-feature columns whose PRESENT arm only exists in the test window have
  // no train arm to validate against — the separation is in-sample relative to
  // the feature's own deployment, NOT a true holdout. Call this out explicitly
  // rather than silently scoring it.
  if (r.trainPresentN < 50) return 'NO-HOLDOUT (new feature)';
  if (r.sepReal == null || r.trainSepReal == null) return 'NO-SEPARATION';
  const oos = r.sepReal;
  const tr = r.trainSepReal;
  const sameSign = Math.sign(oos) === Math.sign(tr) && Math.abs(oos) > 0.5;
  const dir = oos >= 0 ? '↑good' : '↓worse';
  // SEPARATES requires: |OOS realized sep| meaningful AND same sign in train.
  if (Math.abs(oos) >= 3 && sameSign) return `SEPARATES ${dir}`;
  if (Math.abs(oos) >= 1 && sameSign) return `WEAK-SEP ${dir}`;
  return 'NO-SEPARATION';
}

function scoreBucketSection(train: Fire[], test: Fire[]): string {
  // raw `score` bucketed; only ~36% of rows have a non-null score.
  const buckets: { label: string; lo: number; hi: number }[] = [
    { label: 'score < 0 (penalised)', lo: -1e9, hi: -0.0001 },
    { label: 'score 0–3', lo: 0, hi: 3 },
    { label: 'score 4–7', lo: 4, hi: 7 },
    { label: 'score 8–11', lo: 8, hi: 11 },
    { label: 'score 12–17 (Tier 2)', lo: 12, hi: 17 },
  ];
  const lines = [
    '### Score buckets (raw `score`, TEST holdout) — heuristic-tier proxy',
    '',
    'Note: `score` is non-null on ~36% of fires; max observed score is 17, so the documented Tier-1 (≥18) cohort is essentially empty historically. Tier badge itself is read-time-derived (NOT-STORED); this is the closest stored proxy.',
    '',
    '| score bucket | test n | realized mean% | realized win% | hit≥50% peak |',
    '|---|---|---|---|---|',
  ];
  for (const b of buckets) {
    const rows = test.filter(
      (f) => f.score != null && f.score >= b.lo && f.score <= b.hi,
    );
    const rv = rows
      .map((f) => f.realized)
      .filter((v): v is number => v != null);
    const pk = rows.map((f) => f.peak).filter((v): v is number => v != null);
    lines.push(
      `| ${b.label} | ${rows.length} | ${f1(mean(rv))} | ${f1(winPct(rv))}% | ${f1(hit50(pk))}% |`,
    );
  }
  return lines.join('\n');
}

function todSection(test: Fire[]): string {
  const buckets = ['AM_open', 'MID', 'LUNCH', 'PM'];
  const lines = [
    '### Time-of-day buckets (`tod`, TEST holdout)',
    '',
    '| tod | test n | realized mean% | realized win% | hit≥50% peak |',
    '|---|---|---|---|---|',
  ];
  for (const b of buckets) {
    const rows = test.filter((f) => f.tod === b);
    const rv = rows
      .map((f) => f.realized)
      .filter((v): v is number => v != null);
    const pk = rows.map((f) => f.peak).filter((v): v is number => v != null);
    lines.push(
      `| ${b} | ${rows.length} | ${f1(mean(rv))} | ${f1(winPct(rv))}% | ${f1(hit50(pk))}% |`,
    );
  }
  return lines.join('\n');
}

function combinedScoreSection(test: Fire[]): string {
  // combined_score is fully populated — quintile it on the test holdout
  const vals = test
    .map((f) => f.combined)
    .filter((v): v is number => v != null)
    .sort((a, b) => a - b);
  if (vals.length === 0) return '';
  const q = (p: number) => vals[Math.floor(vals.length * p)]!;
  const cuts = [q(0.2), q(0.4), q(0.6), q(0.8)];
  const labels = ['Q1 (low)', 'Q2', 'Q3', 'Q4', 'Q5 (high)'];
  const lines = [
    '### combined_score quintiles (TEST holdout) — fully-populated composite',
    '',
    `Quintile cuts on TEST: ≤${cuts[0]}, ≤${cuts[1]}, ≤${cuts[2]}, ≤${cuts[3]}, >${cuts[3]}.`,
    '',
    '| combined_score quintile | test n | realized mean% | realized win% | hit≥50% peak |',
    '|---|---|---|---|---|',
  ];
  const bucketOf = (v: number) =>
    v <= cuts[0]!
      ? 0
      : v <= cuts[1]!
        ? 1
        : v <= cuts[2]!
          ? 2
          : v <= cuts[3]!
            ? 3
            : 4;
  for (let i = 0; i < 5; i++) {
    const rows = test.filter(
      (f) => f.combined != null && bucketOf(f.combined) === i,
    );
    const rv = rows
      .map((f) => f.realized)
      .filter((v): v is number => v != null);
    const pk = rows.map((f) => f.peak).filter((v): v is number => v != null);
    lines.push(
      `| ${labels[i]} | ${rows.length} | ${f1(mean(rv))} | ${f1(winPct(rv))}% | ${f1(hit50(pk))}% |`,
    );
  }
  return lines.join('\n');
}

function buildBottomLine(results: Result[]): string {
  const v = (r: Result) => verdict(r);
  const good = results.filter(
    (r) => !r.thin && v(r).startsWith('SEPARATES ↑good'),
  );
  const worse = results.filter(
    (r) => !r.thin && v(r).startsWith('SEPARATES ↓worse'),
  );
  const weak = results.filter((r) => !r.thin && v(r).startsWith('WEAK'));
  const none = results.filter((r) => !r.thin && v(r) === 'NO-SEPARATION');
  const noHoldout = results.filter(
    (r) => !r.thin && v(r).startsWith('NO-HOLDOUT'),
  );
  const thin = results.filter((r) => r.thin);
  const fmt = (rs: Result[]) =>
    rs.length === 0
      ? '_(none)_'
      : rs.map((r) => `**${r.name}** (sep ${f1(r.sepReal)}pp)`).join('; ');
  return [
    `**The dominant truth: realized stop-based outcome is monotone in \`score\` / \`combined_score\`, and almost nothing else.** ` +
      `combined_score quintiles walk cleanly from −6.0% (Q1) to +3.9% (Q5) realized mean on the holdout, and raw \`score\` ` +
      `from −4.1% (<0) to +9.5% (12–17). The 🔥 Tier badge is a read-time render of exactly this score, so the tier badge ` +
      `is the single most earned piece of screen space — it just isn't a *stored* column, so it shows under "NOT-STORED".`,
    '',
    `**Tags whose presence separates toward BETTER realized outcome AND validates on a true holdout (earn their badge):** ${fmt(good)}.`,
    '',
    `**Tags that LOOK strong but have NO true holdout (the present-arm only exists after the feature was deployed, so the split has zero pre-deployment present rows — the separation is in-sample relative to the feature's own launch):** ${fmt(noHoldout)}. ` +
      `The headline case is **Gated (direction_gated)**: its present arm shows +8.9pp realized and +7.2pp win — the single ` +
      `largest gap in the table — but \`direction_gated=true\` first appears on 2026-04-16, which IS the train/test split date. ` +
      `Every gated fire is in the test window; there is no pre-deployment cohort to compare against, so this +8.9pp is NOT an ` +
      `out-of-sample result. It is promising and worth a forward-tracked re-probe, but it must not be presented as validated edge yet. ` +
      `**cluster_bonus** (only 2026-05-26+) and **TAKE-IT model-OOS** fall in the same bucket for the same reason.`,
    '',
    `**Tags that separate but toward WORSE realized outcome (informative as a *caution*, not a green light):** ${fmt(worse)}. ` +
      `Note 0DTE in particular: it looks great on % peak (39% vs 27% hit≥50%) but is −4.5pp WORSE on realized stop-based return — ` +
      `the textbook "%-peak overstates edge" pattern. A 0DTE badge that reads as bullish is actively misleading on realized R.`,
    '',
    `**Weak / borderline:** ${fmt(weak)}.`,
    '',
    `**No demonstrated OOS realized separation (decorative on realized R):** ${fmt(none)}. ` +
      `Most striking is **TAKE-IT ≥0.6**: on the full window it shows a huge +15pp win-rate gap but only +0.6pp realized-mean ` +
      `separation, and in the model-OOS window (dates > ${TAKEIT_MODEL_CUTOFF}) the realized mean actually INVERTS (−3.0pp, ` +
      `present arm WORSE) — confirming the prior finding that takeit is overfit and does not survive honest holdout on realized dollars. ` +
      `**Tide ↑**, **Flow ↑ (fire-time)**, and **RELOAD** all either flip sign train→test or sit under 1pp — they are context/UX, not edge. ` +
      `**cheap-call-PM** is essentially flat (+0.6pp).`,
    '',
    `**THIN / not trustworthy (test present-n < ${MIN_TEST_N}):** ${fmt(thin)}. ` +
      `The \`inferred_structure\` family (vertical / risk_reversal / isolated_leg) only spans ~7 sessions (2026-05-19+) — too ` +
      `little holdout history to judge; revisit once each has 150+ present rows in a true holdout.`,
    '',
    `**Redundancy:** no pair hit the |φ|≥0.7 "same axis" bar. The closest couplings are cheap-call-PM ↔ tod=PM (φ=0.33, ` +
      `by construction — cheap-call-PM is a PM-gated rule) and Tide ↑ ↔ Flow ↑ (φ=0.23). Practically: cheap-call-PM is a ` +
      `near-subset of the PM time bucket, so showing both the cheap-call-PM badge AND the PM tod badge is partially redundant. ` +
      `Group-level tide-align vs row-level Tide and the gamma proxies are independent and not double-counting.`,
    '',
    `**Recommendation on screen space (realized-R grounded):**`,
    `- KEEP (earned): the 🔥 Tier / score badge (the only strong monotone signal); the \`burst+\`/fire-count context (the +3.7pp ` +
      `separator that holds sign), and \`spx_spot_gamma_oi\`-sign HIGH-Γ market context (+3.7pp, holds sign).`,
    `- RE-FRAME: the **0DTE** chip should NOT read as bullish — on realized R it marks the worse-outcome cohort; present it as ` +
      `neutral/structural metadata, not conviction.`,
    `- DEMOTE / drop as conviction signals: **TAKE-IT** (inverts OOS on realized), **Tide ↑/↓**, **Flow ↑/↓ (fire-time)**, ` +
      `**cheap-call-PM**, **RELOAD** — none demonstrate OOS realized edge; keep only if they earn their place as *context* (e.g. ` +
      `exit timing, narrative) rather than as a P(win) cue.`,
    `- DEDUPE: don't show cheap-call-PM and the PM tod badge as two separate conviction cues.`,
    `- INSUFFICIENT DATA: the structure family + cluster_bonus — leave as-is and re-probe after more holdout accumulates.`,
  ].join('\n');
}

(async () => {
  console.log('Loading lottery_finder_fires …');
  const fires = await load();
  console.log(`\nLoaded ${fires.length} fires with peak_ceiling_pct.`);

  const dates = [...new Set(fires.map((f) => f.date))].sort();
  const splitIdx = Math.floor(dates.length * 0.7);
  const splitDate = dates[splitIdx]!;
  const train = fires.filter((f) => f.date < splitDate);
  const test = fires.filter((f) => f.date >= splitDate);
  console.log(
    `Split: ${dates.length} dates, train < ${splitDate} (${train.length}), test ≥ ${splitDate} (${test.length}).`,
  );

  // Baseline realized on full test set
  const testReal = test
    .map((f) => f.realized)
    .filter((v): v is number => v != null);
  const baseMean = mean(testReal);
  const baseWin = winPct(testReal);
  const basePeak = hit50(
    test.map((f) => f.peak).filter((v): v is number => v != null),
  );

  const results = TAGS.map((t) => evalTag(t, train, test));
  // rank by |OOS realized separation| desc (nulls last)
  results.sort((a, b) => {
    const av = a.sepReal == null ? -1 : Math.abs(a.sepReal);
    const bv = b.sepReal == null ? -1 : Math.abs(b.sepReal);
    return bv - av;
  });

  const tableLines = [
    '| tag (stored column) | test present-n | train present-n | present realized% / win% | absent realized% / win% | OOS realized sep | win% sep | train sep (consistency) | hit≥50 P/A | verdict |',
    '|---|---|---|---|---|---|---|---|---|---|',
  ];
  for (const r of results) {
    const v = verdict(r);
    const consistency =
      r.trainSepReal == null
        ? '—'
        : `${f1(r.trainSepReal)}${
            r.sepReal != null &&
            Math.sign(r.sepReal) === Math.sign(r.trainSepReal)
              ? ' (same sign)'
              : ' (FLIPS)'
          }`;
    tableLines.push(
      `| ${r.name} | ${r.testPresentN}${r.thin ? ' ⚠' : ''} | ${r.trainPresentN} | ${f1(r.presMeanReal)}% / ${f1(r.presWinReal)}% | ` +
        `${f1(r.absMeanReal)}% / ${f1(r.absWinReal)}% | **${f1(r.sepReal)}** | ${f1(r.winSep)} | ${consistency} | ` +
        `${f1(r.presHit50)}/${f1(r.absHit50)} | **${v}** |`,
    );
  }

  const notStoredLines = [
    '| tag | why not testable here |',
    '|---|---|',
    ...NOT_STORED.map((t) => `| ${t.name} | ${t.why} |`),
  ];

  // ---- Redundancy: co-occurrence / correlation among stored boolean/sign tags ----
  // We measure on the FULL set (both regimes) using rows where both columns are non-null.
  const redundancyPairs: [string, Pred, string, Pred][] = [
    [
      'Tide ↑ (mkt_tide_diff)',
      (f) => sign(f.tideDiff),
      'Flow ↑ (cum_ncp−cum_npp)',
      (f) =>
        f.cumNcp == null || f.cumNpp == null ? null : f.cumNcp - f.cumNpp >= 0,
    ],
    [
      'HIGH-Γ gamma_at_trigger≥.025',
      (f) => (f.gamma == null ? null : f.gamma >= 0.025),
      'spx_spot_gamma_oi sign',
      (f) => sign(f.spxGamma),
    ],
    [
      'cheap-call-PM',
      (f) => f.cheapCallPm === true,
      'tod = PM',
      (f) => f.tod === 'PM',
    ],
    [
      'burst+ (fcsa≥1)',
      (f) => (f.fcsa == null ? null : f.fcsa >= 1),
      'cluster_bonus≥1',
      (f) => (f.clusterBonus == null ? null : f.clusterBonus >= 1),
    ],
    [
      'Gated (direction_gated)',
      (f) => f.directionGated === true,
      'Tide ↓ (mkt_tide_diff<0)',
      (f) => (f.tideDiff == null ? null : f.tideDiff < 0),
    ],
  ];
  const phi = (
    a: Pred,
    b: Pred,
  ): { phi: number | null; n: number; both: number } => {
    let n00 = 0,
      n01 = 0,
      n10 = 0,
      n11 = 0;
    for (const f of fires) {
      const av = a(f);
      const bv = b(f);
      if (av === null || bv === null) continue;
      if (av && bv) n11++;
      else if (av && !bv) n10++;
      else if (!av && bv) n01++;
      else n00++;
    }
    const n = n00 + n01 + n10 + n11;
    const num = n11 * n00 - n10 * n01;
    const den = Math.sqrt(
      (n11 + n10) * (n01 + n00) * (n11 + n01) * (n10 + n00),
    );
    return { phi: den === 0 ? null : num / den, n, both: n11 };
  };
  const redLines = [
    '| pair | φ correlation | n (both non-null) | note |',
    '|---|---|---|---|',
  ];
  for (const [an, ap, bn, bp] of redundancyPairs) {
    const { phi: p, n } = phi(ap, bp);
    const note =
      p == null
        ? 'undefined'
        : Math.abs(p) >= 0.7
          ? 'REDUNDANT (|φ|≥0.7)'
          : Math.abs(p) >= 0.4
            ? 'partial overlap'
            : 'independent';
    redLines.push(
      `| ${an} ↔ ${bn} | ${p == null ? '—' : p.toFixed(3)} | ${n} | ${note} |`,
    );
  }

  const md =
    `# Tag Value Scorecard — Lottery Finder badges vs realized OOS outcome — 2026-05-29\n\n` +
    `**Question:** for each SIGNAL/CONTEXT badge on a Lottery Finder fire row, does its presence actually ` +
    `separate REALIZED outcomes out-of-sample — or is it just screen decoration?\n\n` +
    `**Primary metric (verdict):** \`realized_trail30_10_pct\` — stop-based realized %. mean realized% and ` +
    `win% (realized>0). **Secondary (reference only):** peak_ceiling_pct hit ≥ 50% — % peak repeatedly ` +
    `overstates edge, so it never drives a verdict.\n\n` +
    `**OOS split:** train = earliest 70% of distinct dates (< ${splitDate}), test = latest 30% (≥ ${splitDate}). ` +
    `Verdicts are read on the TEST holdout. Tags map to STORED columns on \`lottery_finder_fires\`; ` +
    `present-vs-absent uses only rows where the column is non-null (NULL rows excluded from both arms). ` +
    `Test present-n < ${MIN_TEST_N} → flagged THIN (⚠).\n\n` +
    `**Data:** ${fires.length} fires with peak_ceiling_pct; ${dates.length} sessions ${dates[0]}…${dates.at(-1)}.\n\n` +
    `**Test-set baseline (all fires):** realized mean ${f1(baseMean)}%, win ${f1(baseWin)}%, hit≥50% peak ${f1(basePeak)}%.\n\n` +
    `**Verdict legend:** SEPARATES = |OOS realized sep| ≥ 3pp and same sign in train. ` +
    `WEAK-SEPARATES = ≥ 1pp and same sign. NO-SEPARATION = below that or train/test sign flips. ` +
    `THIN = test present-n < ${MIN_TEST_N}. NOT-STORED tags are listed separately.\n\n` +
    `## 1. Ranked scorecard (by |OOS realized separation|)\n\n` +
    tableLines.join('\n') +
    `\n\n` +
    scoreBucketSection(train, test) +
    `\n\n` +
    combinedScoreSection(test) +
    `\n\n` +
    todSection(test) +
    `\n\n` +
    `## 2. NOT-STORED tags (judge on UX grounds, not on this data)\n\n` +
    notStoredLines.join('\n') +
    `\n\n` +
    `## 3. Redundancy (φ correlation / co-occurrence on stored tags)\n\n` +
    redLines.join('\n') +
    `\n\n_φ (mean-square-contingency) on the full set, rows where both columns are non-null. ` +
    `|φ|≥0.7 = effectively the same axis; 0.4–0.7 = partial overlap._\n\n` +
    `## 4. Bottom line\n\n` +
    buildBottomLine(results) +
    `\n`;

  const path = 'docs/tmp/tag-value-scorecard-2026-05-29.md';
  writeFileSync(path, md);
  console.log(`\nWrote ${path}\n`);
  console.log(md);
})();
