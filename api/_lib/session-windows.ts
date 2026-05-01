/**
 * DST-aware session-open helpers used by historical-mode endpoints.
 *
 * Reusable across endpoints that need an "08:30-CT today" or "08:30-ET
 * for date X" UTC timestamp without rolling their own DST handling. The
 * implementation iterates candidate UTC hours and verifies the result
 * via the runtime Intl timezone database — no fixed DST cutoff dates,
 * no JS month-arithmetic surprises.
 *
 * Phase 5j of docs/superpowers/specs/api-refactor-2026-05-02.md.
 */

import { getCtParts } from './flow-alert-derive.js';

/**
 * Return the UTC ISO timestamp of the most recent 08:30 America/Chicago
 * instant at or before `now`. If `now` is before today's 08:30 CT, returns
 * `null` (pre-market — caller should skip `newer_than`). Uses Intl TZ
 * lookup to avoid DST bugs.
 *
 *   lastSessionOpenUtc(new Date('2026-04-30T15:00:00Z'))
 *     // → '2026-04-30T13:30:00.000Z'  (08:30 CDT)
 *   lastSessionOpenUtc(new Date('2026-04-30T11:00:00Z'))
 *     // → null                          (pre-08:30 CT)
 */
export function lastSessionOpenUtc(now: Date): string | null {
  // Candidate UTC hour for 08:30 CT is 13:30 UTC during CDT, 14:30 UTC during
  // CST. Try both; pick the one that lands on 08:30 in CT on the same CT
  // calendar day.
  const nowParts = getCtParts(now.toISOString());
  const [y, m, d] = nowParts.dateStr
    .split('-')
    .map((p) => Number.parseInt(p, 10));

  for (const utcHour of [13, 14]) {
    const candidate = new Date(
      Date.UTC(y!, (m ?? 1) - 1, d ?? 1, utcHour, 30, 0, 0),
    );
    const parts = getCtParts(candidate.toISOString());
    if (
      parts.dateStr === nowParts.dateStr &&
      parts.hour === 8 &&
      parts.minute === 30
    ) {
      if (candidate.getTime() <= now.getTime()) {
        return candidate.toISOString();
      }
      return null; // pre-market today
    }
  }
  return null;
}

/**
 * Return the UTC ISO timestamp of 08:30 America/New_York on a given
 * YYYY-MM-DD date string. Accounts for DST by trying both candidate
 * UTC hours (12:30 for EDT, 13:30 for EST) and verifying the result
 * via Intl TZ lookup — same strategy as `lastSessionOpenUtc` but for
 * ET instead of CT.
 *
 *   sessionOpenUtcForDate('2026-04-30')  // → '2026-04-30T12:30:00.000Z' (EDT)
 *   sessionOpenUtcForDate('2026-01-15')  // → '2026-01-15T13:30:00.000Z' (EST)
 */
export function sessionOpenUtcForDate(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map((p) => Number.parseInt(p, 10));
  // 08:30 EDT = 12:30 UTC, 08:30 EST = 13:30 UTC
  for (const utcHour of [12, 13]) {
    const candidate = new Date(
      Date.UTC(y!, (m ?? 1) - 1, d ?? 1, utcHour, 30, 0, 0),
    );
    const etFmt = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
    });
    const etParts = etFmt.formatToParts(candidate);
    const getP = (type: string) =>
      etParts.find((p) => p.type === type)?.value ?? '';
    const etHour = Number.parseInt(getP('hour'), 10) % 24;
    const etMin = Number.parseInt(getP('minute'), 10);
    if (etHour === 8 && etMin === 30) {
      return candidate.toISOString();
    }
  }
  // Fallback: assume EDT (12:30 UTC)
  return new Date(
    Date.UTC(y!, (m ?? 1) - 1, d ?? 1, 12, 30, 0, 0),
  ).toISOString();
}
