/**
 * GET /api/cron/fetch-net-flow-history
 *
 * Daily post-close fetch of `/stock/{ticker}/net-prem-ticks` for the
 * Lottery Finder universe (V3 ∪ EXTENDED). Writes per-minute net-flow
 * deltas into `net_flow_per_ticker_history` with source='rest'. This
 * keeps the table current so `enrich-lottery-outcomes` can compute
 * `realized_flow_inversion_pct` for the day's fires.
 *
 * Schedule: 21:25 UTC Mon-Fri (16:25 CT, 5 min before
 * `enrich-lottery-outcomes` so the flow data is in place when enrich
 * runs). Idempotent via ON CONFLICT (ticker, ts, source) DO NOTHING.
 *
 * Phase 2 of docs/superpowers/specs/lottery-flow-inversion-automation-2026-05-05.md.
 *
 * Environment: UW_API_KEY, CRON_SECRET
 */

import {
  cronJitter,
  mapWithConcurrency,
  uwFetch,
  withRetry,
} from '../_lib/api-helpers.js';
import { getDb, withDbRetry } from '../_lib/db.js';
import logger from '../_lib/logger.js';
import { Sentry } from '../_lib/sentry.js';
import {
  withCronInstrumentation,
  type CronResult,
} from '../_lib/cron-instrumentation.js';
import {
  LOTTERY_V3_TICKERS,
  LOTTERY_EXTENDED_TICKERS,
} from '../_lib/lottery-finder.js';

const SOURCE = 'rest';

// Union of V3 + EXTENDED universes — same set the WS daemon subscribes
// to and the EDA backfill script targets. Set form dedupes SPY/IWM.
const TICKERS: string[] = Array.from(
  new Set([...LOTTERY_V3_TICKERS, ...LOTTERY_EXTENDED_TICKERS]),
);

interface NetPremTick {
  date: string;
  tape_time: string;
  net_call_premium: string;
  net_call_volume: number;
  net_put_premium: string;
  net_put_volume: number;
  call_volume?: number;
  call_volume_ask_side?: number;
  call_volume_bid_side?: number;
  put_volume?: number;
  put_volume_ask_side?: number;
  put_volume_bid_side?: number;
}

/**
 * Session-window gate. UW returns ticks across the full day; we only
 * persist 08:30–14:59 CT to match the EDA's session-scoped flow.
 * Returns true for ts inside the gate.
 */
function isInSessionCT(tapeTimeUtc: string): boolean {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
  });
  const parts = fmt.formatToParts(new Date(tapeTimeUtc));
  const h = Number.parseInt(
    parts.find((p) => p.type === 'hour')?.value ?? '-1',
    10,
  );
  const m = Number.parseInt(
    parts.find((p) => p.type === 'minute')?.value ?? '-1',
    10,
  );
  if (h < 0 || m < 0) return false;
  const hh = h === 24 ? 0 : h;
  const mod = hh * 60 + m;
  return mod >= 510 && mod < 900;
}

interface ParsedRow {
  ts: string;
  netCallPrem: number;
  netCallVol: number;
  netPutPrem: number;
  netPutVol: number;
  callVolume: number;
  callVolumeAsk: number;
  callVolumeBid: number;
  putVolume: number;
  putVolumeAsk: number;
  putVolumeBid: number;
}

function parseRow(raw: NetPremTick): ParsedRow {
  return {
    ts: raw.tape_time,
    netCallPrem: Number.parseFloat(raw.net_call_premium ?? '0') || 0,
    netCallVol: raw.net_call_volume ?? 0,
    netPutPrem: Number.parseFloat(raw.net_put_premium ?? '0') || 0,
    netPutVol: raw.net_put_volume ?? 0,
    callVolume: raw.call_volume ?? 0,
    callVolumeAsk: raw.call_volume_ask_side ?? 0,
    callVolumeBid: raw.call_volume_bid_side ?? 0,
    putVolume: raw.put_volume ?? 0,
    putVolumeAsk: raw.put_volume_ask_side ?? 0,
    putVolumeBid: raw.put_volume_bid_side ?? 0,
  };
}

async function storeRows(
  ticker: string,
  rows: readonly ParsedRow[],
): Promise<number> {
  if (rows.length === 0) return 0;
  const sql = getDb();
  // Single round-trip via unnest, mirrors the option-intraday cache
  // helper. ON CONFLICT (ticker, ts, source) DO NOTHING dedupes when
  // the cron re-runs intraday or alongside the WS daemon's writes.
  const ts = rows.map((r) => r.ts);
  const ncp = rows.map((r) => r.netCallPrem);
  const ncv = rows.map((r) => r.netCallVol);
  const npp = rows.map((r) => r.netPutPrem);
  const npv = rows.map((r) => r.netPutVol);
  const cv = rows.map((r) => r.callVolume);
  const cva = rows.map((r) => r.callVolumeAsk);
  const cvb = rows.map((r) => r.callVolumeBid);
  const pv = rows.map((r) => r.putVolume);
  const pva = rows.map((r) => r.putVolumeAsk);
  const pvb = rows.map((r) => r.putVolumeBid);
  const result = (await withDbRetry(
    () => sql`
      INSERT INTO net_flow_per_ticker_history (
        ticker, ts,
        net_call_prem, net_call_vol,
        net_put_prem, net_put_vol,
        call_volume, call_volume_ask_side, call_volume_bid_side,
        put_volume, put_volume_ask_side, put_volume_bid_side,
        source
      )
      SELECT ${ticker}, t.ts::timestamptz,
             t.ncp, t.ncv, t.npp, t.npv,
             t.cv, t.cva, t.cvb, t.pv, t.pva, t.pvb,
             ${SOURCE}
      FROM unnest(
        ${ts}::text[],
        ${ncp}::numeric[],
        ${ncv}::int[],
        ${npp}::numeric[],
        ${npv}::int[],
        ${cv}::int[],
        ${cva}::int[],
        ${cvb}::int[],
        ${pv}::int[],
        ${pva}::int[],
        ${pvb}::int[]
      ) AS t(ts, ncp, ncv, npp, npv, cv, cva, cvb, pv, pva, pvb)
      ON CONFLICT (ticker, ts, source) DO NOTHING
      RETURNING id
    `,
    2,
    10_000,
  )) as Array<{ id: number }>;
  return result.length;
}

async function fetchAndStore(
  apiKey: string,
  ticker: string,
  date: string,
): Promise<{ ticker: string; fetched: number; stored: number }> {
  let raw: NetPremTick[];
  try {
    raw = await withRetry(() =>
      uwFetch<NetPremTick>(
        apiKey,
        `/stock/${ticker}/net-prem-ticks?date=${date}`,
      ),
    );
  } catch (err) {
    logger.warn(
      { err, ticker, date },
      'fetch-net-flow-history: UW fetch failed',
    );
    // Surface to Sentry — the prior version only logger.warned and
    // returned a zero-stored tuple, so a UW outage across ~50 tickers
    // looked like a healthy zero-row run. This table feeds
    // enrich-lottery-outcomes' realized_flow_inversion_pct; silent
    // zeros corrupt the day's fires. Matches fetch-net-flow.ts.
    Sentry.captureException(err, {
      tags: { cron: 'fetch-net-flow-history', ticker },
    });
    return { ticker, fetched: 0, stored: 0 };
  }
  const kept = raw
    .filter((r) => isInSessionCT(r.tape_time))
    .map((r) => parseRow(r));
  const stored = await storeRows(ticker, kept);
  return { ticker, fetched: raw.length, stored };
}

export default withCronInstrumentation(
  'fetch-net-flow-history',
  async (ctx): Promise<CronResult> => {
    const { apiKey, today } = ctx;
    await cronJitter();

    // UW caps in-flight at 3; any higher reliably 429s. ~50 tickers at
    // concurrency 3 → ~17 sequential rounds, each ~0.5–1 s, total well
    // under the 5-minute window before enrich-lottery-outcomes fires.
    const results = await mapWithConcurrency(TICKERS, 3, (t) =>
      fetchAndStore(apiKey, t, today),
    );

    const totalFetched = results.reduce((s, r) => s + r.fetched, 0);
    const totalStored = results.reduce((s, r) => s + r.stored, 0);
    const emptyTickers = results.filter((r) => r.fetched === 0).length;

    return {
      status: 'success',
      metadata: {
        tickers: TICKERS.length,
        totalFetched,
        totalStored,
        emptyTickers,
      },
    };
  },
  // Scheduled at 21:25 UTC = 17:25 ET = 80 min past the market-hours
  // gate's 16:05 ET close-buffer. Disable the gate so the run actually
  // happens (the cron snapshot's whole purpose is post-close persistence).
  { marketHours: false },
);
