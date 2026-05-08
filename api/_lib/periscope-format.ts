/**
 * Periscope MM-attributed exposure formatter for the analyze endpoint.
 *
 * Replaces the screenshot workflow: instead of pasting a UW Periscope
 * heat-map image and relying on vision OCR, this module reads the
 * `periscope_snapshots` table (populated by the Railway scraper service)
 * and emits a structured text block Claude can quote magnitudes from
 * directly.
 *
 * Three queries per call:
 *   1. Latest slot at or before `asOf`         — primary structural read
 *   2. Slot ~10 min prior                       — momentum / sign-flip
 *      (orange-bar equivalent, since UW's "dot"
 *      is not in our schema)
 *   3. cone_levels + cone_breach_events for the day — Phase 1 outputs
 *
 * Output mirrors the periscope skill's reading model: top +γ floor /
 * ceiling near spot, top −γ acceleration zones, charm tally near spot,
 * extreme charm and vanna magnitudes, sign-flip strikes, and cone
 * status. Spot is supplied by the caller (from `index_candles_1m`,
 * never the chart's red-dotted line — same rule the skill enforces).
 */

import { getDb } from './db.js';

export interface PeriscopeRow {
  strike: number;
  value: number;
}

export interface PeriscopeSlot {
  capturedAt: string;
  expiry: string;
  gamma: PeriscopeRow[];
  charm: PeriscopeRow[];
  vanna: PeriscopeRow[];
}

export interface ConeLevels {
  coneUpper: number;
  coneLower: number;
  coneWidth: number;
  asymmetryPts: number;
  spotAtCalc: number;
}

export interface ConeBreach {
  direction: 'upper' | 'lower';
  breachTime: string;
  spotAtBreach: number;
  ptsPastBound: number;
}

const NEAR_SPOT_HALFWIDTH = 50;
const WIDE_SPOT_HALFWIDTH = 100;

/**
 * Fetch the latest captured Periscope slot at or before `asOf` for the
 * given expiry. Returns null when no rows exist yet (e.g. pre-market on
 * a fresh day before the scraper's first RTH tick).
 */
export async function fetchLatestPeriscopeSlot(
  expiry: string,
  asOf?: string,
): Promise<PeriscopeSlot | null> {
  const sql = getDb();
  const slotRows = asOf
    ? await sql`
        SELECT MAX(captured_at) AS captured_at
        FROM periscope_snapshots
        WHERE expiry = ${expiry} AND captured_at <= ${asOf}
      `
    : await sql`
        SELECT MAX(captured_at) AS captured_at
        FROM periscope_snapshots
        WHERE expiry = ${expiry}
      `;
  const capturedAt = (slotRows[0] as { captured_at: string | Date | null })
    ?.captured_at;
  if (capturedAt == null) return null;

  return loadSlot(expiry, capturedAt);
}

/**
 * Fetch the slot immediately preceding `latestCapturedAt` for momentum /
 * sign-flip detection. Returns null when no prior slot exists in the
 * window (typically the very first RTH slot of the day).
 */
export async function fetchPriorPeriscopeSlot(
  expiry: string,
  latestCapturedAt: string,
): Promise<PeriscopeSlot | null> {
  const sql = getDb();
  const slotRows = await sql`
    SELECT MAX(captured_at) AS captured_at
    FROM periscope_snapshots
    WHERE expiry = ${expiry} AND captured_at < ${latestCapturedAt}
  `;
  const capturedAt = (slotRows[0] as { captured_at: string | Date | null })
    ?.captured_at;
  if (capturedAt == null) return null;
  return loadSlot(expiry, capturedAt);
}

async function loadSlot(
  expiry: string,
  capturedAt: string | Date,
): Promise<PeriscopeSlot> {
  const sql = getDb();
  const rows = (await sql`
    SELECT panel, strike, value
    FROM periscope_snapshots
    WHERE expiry = ${expiry} AND captured_at = ${capturedAt}
    ORDER BY panel, strike
  `) as Array<{ panel: string; strike: number; value: string | number }>;

  const gamma: PeriscopeRow[] = [];
  const charm: PeriscopeRow[] = [];
  const vanna: PeriscopeRow[] = [];

  for (const r of rows) {
    const v = typeof r.value === 'string' ? Number.parseFloat(r.value) : r.value;
    const row: PeriscopeRow = { strike: r.strike, value: v };
    if (r.panel === 'gamma') gamma.push(row);
    else if (r.panel === 'charm') charm.push(row);
    else if (r.panel === 'vanna') vanna.push(row);
  }

  return {
    capturedAt:
      capturedAt instanceof Date ? capturedAt.toISOString() : capturedAt,
    expiry,
    gamma,
    charm,
    vanna,
  };
}

/**
 * Fetch today's cone bounds from `cone_levels` (populated by the
 * compute-cone cron at 13:32 UTC). Returns null if the cron hasn't run
 * yet for the day.
 */
export async function fetchConeLevels(
  date: string,
): Promise<ConeLevels | null> {
  const sql = getDb();
  const rows = (await sql`
    SELECT cone_upper, cone_lower, cone_width, asymmetry_pts, spot_at_calc
    FROM cone_levels
    WHERE date = ${date}
  `) as Array<{
    cone_upper: string | number;
    cone_lower: string | number;
    cone_width: string | number;
    asymmetry_pts: string | number;
    spot_at_calc: string | number;
  }>;
  if (rows.length === 0) return null;
  const r = rows[0]!;
  return {
    coneUpper: Number(r.cone_upper),
    coneLower: Number(r.cone_lower),
    coneWidth: Number(r.cone_width),
    asymmetryPts: Number(r.asymmetry_pts),
    spotAtCalc: Number(r.spot_at_calc),
  };
}

/**
 * Fetch any cone breach events for today, capped at `asOf` so back-test
 * / replay reads don't leak future breaches into a historical slice.
 */
export async function fetchConeBreaches(
  date: string,
  asOf?: string,
): Promise<ConeBreach[]> {
  const sql = getDb();
  const rows = asOf
    ? ((await sql`
        SELECT direction, breach_time, spot_at_breach, pts_past_bound
        FROM cone_breach_events
        WHERE date = ${date} AND breach_time <= ${asOf}
        ORDER BY breach_time ASC
      `) as Array<{
        direction: string;
        breach_time: string | Date;
        spot_at_breach: string | number;
        pts_past_bound: string | number;
      }>)
    : ((await sql`
        SELECT direction, breach_time, spot_at_breach, pts_past_bound
        FROM cone_breach_events
        WHERE date = ${date}
        ORDER BY breach_time ASC
      `) as Array<{
        direction: string;
        breach_time: string | Date;
        spot_at_breach: string | number;
        pts_past_bound: string | number;
      }>);
  return rows.map((r) => ({
    direction: r.direction === 'upper' ? 'upper' : 'lower',
    breachTime:
      r.breach_time instanceof Date
        ? r.breach_time.toISOString()
        : r.breach_time,
    spotAtBreach: Number(r.spot_at_breach),
    ptsPastBound: Number(r.pts_past_bound),
  }));
}

function fmtSigned(n: number): string {
  if (Math.abs(n) >= 1_000_000)
    return `${n >= 0 ? '+' : ''}${(n / 1_000_000).toFixed(2)}M`;
  if (Math.abs(n) >= 1_000)
    return `${n >= 0 ? '+' : ''}${(n / 1_000).toFixed(1)}K`;
  return `${n >= 0 ? '+' : ''}${n.toFixed(0)}`;
}

function topByAbs(rows: PeriscopeRow[], n: number): PeriscopeRow[] {
  return [...rows].sort((a, b) => Math.abs(b.value) - Math.abs(a.value)).slice(0, n);
}

function nearSpot(rows: PeriscopeRow[], spot: number, half: number): PeriscopeRow[] {
  return rows.filter((r) => Math.abs(r.strike - spot) <= half);
}

function tally(rows: PeriscopeRow[]): number {
  let s = 0;
  for (const r of rows) s += r.value;
  return s;
}

/**
 * Find strikes whose gamma sign flipped between `prior` and `latest`
 * AND where the new value is non-trivial (≥10% of the slice's max
 * absolute gamma — filters noise from near-zero strikes that just kissed
 * the axis). This is the orange-bar equivalent the periscope skill
 * leans on for regime-flip detection.
 */
export function findGammaSignFlips(
  latest: PeriscopeRow[],
  prior: PeriscopeRow[],
): Array<{ strike: number; from: number; to: number }> {
  const priorByStrike = new Map<number, number>();
  for (const r of prior) priorByStrike.set(r.strike, r.value);

  const maxAbs = latest.reduce((m, r) => Math.max(m, Math.abs(r.value)), 0);
  const threshold = maxAbs * 0.1;

  const flips: Array<{ strike: number; from: number; to: number }> = [];
  for (const r of latest) {
    const before = priorByStrike.get(r.strike);
    if (before == null) continue;
    if (before === 0 || r.value === 0) continue;
    if (Math.sign(before) === Math.sign(r.value)) continue;
    if (Math.abs(r.value) < threshold) continue;
    flips.push({ strike: r.strike, from: before, to: r.value });
  }
  return flips;
}

/**
 * Format a Periscope slot into the analyze-context text block. Returns
 * null when there's no slot for the day (skipping the section entirely
 * is preferable to emitting an empty header — keeps Claude's prompt
 * lean and surfaces "missing" via the unavailableSection mechanism).
 *
 * `spot` is the authoritative SPX price at read time, supplied by the
 * caller (typically from `index_candles_1m`). The Periscope chart's red
 * dotted line is always live and irrelevant for back-reads.
 */
export function formatPeriscopeForClaude(args: {
  latest: PeriscopeSlot;
  prior: PeriscopeSlot | null;
  spot: number;
  cone: ConeLevels | null;
  breaches: ConeBreach[];
}): string {
  const { latest, prior, spot, cone, breaches } = args;
  const lines: string[] = [];

  const slotTimeCT = new Date(latest.capturedAt).toLocaleTimeString('en-US', {
    timeZone: 'America/Chicago',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });

  lines.push(
    `MM-attributed exposure for ${latest.expiry} expiry, latest 10-min slice ${slotTimeCT} CT (spot ${spot.toFixed(2)}).`,
  );
  if (prior != null) {
    const priorTimeCT = new Date(prior.capturedAt).toLocaleTimeString('en-US', {
      timeZone: 'America/Chicago',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    lines.push(`Prior slice for momentum read: ${priorTimeCT} CT.`);
  }

  // Gamma topology — strongest +γ floor below spot, ceiling above spot,
  // and largest −γ (acceleration) strikes near spot.
  const gammaNear = nearSpot(latest.gamma, spot, NEAR_SPOT_HALFWIDTH);
  const gammaWide = nearSpot(latest.gamma, spot, WIDE_SPOT_HALFWIDTH);

  const ceilingCandidate = gammaWide
    .filter((r) => r.strike > spot && r.value > 0)
    .sort((a, b) => b.value - a.value)[0];
  const floorCandidate = gammaWide
    .filter((r) => r.strike < spot && r.value > 0)
    .sort((a, b) => b.value - a.value)[0];
  const accelCandidates = gammaWide
    .filter((r) => r.value < 0)
    .sort((a, b) => a.value - b.value)
    .slice(0, 3);

  const ceilingDesc =
    ceilingCandidate != null
      ? `${ceilingCandidate.strike} (${fmtSigned(ceilingCandidate.value)}) — ${(ceilingCandidate.strike - spot).toFixed(1)} pts above spot`
      : 'none within ±100';
  const floorDesc =
    floorCandidate != null
      ? `${floorCandidate.strike} (${fmtSigned(floorCandidate.value)}) — ${(spot - floorCandidate.strike).toFixed(1)} pts below spot`
      : 'none within ±100';
  const accelDesc =
    accelCandidates.length === 0
      ? 'none'
      : accelCandidates
          .map((r) => {
            const delta = r.strike - spot;
            const sign = delta >= 0 ? '+' : '';
            return `${r.strike} (${fmtSigned(r.value)}, ${sign}${delta.toFixed(0)} pts)`;
          })
          .join(' | ');
  lines.push(
    '',
    'Gamma topology (±100 of spot):',
    `  +γ ceiling: ${ceilingDesc}`,
    `  +γ floor: ${floorDesc}`,
    `  −γ acceleration (top 3): ${accelDesc}`,
  );

  // Top |γ| strikes near spot, regardless of sign — gives the structural
  // map a quick read regardless of direction.
  const topGammaNear = topByAbs(gammaNear, 5);
  if (topGammaNear.length > 0) {
    const topGammaDesc = topGammaNear
      .map((r) => `${r.strike} ${fmtSigned(r.value)}`)
      .join(' | ');
    lines.push(`  Top |γ| ±50: ${topGammaDesc}`);
  }

  // Charm tally + extremes.
  const charmNear = nearSpot(latest.charm, spot, NEAR_SPOT_HALFWIDTH);
  const charmWide = nearSpot(latest.charm, spot, WIDE_SPOT_HALFWIDTH);
  const charmNearTally = tally(charmNear);
  const charmWideTally = tally(charmWide);
  const topCharm = topByAbs(charmWide, 4);

  lines.push(
    '',
    'Charm flow (positive = mechanical /ES BUY into close):',
    `  Net tally ±50: ${fmtSigned(charmNearTally)}`,
    `  Net tally ±100: ${fmtSigned(charmWideTally)}`,
  );
  if (topCharm.length > 0) {
    const topCharmDesc = topCharm
      .map((r) => `${r.strike} ${fmtSigned(r.value)}`)
      .join(' | ');
    lines.push(`  Top |charm| ±100: ${topCharmDesc}`);
  }

  // Charm-zero strike — the strike where the cumulative charm sum
  // (sorted low → high) genuinely crosses zero. Reports only a real
  // sign change (prev → curr crosses sign), not the first non-negative
  // running sum (which would just be the leftmost strike on a
  // cumulative-positive day).
  const charmSorted = [...charmWide].sort((a, b) => a.strike - b.strike);
  let runningSum = 0;
  let charmZeroStrike: number | null = null;
  for (const r of charmSorted) {
    const prevSum = runningSum;
    runningSum += r.value;
    if (
      prevSum !== 0 &&
      runningSum !== 0 &&
      Math.sign(prevSum) !== Math.sign(runningSum)
    ) {
      charmZeroStrike = r.strike;
      break;
    }
  }
  if (charmZeroStrike != null) {
    lines.push(`  Charm-zero strike: ${charmZeroStrike}`);
  }

  // Vanna extremes (vol-shock sensitivity).
  const vannaWide = nearSpot(latest.vanna, spot, WIDE_SPOT_HALFWIDTH);
  const topVanna = topByAbs(vannaWide, 4);
  if (topVanna.length > 0) {
    const topVannaDesc = topVanna
      .map((r) => `${r.strike} ${fmtSigned(r.value)}`)
      .join(' | ');
    lines.push(
      '',
      'Vanna pressure (vol-shock sensitivity):',
      `  Top |vanna| ±100: ${topVannaDesc}`,
    );
  }

  // Sign-flip detection (orange-bar equivalent).
  if (prior != null) {
    const flips = findGammaSignFlips(latest.gamma, prior.gamma);
    if (flips.length > 0) {
      const flipLines = flips.map((f) => {
        const fromSide = f.from > 0 ? '+γ' : '−γ';
        const toSide = f.to > 0 ? '+γ' : '−γ';
        return `  ${f.strike}: ${fromSide} ${fmtSigned(f.from)} → ${toSide} ${fmtSigned(f.to)}`;
      });
      lines.push(
        '',
        'Gamma sign flips since prior slice (regime change at strike):',
        ...flipLines,
      );
    }
  }

  // Cone bounds + breach status. Asymmetry sign convention from
  // compute-cone.ts: asymmetry_pts = put_mark − call_mark, so
  // POSITIVE = puts richer = downside-skewed (lower bound farther from
  // calc spot), NEGATIVE = calls richer = upside-skewed.
  if (cone != null) {
    const asymmetryLabel =
      cone.asymmetryPts > 0
        ? 'lower-skewed (downside priced richer)'
        : cone.asymmetryPts < 0
          ? 'upper-skewed (upside priced richer)'
          : 'symmetric';
    const asymmetrySign = cone.asymmetryPts >= 0 ? '+' : '';
    lines.push(
      '',
      `Straddle cone (calc spot ${cone.spotAtCalc.toFixed(2)}): lower ${cone.coneLower.toFixed(1)} | upper ${cone.coneUpper.toFixed(1)} | width ${cone.coneWidth.toFixed(0)} pts | asymmetry ${asymmetrySign}${cone.asymmetryPts.toFixed(1)} pts (${asymmetryLabel})`,
    );
    if (breaches.length === 0) {
      const distUp = cone.coneUpper - spot;
      const distDown = spot - cone.coneLower;
      lines.push(
        `  No breach yet. Distance to upper: ${distUp.toFixed(1)} pts. Distance to lower: ${distDown.toFixed(1)} pts.`,
      );
    } else {
      for (const b of breaches) {
        const breachCT = new Date(b.breachTime).toLocaleTimeString('en-US', {
          timeZone: 'America/Chicago',
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
        });
        lines.push(
          `  ${b.direction.toUpperCase()} BREACH at ${breachCT} CT — spot ${b.spotAtBreach.toFixed(2)} (${b.ptsPastBound.toFixed(1)} pts past bound). Vol-extension setup; do not fade.`,
        );
      }
    }
  }

  return lines.join('\n');
}

/**
 * One-shot entry point used by analyze-context.ts. Returns the formatted
 * block or null when no Periscope data exists for `(date, expiry)`.
 *
 * `expiry` defaults to `date` for the 0DTE case the user actually trades
 * — but kept as a separate parameter so a future N-DTE consumer can
 * point it elsewhere without forking the function.
 */
export async function buildPeriscopeContextBlock(args: {
  date: string;
  expiry: string;
  spot: number;
  asOf?: string;
}): Promise<string | null> {
  const { date, expiry, spot, asOf } = args;
  const latest = await fetchLatestPeriscopeSlot(expiry, asOf);
  if (latest == null) return null;
  const [prior, cone, breaches] = await Promise.all([
    fetchPriorPeriscopeSlot(expiry, latest.capturedAt),
    fetchConeLevels(date),
    fetchConeBreaches(date, asOf),
  ]);
  return formatPeriscopeForClaude({ latest, prior, spot, cone, breaches });
}
