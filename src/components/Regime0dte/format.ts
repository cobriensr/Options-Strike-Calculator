/**
 * Pure formatters for the 0DTE Gamma Regime panel. Kept in a non-component
 * module so the component files only export components (keeps Vite's
 * react-refresh/only-export-components rule happy).
 */

/**
 * Format a CT minute-of-day (0–1439) as a 24h "HH:MM" clock string.
 * e.g. 653 → "10:53", 510 → "08:30". Returns "—" for null / non-finite.
 */
export function formatCtMin(ctMin: number | null): string {
  if (ctMin == null || !Number.isFinite(ctMin)) return '—';
  const clamped = Math.max(0, Math.min(1439, Math.trunc(ctMin)));
  const hh = Math.floor(clamped / 60);
  const mm = clamped % 60;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}
