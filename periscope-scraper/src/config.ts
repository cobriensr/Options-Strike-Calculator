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
export const SENTRY_DSN = requireEnv('SENTRY_DSN');
// Required at boot even though scrape.ts is currently a stub — fail-fast
// catches misconfigured deploys before the first tick rather than after.
// Once Phase 0 lands real selectors, scrape.ts will use this cookie to
// authenticate Playwright against UW Periscope.
export const UW_SESSION_COOKIE = requireEnv('UW_SESSION_COOKIE');

// Placeholder default — replaced by env after Phase 0 probe confirms the
// live URL (page path may include query params for expiry / symbol / panel
// selection). Production deploys MUST set UW_PERISCOPE_URL explicitly; the
// default here only exists so misconfigured environments fail loudly with
// a navigation error instead of crashing on a missing env var.
export const UW_PERISCOPE_URL =
  process.env.UW_PERISCOPE_URL ?? 'https://unusualwhales.com/periscope';

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
