/**
 * Shared types for the Contract Tracker frontend.
 *
 * These mirror the row shapes produced by the Phase 2 endpoints
 * (`api/tracker/*`). Numeric columns in Postgres NUMERIC arrive as
 * strings over the wire — we keep them as strings in the API types and
 * parse to `number` lazily inside view components.
 */

export type ContractStatus = 'active' | 'closed' | 'expired';

export type OptionSide = 'C' | 'P';

export type Direction = 'long' | 'short';

export type SpotAlertOp = '>=' | '<=' | '>' | '<';

export interface SpotAlert {
  op: SpotAlertOp;
  level: number;
}

/**
 * A row from GET /api/tracker/contracts. NUMERIC columns arrive as
 * strings (Neon driver default for arbitrary-precision values).
 */
export interface TrackerContract {
  id: number;
  occ_symbol: string;
  ticker: string;
  /** YYYY-MM-DD */
  expiry: string;
  strike: string;
  side: OptionSide;
  direction: Direction;
  entry_price: string;
  quantity: number;
  notes: string | null;
  status: ContractStatus;
  closed_at: string | null;
  closed_price: string | null;
  up_thresholds: string[] | null;
  down_thresholds: string[] | null;
  spot_alerts: SpotAlert[] | null;
  created_at: string;
  updated_at: string;
  /** Joined columns from tracker_contract_ticks (most-recent row). */
  latest_last: string | null;
  latest_bid: string | null;
  latest_ask: string | null;
  latest_underlying: string | null;
  latest_fetched_at: string | null;
}

export type AlertType = 'up_pct' | 'down_pct' | 'spot_level' | 'dte_7';

/** Joined unread-alert row from GET /api/tracker/alerts/unread. */
export interface TrackerAlert {
  id: number;
  contract_id: number;
  fired_at: string;
  alert_type: AlertType;
  threshold: string;
  price_at_fire: string | null;
  underlying_at_fire: string | null;
  acknowledged: boolean;
  occ_symbol: string;
  ticker: string;
  expiry: string;
  strike: string;
  side: OptionSide;
  direction: Direction;
  entry_price: string;
  quantity: number;
  contract_status: ContractStatus;
}

// ============================================================
// Request bodies (frontend → server)
// ============================================================

/** Structured POST body for /api/tracker/contracts. */
export interface ContractCreateInput {
  ticker: string;
  expiry: string;
  strike: number;
  side: OptionSide;
  direction: Direction;
  entry_price: number;
  quantity: number;
  notes?: string;
  up_thresholds?: number[];
  down_thresholds?: number[];
  spot_alerts?: SpotAlert[];
}

/** Free-text POST body for /api/tracker/contracts. */
export interface ContractFreeTextInput {
  input: string;
  notes?: string;
  up_thresholds?: number[];
  down_thresholds?: number[];
  spot_alerts?: SpotAlert[];
}

/** PATCH body for /api/tracker/contracts/:id. */
export interface ContractUpdateInput {
  notes?: string | null;
  up_thresholds?: number[] | null;
  down_thresholds?: number[] | null;
  spot_alerts?: SpotAlert[] | null;
  status?: 'closed';
  closed_price?: number;
  /** Edit position sizing — must be a positive integer when provided. */
  quantity?: number;
  /** Edit entry price in dollars — must be a positive number when provided. */
  entry_price?: number;
}

// ============================================================
// Defaults
// ============================================================

/** Defaults that mirror the cron's behavior when thresholds are NULL. */
export const DEFAULT_UP_THRESHOLDS: number[] = [50, 100, 200];
export const DEFAULT_DOWN_THRESHOLDS: number[] = [-30, -50];
