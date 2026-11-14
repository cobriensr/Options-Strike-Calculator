/**
 * Is the quote behind a live snapshot save fresh enough for its slot?
 *
 * A live row's inputs come from the quote state. When the quote poll stalls,
 * or Schwab serves an old print, the inputs still match that state, so the
 * row looks live while holding a frozen price (F11, 11-02 / 11-04 / 11-06).
 * Only the quote's own time shows it. The client sends it as `quotedAt`, the
 * older of the SPX and VIX Schwab `tradeTime` (epoch ms); this module judges
 * it against the slot, the `entryTime` label's instant, not the server's
 * clock, so the verdict is deterministic. Pure: /api/snapshot supplies `nowMs`.
 *
 * Pulls in src/ modules, so their relative imports carry `.js`.
 */

import {
  getMarketCloseHourET,
  isTradingDay,
} from '../../src/data/marketHours.js';
import { parseEntryTimeMinutes } from '../../src/utils/entry-time.js';
import {
  ctWallClockToUtcIso,
  etWallClockToUtcIso,
  getETMarketOpenUtcIso,
} from '../../src/utils/timezone.js';

/** The spec's limit (P0.6): a quote older than this behind its slot is stale. */
export const MAX_QUOTE_BEHIND_MS = 10 * 60_000;

/**
 * How far ahead of the server's clock a quote may claim to be: Schwab's and
 * Vercel's clocks are not the same clock. Past it the value is not a
 * millisecond time (microseconds would pass any age-only check).
 */
export const MAX_QUOTE_AHEAD_MS = 2 * 60_000;

/**
 * After the open, how long a stale quote is still unremarkable: SPX's first
 * tick is at 9:30:0x, so from 9:40 on a quote older than 10 minutes can't be
 * explained by "no tick yet".
 */
const OPEN_GRACE_MS = 10 * 60_000;

export type QuoteRefusal =
  | 'no-quote-time'
  | 'bad-entry-time'
  | 'quote-from-future'
  | 'stale-quote';

export type QuoteVerdict =
  | { ok: true; behindMs: number }
  | {
      ok: false;
      reason: QuoteRefusal;
      /** The slot's instant (epoch ms); null when the label or date is bad. */
      slotMs: number | null;
      /** slot - quotedAt; null when there is no quote time or no slot. */
      behindMs: number | null;
    };

/** The slot's instant for a date and an entry-time label, or null. */
function slotMsOf(date: string, entryTime: string): number | null {
  const ctMinutes = parseEntryTimeMinutes(entryTime);
  if (Number.isNaN(ctMinutes)) return null;
  const iso = ctWallClockToUtcIso(date, ctMinutes);
  return iso == null ? null : Date.parse(iso);
}

/**
 * Judge a live save's quote time against its slot. The first failing check
 * names the refusal: no usable time, an unreadable slot, a time ahead of
 * `nowMs` by more than MAX_QUOTE_AHEAD_MS, then a quote more than
 * MAX_QUOTE_BEHIND_MS behind the slot (exactly that much passes, and a quote
 * newer than the slot is fine: the slot is floored to 5 minutes).
 */
export function checkQuoteFreshness(args: {
  date: string;
  entryTime: string;
  quotedAt: number | null | undefined;
  nowMs: number;
}): QuoteVerdict {
  const { date, entryTime, quotedAt, nowMs } = args;
  const slotMs = slotMsOf(date, entryTime);
  const refuse = (
    reason: QuoteRefusal,
    behindMs: number | null,
  ): QuoteVerdict => ({ ok: false, reason, slotMs, behindMs });

  if (quotedAt == null || !Number.isFinite(quotedAt) || quotedAt <= 0) {
    return refuse('no-quote-time', null);
  }
  if (slotMs == null) return refuse('bad-entry-time', null);

  const behindMs = slotMs - quotedAt;
  if (quotedAt - nowMs > MAX_QUOTE_AHEAD_MS) {
    return refuse('quote-from-future', behindMs);
  }
  if (behindMs > MAX_QUOTE_BEHIND_MS) return refuse('stale-quote', behindMs);
  return { ok: true, behindMs };
}

/** An ISO time for a log or an alert; null for a value Date can't hold. */
export function isoOrNull(ms: number | null | undefined): string | null {
  if (ms == null) return null;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * Is the slot inside the session: from the open (9:30 ET) plus a grace until
 * the close, which is 13:00 ET on a half day. A weekend or a holiday has no
 * session. The close itself is out.
 */
export function isInSession(date: string, slotMs: number): boolean {
  if (!isTradingDay(date)) return false;
  // A trading day has a close hour (a holiday, the only null, is not one).
  const closeHour = getMarketCloseHourET(date) ?? 16;
  const openIso = getETMarketOpenUtcIso(date);
  const closeIso = etWallClockToUtcIso(date, closeHour * 60);
  if (openIso == null || closeIso == null) return false;
  return (
    slotMs >= Date.parse(openIso) + OPEN_GRACE_MS &&
    slotMs < Date.parse(closeIso)
  );
}

/**
 * Should a refusal raise a Sentry error? A missing quote time or an unreadable
 * label is a wiring bug at any hour. A stale quote or a quote from the future
 * is only news inside the session: before the open and after the close the
 * last quote is old by nature, and the refusal is a log and a metric.
 */
export function alertsOnRefusal(date: string, verdict: QuoteVerdict): boolean {
  if (verdict.ok) return false;
  if (
    verdict.reason === 'no-quote-time' ||
    verdict.reason === 'bad-entry-time'
  ) {
    return true;
  }
  return verdict.slotMs != null && isInSession(date, verdict.slotMs);
}
