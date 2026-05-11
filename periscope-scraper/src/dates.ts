/**
 * Date utilities for the scraper. Kept dependency-free so unit tests
 * can import them without booting `config.ts` (which validates env
 * vars at module load).
 */

/**
 * Compute the captured_at ISO timestamp for a backfilled slot.
 *
 * `date` is YYYY-MM-DD, `slotEndHhmm` is the slot's end time as
 * displayed by UW (which Periscope renders in CT for the typical
 * install). Returns the UTC ISO that corresponds to that CT
 * wall-clock instant.
 *
 * REGRESSION (2026-05-10): An earlier version of this function used
 * `new Date('YYYY-MM-DDTHH:MM:00').toISOString()` and relied on the
 * Railway container being configured with `TZ=America/Chicago`. When
 * the container ran in UTC (default), every backfilled `captured_at`
 * was shifted 5 hours earlier. That corrupted 5/4-5/7 snapshots and
 * caused ~$50 of stale Claude reads in the auto-playbook backfill.
 *
 * This implementation computes the CT-to-UTC offset explicitly via
 * Intl.DateTimeFormat, which is correct regardless of container TZ
 * and handles DST transitions automatically.
 */
export function computeCapturedAt(date: string, slotEndHhmm: string): string {
  const hhmm = normalizeHhmm(slotEndHhmm);
  const [y, m, d] = date.split('-').map((s) => Number.parseInt(s, 10));
  const [hh, mm] = hhmm.split(':').map((s) => Number.parseInt(s, 10));
  if (
    !Number.isFinite(y) ||
    !Number.isFinite(m) ||
    !Number.isFinite(d) ||
    !Number.isFinite(hh) ||
    !Number.isFinite(mm)
  ) {
    throw new Error(
      `computeCapturedAt: malformed inputs date="${date}" slotEnd="${slotEndHhmm}"`,
    );
  }
  // Convergence loop: probe a UTC instant pretending CT values are
  // UTC values, read back what CT actually was at that instant, and
  // shift by the gap. Two passes suffice (one pass corrects the
  // wrong-offset guess; second pass corrects any DST cusp).
  let probeUtcMs = Date.UTC(y!, m! - 1, d!, hh!, mm!, 0);
  for (let pass = 0; pass < 2; pass += 1) {
    const ctParts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Chicago',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(probeUtcMs));
    const get = (t: string) =>
      Number.parseInt(ctParts.find((p) => p.type === t)?.value ?? '0', 10);
    const ctMs = Date.UTC(
      get('year'),
      get('month') - 1,
      get('day'),
      get('hour'),
      get('minute'),
      get('second'),
    );
    const targetMs = Date.UTC(y!, m! - 1, d!, hh!, mm!, 0);
    probeUtcMs += targetMs - ctMs;
  }
  return new Date(probeUtcMs).toISOString();
}

/**
 * Returns true when the given UTC instant maps to a CT wall-clock
 * time inside RTH (08:30-15:00 CT inclusive). DST-aware via
 * Intl.DateTimeFormat. Mon-Fri only.
 *
 * Used by the auto-playbook webhook guard to reject stale captures
 * that landed outside trading hours — and by the scraper's runTick
 * gate where extra safety is desired beyond the isMarketHours UTC
 * approximation.
 */
export function isCtInRth(d: Date): boolean {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(d);
  const wk = parts.find((p) => p.type === 'weekday')?.value ?? '';
  if (wk === 'Sat' || wk === 'Sun') return false;
  const h = Number.parseInt(
    parts.find((p) => p.type === 'hour')?.value ?? '0',
    10,
  );
  const mi = Number.parseInt(
    parts.find((p) => p.type === 'minute')?.value ?? '0',
    10,
  );
  const minutesSinceMidnight = h * 60 + mi;
  return minutesSinceMidnight >= 8 * 60 + 30 && minutesSinceMidnight <= 15 * 60;
}

function normalizeHhmm(s: string): string {
  // Accepts "8:30" or "08:30" — pad the hour to 2 digits.
  const parts = s.split(':');
  if (parts.length !== 2) return s;
  return `${parts[0]!.padStart(2, '0')}:${parts[1]}`;
}
