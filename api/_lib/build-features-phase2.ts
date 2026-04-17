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
 * Check whether `dateStr` falls inside the Unusual Whales 30-trading-day
 * rolling history window. UW returns HTTP 403 with
 * `historic_data_access_missing` for max_pain and options_volume lookups on
 * dates older than that window; pre-flighting lets us skip the fetch entirely
 * and avoid noisy warn logs during blanket backfills.
 *
 * The calculation is a calendar-day approximation:
 *   calendar days ≈ ceil(trading days * 7/5) + safety buffer
 * For 30 trading days, 44 calendar days covers the window with a small
 * over-inclusion margin. Erring generous is safe — at worst we issue one
 * extra API call whose 403 is still caught by the surrounding try-block.
 *
 * Exported for direct unit testing.
 */
export function isWithinUWWindow(
  dateStr: string,
  today: Date = new Date(),
  days = 30,
): boolean {
  const parsed = new Date(`${dateStr}T12:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return false;

  // Compare using UTC midnights so DST transitions don't shift the boundary.
  const targetDay = Date.UTC(
    parsed.getUTCFullYear(),
    parsed.getUTCMonth(),
    parsed.getUTCDate(),
  );
  const todayDay = Date.UTC(
    today.getUTCFullYear(),
    today.getUTCMonth(),
    today.getUTCDate(),
  );

  // Future dates are always "within window" — UW will simply return no data
  // rather than a historic_data_access_missing 403.
  if (targetDay >= todayDay) return true;

  const daysAgo = Math.round((todayDay - targetDay) / (24 * 60 * 60 * 1000));
  const calendarWindow = Math.ceil((days * 7) / 5) + 2;
  return daysAgo <= calendarWindow;
}

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

    const vixNow = typeof features.vix === 'number' ? features.vix : null;
    if (vixNow !== null && prev.vix_close != null) {
      features.prev_day_vix_change = vixNow - Number(prev.vix_close);
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
  const rv5 =
    typeof features.realized_vol_5d === 'number'
      ? features.realized_vol_5d
      : null;
  const vix = typeof features.vix === 'number' ? features.vix : null;
  if (rv5 !== null && vix !== null && vix > 0) {
    features.rv_iv_ratio = rv5 / vix;
  }

  // VIX term structure
  const vix1d = typeof features.vix1d === 'number' ? features.vix1d : null;
  const vix9d = typeof features.vix9d === 'number' ? features.vix9d : null;
  if (vix1d !== null && vix9d !== null && vix !== null && vix > 0) {
    features.vix_term_slope = (vix9d - vix1d) / vix;
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
      const vvixNow = typeof features.vvix === 'number' ? features.vvix : null;
      const belowCount =
        vvixNow !== null ? vvixValues.filter((v) => v <= vvixNow).length : 0;
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
    if (apiKey && !isWithinUWWindow(dateStr)) {
      logger.info(
        { date: dateStr },
        'Max pain: skipping UW fetch (outside 30-trading-day rolling window)',
      );
    } else if (apiKey) {
      const outcome = await fetchMaxPain(apiKey, dateStr);
      if (outcome.kind === 'error') {
        // Don't poison the feature row with placeholder zeros — leave
        // max_pain_0dte / max_pain_dist undefined so downstream models
        // see a genuine NaN rather than a fabricated 0.
        logger.warn(
          { date: dateStr, reason: outcome.reason },
          'Max pain feature extraction skipped (UW API error)',
        );
      } else if (outcome.kind === 'ok') {
        const sorted = outcome.data
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
      // outcome.kind === 'empty' → no entries returned; leave features as-is
    }
  } catch (error_) {
    logger.warn({ err: error_ }, 'Max pain feature extraction failed');
  }

  // Dark pool features (from dark_pool_levels — full tape, per-$1 SPX)
  try {
    const dpRows = await sql`
      SELECT spx_approx, total_premium, trade_count, total_shares
      FROM dark_pool_levels
      WHERE date = ${dateStr}
      ORDER BY total_premium DESC
    `;

    if (dpRows.length > 0) {
      const levels = dpRows.map((r) => ({
        spxLevel: Number(r.spx_approx),
        totalPremium: Number(r.total_premium),
        tradeCount: Number(r.trade_count),
      }));

      const totalPremium = levels.reduce((s, l) => s + l.totalPremium, 0);

      features.dp_total_premium = totalPremium;
      features.dp_cluster_count = levels.length;

      const spxPrice = (features.spx_open as number | undefined) ?? null;
      const topLevel = levels[0]!;

      if (spxPrice != null) {
        features.dp_top_cluster_dist = topLevel.spxLevel - spxPrice;

        // Support = premium at levels AT or BELOW SPX; resistance = above
        let support = 0;
        let resistance = 0;
        for (const l of levels) {
          if (l.spxLevel <= spxPrice) {
            support += l.totalPremium;
          } else {
            resistance += l.totalPremium;
          }
        }
        features.dp_support_premium = support;
        features.dp_resistance_premium = resistance;
        features.dp_support_resistance_ratio =
          resistance > 0
            ? Math.round((support / resistance) * 10000) / 10000
            : null;
      }

      // Concentration: how much of total premium is at the single top level
      features.dp_concentration =
        totalPremium > 0
          ? Math.round((topLevel.totalPremium / totalPremium) * 10000) / 10000
          : null;
    }
  } catch (error_) {
    logger.warn({ err: error_ }, 'Dark pool feature extraction failed');
  }

  // Options volume & premium (from Unusual Whales API)
  try {
    const apiKey = process.env.UW_API_KEY;
    if (apiKey && !isWithinUWWindow(dateStr)) {
      logger.info(
        { date: dateStr },
        'Options volume: skipping UW fetch (outside 30-trading-day rolling window)',
      );
    } else if (apiKey) {
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
  } catch (error_) {
    logger.warn({ err: error_ }, 'Options volume feature extraction failed');
  }

  // OI Change features (from oi_changes table — daily OI diffs)
  try {
    const oicRows = await sql`
      SELECT option_symbol, strike, is_call, oi_diff,
             prev_ask_volume, prev_bid_volume,
             prev_multi_leg_volume, prev_total_premium
      FROM oi_changes
      WHERE date = ${dateStr}
    `;

    if (oicRows.length > 0) {
      let callOiChange = 0;
      let putOiChange = 0;
      let callPremium = 0;
      let putPremium = 0;
      let totalAskVol = 0;
      let totalBidVol = 0;
      let totalMultiLeg = 0;
      const absChanges: { strike: number; absDiff: number }[] = [];

      for (const r of oicRows) {
        const diff = Number(r.oi_diff) || 0;
        const premium = Number(r.prev_total_premium) || 0;
        const askVol = Number(r.prev_ask_volume) || 0;
        const bidVol = Number(r.prev_bid_volume) || 0;
        const multiLeg = Number(r.prev_multi_leg_volume) || 0;
        const strike = Number(r.strike) || 0;
        const isCall = r.is_call === true;

        if (isCall) {
          callOiChange += diff;
          callPremium += premium;
        } else {
          putOiChange += diff;
          putPremium += premium;
        }

        totalAskVol += askVol;
        totalBidVol += bidVol;
        totalMultiLeg += multiLeg;
        absChanges.push({ strike, absDiff: Math.abs(diff) });
      }

      features.oic_net_oi_change = callOiChange + putOiChange;
      features.oic_call_oi_change = callOiChange || null;
      features.oic_put_oi_change = putOiChange || null;
      features.oic_oi_change_pcr =
        callOiChange !== 0
          ? Math.round((putOiChange / callOiChange) * 10000) / 10000
          : null;
      features.oic_net_premium = callPremium + putPremium || null;
      features.oic_call_premium = callPremium || null;
      features.oic_put_premium = putPremium || null;

      const totalVol = totalAskVol + totalBidVol;
      features.oic_ask_ratio =
        totalVol > 0
          ? Math.round((totalAskVol / totalVol) * 10000) / 10000
          : null;

      const allVol = totalAskVol + totalBidVol + totalMultiLeg;
      features.oic_multi_leg_pct =
        allVol > 0
          ? Math.round((totalMultiLeg / allVol) * 10000) / 10000
          : null;

      // Top strike distance from SPX open
      absChanges.sort((a, b) => b.absDiff - a.absDiff);
      const spxOpen = features.spx_open as number | undefined;
      if (absChanges[0] && spxOpen && absChanges[0].strike > 0) {
        features.oic_top_strike_dist = absChanges[0].strike - spxOpen;
      }

      // Concentration: top 5 as fraction of total absolute OI change
      const totalAbsDiff = absChanges.reduce((s, c) => s + c.absDiff, 0);
      const top5AbsDiff = absChanges
        .slice(0, 5)
        .reduce((s, c) => s + c.absDiff, 0);
      features.oic_concentration =
        totalAbsDiff > 0
          ? Math.round((top5AbsDiff / totalAbsDiff) * 10000) / 10000
          : null;
    }
  } catch (error_) {
    logger.warn({ err: error_ }, 'OI change feature extraction failed');
  }

  // Vol surface features (from vol_term_structure + vol_realized + iv_monitor)
  try {
    // Term structure: the /volatility/term-structure endpoint only returns
    // monthly+ expiries (min DTE ~15). For the 0DTE end we use iv_monitor
    // (from /interpolated-iv which includes 0DTE). This gives us the full
    // 0DTE-to-30D slope that defines contango/inversion.
    const tsRows = await sql`
      SELECT days, volatility FROM vol_term_structure
      WHERE date = ${dateStr}
      ORDER BY days ASC
    `;

    // Get 0DTE IV from iv_monitor (first reading of the day)
    const ivMonRow = await sql`
      SELECT volatility FROM iv_monitor
      WHERE date = ${dateStr}
      ORDER BY timestamp ASC
      LIMIT 1
    `;
    const zeroDteVol =
      ivMonRow.length > 0 ? num(ivMonRow[0]!.volatility) : null;

    if (tsRows.length >= 1) {
      const vols = tsRows.map((r) => ({
        days: Number(r.days),
        vol: Number(r.volatility),
      }));

      // Find ~30D point (closest to 30 DTE on the term structure)
      const thirtyD = vols.reduce(
        (best, v) =>
          Math.abs(v.days - 30) < Math.abs(best.days - 30) ? v : best,
        vols[0]!,
      );

      if (zeroDteVol != null && thirtyD) {
        const spread = zeroDteVol - thirtyD.vol;
        features.iv_ts_spread = Math.round(spread * 10000) / 10000;
        features.iv_ts_contango = zeroDteVol < thirtyD.vol;
        features.iv_ts_slope_0d_30d =
          thirtyD.vol > 0
            ? Math.round(((zeroDteVol - thirtyD.vol) / thirtyD.vol) * 10000) /
              10000
            : null;
      }
    }

    // Realized vol + IV rank from vol_realized table
    const rvRow = await sql`
      SELECT rv_30d, iv_rv_spread, iv_overpricing_pct, iv_rank
      FROM vol_realized
      WHERE date = ${dateStr}
      LIMIT 1
    `;

    if (rvRow.length > 0) {
      const rv = rvRow[0]!;
      features.uw_rv_30d = num(rv.rv_30d);
      features.uw_iv_rv_spread = num(rv.iv_rv_spread);
      features.uw_iv_overpricing_pct = num(rv.iv_overpricing_pct);
      features.iv_rank = num(rv.iv_rank);
    }
  } catch (error_) {
    logger.warn({ err: error_ }, 'Vol surface feature extraction failed');
  }
}

// Local num helper (avoids importing full types module just for this)
function num(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
