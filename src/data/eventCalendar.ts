/**
 * Static economic event calendar for 0DTE trading.
 * All dates are known well in advance — FOMC is published a year ahead,
 * CPI/NFP follow fixed monthly patterns.
 *
 * Update this file once per year when the next year's schedule is published.
 * Sources:
 *   FOMC: https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm
 *   CPI:  https://www.bls.gov/schedule/news_release/cpi.htm
 *   NFP:  https://www.bls.gov/schedule/news_release/empsit.htm
 *   PCE:  https://www.bea.gov/news/schedule
 *   GDP:  https://www.bea.gov/news/schedule
 */

export type EventSeverity = 'high' | 'medium';

export interface MarketEvent {
  readonly date: string; // YYYY-MM-DD
  readonly event: string; // Short name
  readonly description: string; // What it is
  readonly time: string; // Release time ET
  readonly severity: EventSeverity;
}

// ============================================================
// 2025 EVENTS
// ============================================================

const EVENTS_2025: readonly MarketEvent[] = [
  // FOMC Decision Days (2nd day = announcement at 2:00 PM ET)
  {
    date: '2025-01-29',
    event: 'FOMC',
    description: 'Federal Reserve interest rate decision',
    time: '2:00 PM',
    severity: 'high',
  },
  {
    date: '2025-03-19',
    event: 'FOMC + SEP',
    description:
      'Fed rate decision + Summary of Economic Projections (dot plot)',
    time: '2:00 PM',
    severity: 'high',
  },
  {
    date: '2025-05-07',
    event: 'FOMC',
    description: 'Federal Reserve interest rate decision',
    time: '2:00 PM',
    severity: 'high',
  },
  {
    date: '2025-06-18',
    event: 'FOMC + SEP',
    description:
      'Fed rate decision + Summary of Economic Projections (dot plot)',
    time: '2:00 PM',
    severity: 'high',
  },
  {
    date: '2025-07-30',
    event: 'FOMC',
    description: 'Federal Reserve interest rate decision',
    time: '2:00 PM',
    severity: 'high',
  },
  {
    date: '2025-09-17',
    event: 'FOMC + SEP',
    description:
      'Fed rate decision + Summary of Economic Projections (dot plot)',
    time: '2:00 PM',
    severity: 'high',
  },
  {
    date: '2025-10-29',
    event: 'FOMC',
    description: 'Federal Reserve interest rate decision',
    time: '2:00 PM',
    severity: 'high',
  },
  {
    date: '2025-12-10',
    event: 'FOMC + SEP',
    description:
      'Fed rate decision + Summary of Economic Projections (dot plot)',
    time: '2:00 PM',
    severity: 'high',
  },

  // CPI releases (8:30 AM ET)
  {
    date: '2025-01-15',
    event: 'CPI',
    description: 'Consumer Price Index (December data)',
    time: '8:30 AM',
    severity: 'high',
  },
  {
    date: '2025-02-12',
    event: 'CPI',
    description: 'Consumer Price Index (January data)',
    time: '8:30 AM',
    severity: 'high',
  },
  {
    date: '2025-03-12',
    event: 'CPI',
    description: 'Consumer Price Index (February data)',
    time: '8:30 AM',
    severity: 'high',
  },
  {
    date: '2025-04-10',
    event: 'CPI',
    description: 'Consumer Price Index (March data)',
    time: '8:30 AM',
    severity: 'high',
  },
  {
    date: '2025-05-13',
    event: 'CPI',
    description: 'Consumer Price Index (April data)',
    time: '8:30 AM',
    severity: 'high',
  },
  {
    date: '2025-06-11',
    event: 'CPI',
    description: 'Consumer Price Index (May data)',
    time: '8:30 AM',
    severity: 'high',
  },
  {
    date: '2025-07-15',
    event: 'CPI',
    description: 'Consumer Price Index (June data)',
    time: '8:30 AM',
    severity: 'high',
  },
  {
    date: '2025-08-12',
    event: 'CPI',
    description: 'Consumer Price Index (July data)',
    time: '8:30 AM',
    severity: 'high',
  },
  {
    date: '2025-09-10',
    event: 'CPI',
    description: 'Consumer Price Index (August data)',
    time: '8:30 AM',
    severity: 'high',
  },
  {
    date: '2025-12-18',
    event: 'CPI',
    description: 'Consumer Price Index (November data)',
    time: '8:30 AM',
    severity: 'high',
  },

  // NFP / Employment Situation (8:30 AM ET, usually 1st Friday)
  {
    date: '2025-01-10',
    event: 'NFP',
    description: 'Nonfarm Payrolls (December data)',
    time: '8:30 AM',
    severity: 'high',
  },
  {
    date: '2025-02-07',
    event: 'NFP',
    description: 'Nonfarm Payrolls (January data)',
    time: '8:30 AM',
    severity: 'high',
  },
  {
    date: '2025-03-07',
    event: 'NFP',
    description: 'Nonfarm Payrolls (February data)',
    time: '8:30 AM',
    severity: 'high',
  },
  {
    date: '2025-04-04',
    event: 'NFP',
    description: 'Nonfarm Payrolls (March data)',
    time: '8:30 AM',
    severity: 'high',
  },
  {
    date: '2025-05-02',
    event: 'NFP',
    description: 'Nonfarm Payrolls (April data)',
    time: '8:30 AM',
    severity: 'high',
  },
  {
    date: '2025-06-06',
    event: 'NFP',
    description: 'Nonfarm Payrolls (May data)',
    time: '8:30 AM',
    severity: 'high',
  },
  {
    date: '2025-07-03',
    event: 'NFP',
    description: 'Nonfarm Payrolls (June data)',
    time: '8:30 AM',
    severity: 'high',
  },
  {
    date: '2025-08-01',
    event: 'NFP',
    description: 'Nonfarm Payrolls (July data)',
    time: '8:30 AM',
    severity: 'high',
  },
  {
    date: '2025-09-05',
    event: 'NFP',
    description: 'Nonfarm Payrolls (August data)',
    time: '8:30 AM',
    severity: 'high',
  },
  {
    date: '2025-11-20',
    event: 'NFP',
    description: 'Nonfarm Payrolls (Sept data, delayed)',
    time: '8:30 AM',
    severity: 'high',
  },
  {
    date: '2025-12-16',
    event: 'NFP',
    description: 'Nonfarm Payrolls (Oct+Nov data)',
    time: '8:30 AM',
    severity: 'high',
  },

  // GDP Advance Estimates (8:30 AM ET)
  {
    date: '2025-01-30',
    event: 'GDP',
    description: 'GDP Advance Estimate (Q4 2024)',
    time: '8:30 AM',
    severity: 'medium',
  },
  {
    date: '2025-04-30',
    event: 'GDP',
    description: 'GDP Advance Estimate (Q1 2025)',
    time: '8:30 AM',
    severity: 'medium',
  },
  {
    date: '2025-07-30',
    event: 'GDP',
    description: 'GDP Advance Estimate (Q2 2025)',
    time: '8:30 AM',
    severity: 'medium',
  },
  {
    date: '2025-10-29',
    event: 'GDP',
    description: 'GDP Advance Estimate (Q3 2025)',
    time: '8:30 AM',
    severity: 'medium',
  },
] as const;

// ============================================================
// 2026 EVENTS
// ============================================================

const EVENTS_2026: readonly MarketEvent[] = [
  // FOMC Decision Days
  {
    date: '2026-01-28',
    event: 'FOMC',
    description: 'Federal Reserve interest rate decision',
    time: '2:00 PM',
    severity: 'high',
  },
  {
    date: '2026-03-18',
    event: 'FOMC + SEP',
    description:
      'Fed rate decision + Summary of Economic Projections (dot plot)',
    time: '2:00 PM',
    severity: 'high',
  },
  {
    date: '2026-05-06',
    event: 'FOMC',
    description: 'Federal Reserve interest rate decision',
    time: '2:00 PM',
    severity: 'high',
  },
  {
    date: '2026-06-17',
    event: 'FOMC + SEP',
    description:
      'Fed rate decision + Summary of Economic Projections (dot plot)',
    time: '2:00 PM',
    severity: 'high',
  },
  {
    date: '2026-07-29',
    event: 'FOMC',
    description: 'Federal Reserve interest rate decision',
    time: '2:00 PM',
    severity: 'high',
  },
  {
    date: '2026-09-16',
    event: 'FOMC + SEP',
    description:
      'Fed rate decision + Summary of Economic Projections (dot plot)',
    time: '2:00 PM',
    severity: 'high',
  },
  {
    date: '2026-10-28',
    event: 'FOMC',
    description: 'Federal Reserve interest rate decision',
    time: '2:00 PM',
    severity: 'high',
  },
  {
    date: '2026-12-09',
    event: 'FOMC + SEP',
    description:
      'Fed rate decision + Summary of Economic Projections (dot plot)',
    time: '2:00 PM',
    severity: 'high',
  },

  // CPI releases (8:30 AM ET)
  {
    date: '2026-01-14',
    event: 'CPI',
    description: 'Consumer Price Index (December 2025 data)',
    time: '8:30 AM',
    severity: 'high',
  },
  {
    date: '2026-02-13',
    event: 'CPI',
    description: 'Consumer Price Index (January data)',
    time: '8:30 AM',
    severity: 'high',
  },
  {
    date: '2026-03-11',
    event: 'CPI',
    description: 'Consumer Price Index (February data)',
    time: '8:30 AM',
    severity: 'high',
  },
  {
    date: '2026-04-10',
    event: 'CPI',
    description: 'Consumer Price Index (March data)',
    time: '8:30 AM',
    severity: 'high',
  },
  {
    date: '2026-05-12',
    event: 'CPI',
    description: 'Consumer Price Index (April data)',
    time: '8:30 AM',
    severity: 'high',
  },
  {
    date: '2026-06-10',
    event: 'CPI',
    description: 'Consumer Price Index (May data)',
    time: '8:30 AM',
    severity: 'high',
  },
  {
    date: '2026-07-14',
    event: 'CPI',
    description: 'Consumer Price Index (June data)',
    time: '8:30 AM',
    severity: 'high',
  },
  {
    date: '2026-08-12',
    event: 'CPI',
    description: 'Consumer Price Index (July data)',
    time: '8:30 AM',
    severity: 'high',
  },
  {
    date: '2026-09-16',
    event: 'CPI',
    description: 'Consumer Price Index (August data)',
    time: '8:30 AM',
    severity: 'high',
  },
  {
    date: '2026-10-13',
    event: 'CPI',
    description: 'Consumer Price Index (September data)',
    time: '8:30 AM',
    severity: 'high',
  },
  {
    date: '2026-11-10',
    event: 'CPI',
    description: 'Consumer Price Index (October data)',
    time: '8:30 AM',
    severity: 'high',
  },
  {
    date: '2026-12-09',
    event: 'CPI',
    description: 'Consumer Price Index (November data)',
    time: '8:30 AM',
    severity: 'high',
  },

  // NFP / Employment Situation (8:30 AM ET)
  {
    date: '2026-01-09',
    event: 'NFP',
    description: 'Nonfarm Payrolls (December 2025 data)',
    time: '8:30 AM',
    severity: 'high',
  },
  {
    date: '2026-02-06',
    event: 'NFP',
    description: 'Nonfarm Payrolls (January data + benchmarks)',
    time: '8:30 AM',
    severity: 'high',
  },
  {
    date: '2026-03-06',
    event: 'NFP',
    description: 'Nonfarm Payrolls (February data)',
    time: '8:30 AM',
    severity: 'high',
  },
  {
    date: '2026-04-03',
    event: 'NFP',
    description: 'Nonfarm Payrolls (March data)',
    time: '8:30 AM',
    severity: 'high',
  },
  {
    date: '2026-05-01',
    event: 'NFP',
    description: 'Nonfarm Payrolls (April data)',
    time: '8:30 AM',
    severity: 'high',
  },
  {
    date: '2026-06-05',
    event: 'NFP',
    description: 'Nonfarm Payrolls (May data)',
    time: '8:30 AM',
    severity: 'high',
  },
  {
    date: '2026-07-02',
    event: 'NFP',
    description: 'Nonfarm Payrolls (June data)',
    time: '8:30 AM',
    severity: 'high',
  },
  {
    date: '2026-08-07',
    event: 'NFP',
    description: 'Nonfarm Payrolls (July data)',
    time: '8:30 AM',
    severity: 'high',
  },
  {
    date: '2026-09-04',
    event: 'NFP',
    description: 'Nonfarm Payrolls (August data)',
    time: '8:30 AM',
    severity: 'high',
  },
  {
    date: '2026-10-02',
    event: 'NFP',
    description: 'Nonfarm Payrolls (September data)',
    time: '8:30 AM',
    severity: 'high',
  },
  {
    date: '2026-11-06',
    event: 'NFP',
    description: 'Nonfarm Payrolls (October data)',
    time: '8:30 AM',
    severity: 'high',
  },
  {
    date: '2026-12-04',
    event: 'NFP',
    description: 'Nonfarm Payrolls (November data)',
    time: '8:30 AM',
    severity: 'high',
  },

  // GDP Advance Estimates (8:30 AM ET)
  {
    date: '2026-02-20',
    event: 'GDP',
    description: 'GDP Advance Estimate (Q4 2025, delayed)',
    time: '8:30 AM',
    severity: 'medium',
  },
  {
    date: '2026-04-29',
    event: 'GDP',
    description: 'GDP Advance Estimate (Q1 2026)',
    time: '8:30 AM',
    severity: 'medium',
  },
  {
    date: '2026-07-29',
    event: 'GDP',
    description: 'GDP Advance Estimate (Q2 2026)',
    time: '8:30 AM',
    severity: 'medium',
  },
  {
    date: '2026-10-28',
    event: 'GDP',
    description: 'GDP Advance Estimate (Q3 2026)',
    time: '8:30 AM',
    severity: 'medium',
  },
] as const;

// ============================================================
// COMBINED INDEX
// ============================================================

/** All events indexed by date for O(1) lookup */
const EVENT_MAP: ReadonlyMap<string, readonly MarketEvent[]> = (() => {
  const map = new Map<string, MarketEvent[]>();
  for (const event of [...EVENTS_2025, ...EVENTS_2026]) {
    const existing = map.get(event.date);
    if (existing) {
      existing.push(event);
    } else {
      map.set(event.date, [event]);
    }
  }
  return map;
})();

// ============================================================
// LOOKUP FUNCTIONS
// ============================================================

/**
 * Get all market events for a given date.
 * Returns an empty array if no events are scheduled.
 */
export function getEventsForDate(date: string): readonly MarketEvent[] {
  return EVENT_MAP.get(date) ?? [];
}

/**
 * Check if a date has any high-severity events.
 */
export function isHighImpactDay(date: string): boolean {
  return getEventsForDate(date).some((e) => e.severity === 'high');
}

/**
 * Check if a date has any events at all.
 */
export function hasEvents(date: string): boolean {
  return EVENT_MAP.has(date);
}

/**
 * Get the highest severity for a given date.
 * Returns null if no events.
 */
export function getMaxSeverity(date: string): EventSeverity | null {
  const events = getEventsForDate(date);
  if (events.length === 0) return null;
  return events.some((e) => e.severity === 'high') ? 'high' : 'medium';
}

/**
 * Get a short summary of events for a date (for badges/tooltips).
 * e.g. "CPI + FOMC" or "NFP"
 */
export function getEventSummary(date: string): string {
  const events = getEventsForDate(date);
  if (events.length === 0) return '';
  return events.map((e) => e.event).join(' + ');
}

// ============================================================
// EARLY CLOSE / MARKET CLOSURE DATES
// NYSE closes early at 1:00 PM ET on these dates.
// This directly affects T (time-to-expiry) for 0DTE calculations.
// ============================================================

const EARLY_CLOSE_DATES: ReadonlyMap<string, number> = new Map([
  // 2025
  ['2025-07-03', 13], // Day before July 4th
  ['2025-11-28', 13], // Black Friday
  ['2025-12-24', 13], // Christmas Eve
  // 2026
  ['2026-07-03', 13], // Day before July 4th
  ['2026-11-27', 13], // Black Friday
  ['2026-12-24', 13], // Christmas Eve
]);

const MARKET_CLOSED_DATES: ReadonlySet<string> = new Set([
  // 2025
  '2025-04-18', // Good Friday
  '2025-05-26', // Memorial Day
  '2025-06-19', // Juneteenth
  '2025-07-04', // Independence Day
  '2025-09-01', // Labor Day
  '2025-11-27', // Thanksgiving
  '2025-12-25', // Christmas
  // 2026
  '2026-01-01', // New Year's Day
  '2026-01-19', // MLK Day
  '2026-02-16', // Presidents Day
  '2026-04-03', // Good Friday
  '2026-05-25', // Memorial Day
  '2026-06-19', // Juneteenth
  '2026-07-03', // Independence Day (observed)
  '2026-09-07', // Labor Day
  '2026-11-26', // Thanksgiving
  '2026-12-25', // Christmas
]);

/**
 * Get the market close hour (ET, 24h) for a given date.
 * Returns 13 for early close days, 16 for normal days, null for closed days.
 */
export function getMarketCloseHourET(date: string): number | null {
  if (MARKET_CLOSED_DATES.has(date)) return null;
  return EARLY_CLOSE_DATES.get(date) ?? 16;
}

/**
 * Get the early close hour if applicable, or undefined for normal days.
 * Designed for passing to useCalculation's earlyCloseHourET parameter.
 */
export function getEarlyCloseHourET(date: string): number | undefined {
  return EARLY_CLOSE_DATES.get(date);
}
