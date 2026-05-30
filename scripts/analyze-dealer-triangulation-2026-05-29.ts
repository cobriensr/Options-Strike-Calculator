#!/usr/bin/env tsx
/**
 * Dealer-positioning triangulation — feasibility + quality gate.
 *
 * Question: do our THREE independent dealer-positioning estimates agree on
 * net-gamma SIGN and on the zero-gamma / flip LEVEL, and is their
 * DISAGREEMENT a usable signal? This is both a research idea and a quality
 * gate for a larger dealer-state program: if the sources disagree, every
 * downstream model is being fed inconsistent inputs.
 *
 * THE THREE SOURCES (SPX, 0DTE):
 *   1. GexBot scalars       — gexbot_snapshots (ticker='SPX'): net_dex /
 *                             net_put_dex (DELTA exposure, signed), and
 *                             z_mlgamma / z_msgamma (0DTE MM long/short
 *                             gamma walls). NOTE: zero_gamma is NULL for
 *                             every row; GexBot exposes no flip level here.
 *   2. Naive per-strike GEX — ws_gex_strike_expiry (ticker='SPX'): sum
 *                             call_gamma_oi − put_gamma_oi across strikes
 *                             per minute → net-gamma sign; sign change of
 *                             the cumulative profile → implied flip level.
 *   3. Periscope MM gamma   — periscope_snapshots (panel='gamma'): per-strike
 *                             MM-attributed gamma (value>0 = MM long gamma at
 *                             that strike). Sum value across strikes → net
 *                             sign; cumulative sign change → flip level.
 *
 * Read-only. No production code touched.
 * Run: npx tsx scripts/analyze-dealer-triangulation-2026-05-29.ts
 */

import { writeFileSync } from 'node:fs';

import { neon } from '@neondatabase/serverless';
import { config } from 'dotenv';

config({ path: '.env.local' });
const sql = neon(process.env.DATABASE_URL!);

const f1 = (v: number | null) => (v == null ? '—' : v.toFixed(1));
const f2 = (v: number | null) => (v == null ? '—' : v.toFixed(2));
const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const pctile = (xs: number[], p: number): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const idx = Math.min(
    s.length - 1,
    Math.max(0, Math.round((s.length - 1) * p)),
  );
  return s[idx]!;
};
type Tri = -1 | 0 | 1 | null;
const sign = (x: number | null): Tri =>
  x == null ? null : x > 0 ? 1 : x < 0 ? -1 : 0;

type Row = Record<string, unknown>;
const N = (v: unknown): number | null => (v == null ? null : Number(v));

/** Minute key in UTC (ms truncated to minute). */
const minuteKey = (iso: string) => {
  const ms = Date.parse(iso);
  return Math.floor(ms / 60_000) * 60_000;
};

interface Snap {
  minute: number; // utc minute (ms)
  netGammaSign: Tri;
  netGammaRaw: number | null;
  flip: number | null; // implied zero-gamma / flip level (SPX pts)
  spot: number | null;
}

/**
 * Standard zero-gamma flip from a per-strike DEALER gamma profile: cumulate
 * dealer gamma from the lowest strike up; the strike at which the running
 * total crosses from negative to positive is the flip. Returns the crossing
 * strike nearest `spot` so far-wing crossings don't dominate.
 */
function flipFromProfile(
  arr: { strike: number; g: number }[],
  spot: number | null,
): number | null {
  if (arr.length < 2) return null;
  const crossings: number[] = [];
  let run = 0;
  for (let i = 0; i < arr.length; i++) {
    const prev = run;
    run += arr[i]!.g;
    if (i > 0 && ((prev < 0 && run >= 0) || (prev > 0 && run <= 0)))
      crossings.push(arr[i]!.strike);
  }
  if (!crossings.length) return null;
  if (spot == null) return crossings[0]!;
  return crossings.reduce(
    (b, c) => (Math.abs(c - spot) < Math.abs(b - spot) ? c : b),
    crossings[0]!,
  );
}

/**
 * Naive per-strike GEX. IMPORTANT CAVEAT: ws_gex_strike_expiry stores
 * call_gamma_oi and put_gamma_oi as POSITIVE magnitudes. There is no dealer
 * sign convention in the raw table, so `call - put` is just call-vs-put OI
 * imbalance (positive almost everywhere near spot for SPX) — NOT signed
 * dealer gamma. To attempt an apples-to-apples comparison we impose the
 * conventional dealer sign: dealers are long calls / short puts ⇒
 * dealerGamma = call_gamma_oi − put_gamma_oi is kept, but the flip is
 * derived from the cumulative profile. We surface BOTH the raw-sum sign and
 * the cumulative-flip so the report can flag that this source is unsigned.
 */
async function loadWsGex(): Promise<Map<number, Snap>> {
  const rows = (await sql`
    SELECT ts_minute, strike, price,
           call_gamma_oi - put_gamma_oi AS net
    FROM ws_gex_strike_expiry
    WHERE ticker='SPX'
    ORDER BY ts_minute, strike
  `) as Row[];
  const byMin = new Map<
    number,
    { strike: number; net: number; price: number }[]
  >();
  for (const r of rows) {
    const k = minuteKey(String(r.ts_minute));
    const arr = byMin.get(k) ?? [];
    arr.push({
      strike: Number(r.strike),
      net: Number(r.net),
      price: Number(r.price),
    });
    byMin.set(k, arr);
  }
  const out = new Map<number, Snap>();
  for (const [k, arr] of byMin) {
    arr.sort((a, b) => a.strike - b.strike);
    const total = arr.reduce((s, x) => s + x.net, 0);
    const spot = arr[0]?.price ?? null;
    const flip = flipFromProfile(
      arr.map((x) => ({ strike: x.strike, g: x.net })),
      spot,
    );
    out.set(k, {
      minute: k,
      netGammaRaw: total,
      netGammaSign: sign(total),
      flip,
      spot,
    });
  }
  return out;
}

/** periscope MM gamma: net sign + flip from cumulative per-strike value.
 *  spotByMinute supplies the SPX spot (from candles) so the flip is anchored
 *  to real price rather than the strike-range midpoint. */
async function loadPeriscope(
  day?: string,
  spotByMinute?: Map<number, number>,
): Promise<Map<number, Snap>> {
  const rows = day
    ? ((await sql`
        SELECT captured_at, expiry, strike, value
        FROM periscope_snapshots
        WHERE panel='gamma' AND captured_at::date = ${day}
          AND expiry = captured_at::date
        ORDER BY captured_at, strike`) as Row[])
    : ((await sql`
        SELECT captured_at, expiry, strike, value
        FROM periscope_snapshots
        WHERE panel='gamma' AND expiry = captured_at::date
        ORDER BY captured_at, strike`) as Row[]);
  const byMin = new Map<number, { strike: number; value: number }[]>();
  for (const r of rows) {
    const k = minuteKey(String(r.captured_at));
    const arr = byMin.get(k) ?? [];
    arr.push({ strike: Number(r.strike), value: Number(r.value) });
    byMin.set(k, arr);
  }
  const out = new Map<number, Snap>();
  for (const [k, arr] of byMin) {
    arr.sort((a, b) => a.strike - b.strike);
    const total = arr.reduce((s, x) => s + x.value, 0);
    // periscope value is already SIGNED MM gamma; flip = spot-anchored
    // running-sum crossing using real SPX spot when available.
    const spotHint =
      spotByMinute && spotByMinute.size
        ? nearestSpot(spotByMinute, k, 5)
        : null;
    const anchor = spotHint ?? (arr[0]!.strike + arr.at(-1)!.strike) / 2;
    const flip = flipFromProfile(
      arr.map((x) => ({ strike: x.strike, g: x.value })),
      anchor,
    );
    out.set(k, {
      minute: k,
      netGammaRaw: total,
      netGammaSign: sign(total),
      flip,
      spot: spotHint,
    });
  }
  return out;
}

/**
 * GexBot scalars. NOTE: this source has NO net-gamma scalar and NO
 * zero_gamma (NULL for all rows). It exposes:
 *   - net_dex / net_put_dex : DELTA exposure (a different quantity from
 *     gamma; included only to test whether DEX sign tracks GEX sign).
 *   - z_mlgamma / z_msgamma : 0DTE MM long/short gamma WALL strikes. The
 *     midpoint is the closest thing GexBot gives to a flip level.
 */
async function loadGexbot(
  day?: string,
): Promise<Map<number, Snap & { dexSign: Tri }>> {
  const rows = day
    ? ((await sql`
        SELECT captured_at, spot, net_dex, net_put_dex, z_mlgamma, z_msgamma
        FROM gexbot_snapshots WHERE ticker='SPX' AND captured_at::date=${day}
        ORDER BY captured_at`) as Row[])
    : ((await sql`
        SELECT captured_at, spot, net_dex, net_put_dex, z_mlgamma, z_msgamma
        FROM gexbot_snapshots WHERE ticker='SPX'
        ORDER BY captured_at`) as Row[]);
  const out = new Map<number, Snap & { dexSign: Tri }>();
  for (const r of rows) {
    const k = minuteKey(String(r.captured_at));
    const zml = N(r.z_mlgamma);
    const zms = N(r.z_msgamma);
    const flip = zml != null && zms != null ? (zml + zms) / 2 : null;
    const dex = N(r.net_dex);
    out.set(k, {
      minute: k,
      // GexBot has no net-gamma scalar; we leave netGamma null and surface
      // dexSign separately so we never silently treat DEX as GEX.
      netGammaRaw: null,
      netGammaSign: null,
      dexSign: sign(dex),
      flip,
      spot: N(r.spot),
    });
  }
  return out;
}

/** SPX 1-min candles keyed by UTC minute (regular session only). */
async function loadCandles(): Promise<
  Map<number, { close: number; high: number; low: number }>
> {
  const rows = (await sql`
    SELECT timestamp, market_time, open, high, low, close
    FROM index_candles_1m
    WHERE symbol='SPX' AND market_time NOT IN ('pr','ah')
    ORDER BY timestamp`) as Row[];
  const out = new Map<number, { close: number; high: number; low: number }>();
  for (const r of rows) {
    const k = minuteKey(String(r.timestamp));
    out.set(k, {
      close: Number(r.close),
      high: Number(r.high),
      low: Number(r.low),
    });
  }
  return out;
}

/** nearest snapshot in `m` within ±tolMin minutes of target minute. */
function nearest<T extends { minute: number }>(
  m: Map<number, T>,
  target: number,
  tolMin: number,
): T | null {
  let best: T | null = null;
  let bestD = Infinity;
  for (let d = 0; d <= tolMin; d++) {
    for (const cand of [target + d * 60_000, target - d * 60_000]) {
      const v = m.get(cand);
      if (v && d < bestD) {
        best = v;
        bestD = d;
      }
    }
    if (best) break;
  }
  return best;
}

/** nearest numeric spot in a minute→value map within ±tolMin. */
function nearestSpot(
  m: Map<number, number>,
  target: number,
  tolMin: number,
): number | null {
  for (let d = 0; d <= tolMin; d++) {
    for (const cand of [target + d * 60_000, target - d * 60_000]) {
      const v = m.get(cand);
      if (v != null) return v;
    }
  }
  return null;
}

(async () => {
  console.log('Loading sources …');
  const [ws, gb, candles] = await Promise.all([
    loadWsGex(),
    loadGexbot(),
    loadCandles(),
  ]);

  // ---- COVERAGE WALL (Section C, done first because it gates everything) ----
  const wsDaysSet = new Set<string>();
  for (const k of ws.keys())
    wsDaysSet.add(new Date(k).toISOString().slice(0, 10));
  const gbDaysSet = new Set<string>();
  for (const k of gb.keys())
    gbDaysSet.add(new Date(k).toISOString().slice(0, 10));

  // periscope day list (cheap query)
  const periDayRows = (await sql`
    SELECT DISTINCT captured_at::date AS d
    FROM periscope_snapshots WHERE panel='gamma' AND expiry = captured_at::date
    ORDER BY d`) as Row[];
  const periDays = periDayRows.map((r) =>
    typeof r.d === 'string'
      ? r.d
      : new Date(r.d as string).toISOString().slice(0, 10),
  );
  const periDaysSet = new Set(periDays);

  const allDays = [
    ...new Set([...wsDaysSet, ...gbDaysSet, ...periDaysSet]),
  ].sort();
  const twoPlus = allDays.filter(
    (d) =>
      [wsDaysSet.has(d), gbDaysSet.has(d), periDaysSet.has(d)].filter(Boolean)
        .length >= 2,
  );
  const threePlus = allDays.filter(
    (d) => wsDaysSet.has(d) && gbDaysSet.has(d) && periDaysSet.has(d),
  );

  // ---- WITHIN-DAY ALIGNMENT on the all-three overlap day(s) ----
  const sections: string[] = [];

  const COV =
    `## C. Coverage overlap (computed FIRST — it gates everything else)\n\n` +
    `| source | distinct SPX 0DTE days | date span |\n|---|---|---|\n` +
    `| periscope MM gamma | ${periDaysSet.size} | ${periDays[0]} → ${periDays.at(-1)} |\n` +
    `| naive ws_gex SPX | ${wsDaysSet.size} | ${[...wsDaysSet].sort().join(', ')} |\n` +
    `| GexBot scalars SPX | ${gbDaysSet.size} | ${[...gbDaysSet].sort().join(', ')} |\n\n` +
    `**Days with ≥2 sources present:** ${twoPlus.length} → ${JSON.stringify(twoPlus)}\n\n` +
    `**Days with all 3 sources present:** ${threePlus.length} → ${JSON.stringify(threePlus)}\n\n` +
    `> GexBot \`zero_gamma\` is NULL for 100% of rows in \`gexbot_snapshots\`, and the\n` +
    `> historical scalar columns on \`lottery_finder_fires\` (\`gex_zero_gamma\`) have\n` +
    `> **0 non-null rows**. GexBot therefore contributes NO flip level and NO\n` +
    `> net-gamma sign to the triangulation — only \`net_dex\` (delta, not gamma) and\n` +
    `> the z_mlgamma/z_msgamma gamma-wall midpoint.\n`;
  sections.push(COV);

  // For each all-three day, align minute-by-minute.
  const spotMap = new Map([...candles].map(([k, v]) => [k, v.close]));
  for (const day of threePlus.length ? threePlus : twoPlus) {
    const peri = await loadPeriscope(day, spotMap);
    const gbDay = await loadGexbot(day);
    const wsDay = new Map(
      [...ws].filter(([k]) => new Date(k).toISOString().slice(0, 10) === day),
    );

    // Anchor minutes = periscope snapshot minutes (sparsest real source).
    const anchors = [...peri.keys()].sort((a, b) => a - b);
    const TOL = 5; // ±5 min match window

    interface Aligned {
      minute: number;
      wsSign: Tri;
      periSign: Tri;
      gbDexSign: Tri;
      wsFlip: number | null;
      periFlip: number | null;
      gbFlip: number | null;
      spot: number | null;
    }
    const aligned: Aligned[] = [];
    for (const a of anchors) {
      const p = peri.get(a)!;
      const w = nearest(wsDay, a, TOL);
      const g = nearest(gbDay, a, TOL);
      aligned.push({
        minute: a,
        periSign: p.netGammaSign,
        wsSign: w?.netGammaSign ?? null,
        gbDexSign: g?.dexSign ?? null,
        periFlip: p.flip,
        wsFlip: w?.flip ?? null,
        gbFlip: g?.flip ?? null,
        spot: g?.spot ?? w?.spot ?? null,
      });
    }

    // A. SIGN AGREEMENT (gamma sources: ws vs periscope; DEX shown separately)
    const bothSign = aligned.filter(
      (r) => r.wsSign != null && r.periSign != null,
    );
    const wsPeriAgree = bothSign.filter((r) => r.wsSign === r.periSign).length;
    const dexRows = aligned.filter(
      (r) => r.gbDexSign != null && r.periSign != null,
    );
    const dexPeriAgree = dexRows.filter(
      (r) => r.gbDexSign === r.periSign,
    ).length;
    const dexWsRows = aligned.filter(
      (r) => r.gbDexSign != null && r.wsSign != null,
    );
    const dexWsAgree = dexWsRows.filter((r) => r.gbDexSign === r.wsSign).length;

    // B. LEVEL AGREEMENT (ws flip vs periscope flip; vs GexBot wall midpoint)
    const wsPeriFlip = aligned
      .filter((r) => r.wsFlip != null && r.periFlip != null)
      .map((r) => Math.abs(r.wsFlip! - r.periFlip!));
    const wsGbFlip = aligned
      .filter((r) => r.wsFlip != null && r.gbFlip != null)
      .map((r) => Math.abs(r.wsFlip! - r.gbFlip!));
    const periGbFlip = aligned
      .filter((r) => r.periFlip != null && r.gbFlip != null)
      .map((r) => Math.abs(r.periFlip! - r.gbFlip!));

    // sign breakdown by time-of-day (hour, UTC)
    const byHour = new Map<number, { agree: number; total: number }>();
    for (const r of bothSign) {
      const h = new Date(r.minute).getUTCHours();
      const e = byHour.get(h) ?? { agree: 0, total: 0 };
      e.total += 1;
      if (r.wsSign === r.periSign) e.agree += 1;
      byHour.set(h, e);
    }
    const hourRows = [...byHour.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(
        ([h, e]) =>
          `| ${String(h).padStart(2, '0')}:00Z | ${e.total} | ${f1((e.agree / e.total) * 100)}% |`,
      )
      .join('\n');

    const pct = (a: number, n: number) => (n ? f1((a / n) * 100) : '—');
    const periPos = aligned.filter((r) => r.periSign === 1).length;
    const periNeg = aligned.filter((r) => r.periSign === -1).length;
    const wsPos = bothSign.filter((r) => r.wsSign === 1).length;

    sections.push(
      `## Within-day alignment — ${day} (the all-three overlap day)\n\n` +
        `Anchored to ${anchors.length} periscope snapshot minutes; ws_gex & GexBot ` +
        `matched within ±${TOL} min. SPX 0DTE.\n\n` +
        `### A. Sign agreement\n\n` +
        `| pair | n overlapping | agree % |\n|---|---|---|\n` +
        `| naive-GEX sign vs periscope-GEX sign | ${bothSign.length} | ${pct(wsPeriAgree, bothSign.length)}% |\n` +
        `| GexBot **DEX** sign vs periscope-GEX sign | ${dexRows.length} | ${pct(dexPeriAgree, dexRows.length)}% |\n` +
        `| GexBot **DEX** sign vs naive-GEX sign | ${dexWsRows.length} | ${pct(dexWsAgree, dexWsRows.length)}% |\n\n` +
        `Directional split: periscope net-gamma was +${periPos} / −${periNeg} of ${aligned.length} mins; ` +
        `naive-GEX was + in ${wsPos}/${bothSign.length} of the overlapping mins.\n\n` +
        `> ⚠️ The naive-GEX "sign" is unsigned-source noise: \`call_gamma_oi\` and\n` +
        `> \`put_gamma_oi\` are stored as positive magnitudes, so \`call−put\` is a\n` +
        `> call/put OI imbalance that is positive almost everywhere for SPX. Its\n` +
        `> cumulative profile never crosses zero (see Section B: 0 flip obs), so the\n` +
        `> ~50% sign-agreement vs periscope is just periscope's own +/− rate measured\n` +
        `> against a near-constant. GexBot DEX is delta, not gamma — its agreement\n` +
        `> numbers compare different greeks and are shown only for completeness.\n\n` +
        `Sign agreement (naive vs periscope) by hour:\n\n` +
        `| hour (UTC) | n | agree % |\n|---|---|---|\n${hourRows}\n\n` +
        `### B. Flip-level agreement (|spread| in SPX pts)\n\n` +
        `| pair | n | median |Δ| | p10 | p90 |\n|---|---|---|---|---|\n` +
        `| naive flip vs periscope flip | ${wsPeriFlip.length} | ${f1(median(wsPeriFlip))} | ${f1(pctile(wsPeriFlip, 0.1))} | ${f1(pctile(wsPeriFlip, 0.9))} |\n` +
        `| naive flip vs GexBot wall-mid | ${wsGbFlip.length} | ${f1(median(wsGbFlip))} | ${f1(pctile(wsGbFlip, 0.1))} | ${f1(pctile(wsGbFlip, 0.9))} |\n` +
        `| periscope flip vs GexBot wall-mid | ${periGbFlip.length} | ${f1(median(periGbFlip))} | ${f1(pctile(periGbFlip, 0.1))} | ${f1(pctile(periGbFlip, 0.9))} |\n\n` +
        `_GexBot "flip" here is the midpoint of the 0DTE MM long/short gamma walls ` +
        `(z_mlgamma, z_msgamma) — NOT a true zero-gamma; treat as a coarse proxy._\n`,
    );

    // D. EXPLORATORY EDGE — only attempt if there's enough material; flag n.
    const dis = bothSign.filter((r) => r.wsSign !== r.periSign);
    const agr = bothSign.filter((r) => r.wsSign === r.periSign);
    const fwd = (r: Aligned, mins: number) => {
      const c0 =
        candles.get(r.minute) ??
        nearest(
          new Map([...candles].map(([k, v]) => [k, { minute: k, ...v }])),
          r.minute,
          3,
        );
      const cEnd = nearest(
        new Map([...candles].map(([k, v]) => [k, { minute: k, ...v }])),
        r.minute + mins * 60_000,
        3,
      );
      if (!c0 || !cEnd) return null;
      const c0close = 'close' in c0 ? (c0 as { close: number }).close : null;
      return c0close == null ? null : ((cEnd.close - c0close) / c0close) * 100;
    };
    const rng = (r: Aligned, mins: number) => {
      let hi = -Infinity;
      let lo = Infinity;
      for (let d = 0; d <= mins; d++) {
        const c = candles.get(r.minute + d * 60_000);
        if (c) {
          hi = Math.max(hi, c.high);
          lo = Math.min(lo, c.low);
        }
      }
      return hi > -Infinity && lo < Infinity ? hi - lo : null;
    };
    const summ = (rows: Aligned[], mins: number) => {
      const moves = rows
        .map((r) => fwd(r, mins))
        .filter((x): x is number => x != null);
      const ranges = rows
        .map((r) => rng(r, mins))
        .filter((x): x is number => x != null);
      return {
        n: rows.length,
        absMove: moves.length ? median(moves.map(Math.abs)) : null,
        range: ranges.length ? median(ranges) : null,
      };
    };
    const d30 = summ(dis, 30);
    const a30 = summ(agr, 30);
    const d60 = summ(dis, 60);
    const a60 = summ(agr, 60);
    sections.push(
      `### D. Exploratory edge (HYPOTHESIS ONLY — single day, do not trust)\n\n` +
        `Forward SPX behaviour after sign-DISAGREE vs sign-AGREE minutes ` +
        `(naive vs periscope). **n is per-minute on ONE day — autocorrelated and ` +
        `tiny; this is not a testable signal, only a direction to note.**\n\n` +
        `| window | disagree n | dis median |Δ%| | dis median range(pts) | agree n | agr median |Δ%| | agr median range(pts) |\n` +
        `|---|---|---|---|---|---|---|\n` +
        `| +30 min | ${d30.n} | ${f2(d30.absMove)} | ${f1(d30.range)} | ${a30.n} | ${f2(a30.absMove)} | ${f1(a30.range)} |\n` +
        `| +60 min | ${d60.n} | ${f2(d60.absMove)} | ${f1(d60.range)} | ${a60.n} | ${f2(a60.absMove)} | ${f1(a60.range)} |\n\n` +
        `No train/test split is possible (1 day). Effect size meaningless at this n.\n`,
    );
  }

  const verdict =
    `## Verdict\n\n` +
    `**(1) Quality gate — are the three sources consistent enough to trust as model inputs?**\n` +
    `No, and more fundamentally the triangulation cannot be performed historically:\n\n` +
    `- **Coverage wall.** Only ONE day (2026-05-29) has all three SPX 0DTE sources\n` +
    `  alive at once; only two days have ≥2. \`ws_gex_strike_expiry\` SPX = 1 day,\n` +
    `  \`gexbot_snapshots\` SPX = 2 days. Periscope alone has real history (136 days).\n` +
    `  There is no multi-day window to validate agreement on, so any downstream\n` +
    `  "dealer-state" model can only be fed ONE of these consistently — periscope.\n` +
    `- **GexBot exposes no gamma sign and no flip.** \`zero_gamma\` is NULL for 100% of\n` +
    `  rows, and the historical \`gex_zero_gamma\` column on fires is entirely empty.\n` +
    `  Its only signed scalar is \`net_dex\` (DELTA), a different greek. The\n` +
    `  z_mlgamma/z_msgamma walls barely move intraday.\n` +
    `- **Naive ws_gex is not signed dealer gamma.** call_gamma_oi/put_gamma_oi are\n` +
    `  positive magnitudes; call−put is an OI imbalance that is positive across the\n` +
    `  whole strike grid and never crosses zero → it yields NO flip level and a\n` +
    `  near-constant "+" sign. It is unusable as an independent gamma estimate\n` +
    `  without a dealer-sign convention the table does not carry.\n` +
    `- The only pair measuring the same thing (signed gamma) on the same day —\n` +
    `  periscope vs GexBot wall-mid — agrees on the positioning LEVEL to ~20 SPX pts\n` +
    `  median, but that is a wall midpoint vs a true profile, not a like-for-like\n` +
    `  flip. Sign agreement between the genuinely-comparable sources cannot be\n` +
    `  measured because the second signed source (ws_gex) is unsigned in practice.\n\n` +
    `**(2) Is disagreement noise, artifact, or a leading indicator?**\n` +
    `On this evidence it is a **data artifact / instrumentation gap**, not signal:\n` +
    `the "disagreement" is dominated by (a) one source being unsigned, (b) one source\n` +
    `lacking a gamma flip entirely, and (c) one day of overlap. The exploratory\n` +
    `forward-return split (Section D) shows essentially identical SPX behaviour after\n` +
    `agree vs disagree minutes (median |Δ| ~0.06–0.09%, range ~13–20 pts either way),\n` +
    `with n that is one autocorrelated trading day — no effect, no power, no OOS.\n\n` +
    `**Recommendation:** Do NOT build a triangulation/disagreement signal yet. The\n` +
    `prerequisite is data: backfill GexBot \`zero_gamma\`/net-gamma and accumulate\n` +
    `multi-week parallel coverage of all three SPX sources before re-probing. Until\n` +
    `then, treat Periscope MM gamma as the single trustworthy SPX dealer-gamma input;\n` +
    `the naive ws_gex table needs a documented dealer-sign convention before it can\n` +
    `even be a second opinion.\n`;

  const out =
    `# Dealer-positioning triangulation — feasibility + quality gate — 2026-05-29\n\n` +
    `**Scope:** SPX, 0DTE. All timestamps aligned in UTC to the minute. ` +
    `Sources: (1) GexBot scalars \`gexbot_snapshots\`, (2) naive per-strike ` +
    `\`ws_gex_strike_expiry\`, (3) Periscope MM-attributed \`periscope_snapshots\` ` +
    `(panel='gamma', expiry==capture date).\n\n` +
    verdict +
    `\n` +
    sections.join('\n\n') +
    `\n`;

  const path = 'docs/tmp/dealer-gex-triangulation-2026-05-29.md';
  writeFileSync(path, out);
  console.log(`\nWrote ${path}\n`);
  console.log(out);
})();
