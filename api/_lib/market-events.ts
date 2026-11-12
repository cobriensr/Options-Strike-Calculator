/**
 * The market event calendar: one source for `/api/events` (a forward window)
 * and for the server-side event-day flag on snapshots (a single date).
 *
 *   - FRED API: CPI, NFP, GDP, PCE, PPI, Retail Sales, JOLTS
 *   - Static: FOMC dates, half-day/early close dates
 *   - Finnhub API: Mega-cap earnings (AAPL, MSFT, NVDA, AMZN, GOOG, META, TSLA)
 *
 * The first two are the macro events (`fetchMacroEvents`). They alone make up
 * the stored snapshot flag (owner decision 2026-11-12); the earnings join them
 * only in `fetchMarketEvents`, for `/api/events` and the app's banner.
 *
 * Environment variables, read from `process.env` on every call:
 *   FRED_API_KEY    — Free key from https://fred.stlouisfed.org/docs/api/api_key.html
 *   FINNHUB_API_KEY — Free key from https://finnhub.io/register (optional, earnings only)
 */

import { Sentry } from './sentry.js';
import { redis } from './redis.js';
import logger from './logger.js';
import { FOMC_DECISION_DATES, isSepMeeting } from './fomc-schedule.js';
import { EARLY_CLOSE_DATES } from '../../src/data/marketHours.js';

// ============================================================
// TYPES
// ============================================================

export interface EventItem {
  date: string;
  event: string;
  description: string;
  time: string;
  severity: 'high' | 'medium';
  source: 'fred' | 'static' | 'finnhub';
}

interface FredReleaseDateEntry {
  release_id: number;
  date: string;
}

interface FredReleaseDatesResponse {
  release_dates: FredReleaseDateEntry[];
}

export interface MarketEventsResult {
  events: EventItem[];
  /** True when every source returned OK — safe to cache for the full day. */
  complete: boolean;
}

/**
 * What `getEventsForDate` answers: the events, plus whether a cache entry
 * served them (`fromCache` true) or this call fetched them (false). A caller
 * that reports a failed lookup uses it to report once per fetch, not once for
 * every call the short failure entry then serves.
 */
export type DayEventsResult = MarketEventsResult & { fromCache: boolean };

// ============================================================
// FRED RELEASE IDS → EVENT MAPPING
// ============================================================

interface FredReleaseConfig {
  readonly id: number;
  readonly event: string;
  readonly description: string;
  readonly time: string;
  readonly severity: 'high' | 'medium';
}

// FRED release IDs, each checked against
// https://api.stlouisfed.org/fred/release?release_id=<id> on 2026-11-12.
// 51 (International Trade) and 110 (Personal Income by State) were once mapped
// to PPI and JOLTS by mistake; the real ones are 46 and 192.
const TRACKED_RELEASES: readonly FredReleaseConfig[] = [
  {
    id: 10,
    event: 'CPI',
    description: 'Consumer Price Index',
    time: '8:30 AM',
    severity: 'high',
  },
  {
    id: 50,
    event: 'NFP',
    description: 'Employment Situation (Nonfarm Payrolls)',
    time: '8:30 AM',
    severity: 'high',
  },
  {
    id: 53,
    event: 'GDP',
    description: 'Gross Domestic Product',
    time: '8:30 AM',
    severity: 'medium',
  },
  {
    id: 54,
    event: 'PCE',
    description: 'Personal Income and Outlays (PCE Inflation)',
    time: '8:30 AM',
    severity: 'high',
  },
  {
    id: 46,
    event: 'PPI',
    description: 'Producer Price Index',
    time: '8:30 AM',
    severity: 'medium',
  },
  {
    id: 9,
    event: 'Retail Sales',
    description: 'Advance Monthly Sales for Retail and Food Services',
    time: '8:30 AM',
    severity: 'medium',
  },
  {
    id: 192,
    event: 'JOLTS',
    description: 'Job Openings and Labor Turnover Survey',
    time: '10:00 AM',
    severity: 'medium',
  },
] as const;

// ============================================================
// STATIC HALF-DAY / EARLY CLOSE DATES
// ============================================================

/**
 * Early closes come from `EARLY_CLOSE_DATES` in `src/data/marketHours.ts`,
 * the same calendar every market-hours gate uses, so the two cannot drift
 * (this file once listed 2026-07-03 as an early close while NYSE was shut).
 * The reason label is derived from the month: Jul = Independence Day Eve,
 * Nov = Black Friday, Dec = Christmas Eve.
 *
 * Good Friday is the only full closure surfaced as a CLOSED event (no 0DTE
 * is possible); `MARKET_CLOSED_DATES` carries no holiday names, so these
 * stay listed by hand. Add next year's Good Friday here when you extend
 * the calendar.
 *
 * Sources: https://www.nyse.com/markets/hours-calendars
 */
const GOOD_FRIDAYS: readonly string[] = [
  '2025-04-18',
  '2026-04-03',
  '2027-03-26',
  '2028-04-14',
];

const EARLY_CLOSE_REASON_BY_MONTH: Readonly<Record<string, string>> = {
  '07': 'Independence Day Eve',
  '11': 'Black Friday',
  '12': 'Christmas Eve',
};

interface HalfDayEntry {
  readonly date: string;
  readonly type: 'early_close' | 'closed';
  readonly closeTime?: string;
  readonly reason: string;
}

function formatCloseTime(hourET: number): string {
  const hour12 = hourET > 12 ? hourET - 12 : hourET;
  return `${hour12}:00 ${hourET >= 12 ? 'PM' : 'AM'}`;
}

const ALL_HALF_DAYS: readonly HalfDayEntry[] = [
  ...GOOD_FRIDAYS.map(
    (date): HalfDayEntry => ({ date, type: 'closed', reason: 'Good Friday' }),
  ),
  ...[...EARLY_CLOSE_DATES].map(
    ([date, hourET]): HalfDayEntry => ({
      date,
      type: 'early_close',
      closeTime: formatCloseTime(hourET),
      reason: EARLY_CLOSE_REASON_BY_MONTH[date.slice(5, 7)] ?? 'Early close',
    }),
  ),
].sort((x, y) => x.date.localeCompare(y.date));

// ============================================================
// MEGA-CAP EARNINGS (FINNHUB)
// ============================================================

/**
 * The "Magnificent 7" — each represents 3–8% of SPX.
 * When one reports earnings (even after hours), the next morning's
 * SPX open can gap significantly.
 */
const MEGA_CAP_SYMBOLS = new Set([
  'AAPL',
  'MSFT',
  'NVDA',
  'AMZN',
  'GOOG',
  'META',
  'TSLA',
]);

const FINNHUB_BASE = 'https://finnhub.io/api/v1';

interface FinnhubEarningsEntry {
  date: string;
  epsActual: number | null;
  epsEstimate: number | null;
  hour: string; // 'bmo' (before open), 'amc' (after close), 'dmh' (during)
  quarter: number;
  revenueActual: number | null;
  revenueEstimate: number | null;
  symbol: string;
  year: number;
}

interface FinnhubEarningsResponse {
  earningsCalendar: FinnhubEarningsEntry[];
}

/**
 * True for a name built by `fetchMegaCapEarnings`, whose event name is the
 * template `${symbol} Earnings`. It pairs with that template: change one and
 * change the other. The leading space and the end anchor are part of the rule,
 * so `Earnings Season` and `NVDA Earnings Call` are not earnings names.
 */
export function isEarningsEventName(name: string): boolean {
  return / Earnings$/.test(name);
}

interface EarningsResult {
  events: EventItem[];
  /** False on a non-OK status, a thrown fetch or body, or a malformed payload. */
  ok: boolean;
}

async function fetchMegaCapEarnings(
  apiKey: string,
  startDate: string,
  endDate: string,
): Promise<EarningsResult> {
  const events: EventItem[] = [];

  try {
    const params = new URLSearchParams({
      from: startDate,
      to: endDate,
      token: apiKey,
    });

    const url = `${FINNHUB_BASE}/calendar/earnings?${params.toString()}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });

    if (!res.ok) {
      logger.error({ status: res.status }, 'Finnhub earnings API error');
      return { events: [], ok: false };
    }

    const data = (await res.json()) as Partial<FinnhubEarningsResponse> | null;

    // A missing or non-array calendar is a bad payload, not "no earnings":
    // an empty array is the normal answer for a quiet day.
    if (!Array.isArray(data?.earningsCalendar)) {
      logger.error('Finnhub earnings malformed payload');
      return { events: [], ok: false };
    }

    for (const entry of data.earningsCalendar) {
      if (!MEGA_CAP_SYMBOLS.has(entry.symbol)) continue;
      // Keep the asked range, inclusive, as FRED's rows are kept: a stray row
      // outside it would put a name on the wrong date.
      if (!(entry.date >= startDate && entry.date <= endDate)) continue;

      const timeLabel =
        entry.hour === 'bmo'
          ? 'Before Open'
          : entry.hour === 'amc'
            ? 'After Close'
            : entry.hour === 'dmh'
              ? 'During Hours'
              : '';

      events.push({
        date: entry.date,
        event: `${entry.symbol} Earnings`,
        description: `${entry.symbol} Q${entry.quarter} ${entry.year} earnings${timeLabel ? ' (' + timeLabel + ')' : ''}`,
        time: timeLabel || 'TBD',
        severity: 'high',
        source: 'finnhub',
      });
    }
  } catch (err) {
    logger.error({ err }, 'Finnhub earnings fetch failed');
    return { events: [], ok: false };
  }

  return { events, ok: true };
}

// ============================================================
// FRED API FETCH
// ============================================================

const FRED_BASE = 'https://api.stlouisfed.org/fred';
// v3: the PPI and JOLTS release IDs were corrected, so a v2 entry can name the
// wrong days. v2: the day lookup is macro-only; a v1 entry can hold Finnhub
// earnings.
const DAY_CACHE_KEY = 'events:day:v3';
export const CACHE_TTL_SEC = 7 * 24 * 60 * 60; // 7 days (key is date-scoped)
// An incomplete or failed lookup is kept briefly, not for the day. Without it
// a lookup that keeps failing repays 7 FRED calls on every snapshot save, and
// a replay saves about 24 times a minute: about 170 FRED calls a minute, more
// than FRED allows per key. Five minutes caps that to one retry per window.
const INCOMPLETE_CACHE_TTL_SEC = 5 * 60;

interface FredReleaseResult {
  entries: FredReleaseDateEntry[];
  ok: boolean;
}

async function fetchReleaseDates(
  releaseId: number,
  apiKey: string,
  startDate: string,
  endDate: string,
): Promise<FredReleaseResult> {
  const params = new URLSearchParams({
    release_id: String(releaseId),
    api_key: apiKey,
    file_type: 'json',
    include_release_dates_with_no_data: 'true',
    sort_order: 'asc',
  });

  const url = `${FRED_BASE}/release/dates?${params.toString()}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });

  if (!res.ok) {
    logger.error({ releaseId, status: res.status }, 'FRED API error');
    Sentry.captureMessage('FRED API non-OK', {
      level: 'warning',
      extra: { releaseId, status: res.status },
    });
    // Signal the error so the caller skips the day-scoped cache write —
    // a transient FRED blip must not pin a degraded list for the day
    // (e.g. a missing CPI flag on a CPI morning).
    return { entries: [], ok: false };
  }

  const data = (await res.json()) as Partial<FredReleaseDatesResponse> | null;

  // A 200 without a release list is a bad payload, not "no events": an empty
  // array is FRED's normal answer, so only a missing or non-array list fails.
  if (!Array.isArray(data?.release_dates)) {
    logger.error({ releaseId }, 'FRED API malformed payload');
    Sentry.captureMessage('FRED API malformed payload', {
      level: 'warning',
      extra: { releaseId },
    });
    return { entries: [], ok: false };
  }

  return {
    entries: data.release_dates.filter(
      (r) => r.date >= startDate && r.date <= endDate,
    ),
    ok: true,
  };
}

// ============================================================
// MAIN FETCH
// ============================================================

/** Sort by date, then severity (high first), then event name. */
function sortEvents(events: EventItem[]): EventItem[] {
  return events.sort((a, b) => {
    if (a.date !== b.date) return a.date.localeCompare(b.date);
    if (a.severity !== b.severity) return a.severity === 'high' ? -1 : 1;
    return a.event.localeCompare(b.event);
  });
}

/**
 * The macro events from `startDate` to `endDate` (inclusive, YYYY-MM-DD),
 * sorted by date, then severity (high first), then event name: the tracked
 * FRED releases, FOMC, and the half-day and closure statics. This is the whole
 * definition of an event day for the stored snapshot flag (owner decision
 * 2026-11-12): mega-cap earnings are left out because Finnhub's free key
 * serves only about a month of past earnings, so they cannot be rebuilt for
 * older dates. It never calls Finnhub and never reads `FINNHUB_API_KEY`.
 *
 * FRED's `release/dates` returns all history and the range is filtered here,
 * so a past range works as well as a forward one.
 *
 * `complete` is true only when `FRED_API_KEY` is set and every FRED release
 * answered with a well-formed payload. Without the key it returns the static
 * events with `complete: false`; it does not throw. A FRED non-OK status or
 * malformed payload is logged and returns `complete: false`. A FRED network
 * error or unparseable body rejects.
 */
export async function fetchMacroEvents(
  startDate: string,
  endDate: string,
): Promise<MarketEventsResult> {
  const fredKey = process.env.FRED_API_KEY;

  const releaseMap = new Map<number, FredReleaseConfig>();
  for (const r of TRACKED_RELEASES) releaseMap.set(r.id, r);

  if (!fredKey) {
    logger.warn('FRED_API_KEY not configured; returning static events only');
  }

  const fredResults = await Promise.all(
    fredKey
      ? TRACKED_RELEASES.map((r) =>
          fetchReleaseDates(r.id, fredKey, startDate, endDate),
        )
      : [],
  );

  // A FRED release failing means the list may be missing an event (e.g. CPI):
  // treat the whole fetch as incomplete so the caller does not cache a
  // degraded result for the day (or, in a snapshot save, trust it over the
  // client's names). No FRED key means no economic events at all, which is
  // incomplete too.
  const complete = Boolean(fredKey) && fredResults.every((r) => r.ok);

  const events: EventItem[] = [];

  // Map FRED results to events
  for (const { entries } of fredResults) {
    for (const entry of entries) {
      const config = releaseMap.get(entry.release_id);
      if (!config) continue;

      events.push({
        date: entry.date,
        event: config.event,
        description: config.description,
        time: config.time,
        severity: config.severity,
        source: 'fred',
      });
    }
  }

  // Add static FOMC dates within range
  for (const fomcDate of FOMC_DECISION_DATES) {
    if (fomcDate >= startDate && fomcDate <= endDate) {
      const hasSEP = isSepMeeting(fomcDate);
      events.push({
        date: fomcDate,
        event: hasSEP ? 'FOMC + SEP' : 'FOMC',
        description: hasSEP
          ? 'Fed rate decision + Summary of Economic Projections (dot plot)'
          : 'Federal Reserve interest rate decision',
        time: '2:00 PM',
        severity: 'high',
        source: 'static',
      });
    }
  }

  // Add half-day / early close dates within range
  for (const hd of ALL_HALF_DAYS) {
    if (hd.date >= startDate && hd.date <= endDate) {
      if (hd.type === 'closed') {
        events.push({
          date: hd.date,
          event: 'CLOSED',
          description: `Market closed \u2014 ${hd.reason}`,
          time: 'All Day',
          severity: 'high',
          source: 'static',
        });
      } else {
        events.push({
          date: hd.date,
          event: 'EARLY CLOSE',
          description: `Market closes at ${hd.closeTime} ET \u2014 ${hd.reason}. Time-to-expiry uses ${hd.closeTime} instead of 4:00 PM.`,
          time: hd.closeTime!,
          severity: 'high',
          source: 'static',
        });
      }
    }
  }

  return { events: sortEvents(events), complete };
}

/**
 * Every event from `startDate` to `endDate` (inclusive, YYYY-MM-DD) for
 * `/api/events` and the app's banner: the macro events from
 * `fetchMacroEvents`, plus the mega-cap earnings from Finnhub when
 * `FINNHUB_API_KEY` is set, sorted as there. Finnhub earnings rows are kept to
 * the same range. The two sources are fetched in parallel.
 *
 * `complete` is true only when the macro fetch is complete and, when a
 * Finnhub key is set, Finnhub answered with a well-formed payload. A Finnhub
 * failure of any kind is logged and returns `complete: false`; the macro
 * failures and rejections are as in `fetchMacroEvents`.
 */
export async function fetchMarketEvents(
  startDate: string,
  endDate: string,
): Promise<MarketEventsResult> {
  const finnhubKey = process.env.FINNHUB_API_KEY; // optional — earnings only

  // Macro first: its FRED requests go out before Finnhub's, as they always did.
  const macroPromise = fetchMacroEvents(startDate, endDate);
  const earningsPromise: Promise<EarningsResult> = finnhubKey
    ? fetchMegaCapEarnings(finnhubKey, startDate, endDate)
    : Promise.resolve({ events: [], ok: true });

  const [macro, earnings] = await Promise.all([macroPromise, earningsPromise]);

  // No Finnhub key means earnings are not part of the list, so that leg
  // counts as OK.
  return {
    events: sortEvents([...macro.events, ...earnings.events]),
    complete: macro.complete && earnings.ok,
  };
}

// ============================================================
// SINGLE-DATE LOOKUP
// ============================================================

interface DayCacheEntry {
  data: EventItem[];
  cachedAt: number;
  /** Absent on a complete entry, which reads as complete. */
  complete?: boolean;
}

async function writeDayCache(
  cacheKey: string,
  entry: DayCacheEntry,
  ttlSec: number,
): Promise<void> {
  try {
    await redis.set(cacheKey, entry, { ex: ttlSec });
  } catch (err) {
    logger.error({ err }, 'Failed to cache day events in Redis');
  }
}

/**
 * The macro events on one date: `fetchMacroEvents(date, date)` behind a Redis
 * key per date (`events:day:v3:{date}`), with two lifetimes. Earnings are not
 * part of it, so a Finnhub failure can neither delay nor degrade the answer.
 *   - a `complete` result is kept 7 days (`CACHE_TTL_SEC`);
 *   - an incomplete result, or a fetch that rejects, is kept 5 minutes as
 *     `{ data, cachedAt, complete: false }`, so a lookup that keeps failing is
 *     not repaid on every call, and a FRED blip or a missing key is retried
 *     within minutes instead of pinning a degraded day. A rejected fetch
 *     caches `data: []`, then rethrows the original error.
 * A hit returns the entry's events with `complete: false` only when the entry
 * says so; an entry without the field is a complete one.
 * `fromCache` is true on a hit and false after a fetch, so a caller can tell
 * the call that found a failure from the calls the failure entry then serves.
 * A Redis read or write failure is logged and the lookup goes on without the
 * cache; a failed write never hides the result or the original rejection.
 *
 * `date` is YYYY-MM-DD, today or earlier in ET. A future date would cache a
 * schedule that can still change for up to 7 days, so callers skip future
 * dates first (`api/snapshot.ts` already does).
 */
export async function getEventsForDate(date: string): Promise<DayEventsResult> {
  const cacheKey = `${DAY_CACHE_KEY}:${date}`;

  try {
    const cached = await redis.get<DayCacheEntry>(cacheKey);
    if (cached && Array.isArray(cached.data)) {
      return {
        events: cached.data,
        complete: cached.complete !== false,
        fromCache: true,
      };
    }
  } catch (err) {
    logger.error({ err }, 'Failed to read day events from Redis');
  }

  let result: MarketEventsResult;
  try {
    result = await fetchMacroEvents(date, date);
  } catch (err) {
    await writeDayCache(
      cacheKey,
      { data: [], cachedAt: Date.now(), complete: false },
      INCOMPLETE_CACHE_TTL_SEC,
    );
    throw err;
  }

  if (result.complete) {
    await writeDayCache(
      cacheKey,
      { data: result.events, cachedAt: Date.now() },
      CACHE_TTL_SEC,
    );
  } else {
    await writeDayCache(
      cacheKey,
      { data: result.events, cachedAt: Date.now(), complete: false },
      INCOMPLETE_CACHE_TTL_SEC,
    );
  }

  return { ...result, fromCache: false };
}

// ============================================================
// SNAPSHOT NAMES
// ============================================================

/**
 * The `event_names` a snapshot stores for a date's events: each macro event's
 * name in the order given, duplicates kept, and no Finnhub earnings (the
 * stored flag is macro-only, owner decision 2026-11-12). This is the one
 * definition shared by the snapshot save and the history backfill, so the two
 * writers cannot drift apart. The app's own list still carries earnings, so a
 * client's names may hold some: see `isEarningsEventName`.
 */
export function eventNamesForSnapshot(events: readonly EventItem[]): string[] {
  return events.filter((e) => e.source !== 'finnhub').map((e) => e.event);
}
