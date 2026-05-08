/**
 * GET /api/cron/compute-cone
 *
 * Computes the SPX 0DTE straddle breakeven cone at 9:31 ET each weekday and
 * persists it to `cone_levels`. Replaces the user-facing manual cone input
 * with an auto-computed pair derived from the ATM call+put marks on the
 * SPX 0DTE chain.
 *
 * Math (per the Periscope / UW convention):
 *   atm_strike   = strike closest to underlying.last in the chain
 *   cone_upper   = atm_strike + call_mark
 *   cone_lower   = atm_strike - put_mark
 *   cone_width   = cone_upper - cone_lower         (≈ 2 × atm_straddle)
 *   asymmetry    = (atm_strike - cone_lower) - (cone_upper - atm_strike)
 *                = put_mark - call_mark
 *                  positive = downside-skewed (puts richer than calls).
 *
 * Cone is then anchored at calc_time and rendered as diagonals converging
 * toward the breakeven prices at the close (frontend concern). For the
 * cron-side persistence we just record the bounds + asymmetry.
 *
 * Source: Schwab `/chains?symbol=$SPX` with SPXW OSI-root filter — same
 * fetch shape as `fetch-strike-iv` (which we mirror for parity). The
 * 0DTE chain is fromDate=today, toDate=today.
 *
 * Schedule: `32 13 * * 1-5` (13:32 UTC = 9:32 EDT — 1 min after the
 * 9:31 ET Periscope cone-calc anchor, giving Schwab time to settle the
 * opening chain marks). DST-tuned to match the rest of the cron fleet —
 * every other RTH cron in vercel.json uses 13–21 UTC under the same
 * DST convention.
 *
 * Idempotency: cone_levels has DATE PRIMARY KEY. We `ON CONFLICT DO
 * NOTHING` so a same-day re-fire (e.g. accidental backfill) is a no-op
 * rather than overwriting the morning's cone with later marks.
 *
 * Spec: docs/superpowers/specs/periscope-html-ingestion-2026-05-07.md
 *       (Phase 1 — cone auto-compute)
 */

import { getDb } from '../_lib/db.js';
import { schwabFetch } from '../_lib/api-helpers.js';
import {
  withCronInstrumentation,
  type CronResult,
} from '../_lib/cron-instrumentation.js';

interface SchwabOptionContract {
  putCall: 'PUT' | 'CALL';
  symbol: string; // OSI: e.g. "SPXW  260507C05750000"
  bid: number;
  ask: number;
  mark: number;
  strikePrice: number;
  expirationDate: string;
}

interface SchwabChainResponse {
  symbol: string;
  status: string;
  underlying: {
    symbol: string;
    last: number;
    close: number;
  };
  putExpDateMap: Record<string, Record<string, SchwabOptionContract[]>>;
  callExpDateMap: Record<string, Record<string, SchwabOptionContract[]>>;
}

function parseExpKey(key: string): string {
  const colon = key.indexOf(':');
  return colon === -1 ? key : key.slice(0, colon);
}

/**
 * SPXW (weekly) and SPX (monthly) share the `$SPX` chain endpoint —
 * filter to the SPXW root by reading the OSI symbol's first whitespace-
 * delimited token. Same logic as fetch-strike-iv.matchesRoot for SPXW.
 */
function isSPXW(contractSymbol: string | undefined): boolean {
  if (!contractSymbol) return false;
  const root = contractSymbol.split(/\s+/)[0] ?? '';
  return root === 'SPXW';
}

/**
 * Find the SPXW contract whose strikePrice is closest to spot in a
 * {strike → contracts[]} map. Returns null if no SPXW contracts found.
 */
function pickAtmContract(
  strikesMap: Record<string, SchwabOptionContract[]>,
  spot: number,
): SchwabOptionContract | null {
  let best: SchwabOptionContract | null = null;
  let bestDist = Infinity;
  for (const arr of Object.values(strikesMap)) {
    const c = arr.find((x) => isSPXW(x.symbol));
    if (!c) continue;
    if (!Number.isFinite(c.strikePrice) || !Number.isFinite(c.mark)) continue;
    const dist = Math.abs(c.strikePrice - spot);
    if (dist < bestDist) {
      best = c;
      bestDist = dist;
    }
  }
  return best;
}

interface AtmPair {
  atmStrike: number;
  callMark: number;
  putMark: number;
}

function extractAtmMarks(
  chain: SchwabChainResponse,
  today: string,
): AtmPair | null {
  const spot = chain.underlying?.last;
  if (!Number.isFinite(spot) || spot <= 0) return null;

  // Find today's expiry key in both maps.
  const callKey = Object.keys(chain.callExpDateMap ?? {}).find(
    (k) => parseExpKey(k) === today,
  );
  const putKey = Object.keys(chain.putExpDateMap ?? {}).find(
    (k) => parseExpKey(k) === today,
  );
  if (callKey == null || putKey == null) return null;

  const callMap = chain.callExpDateMap[callKey];
  const putMap = chain.putExpDateMap[putKey];
  if (callMap == null || putMap == null) return null;

  const atmCall = pickAtmContract(callMap, spot);
  const atmPut = pickAtmContract(putMap, spot);
  if (atmCall == null || atmPut == null) return null;

  // Sanity: ATM call and put must agree on strike. They should, given both
  // are independently picked as the strike closest to the same spot, but
  // protect against odd chain gaps where one side is missing the nearest
  // strike. If they disagree, prefer the call's strike and re-pick the put
  // at that exact strike — common 5pt SPXW grid means the disagreement is
  // typically a 1-strike gap, not a real ATM split.
  if (atmCall.strikePrice !== atmPut.strikePrice) {
    const atStrike = String(atmCall.strikePrice);
    const putAtStrike = putMap[atStrike]?.find((x) => isSPXW(x.symbol));
    if (putAtStrike == null || !Number.isFinite(putAtStrike.mark)) return null;
    return {
      atmStrike: atmCall.strikePrice,
      callMark: atmCall.mark,
      putMark: putAtStrike.mark,
    };
  }

  return {
    atmStrike: atmCall.strikePrice,
    callMark: atmCall.mark,
    putMark: atmPut.mark,
  };
}

export default withCronInstrumentation(
  'compute-cone',
  async (ctx): Promise<CronResult> => {
    const { today, logger } = ctx;
    const sql = getDb();

    const path =
      `/chains?symbol=${encodeURIComponent('$SPX')}` +
      `&contractType=ALL&includeUnderlyingQuote=true` +
      `&strategy=SINGLE&range=ALL&fromDate=${today}&toDate=${today}` +
      `&strikeCount=500`;

    const result = await schwabFetch<SchwabChainResponse>(path);
    if (!result.ok) {
      logger.warn(
        { status: result.status, error: result.error },
        'compute-cone: Schwab chain fetch failed',
      );
      return {
        status: 'error',
        metadata: { reason: 'schwab_fetch_failed', error: result.error },
      };
    }

    const chain = result.data;
    const spot = chain.underlying?.last;
    if (!Number.isFinite(spot) || spot <= 0) {
      logger.warn({ today }, 'compute-cone: invalid underlying.last');
      return {
        status: 'skipped',
        metadata: { reason: 'invalid_spot' },
      };
    }

    const atm = extractAtmMarks(chain, today);
    if (atm == null) {
      logger.warn(
        { today, spot },
        'compute-cone: could not extract ATM call+put marks',
      );
      return {
        status: 'skipped',
        metadata: { reason: 'atm_extraction_failed', spot },
      };
    }

    const coneUpper = atm.atmStrike + atm.callMark;
    const coneLower = atm.atmStrike - atm.putMark;
    const coneWidth = coneUpper - coneLower;
    // (atm - lower) - (upper - atm) simplifies to put - call.
    // Positive = downside-skewed (put richer than call).
    const asymmetryPts = atm.putMark - atm.callMark;

    // Round to 2dp for the NUMERIC(10,2) columns; premium kept at 4dp.
    const round2 = (n: number): number => Math.round(n * 100) / 100;
    const round4 = (n: number): number => Math.round(n * 10000) / 10000;

    await sql`
      INSERT INTO cone_levels (
        date, calc_time, spot_at_calc, atm_strike,
        call_premium, put_premium,
        cone_upper, cone_lower, cone_width, asymmetry_pts
      )
      VALUES (
        ${today}, NOW(), ${round2(spot)}, ${atm.atmStrike},
        ${round4(atm.callMark)}, ${round4(atm.putMark)},
        ${round2(coneUpper)}, ${round2(coneLower)},
        ${round2(coneWidth)}, ${round2(asymmetryPts)}
      )
      ON CONFLICT (date) DO NOTHING
    `;

    logger.info(
      {
        today,
        spot: round2(spot),
        atmStrike: atm.atmStrike,
        callMark: round4(atm.callMark),
        putMark: round4(atm.putMark),
        coneUpper: round2(coneUpper),
        coneLower: round2(coneLower),
        coneWidth: round2(coneWidth),
        asymmetryPts: round2(asymmetryPts),
      },
      'compute-cone: cone bounds persisted',
    );

    return {
      status: 'success',
      metadata: {
        date: today,
        spot: round2(spot),
        atmStrike: atm.atmStrike,
        coneUpper: round2(coneUpper),
        coneLower: round2(coneLower),
        coneWidth: round2(coneWidth),
        asymmetryPts: round2(asymmetryPts),
      },
    };
  },
  { requireApiKey: false },
);
