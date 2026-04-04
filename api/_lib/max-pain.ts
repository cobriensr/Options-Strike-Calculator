/**
 * SPX Max Pain
 *
 * Fetches max pain levels for all SPX expirations from Unusual Whales API.
 * The 0DTE max pain is a settlement attractor — the strike where total
 * option holder losses are maximized (and MM profits are maximized).
 *
 * On neutral/low-gamma days, settlement gravitates toward max pain.
 * On high-gamma days, the dominant gamma wall typically overrides max pain.
 * On bearish GEX days, the straddle cone lower boundary overrides both.
 *
 * Called on-demand at analysis time — not a cron job.
 * Uses the existing UW_API_KEY.
 */
import logger from './logger.js';

const UW_BASE = 'https://api.unusualwhales.com/api';

// ── Types ───────────────────────────────────────────────────

export interface MaxPainEntry {
  expiry: string;
  max_pain: string;
}

interface MaxPainResponse {
  data: MaxPainEntry[];
  date: string;
}

// ── Fetch ────────────────────��─────────────────────��────────

/**
 * Fetch max pain for all SPX expirations.
 * Returns entries sorted by expiry ascending, or empty array on failure.
 */
export async function fetchMaxPain(
  apiKey: string,
  date?: string,
): Promise<MaxPainEntry[]> {
  try {
    const params = new URLSearchParams();
    if (date) params.set('date', date);

    const qs = params.toString();
    const suffix = qs ? `?${qs}` : '';
    const url = `${UW_BASE}/stock/SPX/max-pain${suffix}`;

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      logger.warn(
        { status: res.status, body: text.slice(0, 200) },
        'Max pain API returned non-OK',
      );
      return [];
    }

    const body: MaxPainResponse = await res.json();
    return body.data ?? [];
  } catch (err) {
    logger.error({ err }, 'Failed to fetch max pain data');
    return [];
  }
}

// ── Format for Claude ────���──────────────────────────────────

/**
 * Format max pain data for Claude's context.
 * Highlights the 0DTE max pain as a settlement attractor and shows
 * the next few expirations for multi-day gamma anchor context.
 *
 * @param entries - Max pain entries from UW API
 * @param analysisDate - Today's date (YYYY-MM-DD) to identify the 0DTE expiry
 * @param currentSpx - Current SPX price for distance calculation
 * @returns Formatted text block, or null if no data
 */
export function formatMaxPainForClaude(
  entries: MaxPainEntry[],
  analysisDate: string,
  currentSpx?: number,
): string | null {
  if (entries.length === 0) return null;

  // UW API returns monthly expirations only — find exact 0DTE match
  // first, then fall back to the nearest expiry on or after this date
  // (the dominant OI anchor for settlement gravitational pull).
  const zeroDte =
    entries.find((e) => e.expiry === analysisDate) ??
    entries
      .filter((e) => e.expiry >= analysisDate)
      .sort((a, b) => a.expiry.localeCompare(b.expiry))[0];
  if (!zeroDte) return null;

  const zeroDteStrike = Number.parseFloat(zeroDte.max_pain);
  if (Number.isNaN(zeroDteStrike)) return null;

  const lines: string[] = [];

  // Label reflects whether we matched 0DTE exactly or used nearest monthly
  const isExact = zeroDte.expiry === analysisDate;
  const expiryLabel = isExact ? '0DTE' : `nearest monthly (${zeroDte.expiry})`;
  lines.push(`Max Pain (${expiryLabel}): ${zeroDteStrike.toFixed(0)}`);

  if (currentSpx != null) {
    const dist = currentSpx - zeroDteStrike;
    const dir = dist > 0 ? 'above' : 'below';
    lines.push(
      `  SPX at ${currentSpx.toFixed(1)} is ${Math.abs(dist).toFixed(0)} pts ${dir} max pain`,
    );

    // Interpretation
    if (Math.abs(dist) <= 10) {
      lines.push(
        '  Price AT max pain — settlement likely near current level on neutral gamma days',
      );
    } else if (Math.abs(dist) <= 30) {
      lines.push(
        `  Price moderately ${dir} max pain — gravitational pull toward ${zeroDteStrike.toFixed(0)} increases into final 2 hours if gamma is neutral`,
      );
    } else {
      lines.push(
        `  Price far ${dir} max pain — max pain pull is weak at this distance. Gamma walls and flow direction dominate`,
      );
    }
  }

  // Show next 3 expirations for multi-day context
  const upcoming = entries
    .filter((e) => e.expiry > analysisDate)
    .sort((a, b) => a.expiry.localeCompare(b.expiry))
    .slice(0, 3);

  if (upcoming.length > 0) {
    lines.push('', '  Upcoming expirations:');
    for (const e of upcoming) {
      const strike = Number.parseFloat(e.max_pain);
      if (Number.isNaN(strike)) continue;
      const dist =
        currentSpx != null
          ? ` (${Math.abs(currentSpx - strike).toFixed(0)} pts ${currentSpx > strike ? 'above' : 'below'})`
          : '';
      lines.push(`    ${e.expiry}: ${strike.toFixed(0)}${dist}`);
    }
  }

  return lines.join('\n');
}
