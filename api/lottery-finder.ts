/**
 * GET /api/lottery-finder
 *
 * Owner-or-guest read endpoint backing the LotteryFinder component.
 * Returns recent v4 trigger fires from `lottery_finder_fires` with
 * derived discriminators (RE-LOAD, cheap-call-PM), the macro snapshot
 * captured at fire time (display-only, see spec Appendix A), and the
 * realized-exit outcomes under each policy when the enrich cron has
 * filled them in.
 *
 * Query params: ?date= ?at= ?ticker= ?reload= ?cheapCallPm= ?mode= ?limit=
 * Validated by `lotteryFinderQuerySchema` in api/_lib/validation.ts.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getDb } from './_lib/db.js';
import { Sentry } from './_lib/sentry.js';
import logger from './_lib/logger.js';
import {
  guardOwnerOrGuestEndpoint,
  setCacheHeaders,
} from './_lib/api-helpers.js';
import { lotteryFinderQuerySchema } from './_lib/validation.js';
import { getETDateStr } from '../src/utils/timezone.js';

type DbId = number | string;
type DbNumeric = string | number;
type DbNullableNumeric = DbNumeric | null;
type DbTimestamp = string | Date;
type DbOptionType = 'C' | 'P';

interface FireRow {
  id: DbId;
  // neon serverless returns DATE columns as Date objects (not strings)
  // unless `arrayMode`/`fullResults` is configured otherwise. Type
  // accordingly and normalise via toIso() at the boundary.
  date: DbTimestamp;
  trigger_time_ct: DbTimestamp;
  entry_time_ct: DbTimestamp;
  option_chain_id: string;
  underlying_symbol: string;
  option_type: DbOptionType;
  strike: DbNumeric;
  expiry: string;
  dte: number;

  trigger_vol_to_oi_window: DbNumeric;
  trigger_vol_to_oi_cum: DbNumeric;
  trigger_iv: DbNumeric;
  trigger_delta: DbNumeric;
  trigger_ask_pct: DbNumeric;
  trigger_window_size: DbNumeric;
  trigger_window_prints: number;

  entry_price: DbNumeric;
  open_interest: number;
  spot_at_first: DbNumeric;
  alert_seq: number;
  minutes_since_prev_fire: DbNumeric;

  flow_quad: string;
  tod: string;
  mode: string;
  reload_tagged: boolean;
  cheap_call_pm_tagged: boolean;
  burst_ratio_vs_prev: DbNullableNumeric;
  entry_drop_pct_vs_prev: DbNullableNumeric;

  mkt_tide_ncp: DbNullableNumeric;
  mkt_tide_npp: DbNullableNumeric;
  mkt_tide_diff: DbNullableNumeric;
  mkt_tide_otm_diff: DbNullableNumeric;
  spx_flow_diff: DbNullableNumeric;
  spy_etf_diff: DbNullableNumeric;
  qqq_etf_diff: DbNullableNumeric;
  zero_dte_diff: DbNullableNumeric;
  spx_spot_gamma_oi: DbNullableNumeric;
  spx_spot_gamma_vol: DbNullableNumeric;
  spx_spot_charm_oi: DbNullableNumeric;
  spx_spot_vanna_oi: DbNullableNumeric;
  gex_strike_call_minus_put: DbNullableNumeric;
  gex_strike_call_ask_minus_bid: DbNullableNumeric;
  gex_strike_put_ask_minus_bid: DbNullableNumeric;
  gex_strike_actual_strike: DbNullableNumeric;

  realized_trail30_10_pct: DbNullableNumeric;
  realized_hard30m_pct: DbNullableNumeric;
  realized_tier50_holdeod_pct: DbNullableNumeric;
  realized_eod_pct: DbNullableNumeric;
  peak_ceiling_pct: DbNullableNumeric;
  minutes_to_peak: DbNullableNumeric;
  inserted_at: DbTimestamp;
  enriched_at: DbTimestamp | null;
}

const toIso = (v: DbTimestamp): string =>
  typeof v === 'string' ? v : v.toISOString();

const num = (v: DbNullableNumeric): number | null =>
  v == null ? null : Number(v);

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const guarded = await guardOwnerOrGuestEndpoint(req, res, () => undefined);
  if (guarded) return;

  try {
    const parsed = lotteryFinderQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({
        error: 'invalid query',
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      });
      return;
    }
    const { ticker, reload, cheapCallPm, mode, date, at, limit } = parsed.data;

    // Bound the result set to one trading day. `date` defaults to
    // ET-today; the trading day rolls in CT/ET, not UTC. We filter on
    // the `date` column (which the cron stamps from ctx.today, also
    // ET-anchored) — exact equality, no TZ-bound math required.
    const targetDate = date ?? getETDateStr(new Date());

    // `at` is the scrubber cutoff. When provided, only fires with
    // trigger_time_ct ≤ at are returned. Sentinel for "no cutoff" is
    // a far-future timestamp on the trading day so the SQL stays one
    // shape regardless of param presence.
    const cutoffTs = at ?? `${targetDate}T23:59:59.999Z`;

    const db = getDb();

    // Two queries in parallel: (1) the row payload bounded by LIMIT,
    // and (2) the total matching count BEFORE limit so the UI can
    // surface "showing N of M" when the limit truncates the day.
    // ORDER BY DESC matches the spec ("most recent fire first by
    // default") so a busy-day user sees the latest fires immediately
    // and the time scrubber meaningfully shifts the visible window.
    const [rows, totalRows] = (await Promise.all([
      db`
        SELECT
          id, date, trigger_time_ct, entry_time_ct, option_chain_id,
          underlying_symbol, option_type, strike, expiry, dte,
          trigger_vol_to_oi_window, trigger_vol_to_oi_cum,
          trigger_iv, trigger_delta, trigger_ask_pct,
          trigger_window_size, trigger_window_prints,
          entry_price, open_interest, spot_at_first,
          alert_seq, minutes_since_prev_fire,
          flow_quad, tod, mode,
          reload_tagged, cheap_call_pm_tagged,
          burst_ratio_vs_prev, entry_drop_pct_vs_prev,
          mkt_tide_ncp, mkt_tide_npp, mkt_tide_diff, mkt_tide_otm_diff,
          spx_flow_diff, spy_etf_diff, qqq_etf_diff, zero_dte_diff,
          spx_spot_gamma_oi, spx_spot_gamma_vol, spx_spot_charm_oi, spx_spot_vanna_oi,
          gex_strike_call_minus_put, gex_strike_call_ask_minus_bid,
          gex_strike_put_ask_minus_bid, gex_strike_actual_strike,
          realized_trail30_10_pct, realized_hard30m_pct,
          realized_tier50_holdeod_pct, realized_eod_pct,
          peak_ceiling_pct, minutes_to_peak,
          inserted_at, enriched_at
        FROM lottery_finder_fires
        WHERE date = ${targetDate}::date
          AND trigger_time_ct <= ${cutoffTs}::timestamptz
          AND (${ticker ?? null}::text IS NULL OR underlying_symbol = ${ticker ?? ''})
          AND (${reload ?? null}::boolean IS NULL OR reload_tagged = ${reload ?? false})
          AND (${cheapCallPm ?? null}::boolean IS NULL OR cheap_call_pm_tagged = ${cheapCallPm ?? false})
          AND (${mode ?? null}::text IS NULL OR mode = ${mode ?? ''})
        ORDER BY trigger_time_ct DESC
        LIMIT ${limit}
      `,
      db`
        SELECT COUNT(*)::int AS total
        FROM lottery_finder_fires
        WHERE date = ${targetDate}::date
          AND trigger_time_ct <= ${cutoffTs}::timestamptz
          AND (${ticker ?? null}::text IS NULL OR underlying_symbol = ${ticker ?? ''})
          AND (${reload ?? null}::boolean IS NULL OR reload_tagged = ${reload ?? false})
          AND (${cheapCallPm ?? null}::boolean IS NULL OR cheap_call_pm_tagged = ${cheapCallPm ?? false})
          AND (${mode ?? null}::text IS NULL OR mode = ${mode ?? ''})
      `,
    ])) as [FireRow[], { total: number }[]];

    const total = totalRows[0]?.total ?? 0;

    const fires = rows.map((r) => ({
      id: Number(r.id),
      date: toIso(r.date).slice(0, 10),
      triggerTimeCt: toIso(r.trigger_time_ct),
      entryTimeCt: toIso(r.entry_time_ct),
      optionChainId: r.option_chain_id,
      underlyingSymbol: r.underlying_symbol,
      optionType: r.option_type,
      strike: Number(r.strike),
      expiry:
        typeof r.expiry === 'string'
          ? r.expiry.slice(0, 10)
          : toIso(r.expiry).slice(0, 10),
      dte: Number(r.dte),

      trigger: {
        volToOiWindow: Number(r.trigger_vol_to_oi_window),
        volToOiCum: Number(r.trigger_vol_to_oi_cum),
        iv: Number(r.trigger_iv),
        delta: Number(r.trigger_delta),
        askPct: Number(r.trigger_ask_pct),
        windowSize: Number(r.trigger_window_size),
        windowPrints: Number(r.trigger_window_prints),
      },

      entry: {
        price: Number(r.entry_price),
        openInterest: Number(r.open_interest),
        spotAtFirst: Number(r.spot_at_first),
        alertSeq: Number(r.alert_seq),
        minutesSincePrevFire: Number(r.minutes_since_prev_fire),
      },

      tags: {
        flowQuad: r.flow_quad,
        tod: r.tod,
        mode: r.mode,
        reload: r.reload_tagged,
        cheapCallPm: r.cheap_call_pm_tagged,
        burstRatioVsPrev: num(r.burst_ratio_vs_prev),
        entryDropPctVsPrev: num(r.entry_drop_pct_vs_prev),
      },

      macro: {
        mktTideNcp: num(r.mkt_tide_ncp),
        mktTideNpp: num(r.mkt_tide_npp),
        mktTideDiff: num(r.mkt_tide_diff),
        mktTideOtmDiff: num(r.mkt_tide_otm_diff),
        spxFlowDiff: num(r.spx_flow_diff),
        spyEtfDiff: num(r.spy_etf_diff),
        qqqEtfDiff: num(r.qqq_etf_diff),
        zeroDteDiff: num(r.zero_dte_diff),
        spxSpotGammaOi: num(r.spx_spot_gamma_oi),
        spxSpotGammaVol: num(r.spx_spot_gamma_vol),
        spxSpotCharmOi: num(r.spx_spot_charm_oi),
        spxSpotVannaOi: num(r.spx_spot_vanna_oi),
        gexStrikeCallMinusPut: num(r.gex_strike_call_minus_put),
        gexStrikeCallAskMinusBid: num(r.gex_strike_call_ask_minus_bid),
        gexStrikePutAskMinusBid: num(r.gex_strike_put_ask_minus_bid),
        gexStrikeActualStrike: num(r.gex_strike_actual_strike),
      },

      outcomes: {
        realizedTrail30_10Pct: num(r.realized_trail30_10_pct),
        realizedHard30mPct: num(r.realized_hard30m_pct),
        realizedTier50HoldEodPct: num(r.realized_tier50_holdeod_pct),
        realizedEodPct: num(r.realized_eod_pct),
        peakCeilingPct: num(r.peak_ceiling_pct),
        minutesToPeak: num(r.minutes_to_peak),
        enrichedAt: r.enriched_at != null ? toIso(r.enriched_at) : null,
      },

      insertedAt: toIso(r.inserted_at),
    }));

    // No CDN cache — the feed is an alert surface and the UI polls
    // every 30s. Caching at the edge means most polls land on a stale
    // copy and never see a just-inserted fire. The bot-protected GET
    // is cheap; the per-call DB scan is one indexed query.
    setCacheHeaders(res, 0, 0);
    res.status(200).json({
      date: targetDate,
      asOf: at ?? null,
      filters: { ticker, reload, cheapCallPm, mode },
      // count = rows returned (≤ limit). total = total matching rows
      // before LIMIT. UI shows "Showing N of M" when total > count.
      count: fires.length,
      total,
      limit,
      fires,
    });
  } catch (err) {
    Sentry.captureException(err);
    logger.error({ err }, 'lottery-finder error');
    res.status(500).json({
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
