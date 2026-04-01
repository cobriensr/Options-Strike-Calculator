/**
 * Phase 2 feature engineering for build-features cron.
 *
 * Extracts: previous-day stats, realized volatility, VIX term structure,
 * VVIX percentile, economic events (FOMC/OPEX/etc.), max pain,
 * dark pool features, and options volume/premium.
 */

import type { NeonQueryFunction } from '@neondatabase/serverless';
import type { FeatureRow } from './build-features-types.js';
import { fetchMaxPain } from './max-pain.js';
import logger from './logger.js';

/**
 * Engineer Phase 2 features: previous day, realized vol, events,
 * VIX term structure, max pain, dark pool, options volume.
 * Mutates `features` in place.
 */
export async function engineerPhase2Features(
  sql: NeonQueryFunction<false, false>,
  dateStr: string,
  features: FeatureRow,
): Promise<void> {
  // Previous day features (from outcomes table)
  const prevDayRows = await sql`
    SELECT date, day_range_pts, close_vs_open, vix_close,
           CASE WHEN close_vs_open > 0 THEN 'UP' ELSE 'DOWN' END AS direction,
           CASE
             WHEN day_range_pts < 30 THEN 'NARROW'
             WHEN day_range_pts < 60 THEN 'NORMAL'
             WHEN day_range_pts < 100 THEN 'WIDE'
             ELSE 'EXTREME'
           END AS range_cat
    FROM outcomes
    WHERE date < ${dateStr}
    ORDER BY date DESC
    LIMIT 10
  `;

  if (prevDayRows.length > 0) {
    const prev = prevDayRows[0]!;
    features.prev_day_range_pts = num(prev.day_range_pts);
    features.prev_day_direction = prev.direction as string;
    features.prev_day_range_cat = prev.range_cat as string;

    if (features.vix != null && prev.vix_close != null) {
      features.prev_day_vix_change = features.vix - Number(prev.vix_close);
    }
  }

  // Realized volatility from log returns of settlement prices
  const settlements = await sql`
    SELECT settlement FROM outcomes
    WHERE date <= ${dateStr} AND settlement IS NOT NULL
    ORDER BY date DESC
    LIMIT 11
  `;

  const prices = settlements.map((r) => Number(r.settlement));

  if (prices.length >= 6) {
    const logReturns5: number[] = [];
    for (let i = 0; i < 5 && i + 1 < prices.length; i++) {
      logReturns5.push(Math.log(prices[i]! / prices[i + 1]!));
    }
    if (logReturns5.length >= 5) {
      const mean5 = logReturns5.reduce((a, b) => a + b, 0) / logReturns5.length;
      const variance5 =
        logReturns5.reduce((a, b) => a + (b - mean5) ** 2, 0) /
        (logReturns5.length - 1);
      features.realized_vol_5d = Math.sqrt(variance5) * Math.sqrt(252) * 100;
    }
  }

  if (prices.length >= 11) {
    const logReturns10: number[] = [];
    for (let i = 0; i < 10 && i + 1 < prices.length; i++) {
      logReturns10.push(Math.log(prices[i]! / prices[i + 1]!));
    }
    if (logReturns10.length >= 10) {
      const mean10 =
        logReturns10.reduce((a, b) => a + b, 0) / logReturns10.length;
      const variance10 =
        logReturns10.reduce((a, b) => a + (b - mean10) ** 2, 0) /
        (logReturns10.length - 1);
      features.realized_vol_10d = Math.sqrt(variance10) * Math.sqrt(252) * 100;
    }
  }

  // RV/IV ratio
  if (
    features.realized_vol_5d != null &&
    features.vix != null &&
    features.vix > 0
  ) {
    features.rv_iv_ratio = features.realized_vol_5d / features.vix;
  }

  // VIX term structure
  if (
    features.vix1d != null &&
    features.vix9d != null &&
    features.vix != null &&
    features.vix > 0
  ) {
    features.vix_term_slope = (features.vix9d - features.vix1d) / features.vix;
  }

  // VVIX percentile (trailing 20-day)
  if (features.vvix != null) {
    const vvixHistory = await sql`
      SELECT vvix FROM training_features
      WHERE date < ${dateStr} AND vvix IS NOT NULL
      ORDER BY date DESC LIMIT 20
    `;
    if (vvixHistory.length >= 10) {
      const vvixValues = vvixHistory.map((r) => Number(r.vvix));
      const belowCount = vvixValues.filter((v) => v <= features.vvix!).length;
      features.vvix_percentile = belowCount / vvixValues.length;
    }
  }

  // Economic event features
  features.is_opex = false;
  features.is_fomc = false;
  features.event_count = 0;

  const eventRows = await sql`
    SELECT event_name, event_type, event_time
    FROM economic_events
    WHERE date = ${dateStr}
  `;

  if (eventRows.length > 0) {
    features.event_count = eventRows.length;
    const types = new Set(eventRows.map((r) => r.event_type as string));
    const priority = [
      'FOMC',
      'CPI',
      'PCE',
      'JOBS',
      'GDP',
      'PMI',
      'RETAIL',
      'SENTIMENT',
      'OTHER',
    ];
    features.event_type = priority.find((p) => types.has(p)) ?? null;
    features.is_fomc = types.has('FOMC');
  }

  // Check if today is OPEX (3rd Friday of month)
  const opexDate = new Date(`${dateStr}T12:00:00-05:00`);
  if (!Number.isNaN(opexDate.getTime()) && opexDate.getDay() === 5) {
    const dayOfMonth = opexDate.getDate();
    features.is_opex = dayOfMonth >= 15 && dayOfMonth <= 21;
  }

  // Days to next event
  const nextEventRow = await sql`
    SELECT MIN(date) AS next_date
    FROM economic_events
    WHERE date > ${dateStr}
  `;
  if (nextEventRow.length > 0 && nextEventRow[0]!.next_date != null) {
    const nextDate = new Date(String(nextEventRow[0]!.next_date));
    const thisDate = new Date(`${dateStr}T12:00:00-05:00`);
    if (
      !Number.isNaN(nextDate.getTime()) &&
      !Number.isNaN(thisDate.getTime())
    ) {
      features.days_to_next_event = Math.round(
        (nextDate.getTime() - thisDate.getTime()) / (24 * 60 * 60 * 1000),
      );
    }
  }

  // Max pain (from Unusual Whales API)
  try {
    const apiKey = process.env.UW_API_KEY;
    if (apiKey) {
      const maxPainEntries = await fetchMaxPain(apiKey, dateStr);
      const sorted = maxPainEntries
        .filter((e) => e.expiry >= dateStr)
        .sort((a, b) => a.expiry.localeCompare(b.expiry));
      const best = sorted[0];
      if (best) {
        const mp = Number.parseFloat(best.max_pain);
        if (!Number.isNaN(mp)) {
          features.max_pain_0dte = mp;
          const spxOpen = features.spx_open as number | undefined;
          if (spxOpen != null && spxOpen > 0) {
            features.max_pain_dist = mp - spxOpen;
          }
        }
      }
    }
  } catch (mpErr) {
    logger.warn({ err: mpErr }, 'Max pain feature extraction failed');
  }

  // Dark pool features (from dark_pool_snapshots)
  try {
    const dpRows = await sql`
      SELECT spx_price, clusters
      FROM dark_pool_snapshots
      WHERE date = ${dateStr}
      ORDER BY timestamp DESC
      LIMIT 1
    `;

    if (dpRows.length > 0 && dpRows[0]!.clusters) {
      const clusters = dpRows[0]!.clusters as Array<{
        spxApprox: number;
        totalPremium: number;
        tradeCount: number;
        buyerInitiated: number;
        sellerInitiated: number;
      }>;
      const spxPrice = Number.parseFloat(String(dpRows[0]!.spx_price)) || null;

      features.dp_total_premium = clusters.reduce(
        (s, c) => s + c.totalPremium,
        0,
      );
      features.dp_buyer_initiated = clusters.reduce(
        (s, c) => s + c.buyerInitiated,
        0,
      );
      features.dp_seller_initiated = clusters.reduce(
        (s, c) => s + c.sellerInitiated,
        0,
      );
      features.dp_cluster_count = clusters.length;

      const totalBuyer = features.dp_buyer_initiated as number;
      const totalSeller = features.dp_seller_initiated as number;
      features.dp_net_bias =
        totalBuyer > totalSeller * 1.5
          ? 'BUYER'
          : totalSeller > totalBuyer * 1.5
            ? 'SELLER'
            : 'MIXED';

      if (clusters.length > 0 && spxPrice != null) {
        features.dp_top_cluster_dist = clusters[0]!.spxApprox - spxPrice;
      }

      features.dp_support_premium = clusters
        .filter((c) => c.buyerInitiated > c.sellerInitiated)
        .reduce((s, c) => s + c.totalPremium, 0);
      features.dp_resistance_premium = clusters
        .filter((c) => c.sellerInitiated > c.buyerInitiated)
        .reduce((s, c) => s + c.totalPremium, 0);
    }
  } catch (dpErr) {
    logger.warn({ err: dpErr }, 'Dark pool feature extraction failed');
  }

  // Options volume & premium (from Unusual Whales API)
  try {
    const apiKey = process.env.UW_API_KEY;
    if (apiKey) {
      const ovRes = await fetch(
        `https://api.unusualwhales.com/api/stock/SPX/options-volume?limit=1&date=${dateStr}`,
        {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: AbortSignal.timeout(10_000),
        },
      );
      if (ovRes.ok) {
        const ovBody = await ovRes.json();
        const ovData = ovBody.data;
        if (Array.isArray(ovData) && ovData.length > 0) {
          const ov = ovData[0]!;

          const callVol = Number.parseInt(String(ov.call_volume ?? '0'), 10);
          const putVol = Number.parseInt(String(ov.put_volume ?? '0'), 10);
          const callOI = Number.parseInt(
            String(ov.call_open_interest ?? '0'),
            10,
          );
          const putOI = Number.parseInt(
            String(ov.put_open_interest ?? '0'),
            10,
          );

          features.opt_call_volume = callVol || null;
          features.opt_put_volume = putVol || null;
          features.opt_call_oi = callOI || null;
          features.opt_put_oi = putOI || null;

          const callPrem = Number.parseFloat(String(ov.call_premium ?? '0'));
          const putPrem = Number.parseFloat(String(ov.put_premium ?? '0'));
          const bullPrem = Number.parseFloat(String(ov.bullish_premium ?? '0'));
          const bearPrem = Number.parseFloat(String(ov.bearish_premium ?? '0'));
          features.opt_call_premium = callPrem || null;
          features.opt_put_premium = putPrem || null;
          features.opt_bullish_premium = bullPrem || null;
          features.opt_bearish_premium = bearPrem || null;

          const callAsk = Number.parseInt(
            String(ov.call_volume_ask_side ?? '0'),
            10,
          );
          const putBid = Number.parseInt(
            String(ov.put_volume_bid_side ?? '0'),
            10,
          );
          features.opt_call_vol_ask = callAsk || null;
          features.opt_put_vol_bid = putBid || null;

          if (callVol > 0) {
            features.opt_vol_pcr = putVol / callVol;
          }
          if (callOI > 0) {
            features.opt_oi_pcr = putOI / callOI;
          }
          if (bullPrem + bearPrem > 0) {
            features.opt_premium_ratio = bullPrem / (bullPrem + bearPrem);
          }

          const avg30Call = Number.parseInt(
            String(ov.avg_30_day_call_volume ?? '0'),
            10,
          );
          const avg30Put = Number.parseInt(
            String(ov.avg_30_day_put_volume ?? '0'),
            10,
          );
          if (avg30Call > 0) {
            features.opt_call_vol_vs_avg30 = callVol / avg30Call;
          }
          if (avg30Put > 0) {
            features.opt_put_vol_vs_avg30 = putVol / avg30Put;
          }
        }
      }
    }
  } catch (ovErr) {
    logger.warn({ err: ovErr }, 'Options volume feature extraction failed');
  }
}

// Local num helper (avoids importing full types module just for this)
function num(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
