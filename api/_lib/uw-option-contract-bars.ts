/**
 * UW per-contract minute bars:
 *   GET /api/option-contract/{id}/intraday?date=YYYY-MM-DD
 * Operation PublicApi.OptionContractController.intraday.
 *
 * Live shape, probed 2026-10-02, drifts from the published example. Rows
 * carry start_time (UTC minute start, e.g. '2026-09-30T19:59:00Z'),
 * open/high/low/close as decimal strings, trading_hours ('rth'), and
 * side-split volume/premium. They come newest first and carry NO
 * option_symbol or expiry echo. The response cannot be keyed on an echoed
 * contract, so the parser checks the one thing it can: the bars fall on the
 * requested day.
 *
 * Why this is not `uwFetch`: the caller is a local backfill script
 * (scripts/backfill-periscope-lottery-outcomes.ts), not a Vercel Function.
 * It sends an explicit User-Agent and must tell three outcomes apart
 * (bars / no bars / failed) instead of collapsing them to `[]`. Like
 * `uwFetch`, each request holds one of the crons' shared in-flight slots
 * (uw-concurrency; a no-op without Redis), so a run never pushes UW past
 * its 3-in-flight plan cap alongside the live crons.
 */

import { z } from 'zod';
import { getETDateStr } from '../../src/utils/timezone.js';
import { TIMEOUTS, UW_BASE } from './constants.js';
import { toOccSymbol } from './occ.js';
import type { MinuteBar } from './periscope-lottery-outcome.js';
import {
  acquireConcurrencySlot,
  releaseConcurrencySlot,
} from './uw-concurrency.js';
import type { UwFetchOutcome } from './uw-result.js';
import { parseUwHttpStatus, withRetry } from './uw-fetch.js';

/** UW 403s anonymous client UAs (e.g. Python-urllib); always identify. */
export const UW_BACKFILL_USER_AGENT = 'strike-calculator-backfill/1.0';

/**
 * UW's contract id: the OCC symbol without the root's space padding,
 * e.g. SPXW 2026-09-30 7580 put → 'SPXW260930P07580000'.
 */
export function uwOptionSymbol(
  ticker: string,
  expiry: string,
  side: 'C' | 'P',
  strike: number,
): string {
  return toOccSymbol({ ticker, expiry, side, strike }).replaceAll(' ', '');
}

/** Decimal string or number → a finite price > 0. */
const uwPrice = z
  .union([z.string(), z.number()])
  .transform((v) => (typeof v === 'number' ? v : Number(v)))
  .pipe(z.number().positive()); // rejects NaN ('abc'), 0 ('') and Infinity

const UwBarRow = z
  .object({
    start_time: z
      .string()
      .refine((s) => !Number.isNaN(Date.parse(s)), 'unparseable start_time'),
    open: uwPrice,
    high: uwPrice,
    low: uwPrice,
    close: uwPrice,
  })
  .refine(
    (r) =>
      r.low <= r.high &&
      r.low <= r.open &&
      r.open <= r.high &&
      r.low <= r.close &&
      r.close <= r.high,
    'OHLC out of order',
  );

const UwIntradayBody = z.object({ data: z.array(z.unknown()) });

/**
 * Validate one intraday response body. Empty `data` is `empty`, never an
 * error. Any malformed row fails the WHOLE contract-day: silently dropping
 * a bar could drop the peak.
 */
export function parseIntradayBars(
  body: unknown,
  date: string,
): UwFetchOutcome<MinuteBar[]> {
  const parsedBody = UwIntradayBody.safeParse(body);
  if (!parsedBody.success) return { kind: 'error', reason: 'malformed_shape' };
  if (parsedBody.data.data.length === 0) return { kind: 'empty' };

  const bars: MinuteBar[] = [];
  for (const raw of parsedBody.data.data) {
    const row = UwBarRow.safeParse(raw);
    if (!row.success) return { kind: 'error', reason: 'malformed_bar' };
    const r = row.data;
    bars.push({
      start: new Date(r.start_time),
      open: r.open,
      high: r.high,
      low: r.low,
      close: r.close,
    });
  }
  bars.sort((a, b) => a.start.getTime() - b.start.getTime());

  // The outcome proofs assume 60 s bars that start on a minute boundary.
  if (bars.some((b) => b.start.getTime() % 60_000 !== 0)) {
    return { kind: 'error', reason: 'misaligned_bar' };
  }
  for (let i = 1; i < bars.length; i++) {
    if (bars[i]!.start.getTime() === bars[i - 1]!.start.getTime()) {
      return { kind: 'error', reason: 'duplicate_bar' };
    }
  }
  // `date` defaults to the latest session when UW ignores it; never let a
  // different day's bars stand in for the requested one.
  if (!bars.some((b) => getETDateStr(b.start) === date)) {
    return { kind: 'error', reason: 'wrong_day' };
  }
  return { kind: 'ok', data: bars };
}

/**
 * Fetch one contract-day of minute bars. Transient failures (429, 5xx,
 * network) are retried by `withRetry`; whatever still fails comes back as
 * `{ kind: 'error' }` naming the cause — `http_<status>`, `network: …`,
 * `malformed_json`, or a parse reason — never as an empty day.
 */
export async function fetchContractDayBars(
  apiKey: string,
  symbol: string,
  date: string,
): Promise<UwFetchOutcome<MinuteBar[]>> {
  const url = `${UW_BASE}/option-contract/${encodeURIComponent(symbol)}/intraday?date=${date}`;
  let text: string;
  try {
    text = await withRetry(async () => {
      // Held until the body is read, so the shared in-flight count is true.
      const slotId = await acquireConcurrencySlot();
      try {
        const r = await fetch(url, {
          headers: {
            Authorization: `Bearer ${apiKey}`,
            Accept: 'application/json',
            'User-Agent': UW_BACKFILL_USER_AGENT,
          },
          signal: AbortSignal.timeout(TIMEOUTS.UW_API),
        });
        if (!r.ok) {
          const errText = await r.text().catch(() => '');
          // `UW API <status>:` is the format withRetry classifies (429/5xx).
          throw new Error(`UW API ${r.status}: ${errText.slice(0, 200)}`);
        }
        return await r.text();
      } finally {
        await releaseConcurrencySlot(slotId);
      }
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const status = parseUwHttpStatus(msg);
    return {
      kind: 'error',
      reason: status === null ? `network: ${msg}` : `http_${status}`,
    };
  }

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { kind: 'error', reason: 'malformed_json' };
  }
  return parseIntradayBars(body, date);
}
