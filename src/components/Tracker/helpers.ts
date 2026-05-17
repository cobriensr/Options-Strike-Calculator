/**
 * Pure helpers for the Contract Tracker UI.
 *
 * No React, no fetch. All inputs are values from `TrackerContract` rows
 * (NUMERIC arrives as string) and outputs are display numbers / strings.
 */

import type { AlertType, TrackerAlert, TrackerContract } from './types.js';

/**
 * Parse a NUMERIC column value (string from Neon driver) into a number.
 * Returns `null` when the input is null/undefined or non-finite.
 */
export function parseNum(v: string | null | undefined): number | null {
  if (v == null) return null;
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Days-to-expiry from an ISO `YYYY-MM-DD` expiry against today (UTC).
 * Returns a non-negative integer; expired rows return 0.
 *
 * UTC is used to keep the calculation deterministic across timezones —
 * the cron and DB both store DATE values in UTC.
 */
export function dteFromExpiry(expiry: string, now: Date = new Date()): number {
  const [y, m, d] = expiry.split('-').map(Number);
  if (
    !Number.isFinite(y ?? NaN) ||
    !Number.isFinite(m ?? NaN) ||
    !Number.isFinite(d ?? NaN)
  ) {
    return 0;
  }
  const expiryUtc = Date.UTC(y!, (m ?? 1) - 1, d ?? 1);
  const todayUtc = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  );
  const days = Math.round((expiryUtc - todayUtc) / 86_400_000);
  return Math.max(0, days);
}

/** Format a strike as `225P` or `397.5C`. */
export function formatStrikeSide(strike: number, side: 'C' | 'P'): string {
  // Trim trailing .00 but keep .5 / .25 etc.
  const s = strike % 1 === 0 ? strike.toFixed(0) : strike.toString();
  return `${s}${side}`;
}

/** Format an expiry as `MM/DD` for the Contract column. */
export function formatExpiryMD(expiry: string): string {
  const [, mm, dd] = expiry.split('-');
  if (!mm || !dd) return expiry;
  return `${mm}/${dd}`;
}

/** Format a contract for the list — e.g. "225P 05/22". */
export function formatContractShort(c: TrackerContract): string {
  const strike = parseNum(c.strike) ?? 0;
  return `${formatStrikeSide(strike, c.side)} ${formatExpiryMD(c.expiry)}`;
}

/** Format a dollar amount like `$4.30` (always two decimals). */
export function formatDollar(n: number | null): string {
  if (n == null) return '—';
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  return `${sign}$${abs.toFixed(2)}`;
}

/** Format a signed percentage like `+50.0%` / `-30.0%`. */
export function formatSignedPct(pct: number | null): string {
  if (pct == null) return '—';
  const sign = pct > 0 ? '+' : '';
  return `${sign}${pct.toFixed(1)}%`;
}

/** Format a signed dollar delta like `+$2.15` / `-$1.42`. */
export function formatSignedDollar(delta: number | null): string {
  if (delta == null) return '—';
  const abs = Math.abs(delta);
  const sign = delta < 0 ? '-' : '+';
  return `${sign}$${abs.toFixed(2)}`;
}

/**
 * Format an underlying spot level for the `spot_level` toast.
 *
 * Integer thresholds render as `595` (no trailing zeros); fractional
 * thresholds keep their precision but drop any trailing zero from the
 * decimal portion (`595.50` → `595.5`). Avoids `toFixed(2)`'s habit of
 * showing `595.00` for what the user wrote as `595`.
 *
 * Exported so the unit test can pin the formatter behavior independent
 * of the toast string-builder.
 */
export function formatSpotLevel(level: number): string {
  if (!Number.isFinite(level)) return String(level);
  if (level % 1 === 0) return level.toFixed(0);
  // `toFixed(2)` + parseFloat round-trip strips `595.50` → `595.5` while
  // preserving `595.25`. Cheaper than a regex and handles negatives.
  return Number.parseFloat(level.toFixed(2)).toString();
}

// ============================================================
// PnL computation
// ============================================================

/**
 * Compute the per-contract dollar and percentage delta for an open
 * row. Returns null fields when the latest tick is missing.
 *
 * Direction (`long` vs `short`) flips the sign — a long call up 50% is
 * +50%; a short call up 50% (i.e. the underlying moved against the
 * trader) is -50%.
 */
export function computePnl(c: TrackerContract): {
  entry: number | null;
  current: number | null;
  deltaDollar: number | null;
  deltaPct: number | null;
} {
  const entry = parseNum(c.entry_price);
  const current = parseNum(c.latest_last) ?? parseNum(c.latest_ask);
  if (entry == null || current == null) {
    return { entry, current, deltaDollar: null, deltaPct: null };
  }
  const raw = current - entry;
  const signed = c.direction === 'short' ? -raw : raw;
  const pct = entry > 0 ? (signed / entry) * 100 : 0;
  return {
    entry,
    current,
    deltaDollar: signed,
    deltaPct: pct,
  };
}

/**
 * Closed-row PnL — uses `closed_price` instead of the latest tick.
 * Same direction flip as `computePnl`. Returns null when fields are
 * missing.
 */
export function computeClosedPnl(c: TrackerContract): {
  deltaDollar: number | null;
  deltaPct: number | null;
} {
  const entry = parseNum(c.entry_price);
  const closed = parseNum(c.closed_price);
  if (entry == null || closed == null) {
    return { deltaDollar: null, deltaPct: null };
  }
  const raw = closed - entry;
  const signed = c.direction === 'short' ? -raw : raw;
  const pct = entry > 0 ? (signed / entry) * 100 : 0;
  return { deltaDollar: signed, deltaPct: pct };
}

// ============================================================
// Toast copy
// ============================================================

/**
 * Build the user-facing toast string for a fired alert. The emoji
 * prefix categorizes severity at a glance:
 *
 *   up_pct      🟢 win
 *   down_pct    🔴 drawdown
 *   spot_level  ⚪ informational underlying-cross
 *   dte_7       🟡 expiry warning
 */
export function buildAlertToast(a: TrackerAlert): {
  message: string;
  type: 'success' | 'error' | 'info';
} {
  const strike = parseNum(a.strike) ?? 0;
  const label = `${a.ticker} ${formatStrikeSide(strike, a.side)} ${formatExpiryMD(a.expiry)}`;
  const last = parseNum(a.price_at_fire);
  const entry = parseNum(a.entry_price);
  const threshold = parseNum(a.threshold) ?? 0;

  if (a.alert_type === 'up_pct') {
    return {
      type: 'success',
      message: `🟢 ${label} hit +${threshold.toFixed(0)}% — now ${formatDollar(last)} (entry ${formatDollar(entry)})`,
    };
  }
  if (a.alert_type === 'down_pct') {
    return {
      type: 'error',
      message: `🔴 ${label} hit ${threshold.toFixed(0)}% — now ${formatDollar(last)} (entry ${formatDollar(entry)})`,
    };
  }
  if (a.alert_type === 'spot_level') {
    // Strip the redundant `.00` on integer thresholds — "595" reads
    // cleaner than "595.00". Fractional thresholds keep their precision.
    return {
      type: 'info',
      message: `⚪ ${a.ticker} crossed ${formatSpotLevel(threshold)} — your ${label} is at ${formatDollar(last)}`,
    };
  }
  // dte_7
  return {
    type: 'info',
    message: `🟡 ${label} has 7 days to expiry`,
  };
}

// ============================================================
// Watchlist filter
// ============================================================

/**
 * Watchlist tab membership: a contract is on the watchlist when its
 * DTE is ≤ 7 OR it has an unacknowledged alert.
 */
export function isWatchlistContract(
  c: TrackerContract,
  unreadAlerts: ReadonlyArray<TrackerAlert>,
  now: Date = new Date(),
): boolean {
  if (c.status !== 'active') return false;
  if (dteFromExpiry(c.expiry, now) <= 7) return true;
  return unreadAlerts.some((a) => a.contract_id === c.id);
}

/** Pick a stable alert "type" label for accessibility / grouping. */
export const ALERT_TYPE_LABEL: Record<AlertType, string> = {
  up_pct: 'Up threshold',
  down_pct: 'Down threshold',
  spot_level: 'Spot level',
  dte_7: '7 days to expiry',
};
