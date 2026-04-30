/**
 * Whale-detection logic — pure, side-effect-free.
 *
 * Codifies the hand-derived whale-detection checklist (see
 * `docs/whale-detection-checklist.md`) so that:
 *   1. The live `detect-whales` cron can classify rows from `whale_alerts`.
 *   2. The EOD backfill script can mirror the same logic against the
 *      parquet archive.
 *   3. Tests can verify the classifier against historical fixtures.
 *
 * Per-ticker premium thresholds are p95 of the 11-day outsized-chain
 * universe (2026-04-13 → 2026-04-29). Recompute every ~30 trading days as
 * the parquet archive grows.
 */

// ── Whale ticker universe ────────────────────────────────────

export const WHALE_TICKERS = [
  'SPX',
  'SPXW',
  'NDX',
  'NDXP',
  'QQQ',
  'SPY',
  'IWM',
] as const;

export type WhaleTicker = (typeof WHALE_TICKERS)[number];

// ── Per-ticker premium thresholds (p95 of 11-day archive) ────

export const WHALE_THRESHOLDS: Record<WhaleTicker, number> = {
  SPX: 80_772_337,
  SPXW: 6_844_350,
  NDX: 26_039_632,
  NDXP: 2_615_032,
  QQQ: 5_661_186,
  SPY: 6_272_830,
  IWM: 9_328_335,
};

// ── Other checklist constants ────────────────────────────────

export const MIN_TRADE_COUNT = 5;
export const MAX_DTE = 14;
export const MAX_MONEYNESS = 0.05; // ±5%
export const MIN_ONE_SIDED = 0.85;
/** Overlap > this in seconds → simultaneous synthetic (filter out). */
export const PAIRING_OVERLAP_SEC = 60;

// ── Input shape (subset of UwFlowAlert / parquet row) ────────

/**
 * Minimal per-chain row shape needed for classification. Both the live
 * cron (`whale_alerts` row) and the backfill (parquet chain row) populate
 * this shape — the classifier doesn't care which source.
 */
export interface WhaleCandidate {
  ticker: string;
  option_chain: string;
  strike: number;
  option_type: 'call' | 'put';
  expiry: string; // ISO date (YYYY-MM-DD)
  first_ts: Date;
  last_ts: Date;
  side_ask_premium: number;
  side_bid_premium: number;
  total_premium: number;
  trade_count: number;
  underlying_price: number | null;
  vol_oi_ratio: number | null;
  dte: number;
}

export interface WhaleClassification {
  whale_type: 1 | 2 | 3 | 4;
  direction: 'bullish' | 'bearish';
  side: 'ASK' | 'BID';
  ask_pct: number;
  moneyness: number | null;
}

// ── Classifier ───────────────────────────────────────────────

/**
 * Returns a classification if the candidate matches the whale checklist,
 * or `null` if it should be filtered out.
 *
 * The pairing check is NOT performed here — the caller must call
 * `detectPairing()` separately with the same-strike same-expiry context
 * and discard simultaneous synthetics before persisting.
 */
export function classifyWhale(c: WhaleCandidate): WhaleClassification | null {
  // Filter 1: Underlying must be a whale-tracked index/ETF.
  if (!WHALE_TICKERS.includes(c.ticker as WhaleTicker)) return null;

  // Filter 2: Premium ≥ ticker-specific p95.
  const threshold = WHALE_THRESHOLDS[c.ticker as WhaleTicker];
  if (c.total_premium < threshold) return null;

  // Filter 3: Trade count ≥ MIN_TRADE_COUNT (filters out single-block synthetics).
  if (c.trade_count < MIN_TRADE_COUNT) return null;

  // Filter 4: DTE ≤ MAX_DTE.
  if (c.dte > MAX_DTE) return null;

  // Filter 5: Moneyness ≤ MAX_MONEYNESS (only when underlying is known).
  let moneyness: number | null = null;
  if (c.underlying_price != null && c.underlying_price > 0) {
    moneyness = c.strike / c.underlying_price - 1;
    if (Math.abs(moneyness) > MAX_MONEYNESS) return null;
  }

  // Filter 6: ≥85% one-sided.
  const sidedTotal = c.side_ask_premium + c.side_bid_premium;
  if (sidedTotal <= 0) return null;
  const askPct = c.side_ask_premium / sidedTotal;
  const isAskDominant = askPct >= MIN_ONE_SIDED;
  const isBidDominant = askPct <= 1 - MIN_ONE_SIDED;
  if (!isAskDominant && !isBidDominant) return null;

  const side: 'ASK' | 'BID' = isAskDominant ? 'ASK' : 'BID';

  // Type 1-4 classification — the strike is the level.
  const type = classifyType({
    side,
    optionType: c.option_type,
    moneyness,
  });
  if (type == null) return null;

  const direction = directionForType(type);

  return {
    whale_type: type,
    direction,
    side,
    ask_pct: askPct,
    moneyness,
  };
}

/**
 * Type 1: Floor declared       — BID put,  strike ≥ spot OR ≤ 0.5% OTM
 * Type 2: Ceiling declared     — BID call, strike ≤ spot OR ≤ 0.5% OTM
 * Type 3: Floor break expected — ASK put,  strike 0.5–3% OTM
 * Type 4: Ceiling break expected — ASK call, strike 0.5–3% OTM
 *
 * Edge cases (extended classifications): ATM/ITM ASK and far-OTM BID are
 * permissive — they fall into the "type extended" bucket. The doc treats
 * these as still-actionable but with weaker conviction. We classify them
 * to the same Type but they pass through. moneyness=null (NDX/NDXP) is
 * permissive — assume near-ATM.
 */
function classifyType(args: {
  side: 'ASK' | 'BID';
  optionType: 'call' | 'put';
  moneyness: number | null;
}): 1 | 2 | 3 | 4 | null {
  const { side, optionType, moneyness } = args;
  const m = moneyness;

  if (side === 'BID' && optionType === 'put') {
    // Type 1: floor — strict ITM put or ≤0.5% OTM (m ≥ -0.005).
    // Permissive: include slightly OTM puts sold (1% OTM) — still a floor signal.
    if (m == null || m >= -0.03) return 1;
    return null;
  }
  if (side === 'BID' && optionType === 'call') {
    // Type 2: ceiling — strict ITM call or ≤0.5% OTM (m ≤ 0.005).
    // Permissive: include slightly OTM calls sold (1% OTM).
    if (m == null || m <= 0.03) return 2;
    return null;
  }
  if (side === 'ASK' && optionType === 'put') {
    // Type 3: floor break — OTM put 0.5-3% (m in [-0.03, -0.005]).
    // Permissive: include ATM and slightly ITM ASK puts as bearish bets.
    if (m == null || m <= 0.03) return 3;
    return null;
  }
  // Type 4: ceiling break — OTM call 0.5-3% (m in [0.005, 0.03]).
  if (m == null || m >= -0.03) return 4;
  return null;
}

function directionForType(type: 1 | 2 | 3 | 4): 'bullish' | 'bearish' {
  return type === 1 || type === 4 ? 'bullish' : 'bearish';
}

// ── Pairing detection ────────────────────────────────────────

/**
 * A row that might be the opposite leg of a paired position.
 * Provided by the caller from a same-day same-strike same-expiry lookup.
 */
export interface PairingPeer {
  option_type: 'call' | 'put';
  first_ts: Date;
  last_ts: Date;
}

export type PairingStatus = 'alone' | 'sequential' | 'simultaneous_filtered';

/**
 * Decide whether a candidate's same-strike opposite-side peer is:
 *   - 'alone'                  → no peer found
 *   - 'sequential'             → peer exists but trade windows do not overlap
 *                                (position roll — keep, treat candidate as
 *                                directional)
 *   - 'simultaneous_filtered'  → peer overlaps in time → pure synthetic
 *                                (drop the candidate)
 *
 * Overlap is measured in seconds. Anything > PAIRING_OVERLAP_SEC counts
 * as simultaneous.
 */
export function detectPairing(
  candidate: { first_ts: Date; last_ts: Date; option_type: 'call' | 'put' },
  peers: PairingPeer[],
): PairingStatus {
  const oppositeType = candidate.option_type === 'call' ? 'put' : 'call';
  const matching = peers.filter((p) => p.option_type === oppositeType);
  if (matching.length === 0) return 'alone';

  const graceMs = PAIRING_OVERLAP_SEC * 1000;

  for (const peer of matching) {
    // (a) Standard overlap. Works for EOD multi-trade chains where both
    //     legs have real time ranges.
    const overlapMs =
      Math.min(candidate.last_ts.getTime(), peer.last_ts.getTime()) -
      Math.max(candidate.first_ts.getTime(), peer.first_ts.getTime());
    if (overlapMs / 1000 > PAIRING_OVERLAP_SEC) {
      return 'simultaneous_filtered';
    }
    // (b) Containedness. Live whale_alerts rows are single instants
    //     (first_ts == last_ts), so case (a) yields overlap=0 even when
    //     the peer leg is clearly active around the alert. Treat the peer
    //     as simultaneous if its active window spans the candidate with
    //     comfortable grace on both sides.
    const beforeMs = candidate.first_ts.getTime() - peer.first_ts.getTime();
    const afterMs = peer.last_ts.getTime() - candidate.last_ts.getTime();
    if (beforeMs > graceMs && afterMs > graceMs) {
      return 'simultaneous_filtered';
    }
  }
  return 'sequential';
}
