// All GEX values are "net GEX within +/-1% of spot" in LIVE gex_strike_0dte units:
// sum of (call_gamma_oi + put_gamma_oi) over the band. NOTE put_gamma_oi is stored
// SIGNED-NEGATIVE, so net GEX = call + put (NOT call - put). Magnitudes are ~1e10.
export const REGIME_0DTE = {
  GATE_BAND_PCT: 0.01,
  // Calibrated 2026-06-07 against 74 days of gex_strike_0dte (2026-02-20..06-05): 12th-percentile
  // open-spot gexNear = -1.52e10. Cross-check: days <= this had 55.6% down-rate vs 9.8% (rest),
  // 11% up-rate vs 28% — downside-asymmetric, matching the study. Recalibrate if OI scale drifts.
  GATE_DEEP_NEG: -1.5e10,
  IVBREAK_REL: 1.02,
  IVBREAK_REF_START: 510,
  IVBREAK_REF_END: 600, // 08:30–10:00 CT, minutes from midnight
  IVBREAK_WIN_START: 600,
  IVBREAK_WIN_END: 750, // 10:00–12:30 CT
  MOSTLY_RED_MAX_GREEN: 1,
  MOSTLY_RED_MIN_RED: 4,
  PERSIST_END_MIN: 660, // 11:00 CT
  MIDDAY_AFTER_MIN: 750, // 12:30 CT
  MIN_STRIKES: 5,
  OPEN_MIN: 510,
  CLOSE_MIN: 900, // 08:30 / 15:00 CT
} as const;

export type Gate = 'calm' | 'big_move' | 'lean_down' | 'unknown';

export interface GexStrike {
  strike: number;
  netGex: number;
} // call_gamma_oi + put_gamma_oi (put_gamma_oi is signed-negative)
export interface IvPoint {
  ctMin: number;
  iv: number;
} // nearest-ATM put iv per minute
export interface Candle30 {
  ctMin: number;
  open: number;
  close: number;
} // 30-min bucket

/**
 * A per-strike net-GEX profile read at one anchor minute, plus that minute's
 * spot. The 0DTE gamma profile MIGRATES with spot through the session, so the
 * gate, the midday re-measure, and the live viz must each read a TIME-CORRECT
 * profile rather than a single snapshot evaluated at the wrong spot.
 */
export interface ProfileSnapshot {
  strikes: GexStrike[];
  spot: number | null;
}

export interface Regime0dteInput {
  nowCtMin: number; // minutes from CT midnight (e.g. 11:07 -> 667)
  openProfile: ProfileSnapshot; // first-minute profile — THE GATE ANCHOR
  middayProfile: ProfileSnapshot | null; // ~12:30 profile; null/ignored pre-12:30
  currentProfile: ProfileSnapshot | null; // latest minute (gexNearSpot info + viz); null pre-open
  putIv: IvPoint[]; // SPXW 0DTE nearest-ATM put IV series, today
  candles30: Candle30[]; // 30-min SPX candles, today, regular session
}

export interface TriggerState {
  fired: boolean;
  atCtMin: number | null;
}
export interface Regime0dteState {
  asOfCtMin: number;
  gate: Gate;
  gexNearSpot: number | null;
  gexAtOpen: number | null;
  flipStrike: number | null;
  flipMinusOpenPct: number | null;
  triggers: {
    mostlyRed: TriggerState & { green: number; red: number };
    ivBreak: TriggerState & { magPct: number | null; refHi: number | null };
    middayDeepNeg: TriggerState & { gexMid: number | null };
  };
  note: string;
}

export function gexNear(strikes: GexStrike[], spot: number): number | null {
  if (!spot || strikes.length < REGIME_0DTE.MIN_STRIKES) return null;
  const band = REGIME_0DTE.GATE_BAND_PCT * spot;
  return strikes
    .filter((s) => Math.abs(s.strike - spot) <= band)
    .reduce((a, s) => a + s.netGex, 0);
}

export function gradeGate(gex: number | null): Gate {
  if (gex == null) return 'unknown';
  if (gex > 0) return 'calm';
  if (gex > REGIME_0DTE.GATE_DEEP_NEG) return 'big_move';
  return 'lean_down';
}

export function flipStrike(strikes: GexStrike[], spot: number): number | null {
  const sorted = [...strikes].sort((a, b) => a.strike - b.strike);
  let best: number | null = null;
  let bestD = Infinity;
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i];
    const b = sorted[i + 1];
    if (!a || !b) continue;
    if (
      a.netGex < 0 !== b.netGex < 0 &&
      Math.abs(a.strike - spot) <= 0.05 * spot
    ) {
      const mid = (a.strike + b.strike) / 2;
      const d = Math.abs(mid - spot);
      if (d < bestD) {
        bestD = d;
        best = mid;
      }
    }
  }
  return best;
}

export function countCandles(c: Candle30[], untilCtMin: number) {
  const upto = c.filter((x) => x.ctMin < untilCtMin);
  return {
    green: upto.filter((x) => x.close > x.open).length,
    red: upto.filter((x) => x.close < x.open).length,
  };
}

export function ivBreak(series: IvPoint[], nowCtMin: number) {
  const ref = series.filter(
    (p) =>
      p.ctMin >= REGIME_0DTE.IVBREAK_REF_START &&
      p.ctMin <= REGIME_0DTE.IVBREAK_REF_END,
  );
  const refHi = ref.length ? Math.max(...ref.map((p) => p.iv)) : null;
  if (refHi == null)
    return { fired: false, atCtMin: null, magPct: null, refHi: null };
  for (const p of series) {
    if (
      p.ctMin >= REGIME_0DTE.IVBREAK_WIN_START &&
      p.ctMin <= Math.min(nowCtMin, REGIME_0DTE.IVBREAK_WIN_END) &&
      p.iv > refHi * REGIME_0DTE.IVBREAK_REL
    ) {
      return {
        fired: true,
        atCtMin: p.ctMin,
        magPct: ((p.iv - refHi) / refHi) * 100,
        refHi,
      };
    }
  }
  return { fired: false, atCtMin: null, magPct: null, refHi };
}

export function evaluateRegime0dte(input: Regime0dteInput): Regime0dteState {
  const {
    nowCtMin,
    openProfile,
    middayProfile,
    currentProfile,
    putIv,
    candles30,
  } = input;

  // THE GATE is the OPEN gate: net GEX in-band around the OPEN spot, on the
  // OPEN-minute profile. This is the morning regime — stable all day and the
  // anchoring the GATE_DEEP_NEG calibration was validated against. Evaluating a
  // later profile at the open spot finds no strikes in band and reads ~0; that
  // coincident-close read is the bug this contract removes.
  const gexOpen =
    openProfile.spot != null
      ? gexNear(openProfile.strikes, openProfile.spot)
      : null;
  const gexAtOpen = gexOpen; // recorded field — now the real open-profile value
  const gate = gradeGate(gexOpen);

  // Flip strike is an open-anchored level (nearest dealer +/- sign change to
  // the open spot) and its distance from the open spot.
  const flip =
    openProfile.spot != null
      ? flipStrike(openProfile.strikes, openProfile.spot)
      : null;

  // Midday re-measure: net GEX in-band around the MIDDAY spot on the MIDDAY
  // profile. Drives the middayDeepNeg trigger after 12:30 CT.
  const gexMid =
    middayProfile && middayProfile.spot != null
      ? gexNear(middayProfile.strikes, middayProfile.spot)
      : null;

  // Current GEX near the live spot — informational (and the number the viz
  // annotates). Falls back to the open read before the first live minute lands.
  const gexNearSpot =
    currentProfile && currentProfile.spot != null
      ? gexNear(currentProfile.strikes, currentProfile.spot)
      : gexOpen;

  const { green, red } = countCandles(candles30, REGIME_0DTE.PERSIST_END_MIN);
  const mostlyRedFired =
    nowCtMin >= REGIME_0DTE.PERSIST_END_MIN &&
    green <= REGIME_0DTE.MOSTLY_RED_MAX_GREEN &&
    red >= REGIME_0DTE.MOSTLY_RED_MIN_RED;

  const iv = ivBreak(putIv, nowCtMin);

  const middayFired =
    nowCtMin >= REGIME_0DTE.MIDDAY_AFTER_MIN &&
    gexMid != null &&
    gexMid <= REGIME_0DTE.GATE_DEEP_NEG;

  const downConfirmed = mostlyRedFired || iv.fired || middayFired;
  let note: string;
  if (gate === 'lean_down' && !downConfirmed) {
    note = 'deep negative gamma, no downside confirmation yet — up-ambush risk';
  } else if (gate === 'calm') {
    note = 'positive gamma — mean-revert / tight range likely';
  } else if (downConfirmed) {
    note = 'downside confirmed by intraday trigger(s)';
  } else {
    note = 'big move likely, direction unconfirmed';
  }

  return {
    asOfCtMin: nowCtMin,
    gate,
    gexNearSpot,
    gexAtOpen,
    flipStrike: flip,
    flipMinusOpenPct:
      flip != null && openProfile.spot
        ? ((flip - openProfile.spot) / openProfile.spot) * 100
        : null,
    triggers: {
      mostlyRed: {
        fired: mostlyRedFired,
        atCtMin: mostlyRedFired ? REGIME_0DTE.PERSIST_END_MIN : null,
        green,
        red,
      },
      ivBreak: {
        fired: iv.fired,
        atCtMin: iv.atCtMin,
        magPct: iv.magPct,
        refHi: iv.refHi,
      },
      middayDeepNeg: {
        fired: middayFired,
        atCtMin: middayFired ? nowCtMin : null,
        gexMid,
      },
    },
    note,
  };
}
