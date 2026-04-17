import { MARKET, DEFAULTS, IV_MODES } from '../constants/index.js';
import type { TimeValidation, IVResult, IVMode } from '../types/index.js';
import { convertCTToET } from './timezone.js';

/**
 * Parses the day of week from 'YYYY-MM-DD' (UTC to avoid timezone shift).
 * Returns 0 = Mon .. 4 = Fri, or null for weekends / invalid input.
 * If no date is given, uses today's local day.
 */
export function parseDow(selectedDate?: string): number | null {
  if (selectedDate) {
    const parts = selectedDate.split('-');
    if (parts.length === 3) {
      const d = new Date(
        Date.UTC(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2])),
      );
      const jsDay = d.getUTCDay(); // 0=Sun, 1=Mon ... 6=Sat
      if (jsDay >= 1 && jsDay <= 5) return jsDay - 1; // 0=Mon..4=Fri
      return null; // weekend
    }
  }
  const jsDay = new Date().getDay();
  if (jsDay === 0 || jsDay === 6) return null;
  return jsDay - 1;
}

/**
 * Validates that a given time (in ET, 24h format) falls within market hours.
 * Returns hours remaining if valid, error message if not.
 */
export function validateMarketTime(
  hour: number,
  minute: number,
): TimeValidation {
  const totalMinutes = hour * 60 + minute;
  const openMinutes = MARKET.OPEN_HOUR_ET * 60 + MARKET.OPEN_MINUTE_ET;
  const closeMinutes = MARKET.CLOSE_HOUR_ET * 60 + MARKET.CLOSE_MINUTE_ET;

  if (totalMinutes < openMinutes) {
    return {
      valid: false,
      error: 'Before market open; use 9:30 AM ET or later',
    };
  }
  if (totalMinutes >= closeMinutes) {
    return {
      valid: false,
      error: 'After market close; use before 4:00 PM ET',
    };
  }

  const hoursRemaining = (closeMinutes - totalMinutes) / 60;
  return { valid: true, hoursRemaining };
}

/**
 * Converts hours remaining in the trading day to annualized time-to-expiry (T).
 * T = hoursRemaining / (6.5 hours × 252 trading days)
 */
export function calcTimeToExpiry(hoursRemaining: number): number {
  return hoursRemaining / MARKET.ANNUAL_TRADING_HOURS;
}

/**
 * Resolves implied volatility (σ) from either VIX or direct input.
 * Single convergence point — both modes produce one σ output.
 */
export function resolveIV(
  mode: IVMode,
  params: { vix?: number; multiplier?: number; directIV?: number },
): IVResult {
  if (mode === IV_MODES.VIX) {
    const { vix, multiplier } = params;

    if (vix == null || Number.isNaN(vix) || vix < 0) {
      return { sigma: null, error: 'VIX must be a positive number' };
    }
    if (vix === 0) {
      return {
        sigma: null,
        error: 'VIX cannot be zero; enter a value > 0',
      };
    }
    if (
      multiplier == null ||
      Number.isNaN(multiplier) ||
      multiplier < DEFAULTS.IV_PREMIUM_MIN ||
      multiplier > DEFAULTS.IV_PREMIUM_MAX
    ) {
      return {
        sigma: null,
        error: `Multiplier must be ${DEFAULTS.IV_PREMIUM_MIN} to ${DEFAULTS.IV_PREMIUM_MAX}`,
      };
    }

    return { sigma: (vix * multiplier) / 100 };
  }

  if (mode === IV_MODES.DIRECT) {
    const { directIV } = params;

    if (directIV == null || Number.isNaN(directIV) || directIV <= 0) {
      return { sigma: null, error: 'IV must be a positive number' };
    }
    if (directIV > 2) {
      return { sigma: null, error: 'Enter as decimal (e.g. 0.20 for 20%)' };
    }

    return { sigma: directIV };
  }

  return { sigma: null, error: 'Invalid IV mode' };
}

/**
 * Converts 12-hour time to 24-hour format.
 */
export function to24Hour(hour: number, ampm: 'AM' | 'PM'): number {
  if (ampm === 'AM') return hour === 12 ? 0 : hour;
  return hour === 12 ? 12 : hour + 12;
}

/**
 * Converts UI time inputs (12-hour + timezone) to ET hour and minute.
 * Single source of truth for this conversion — used by App.tsx and hooks.
 *
 * For CT inputs, uses the live IANA zone data via `convertCTToET()` rather
 * than a hard-coded `+1` offset. The hard-coded offset was correct by
 * accident (ET and CT share US DST rules today), but would silently break
 * if the rules ever diverge or if a non-US zone were ever added. (FE-STATE-004)
 */
export function toETTime(
  timeHour: string,
  timeMinute: string,
  timeAmPm: 'AM' | 'PM',
  timezone: 'ET' | 'CT',
): { etHour: number; etMinute: number } {
  const h24 = to24Hour(Number.parseInt(timeHour, 10), timeAmPm);
  const etMinute = Number.parseInt(timeMinute, 10) || 0;
  if (timezone === 'CT') {
    const { hour, minute } = convertCTToET(h24, etMinute);
    return { etHour: hour, etMinute: minute };
  }
  return { etHour: h24, etMinute };
}
