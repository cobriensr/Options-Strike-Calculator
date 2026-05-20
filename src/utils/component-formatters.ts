/**
 * Shared display formatters for components. These exist to deduplicate
 * the per-component formatTime / formatDeltaPct helpers that had
 * accumulated across the codebase. Domain-specific formatters (e.g.
 * formatPremium variants in DarkPoolLevels vs. OptionsFlow with
 * different precision rules) intentionally stay local.
 */

const TIME_FORMATTER_CT = new Intl.DateTimeFormat('en-US', {
  hour: 'numeric',
  minute: '2-digit',
  timeZone: 'America/Chicago',
});

/**
 * Format a timestamp as a Central Time wall-clock time (e.g. "2:45 PM").
 *
 * Accepts either an ISO 8601 string OR a numeric epoch in milliseconds.
 * The number overload exists because hook freshness state is canonically
 * `fetchedAt: number | null` (epoch ms) — see useFetchedData. Returns
 * the optional fallback (default '') for null/undefined/empty input or
 * unparseable strings, and for non-finite numbers.
 *
 * Use this anywhere a component currently rolls its own
 * `new Date(iso).toLocaleTimeString('en-US', { ..., timeZone: 'America/Chicago' })`.
 */
export function formatTimeCT(
  value: string | number | null | undefined,
  options?: { fallback?: string },
): string {
  const fallback = options?.fallback ?? '';
  if (value == null || value === '') return fallback;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return fallback;
    return TIME_FORMATTER_CT.format(new Date(value));
  }
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return fallback;
  return TIME_FORMATTER_CT.format(d);
}

/**
 * Format a delta-like fractional value (e.g. 0.045 → "+4.5%") with a
 * forced sign. Returns the optional fallback (default em dash) for
 * null/undefined/non-finite input.
 */
export function formatDeltaPct(
  value: number | null | undefined,
  options?: { fallback?: string; digits?: number },
): string {
  const fallback = options?.fallback ?? '—';
  if (value == null || !Number.isFinite(value)) return fallback;
  const digits = options?.digits ?? 1;
  const sign = value >= 0 ? '+' : '';
  return `${sign}${(value * 100).toFixed(digits)}%`;
}
