/**
 * Shared GEXBot decoder + panel constants used by the 10-min adapter
 * cron (`populate-periscope-from-gexbot`) and the two 1-min readers
 * (`/api/periscope-map`, `/api/gex-landscape`).
 *
 * Lives in _lib so endpoints don't have to reach into cron handlers
 * to import the decoder.
 */

export type PanelName = 'gamma' | 'charm' | 'vanna';

export const PANELS: PanelName[] = ['gamma', 'charm', 'vanna'];

export const PANEL_TO_CATEGORY: Record<PanelName, string> = {
  gamma: 'gamma_zero',
  charm: 'charm_zero',
  vanna: 'vanna_zero',
};

/**
 * Sign that turns a GEXBot State value into the convention every Periscope
 * reader, rule and label assumes. The one place the GEXBot sign is fixed.
 *
 * Gamma: -1. GEXBot's per-strike gamma is taker-signed, the negative of
 * the UW Periscope scraper's market-maker convention (positive = MMs long
 * gamma). Against UW taker flow (ask γ − bid γ, Spearman per hourly
 * snapshot) the correlation flips sign exactly at the 2026-05-26 cutover:
 * scraper era ρ −0.11 (5 of 31 days > 0), GEXBot era ρ +0.19 (66 of 70
 * days > 0). Owner decision D1 (2026-10-28): negate it, so stored and
 * served gamma stays MM-signed.
 * Charm and vanna: +1. They keep GEXBot's own sign (D1 does not flip them).
 *
 * Spec: docs/superpowers/specs/gexbot-refresh-2026-10-28.md (D1, P10b).
 */
export const GEXBOT_TO_MM_SIGN: Readonly<Record<PanelName, 1 | -1>> = {
  gamma: -1,
  charm: 1,
  vanna: 1,
};

/** `periscope_snapshots.source` values (migration #194). */
export const PERISCOPE_SOURCE = {
  /** UW Periscope scraper, MM-attributed: rows before the 2026-05-26 cutover. */
  scraper: 'scraper',
  /** GEXBot State; gamma negated to MM sign by `GEXBOT_TO_MM_SIGN`. */
  gexbot: 'gexbot',
} as const;

/** Apply the panel's sign. A flipped 0 stays 0, never -0. */
function toPeriscopeSign(value: number, sign: 1 | -1): number {
  return sign === 1 || value === 0 ? value : -value;
}

/** Single ticker covered today. NDX is on the roadmap; not yet wired. */
export const TICKER = 'SPX';

/** How old a GEXBot capture can be before we treat it as stale and
 *  refuse to serve / write it. Shared between cron and endpoint so
 *  the freshness contract is one number, not two. */
export const STALENESS_CUTOFF_MS = 5 * 60 * 1000;

/** Lookback used by the map endpoint to find a "prior" slice for
 *  sign-flip detection. Matches the 10-min slice cadence the
 *  detect-periscope-* crons compare against. */
export const PRIOR_LOOKBACK_MIN = 10;

/** Upper bound on how far back we'll hunt for a prior slice when the
 *  ideal 10-min lookback has no data (e.g. first session minutes). */
export const PRIOR_LOOKBACK_FLOOR_MIN = 30;

export interface GexbotStatePayload {
  spot?: number;
  ticker?: string;
  timestamp?: number;
  min_dte?: number;
  major_negative?: number;
  major_positive?: number;
  mini_contracts?: unknown[][];
}

export interface DecodedStrike {
  strike: number;
  value: number;
}

export interface DecodedStrikeWithHistory extends DecodedStrike {
  /**
   * Position-4 priors array: the strike's value at [t-5m, t-15m, t-30m]
   * (verified: vendor EOD history matches at exactly those lags, the
   * consumers probe fits at 5/15/30 with 0.017-0.020 relative error vs
   * 0.16-0.42 elsewhere, and three vendor integration docs list only the
   * 5, 15 and 30 minute lookback windows). null when sparse.
   */
  prev5m: number | null;
  prev15m: number | null;
  prev30m: number | null;
}

/**
 * Internal: a `mini_contracts` row passes the strike/value gates that
 * both decoders share. Returns the parsed strike + value, or `null` if
 * the row is malformed / sparse (caller should `continue`).
 */
function parseRowCore(row: unknown): { strike: number; value: number } | null {
  if (!Array.isArray(row) || row.length < 4) return null;
  // Number(null) coerces to 0 — explicit null/undefined check.
  if (row[0] == null || row[3] == null) return null;
  const strike = Number(row[0]);
  const value = Number(row[3]);
  if (!Number.isFinite(strike) || !Number.isFinite(value)) return null;
  return { strike: Math.round(strike), value };
}

/**
 * Read a single prev-window slot from position-4. Returns `null` when
 * the slot is missing, non-finite, or position-4 itself isn't an array.
 */
function readPrev(row: unknown[], idx: number): number | null {
  const arr = row[4];
  if (!Array.isArray(arr) || idx >= arr.length) return null;
  const raw = arr[idx];
  if (raw == null) return null;
  const v = Number(raw);
  return Number.isFinite(v) ? v : null;
}

/**
 * Decode GEXBot's `mini_contracts` array for one panel. Per spec 2.13.0
 * each row is:
 *   [strike, call_ivol, put_ivol, greek value, priors array,
 *    put classified volume, put volume priors]
 * and in public API responses the last two are 0 and null, e.g.
 *   [7795, 0, 0, -68.8, [-25.62, -49.67, -48.69], 0, null]
 * Position-3 is the signed Greek value for the panel (gamma at the
 * gamma_zero endpoint, charm at charm_zero, etc.), a net taker
 * imbalance from GEXBot's orderflow classification engine. The decoder
 * returns it in the Periscope convention via `GEXBOT_TO_MM_SIGN[panel]`:
 * gamma negated to MM sign, charm and vanna in the vendor sign. Live
 * priors arrays hold 3 entries: the strike's value at t-5, t-15 and
 * t-30 min (vendor-confirmed windows, not t-1/5/10).
 *
 * Rows with non-numeric position-0 or position-3 are dropped — the
 * payload occasionally includes sparse rows for far-OTM strikes with
 * no classified flow.
 */
export function decodeStrikes(
  payload: GexbotStatePayload,
  panel: PanelName,
): DecodedStrike[] {
  const arr = payload.mini_contracts;
  if (!Array.isArray(arr)) return [];
  const sign = GEXBOT_TO_MM_SIGN[panel];
  const out: DecodedStrike[] = [];
  for (const row of arr) {
    const parsed = parseRowCore(row);
    if (parsed == null) continue;
    out.push({
      strike: parsed.strike,
      value: toPeriscopeSign(parsed.value, sign),
    });
  }
  return out;
}

/**
 * Same row-validity gates and panel sign as `decodeStrikes`, but also
 * lifts position-4 (the priors array, `[t-5m, t-15m, t-30m]` per strike,
 * vendor-confirmed) into the result so the frontend can compute Δ%
 * windows without a second DB read. The priors get the same sign as the
 * value, so a change between them keeps its meaning.
 *
 * Position-4 can be absent, shorter than 3, or contain null / NaN
 * entries — each missing slot maps to `null`. Position-3 staying valid
 * is what keeps the row; we never drop a row purely on missing history.
 */
export function decodeStrikesWithHistory(
  payload: GexbotStatePayload,
  panel: PanelName,
): DecodedStrikeWithHistory[] {
  const arr = payload.mini_contracts;
  if (!Array.isArray(arr)) return [];
  const sign = GEXBOT_TO_MM_SIGN[panel];
  const prior = (row: unknown[], idx: number): number | null => {
    const v = readPrev(row, idx);
    return v == null ? null : toPeriscopeSign(v, sign);
  };
  const out: DecodedStrikeWithHistory[] = [];
  for (const row of arr) {
    const parsed = parseRowCore(row);
    if (parsed == null) continue;
    // `parseRowCore` confirmed `row` is an array with length >= 4.
    out.push({
      strike: parsed.strike,
      value: toPeriscopeSign(parsed.value, sign),
      prev5m: prior(row as unknown[], 0),
      prev15m: prior(row as unknown[], 1),
      prev30m: prior(row as unknown[], 2),
    });
  }
  return out;
}
