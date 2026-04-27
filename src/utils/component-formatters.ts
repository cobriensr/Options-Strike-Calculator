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
 * Format an ISO timestamp as a Central Time wall-clock time
 * (e.g. "2:45 PM"). Returns the optional fallback (default '') for
 * null/undefined input or unparseable strings.
 *
 * Use this anywhere a component currently rolls its own
 * `new Date(iso).toLocaleTimeString('en-US', { ..., timeZone: 'America/Chicago' })`.
 */
export function formatTimeCT(
  iso: string | null | undefined,
  options?: { fallback?: string },
): string {
  const fallback = options?.fallback ?? '';
  if (!iso) return fallback;
  const d = new Date(iso);
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
