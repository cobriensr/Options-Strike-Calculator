/**
 * Shared helpers for the pyramid chain + leg form modals.
 *
 * Colocated with the form components (local to the feature folder) so the
 * "delete the directory if the experiment fails" cleanup runbook stays
 * mechanical — no imports reach outside `PyramidTracker/`.
 */

import type { PyramidSessionPhase } from '../../types/pyramid';

/** Format `YYYY-MM-DD` for today in the user's local tz (CT during market). */
export function todayIsoDate(): string {
  const d = new Date();
  const y = String(d.getFullYear());
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Map an `HH:MM` Chicago-time string to the session phase bucket used by
 * pyramid legs. Thresholds match the spec:
 *   <08:30         -> pre_open
 *    08:30-09:15   -> open_drive
 *    09:15-11:30   -> morning_drive
 *    11:30-13:30   -> lunch
 *    13:30-14:30   -> afternoon
 *    14:30-15:30   -> power_hour
 *    15:30+        -> close
 *
 * Returns `null` for inputs that don't parse as `HH:MM`. Callers treat null
 * as "leave the field blank" and let the user pick manually.
 */
export function sessionPhaseFromTime(
  hhmm: string | null | undefined,
): PyramidSessionPhase | null {
  if (hhmm == null || hhmm.length < 4) return null;
  const m = /^(\d{1,2}):(\d{2})/.exec(hhmm);
  if (!m) return null;
  const hh = Number.parseInt(m[1]!, 10);
  const mm = Number.parseInt(m[2]!, 10);
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
  const minutes = hh * 60 + mm;
  if (minutes < 8 * 60 + 30) return 'pre_open';
  if (minutes < 9 * 60 + 15) return 'open_drive';
  if (minutes < 11 * 60 + 30) return 'morning_drive';
  if (minutes < 13 * 60 + 30) return 'lunch';
  if (minutes < 14 * 60 + 30) return 'afternoon';
  if (minutes < 15 * 60 + 30) return 'power_hour';
  return 'close';
}

/**
 * Count how many of the supplied form values are "filled" for completeness-
 * meter purposes. A value is filled iff it is not `null`, not `undefined`,
 * not an empty string, and not `NaN` (which `Number.parseFloat('')` returns).
 *
 * `true` / `false` booleans both count as filled — the user explicitly
 * answered. This is why `was_profitable` is `true | false | null`, not
 * `true | false | undefined`.
 */
export function countFilled(values: ReadonlyArray<unknown>): number {
  let n = 0;
  for (const v of values) {
    if (v == null) continue;
    if (typeof v === 'string' && v.length === 0) continue;
    if (typeof v === 'number' && Number.isNaN(v)) continue;
    n += 1;
  }
  return n;
}

/** Pick a colour band for the completeness meter. */
export function completenessColor(pct: number): string {
  if (pct < 33) return 'var(--color-danger)';
  if (pct < 66) return 'var(--color-caution)';
  return 'var(--color-success)';
}

/**
 * Parse a string from a number input into a nullable number.
 * Empty input -> null. NaN -> null. Matches how the Zod schemas and DB
 * columns treat missing values.
 */
export function parseNumberInput(raw: string): number | null {
  if (raw.length === 0) return null;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse a string from a number input into a nullable integer.
 * Empty input -> null. NaN -> null. Used for fields that should be whole
 * numbers (leg_number, minutes_since_*, ob_quality, etc).
 */
export function parseIntInput(raw: string): number | null {
  if (raw.length === 0) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * Format a nullable number for a controlled text field. Uses empty string
 * for null/undefined so React doesn't warn about the value switching
 * between `undefined` and a string.
 */
export function numberToInput(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '';
  return String(n);
}

/** Format a nullable string for a controlled text field. */
export function stringToInput(s: string | null | undefined): string {
  return s ?? '';
}

/**
 * Produce a best-effort chain ID suggestion of the form
 * `YYYY-MM-DD-SYMBOL-1`. The sequence suffix is always `1` here — the
 * next-sequence logic would require a round-trip to the server (or a
 * client-side scan of existing chains for the same date+symbol), and the
 * spec explicitly allows "leave blank and accept client-provided IDs" when
 * inference is uncertain. Keeps this helper pure.
 */
export function suggestChainId(
  date: string | null,
  instrument: string | null,
): string {
  const d = date != null && date.length > 0 ? date : todayIsoDate();
  const sym = instrument != null && instrument.length > 0 ? instrument : 'MNQ';
  return `${d}-${sym}-1`;
}

/**
 * Pyramid API error message mapper. The form modals re-throw unknown errors
 * and surface `PyramidApiError` instances as inline form errors; this
 * translates `.status` / `.code` into the user-facing copy.
 */
export interface ApiErrorLike {
  readonly status: number;
  readonly code?: string | undefined;
  readonly message: string;
}

export function pyramidApiErrorMessage(err: ApiErrorLike): string {
  if (err.status === 401) {
    return 'Owner access required to save.';
  }
  if (err.status === 409 && err.code === 'leg_1_missing') {
    return 'Leg 1 is missing for this chain \u2014 create leg 1 first.';
  }
  if (err.status >= 500) {
    return 'Server error \u2014 please try again.';
  }
  if (err.status === 400) {
    return err.message.length > 0 ? err.message : 'Invalid input.';
  }
  return err.message;
}
