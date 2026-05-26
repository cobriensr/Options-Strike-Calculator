/**
 * Shared GEXBot decoder + panel constants used by both the 10-min
 * adapter cron (`populate-periscope-from-gexbot`) and the 1-min map
 * endpoint (`/api/periscope-map`).
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

/**
 * Decode GEXBot's `mini_contracts` array. Each row is:
 *   [strike, call_val, put_val, total_dealer_value, [t-1m, t-5m, t-10m], 0, null]
 * Position-3 is the signed MM-attributed value for the panel
 * (gamma at gamma_zero endpoint, charm at charm_zero, etc.).
 *
 * Rows with non-numeric position-0 or position-3 are dropped — the
 * payload occasionally includes sparse rows for far-OTM strikes where
 * the dealer book is empty.
 */
export function decodeStrikes(payload: GexbotStatePayload): DecodedStrike[] {
  const arr = payload.mini_contracts;
  if (!Array.isArray(arr)) return [];
  const out: DecodedStrike[] = [];
  for (const row of arr) {
    if (!Array.isArray(row) || row.length < 4) continue;
    // Number(null) coerces to 0 — explicit null/undefined check.
    if (row[0] == null || row[3] == null) continue;
    const strike = Number(row[0]);
    const value = Number(row[3]);
    if (!Number.isFinite(strike) || !Number.isFinite(value)) continue;
    out.push({ strike: Math.round(strike), value });
  }
  return out;
}
