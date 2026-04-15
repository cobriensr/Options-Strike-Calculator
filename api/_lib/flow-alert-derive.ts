/**
 * Pure derivation logic for UW flow-alert rows.
 *
 * Extracted so that both the live cron (`api/cron/fetch-flow-alerts.ts`)
 * and the 30-day backfill (`scripts/backfill-flow-alerts.mjs`) compute the
 * same denormalized fields. Keep side-effect-free: no DB, no fetch, no
 * `Date.now()` — only the input `UwFlowAlert` drives the output.
 */

// ── Types ────────────────────────────────────────────────────

export interface UwFlowAlert {
  alert_rule: string;
  all_opening_trades: boolean;
  created_at: string;
  expiry: string;
  expiry_count: number;
  has_floor: boolean;
  has_multileg: boolean;
  has_singleleg: boolean;
  has_sweep: boolean;
  issue_type: string;
  open_interest: number;
  option_chain: string;
  price: string;
  strike: string;
  ticker: string;
  total_ask_side_prem: string;
  total_bid_side_prem: string;
  total_premium: string;
  total_size: number;
  trade_count: number;
  type: string;
  underlying_price: string;
  volume: number;
  volume_oi_ratio: string;
}

export interface DerivedFields {
  ask_side_ratio: number | null;
  bid_side_ratio: number | null;
  net_premium: number;
  dte_at_alert: number;
  distance_from_spot: number;
  distance_pct: number | null;
  moneyness: number | null;
  is_itm: boolean | null;
  minute_of_day: number;
  session_elapsed_min: number;
  day_of_week: number;
}

// ── Constants ────────────────────────────────────────────────

/** 08:30 CT in minutes from local midnight = 8*60 + 30. */
export const SESSION_OPEN_MINUTE_CT = 510;

// ── Derived-field computation ────────────────────────────────

/**
 * Extract hour/minute/day-of-week/date in America/Chicago TZ using
 * Intl.DateTimeFormat. Avoids DST bugs that plague manual offset math.
 */
export function getCtParts(isoUtc: string): {
  hour: number;
  minute: number;
  dayOfWeek: number;
  dateStr: string;
} {
  const d = new Date(isoUtc);
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    hour12: false,
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
  const parts = fmt.formatToParts(d);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const hour = Number.parseInt(get('hour'), 10) % 24; // 24 → 0 guard
  const minute = Number.parseInt(get('minute'), 10);
  const weekdayMap: Record<string, number> = {
    Mon: 0,
    Tue: 1,
    Wed: 2,
    Thu: 3,
    Fri: 4,
    Sat: 5,
    Sun: 6,
  };
  const dayOfWeek = weekdayMap[get('weekday')] ?? -1;
  const dateStr = `${get('year')}-${get('month')}-${get('day')}`;
  return { hour, minute, dayOfWeek, dateStr };
}

/** ISO date (YYYY-MM-DD) → epoch day number, for day-diff math. */
export function isoDateToEpochDays(iso: string): number {
  const [y, m, d] = iso.split('-').map((p) => Number.parseInt(p, 10));
  // Date.UTC returns ms since epoch for that midnight UTC.
  return Math.floor(Date.UTC(y!, (m ?? 1) - 1, d ?? 1) / 86_400_000);
}

export function computeDerived(a: UwFlowAlert): DerivedFields {
  const totalPrem = Number.parseFloat(a.total_premium);
  const askPrem = Number.parseFloat(a.total_ask_side_prem);
  const bidPrem = Number.parseFloat(a.total_bid_side_prem);
  const strike = Number.parseFloat(a.strike);
  const spot = Number.parseFloat(a.underlying_price);

  const ask_side_ratio =
    Number.isFinite(totalPrem) && totalPrem > 0 ? askPrem / totalPrem : null;
  const bid_side_ratio =
    Number.isFinite(totalPrem) && totalPrem > 0 ? bidPrem / totalPrem : null;
  const net_premium = askPrem - bidPrem;

  const { hour, minute, dayOfWeek, dateStr } = getCtParts(a.created_at);
  const alertEpoch = isoDateToEpochDays(dateStr);
  const expiryEpoch = isoDateToEpochDays(a.expiry);
  const dte_at_alert = Math.max(0, expiryEpoch - alertEpoch);

  const distance_from_spot = strike - spot;
  const distance_pct =
    Number.isFinite(spot) && spot > 0 ? (strike - spot) / spot : null;
  const moneyness =
    Number.isFinite(strike) && strike > 0 ? spot / strike : null;

  let is_itm: boolean | null = null;
  if (
    Number.isFinite(strike) &&
    strike > 0 &&
    Number.isFinite(spot) &&
    spot > 0
  ) {
    if (a.type === 'call') is_itm = strike < spot;
    else if (a.type === 'put') is_itm = strike > spot;
  }

  const minute_of_day = hour * 60 + minute;
  const session_elapsed_min = minute_of_day - SESSION_OPEN_MINUTE_CT;

  return {
    ask_side_ratio,
    bid_side_ratio,
    net_premium,
    dte_at_alert,
    distance_from_spot,
    distance_pct,
    moneyness,
    is_itm,
    minute_of_day,
    session_elapsed_min,
    day_of_week: dayOfWeek,
  };
}
