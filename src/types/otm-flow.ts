/**
 * Shared types for the OTM SPXW Flow Alerts feature.
 *
 * Both the polling hook (`useOtmFlowAlerts`) and the settings hook
 * (`useOtmFlowSettings`) import from here. The `OtmFlowAlert` shape
 * mirrors `api/options-flow/otm-heavy.ts` so the network response
 * deserializes cleanly — keep the two in sync when the server adds
 * or removes fields.
 */

/** A single OTM heavy-flow alert row, as returned by /api/options-flow/otm-heavy. */
export interface OtmFlowAlert {
  id: number;
  option_chain: string;
  strike: number;
  type: 'call' | 'put';
  created_at: string;
  price: number;
  underlying_price: number;
  total_premium: number;
  total_size: number;
  volume: number;
  open_interest: number;
  volume_oi_ratio: number;
  ask_side_ratio: number | null;
  bid_side_ratio: number | null;
  distance_from_spot: number;
  distance_pct: number;
  moneyness: number | null;
  dte_at_alert: number;
  has_sweep: boolean;
  has_multileg: boolean;
  alert_rule: string;
  /** Which side (ask or bid) dominated this alert — server-derived. */
  dominant_side: 'ask' | 'bid';
}

/** Envelope returned by /api/options-flow/otm-heavy. */
export interface OtmFlowResponse {
  alerts: OtmFlowAlert[];
  alert_count: number;
  last_updated: string | null;
  spot: number | null;
  window_minutes: number;
  mode: 'live' | 'historical';
  thresholds: {
    ask: number;
    bid: number;
    distance_pct: number;
    premium: number;
  };
}

/** User-tunable settings for the OTM Flow Alerts dashboard widget. */
export interface OtmFlowSettings {
  /** Rolling window length in minutes — must match server enum. */
  windowMinutes: 5 | 15 | 30 | 60;
  /** Minimum ask_side_ratio to count as "ask-heavy" (0.5–0.95). */
  minAskRatio: number;
  /** Minimum bid_side_ratio to count as "bid-heavy" (0.5–0.95). */
  minBidRatio: number;
  /** Minimum |distance_pct| to count as "far OTM" (0.001–0.02, e.g. 0.005 = 0.5%). */
  minDistancePct: number;
  /** Dollar floor on total_premium to suppress noise. */
  minPremium: number;
  /** Which sides to surface. */
  sides: 'ask' | 'bid' | 'both';
  /** Which option types to surface. */
  type: 'call' | 'put' | 'both';
  /** Live vs historical (scrubbed) view. */
  mode: 'live' | 'historical';
  /** Date picker value (YYYY-MM-DD) — only read when mode === 'historical'. */
  historicalDate: string;
  /** Time picker value (HH:MM, 24-hour CT) — only read when mode === 'historical'. */
  historicalTime: string;
  /** Play a chime on newly-arrived alerts (live mode only). */
  audioOn: boolean;
  /** Fire browser Notification on newly-arrived alerts. */
  notificationsOn: boolean;
}
