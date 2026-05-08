/**
 * Environment validation and runtime constants for the scraper.
 *
 * Required env vars are read once at module load. Missing required vars throw
 * before the scheduler ever starts, so Railway logs show a clear boot failure
 * rather than a silent loop with no inserts.
 */

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

export const DATABASE_URL = requireEnv('DATABASE_URL');
// SENTRY_DSN is optional — when empty, index.ts skips Sentry.init and
// errors land on stdout only. Useful for local dev runs without
// Sentry credentials.
export const SENTRY_DSN = process.env.SENTRY_DSN ?? '';

// Auth is via Playwright storageState, not a raw cookie. The path
// defaults to a Railway-volume location; locally, point it at the file
// scripts/periscope-probe.mjs --login wrote to your home directory.
export const UW_AUTH_STATE_PATH =
  process.env.UW_AUTH_STATE_PATH ?? '/data/uw-auth-state.json';

// Defaults to the Market Maker Exposures Table view confirmed in the
// Phase 0 probe. Production deploys can override via env if UW renames
// the route.
export const UW_PERISCOPE_URL =
  process.env.UW_PERISCOPE_URL ??
  'https://unusualwhales.com/periscope/market-exposures-table';

export const LOG_LEVEL = process.env.LOG_LEVEL ?? 'info';

/** 10 minutes between scrape passes. */
export const MS_PER_TICK = 10 * 60 * 1000;

/**
 * Returns true during the regular trading session window in UTC.
 *
 * RTH is 13:30–21:00 UTC (Mon–Fri). We use hour 13–20 inclusive, which covers
 * the full session plus a 1-hour tail buffer for late ticks and clock skew.
 */
export function isMarketHours(d: Date): boolean {
  const day = d.getUTCDay();
  if (day < 1 || day > 5) return false;
  const hour = d.getUTCHours();
  return hour >= 13 && hour <= 20;
}
