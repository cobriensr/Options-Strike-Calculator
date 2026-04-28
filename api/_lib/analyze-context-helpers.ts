/**
 * Shared helpers + types for the analyze-context module family.
 *
 * Pure functions only — no DB, no network. These are used by both the
 * orchestrator (analyze-context.ts) and the fetchers
 * (analyze-context-fetchers.ts).
 */

import type { ImageMediaType } from './analyze-prompts.js';

/** Safely extract a numeric value from the untyped context object. */
export function numOrUndef(val: unknown): number | undefined {
  return typeof val === 'number' && Number.isFinite(val) ? val : undefined;
}

/** Format an open-interest count — "1.2K" for ≥1000, otherwise the raw int. */
export function formatOI(n: number): string {
  return n >= 1000 ? (n / 1000).toFixed(1) + 'K' : String(n);
}

/**
 * Parse an entryTime string ("2:55 PM CT" or "2:55 PM ET") on a given date
 * into a UTC ISO string suitable for DB timestamp comparisons.
 *
 * Returns undefined if parsing fails — callers treat undefined as "no cutoff"
 * and return all rows for the day (safe fallback for live runs).
 */
export function parseEntryTimeAsUtc(
  entryTime: string | null,
  date: string,
): string | undefined {
  if (!entryTime) return undefined;

  // Expected format: "H:MM AM/PM TZ" e.g. "2:55 PM CT" or "10:30 AM ET"
  const match = /^(\d{1,2}):(\d{2})\s+(AM|PM)\s+(CT|ET)$/i.exec(
    entryTime.trim(),
  );
  if (!match) return undefined;

  const [, hourStr, minuteStr, ampm, tz] = match;
  if (!ampm || !tz) return undefined;
  let hour = Number(hourStr);
  const minute = Number(minuteStr);

  if (ampm.toUpperCase() === 'PM' && hour !== 12) hour += 12;
  if (ampm.toUpperCase() === 'AM' && hour === 12) hour = 0;

  const ianaZone =
    tz.toUpperCase() === 'CT' ? 'America/Chicago' : 'America/New_York';

  // Build a wall-clock date-time string and find the UTC equivalent by
  // iterating the Intl offset correction (converges in up to 2 passes).
  const wallClock = `${date}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:59`;

  let utcGuess = new Date(`${wallClock}Z`);
  for (let i = 0; i < 2; i++) {
    const localStr = utcGuess.toLocaleString('en-CA', {
      timeZone: ianaZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
    // en-CA produces "YYYY-MM-DD, HH:MM:SS"
    const localDate = new Date(localStr.replace(', ', 'T') + 'Z');
    const offsetMs = utcGuess.getTime() - localDate.getTime();
    utcGuess = new Date(new Date(`${wallClock}Z`).getTime() + offsetMs);
  }

  return utcGuess.toISOString();
}

/** Shape of the content blocks sent to the Anthropic API. */
export type AnalysisContentBlock =
  | { type: 'text'; text: string }
  | {
      type: 'image';
      source: {
        type: 'base64';
        media_type: ImageMediaType;
        data: string;
      };
    };
