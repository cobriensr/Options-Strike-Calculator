// All GEX values are "net GEX within +/-1% of spot" in the LIVE gex_strike_0dte units
// (sum of call_gamma_oi - put_gamma_oi over the band). DEEP_NEG is calibrated in Phase 2;
// until then lean_down uses sign + a placeholder magnitude that Task 12 overwrites.
export const REGIME_0DTE = {
  GATE_BAND_PCT: 0.01,
  GATE_DEEP_NEG: -0.15, // PLACEHOLDER (study units) — recalibrated to live units in Task 12
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
} // call_gamma_oi - put_gamma_oi
export interface IvPoint {
  ctMin: number;
  iv: number;
} // nearest-ATM put iv per minute
export interface Candle30 {
  ctMin: number;
  open: number;
  close: number;
} // 30-min bucket

export interface Regime0dteInput {
  nowCtMin: number; // minutes from CT midnight (e.g. 11:07 -> 667)
  spot: number; // current SPX spot
  openSpot: number | null; // first stable spot (~08:35), null pre-open
  gexStrikes: GexStrike[]; // latest-minute net GEX by strike
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
