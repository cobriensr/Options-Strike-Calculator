/**
 * GET /api/cron/detect-periscope-put-lottery
 *
 * Sibling of detect-periscope-call-lottery for the L (put lottery)
 * filter. Same cadence and idempotency model — every 5 min during RTH,
 * UPSERT on (fire_type, fire_time, event_strike).
 *
 * Spec: docs/superpowers/specs/periscope-lottery-alerts-2026-05-19.md
 */

import { getDb, withDbRetry } from '../_lib/db.js';
import {
  detectPutLottery,
  todayExpiry,
} from '../_lib/periscope-lottery-finder.js';
import type { PeriscopeLotteryFire } from '../_lib/periscope-lottery-types.js';
import {
  withCronInstrumentation,
  type CronResult,
} from '../_lib/cron-instrumentation.js';

export default withCronInstrumentation(
  'detect-periscope-put-lottery',
  async (ctx): Promise<CronResult> => {
    const expiry = todayExpiry();
    const fires = await detectPutLottery(expiry);

    if (fires.length === 0) {
      return {
        status: 'success',
        rows: 0,
        metadata: { expiry, candidates: 0 },
      };
    }

    const sql = getDb();
    let inserted = 0;
    for (const f of fires) {
      const result = (await withDbRetry(
        () => sql`
          INSERT INTO periscope_lottery_fires (
            fire_type, fire_time, expiry, event_strike, trade_strike,
            spot_at_event, strike_dist, greek_post, greek_delta,
            greek_lvl_rank, greek_chg_rank,
            gex_dollars, call_ratio, qqq_net_prem_balance_30m,
            entry_px, vix,
            v3_strict_pass, v4_badge
          ) VALUES (
            ${f.fireType}, ${f.fireTime.toISOString()}, ${f.expiry},
            ${f.eventStrike}, ${f.tradeStrike},
            ${f.spotAtEvent}, ${f.strikeDist},
            ${f.greekPost}, ${f.greekDelta},
            ${f.greekLvlRank}, ${f.greekChgRank},
            ${f.gexDollars}, ${f.callRatio}, ${f.qqqNetPremBalance30m},
            ${f.entryPx}, ${f.vix},
            ${f.v3StrictPass}, ${f.v4Badge}
          )
          ON CONFLICT (fire_type, fire_time, event_strike) DO NOTHING
          RETURNING id
        `,
        2,
        10_000,
      )) as { id: number }[];
      if (result.length > 0) inserted += 1;
    }

    ctx.logger.info(
      { expiry, candidates: fires.length, inserted },
      'detect-periscope-put-lottery completed',
    );

    const v4Badges = fires.filter(
      (f: PeriscopeLotteryFire) => f.v4Badge,
    ).length;

    return {
      status: 'success',
      rows: inserted,
      metadata: {
        expiry,
        candidates: fires.length,
        inserted,
        v4Badges,
      },
    };
  },
  { requireApiKey: false },
);
