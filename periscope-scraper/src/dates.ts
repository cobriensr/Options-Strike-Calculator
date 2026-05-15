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
 * that landed outside trading hours.
 */
export function isCtInRth(d: Date): boolean {
  const { weekday, minutesSinceMidnight } = ctParts(d);
  if (weekday === 'Sat' || weekday === 'Sun') return false;
  return minutesSinceMidnight >= 8 * 60 + 30 && minutesSinceMidnight <= 15 * 60;
}

/**
 * Returns true when the given UTC instant is inside the scraper's
 * active polling window: Mon-Fri, 08:21-15:14 CT. DST-aware.
 *
 * Window bounds:
 *   - 08:21 CT — earliest a 10-min slot ending at 08:20 could appear
 *     in UW's "Latest" panel (publication lag is typically 1-3 min).
 *   - 15:14 CT — latest tick that can still capture the debrief slot
 *     ("14:50 - 15:00") within the auto-playbook's 15:15 CT wallclock
 *     ceiling. Beyond this the scraper has nothing useful to do.
 *
 * Outside this window the scraper resets its dedup state and sleeps
 * until the next active window.
 */
export function isInActivePollingWindow(d: Date): boolean {
  const { weekday, minutesSinceMidnight } = ctParts(d);
  if (weekday === 'Sat' || weekday === 'Sun') return false;
  return (
    minutesSinceMidnight >= 8 * 60 + 21 && minutesSinceMidnight <= 15 * 60 + 14
  );
}

/**
 * Return the end time (HH:MM) of the most recently CLOSED 10-min UW
 * slot at the given instant, in CT. DST-aware. Returns null when the
 * instant is before the first 10-min boundary of the day (00:10 CT).
 *
 * Examples (all CT):
 *   08:30:00 → "08:30"  (the 08:20-08:30 slot just closed)
 *   08:32:15 → "08:30"
 *   08:39:59 → "08:30"
 *   08:40:00 → "08:40"  (the 08:30-08:40 slot just closed)
 *
 * Used by the scraper to know which slot end-time to expect from UW's
 * "Latest" panel. When lastCapturedWindowEnd === expectedWindowEnd, we
 * already have the slot for this window and can skip the scrape until
 * the next 10-min boundary closes.
 */
export function expectedWindowEnd(d: Date): string | null {
  const { hour, minute } = ctParts(d);
  const totalMin = hour * 60 + minute;
  if (totalMin < 10) return null;
  const endMin = Math.floor(totalMin / 10) * 10;
  const eh = Math.floor(endMin / 60);
  const em = endMin % 60;
  return `${pad2(eh)}:${pad2(em)}`;
}

/**
 * Parse the END time (HH:MM) from a UW slot label like "08:20 - 08:30".
 * Returns null on unparseable input. The scraper uses this to compare
 * a freshly-captured slot's end against `expectedWindowEnd(now)`.
 */
export function parseSlotEnd(slotKey: string): string | null {
  const m = slotKey.match(/^\s*\d{1,2}:\d{2}\s*-\s*(\d{1,2}):(\d{2})\s*$/);
  if (m == null) return null;
  return `${pad2(Number.parseInt(m[1]!, 10))}:${m[2]}`;
}

function ctParts(d: Date): {
  hour: number;
  minute: number;
  weekday: string;
  minutesSinceMidnight: number;
} {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const hour = Number.parseInt(get('hour'), 10);
  const minute = Number.parseInt(get('minute'), 10);
  return {
    hour,
    minute,
    weekday: get('weekday'),
    minutesSinceMidnight: hour * 60 + minute,
  };
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function normalizeHhmm(s: string): string {
  // Accepts "8:30" or "08:30" — pad the hour to 2 digits.
  const parts = s.split(':');
  if (parts.length !== 2) return s;
  return `${parts[0]!.padStart(2, '0')}:${parts[1]}`;
}
