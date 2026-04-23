/**
 * GET /api/institutional-program?days=30
 *
 * Returns daily-aggregated institutional program state for the SPXW
 * regime + opening-blocks tracker. Aggregation happens on-the-fly
 * from institutional_blocks — no separate aggregation cron.
 *
 * Response shape:
 *   {
 *     days: DailyProgramSummary[],        // time series, ceiling track
 *     today: { blocks: InstitutionalBlock[] }
 *   }
 *
 * Source: docs/institutional-program-tracker.md (v2 spec).
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { checkBot } from './_lib/api-helpers.js';
import { getDb } from './_lib/db.js';
import { Sentry } from './_lib/sentry.js';

interface DominantPair {
  low_strike: number;
  high_strike: number;
  spread_width: number;
  total_size: number;
  total_premium: number;
  direction: 'sell' | 'buy' | 'mixed';
}

interface DailyProgramSummary {
  date: string;
  dominant_pair: DominantPair | null;
  avg_spot: number | null;
  ceiling_pct_above_spot: number | null;
  n_blocks: number;
  n_call_blocks: number;
  n_put_blocks: number;
}

interface InstitutionalBlockRow {
  executed_at: string;
  option_chain_id: string;
  strike: number;
  option_type: 'call' | 'put';
  dte: number;
  size: number;
  premium: number;
  price: number;
  side: string | null;
  condition: string;
  exchange: string | null;
  underlying_price: number;
  moneyness_pct: number;
  program_track: 'ceiling' | 'opening_atm' | 'other';
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
) {
  if (!(await checkBot(req))) {
    return res.status(403).json({ error: 'bot check failed' });
  }

  const daysRaw = Number.parseInt(String(req.query.days ?? '30'), 10);
  const days = Math.min(Math.max(Number.isFinite(daysRaw) ? daysRaw : 30, 1), 180);

  // Optional date param for backtesting: which day's blocks to show in
  // the "today" slot. Defaults to today; format YYYY-MM-DD.
  const dateRaw = String(req.query.date ?? '');
  const dateFilter = /^\d{4}-\d{2}-\d{2}$/.test(dateRaw) ? dateRaw : null;

  try {
    const sql = getDb();

    // Ceiling-track daily summary + dominant-pair detection.
    // Restricted to option_type='call' for the ceiling metric: the
    // program is predominantly a short call-spread sale, so mixing
    // OTM calls (strike >> spot) with OTM puts (strike << spot) would
    // pull avg_strike toward spot and destroy the "ceiling %" signal.
    // Put-side activity is preserved in the raw table for future
    // floor-metric analysis.
    const summaries = (await sql`
      WITH per_day AS (
        SELECT
          CAST(executed_at AS DATE) AS date,
          AVG(underlying_price) AS avg_spot,
          COUNT(*)::INTEGER AS n_blocks,
          SUM(CASE WHEN option_type = 'call' THEN 1 ELSE 0 END)::INTEGER
            AS n_call_blocks,
          SUM(CASE WHEN option_type = 'put'  THEN 1 ELSE 0 END)::INTEGER
            AS n_put_blocks,
          AVG(strike) FILTER (WHERE option_type = 'call') AS avg_strike
        FROM institutional_blocks
        WHERE program_track = 'ceiling'
          AND executed_at >= NOW() - (${days}::TEXT || ' days')::INTERVAL
        GROUP BY 1
      ),
      candidate_pairs AS (
        SELECT
          CAST(executed_at AS DATE) AS date,
          option_type,
          date_trunc('minute', executed_at) AS exec_min,
          COUNT(DISTINCT strike) AS n_strikes,
          MIN(strike) AS low_strike,
          MAX(strike) AS high_strike,
          SUM(size)::INTEGER AS total_size,
          SUM(premium) AS total_premium,
          CASE
            WHEN SUM(CASE WHEN side = 'ask' THEN size ELSE 0 END)
                 > SUM(CASE WHEN side = 'bid' THEN size ELSE 0 END) * 1.5
              THEN 'buy'
            WHEN SUM(CASE WHEN side = 'bid' THEN size ELSE 0 END)
                 > SUM(CASE WHEN side = 'ask' THEN size ELSE 0 END) * 1.5
              THEN 'sell'
            ELSE 'mixed'
          END AS direction
        FROM institutional_blocks
        WHERE program_track = 'ceiling'
          AND option_type = 'call'
          AND executed_at >= NOW() - (${days}::TEXT || ' days')::INTERVAL
        GROUP BY 1, 2, 3
        HAVING COUNT(DISTINCT strike) >= 2
      ),
      dominant_per_day AS (
        SELECT DISTINCT ON (date)
          date, low_strike, high_strike,
          (high_strike - low_strike) AS spread_width,
          total_size, total_premium, direction
        FROM candidate_pairs
        ORDER BY date, total_size DESC
      )
      SELECT
        pd.date::TEXT AS date,
        CASE
          WHEN dpd.date IS NULL THEN NULL
          ELSE json_build_object(
            'low_strike',    dpd.low_strike,
            'high_strike',   dpd.high_strike,
            'spread_width',  dpd.spread_width,
            'total_size',    dpd.total_size,
            'total_premium', dpd.total_premium,
            'direction',     dpd.direction
          )
        END AS dominant_pair,
        pd.avg_spot::DOUBLE PRECISION AS avg_spot,
        (pd.avg_strike / NULLIF(pd.avg_spot, 0) - 1)::DOUBLE PRECISION
          AS ceiling_pct_above_spot,
        pd.n_blocks,
        pd.n_call_blocks,
        pd.n_put_blocks
      FROM per_day pd
      LEFT JOIN dominant_per_day dpd ON dpd.date = pd.date
      ORDER BY pd.date ASC
    `) as DailyProgramSummary[];

    // Block list for the requested date (both tracks) for the
    // expandable table. Defaults to today when no date is supplied;
    // honors ?date=YYYY-MM-DD for historical backtesting.
    const today = (dateFilter
      ? await sql`
          SELECT
            executed_at::TEXT AS executed_at,
            option_chain_id,
            strike,
            option_type,
            dte,
            size,
            premium,
            price,
            side,
            condition,
            exchange,
            underlying_price,
            moneyness_pct,
            program_track
          FROM institutional_blocks
          WHERE CAST(executed_at AS DATE) = ${dateFilter}::DATE
          ORDER BY executed_at DESC
          LIMIT 200
        `
      : await sql`
          SELECT
            executed_at::TEXT AS executed_at,
            option_chain_id,
            strike,
            option_type,
            dte,
            size,
            premium,
            price,
            side,
            condition,
            exchange,
            underlying_price,
            moneyness_pct,
            program_track
          FROM institutional_blocks
          WHERE CAST(executed_at AS DATE) = CURRENT_DATE
          ORDER BY executed_at DESC
          LIMIT 200
        `) as InstitutionalBlockRow[];

    res.status(200).json({
      days: summaries,
      today: { blocks: today, date: dateFilter ?? 'today' },
    });
  } catch (err) {
    Sentry.captureException(err);
    res.status(500).json({ error: String(err) });
  }
}
